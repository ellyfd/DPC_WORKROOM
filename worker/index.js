// DPC Hub Worker — D1 for state, R2 for uploaded files, Static Assets for the SPA.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Uploaded-By, X-Tool-Id, X-Filename",
};

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    try {
      if (url.pathname === "/api/state") {
        if (request.method === "GET") return await getState(env);
        if (request.method === "PUT") {
          if (!writeOriginAllowed(request)) return jsonError("origin not allowed", 403);
          return await putState(request, env);
        }
        return jsonError("method not allowed", 405);
      }
      if (url.pathname === "/api/upload" && request.method === "POST") {
        if (!writeOriginAllowed(request)) return jsonError("origin not allowed", 403);
        return await uploadFile(request, env);
      }
      if (url.pathname === "/api/hit" && request.method === "POST") {
        if (!writeOriginAllowed(request)) return jsonError("origin not allowed", 403);
        return await recordHit(request, env);
      }
      if (url.pathname.startsWith("/files/")) {
        const key = decodeURIComponent(url.pathname.slice("/files/".length));
        return await downloadFile(env, key);
      }
      if (url.pathname.startsWith("/p/")) {
        return await servePage(env, url);
      }
    } catch (err) {
      return jsonError(err?.message || String(err), 500);
    }

    // Fall back to static assets. Force no-cache on the HTML shell so the
    // ?v=... query strings on script.js / styles.css always pick up changes.
    const res = await env.ASSETS.fetch(request);
    const isHtml = (res.headers.get("Content-Type") || "").startsWith("text/html");
    if (isHtml) {
      const headers = new Headers(res.headers);
      headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      return new Response(res.body, { status: res.status, headers });
    }
    return res;
  },

  // Daily cron (wrangler.toml [triggers]): snapshot the whole state blob to
  // R2 so a bad write or bug can never lose data permanently.
  async scheduled(_event, env) {
    await backupState(env);
  },
};

/* Writes must come from the app itself (same-origin), local dev, or
   non-browser tools (no Origin header). Sandboxed /p/ pages send
   Origin: "null" and are rejected — an uploaded HTML page must not be able
   to rewrite the shared state or upload files. */
function writeOriginAllowed(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  if (origin === "https://dpcwork.ellyfd.workers.dev") return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host.startsWith("127.");
  } catch {
    return false;
  }
}

const BACKUP_PREFIX = "_backups/";
const BACKUP_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

async function backupState(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind("state").first();
  if (!row) return;
  const day = new Date().toISOString().slice(0, 10);
  await env.FILES.put(`${BACKUP_PREFIX}state-${day}.json`, row.v, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  // Prune snapshots older than the retention window.
  const cutoff = Date.now() - BACKUP_KEEP_MS;
  const listing = await env.FILES.list({ prefix: BACKUP_PREFIX });
  for (const obj of listing.objects || []) {
    const uploaded = obj.uploaded ? new Date(obj.uploaded).getTime() : NaN;
    if (Number.isFinite(uploaded) && uploaded < cutoff) {
      try {
        await env.FILES.delete(obj.key);
      } catch {}
    }
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}
function jsonError(message, status = 500) {
  return json({ error: message }, status);
}

const EMPTY_TOMBSTONES = () => ({ tools: {}, tips: {}, categories: {}, creators: {}, brands: {} });
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // purge delete-markers after 30 days
// Aligned with the tombstone TTL so a tool restored from the recycle bin
// still has its uploaded files.
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVITY_CAP = 300;
const DELETED_TOOLS_CAP = 100;

function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const tomb = EMPTY_TOMBSTONES();
  if (s.tombstones && typeof s.tombstones === "object") {
    for (const kind of Object.keys(tomb)) {
      if (s.tombstones[kind] && typeof s.tombstones[kind] === "object") {
        tomb[kind] = { ...s.tombstones[kind] };
      }
    }
  }
  return {
    tools: Array.isArray(s.tools) ? s.tools : [],
    categories: Array.isArray(s.categories) ? s.categories : [],
    creators: Array.isArray(s.creators) ? s.creators : [],
    brands: Array.isArray(s.brands) ? s.brands : [],
    tips: Array.isArray(s.tips) ? s.tips : [],
    tombstones: tomb,
    rev: Number.isFinite(s.rev) ? s.rev : 0,
    // Server-managed only: file keys no longer referenced anywhere, kept in
    // R2 for a grace period so a merge that re-references them can rescue
    // them. Clients never send this — it's carried across writes below.
    trash: s.trash && typeof s.trash === "object" ? { ...s.trash } : {},
    // Server-managed: full copies of deleted tools (the recycle bin) and the
    // recent-changes feed. Clients read these but never send them.
    deletedTools: Array.isArray(s.deletedTools) ? s.deletedTools : [],
    activity: Array.isArray(s.activity) ? s.activity : [],
  };
}

async function getState(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind("state").first();
  const state = normalizeState(row ? JSON.parse(row.v) : null);
  // Usage counters live in their own table (not the merged blob) so a click
  // never triggers a state write; missing table just means no stats yet.
  state.stats = {};
  try {
    const { results } = await env.DB.prepare(
      "SELECT tool_id, opens, downloads, last_at FROM hits"
    ).all();
    for (const r of results || []) {
      state.stats[r.tool_id] = {
        opens: r.opens || 0,
        downloads: r.downloads || 0,
        lastAt: r.last_at || 0,
      };
    }
  } catch {}
  return json(state);
}

/* Per-tool usage counters — POST /api/hit {toolId, kind: "open"|"download"}.
   Fire-and-forget from the client; kept out of the state blob so counting a
   click can never conflict with (or spam) the merge machinery. */
async function recordHit(request, env) {
  const body = await request.json().catch(() => ({}));
  const toolId = typeof body.toolId === "string" ? body.toolId.slice(0, 80) : "";
  const kind = body.kind === "download" ? "download" : body.kind === "open" ? "open" : "";
  if (!toolId || !kind) return jsonError("bad hit", 400);
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS hits (tool_id TEXT PRIMARY KEY, opens INTEGER DEFAULT 0, downloads INTEGER DEFAULT 0, last_at INTEGER)"
    ),
    env.DB.prepare(
      "INSERT INTO hits (tool_id, opens, downloads, last_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(tool_id) DO UPDATE SET opens = opens + excluded.opens, downloads = downloads + excluded.downloads, last_at = excluded.last_at"
    ).bind(toolId, kind === "open" ? 1 : 0, kind === "download" ? 1 : 0, Date.now()),
  ]);
  return json({ ok: true });
}

async function putState(request, env) {
  const body = await request.json();
  const incoming = normalizeState(body);
  const baseRev = Number.isFinite(body.baseRev) ? body.baseRev : null;
  const actor = typeof body.actor === "string" ? body.actor.trim().slice(0, 40) : "";

  // Optimistic-concurrency loop: read → merge → conditional write. If another
  // request lands in between (rev moved), re-read and merge again.
  for (let attempt = 0; attempt < 4; attempt++) {
    const oldRow = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind("state").first();
    const oldRaw = oldRow ? JSON.parse(oldRow.v) : null;
    // Raw rev as stored (null when the row predates revs) — used in the
    // conditional UPDATE below, where json_extract also yields NULL for it.
    const oldRawRev = Number.isFinite(oldRaw?.rev) ? oldRaw.rev : null;
    const oldState = normalizeState(oldRaw);

    // A client that loaded the current rev is up to date — take its state
    // wholesale (reorders, renames and deletions all apply exactly).
    // Anything else (stale tab, old cached script.js with no baseRev) gets
    // MERGED into the stored state so it can't wipe newer tools or resurrect
    // deleted ones.
    const upToDate = baseRev !== null && baseRev === oldState.rev;
    const finalState = upToDate ? { ...incoming } : mergeStates(oldState, incoming);
    finalState.rev = oldState.rev + 1;
    purgeTombstones(finalState.tombstones);

    // File-key trash: unreferenced keys get a grace period instead of an
    // immediate R2 delete; re-referencing a trashed key rescues it. Expired
    // keys are dropped from the stored state now but only physically deleted
    // after the write succeeds (a lost write must not lose files).
    const { trash, expired } = computeTrash(oldState, finalState);
    finalState.trash = trash;
    finalState.deletedTools = computeDeletedTools(oldState, finalState, actor);
    finalState.activity = appendActivity(oldState, finalState, actor);

    const written = oldRow
      ? await env.DB.prepare(
          "UPDATE kv SET v = ?, updated_at = ? WHERE k = 'state' AND json_extract(v, '$.rev') IS ?"
        )
          .bind(JSON.stringify(finalState), Date.now(), oldRawRev)
          .run()
      : await env.DB.prepare(
          "INSERT OR IGNORE INTO kv (k, v, updated_at) VALUES ('state', ?, ?)"
        )
          .bind(JSON.stringify(finalState), Date.now())
          .run();
    if (written.meta && written.meta.changes > 0) {
      await deleteFiles(env, expired);
      return upToDate
        ? json({ ok: true, rev: finalState.rev })
        : json({ ok: true, rev: finalState.rev, merged: true, state: finalState });
    }
  }
  return jsonError("write conflict, please retry", 409);
}

function computeTrash(oldState, finalState) {
  const oldKeys = collectFileKeys(oldState.tools, oldState.tips);
  const newKeys = collectFileKeys(finalState.tools, finalState.tips);
  const trash = { ...oldState.trash };
  for (const key of Object.keys(trash)) {
    if (newKeys.has(key)) delete trash[key]; // re-referenced → rescued
  }
  for (const key of oldKeys) {
    if (!newKeys.has(key) && !trash[key]) trash[key] = new Date().toISOString();
  }
  const cutoff = Date.now() - TRASH_TTL_MS;
  const expired = [];
  for (const [key, at] of Object.entries(trash)) {
    const t = Date.parse(at);
    if (!Number.isFinite(t) || t < cutoff) {
      expired.push(key);
      delete trash[key];
    }
  }
  return { trash, expired };
}

/* Recycle bin: whenever a live tool becomes tombstoned, its full object is
   parked here so it can be restored with one click. Entries leave when the
   tool comes back to life or the tombstone expires (30 days). */
function computeDeletedTools(oldState, finalState, actor) {
  const tomb = finalState.tombstones.tools;
  const liveIds = new Set(finalState.tools.map((t) => t && t.id).filter(Boolean));
  const out = [];
  for (const e of oldState.deletedTools) {
    const id = e && e.tool && e.tool.id;
    if (!id || liveIds.has(id) || !tomb[id]) continue;
    out.push(e);
  }
  const kept = new Set(out.map((e) => e.tool.id));
  const oldById = new Map(oldState.tools.map((t) => [t && t.id, t]));
  for (const [id, at] of Object.entries(tomb)) {
    if (liveIds.has(id) || kept.has(id)) continue;
    const tool = oldById.get(id);
    if (tool) out.push({ tool, deletedAt: at, deletedBy: actor || "" });
  }
  return out.slice(-DELETED_TOOLS_CAP);
}

/* Recent-changes feed, derived from the diff between the stored state and
   what this write produced. Tools and tips only — enough to answer "who
   changed what, when" without drowning in noise. */
function appendActivity(oldState, finalState, actor) {
  const ts = new Date().toISOString();
  const acts = [];
  const push = (action, target) =>
    acts.push({ ts, actor, action, target: String(target || "").slice(0, 60) });

  const wasDeleted = new Set(
    oldState.deletedTools.map((e) => e && e.tool && e.tool.id).filter(Boolean)
  );
  const oldTools = new Map(oldState.tools.map((t) => [t && t.id, t]));
  const newTools = new Map(finalState.tools.map((t) => [t && t.id, t]));
  for (const [id, t] of newTools) {
    if (!id) continue;
    const o = oldTools.get(id);
    if (!o) push(wasDeleted.has(id) ? "還原工具" : "新增工具", t.name || id);
    else if ((t.updated || "") !== (o.updated || "")) push("更新工具", t.name || id);
  }
  for (const [id, o] of oldTools) {
    if (id && !newTools.has(id)) push("刪除工具", o.name || id);
  }

  const oldTips = new Map(oldState.tips.map((t) => [t && t.id, t]));
  const newTips = new Map(finalState.tips.map((t) => [t && t.id, t]));
  const tipLabel = (t) => (t.text || "").slice(0, 24) || "(圖片)";
  for (const [id, t] of newTips) {
    if (!id) continue;
    const o = oldTips.get(id);
    if (!o) push("新增小知識", tipLabel(t));
    else if ((t.updatedAt || "") !== (o.updatedAt || "")) push("更新小知識", tipLabel(t));
  }
  for (const [id, o] of oldTips) {
    if (id && !newTips.has(id)) push("刪除小知識", tipLabel(o));
  }

  if (!acts.length) return oldState.activity;
  return [...oldState.activity, ...acts].slice(-ACTIVITY_CAP);
}

/* Merge a (possibly stale) client state into the stored one.
   Principles: absence is NOT deletion — only an explicit tombstone deletes.
   Tools / tips merge per-entity by id with newest-`updated` wins, so a stale
   tab can never wipe a tool someone else just added, and a deleted tool only
   comes back if it was genuinely re-created after the deletion. */
function mergeStates(oldS, inc) {
  const tombstones = EMPTY_TOMBSTONES();
  for (const kind of Object.keys(tombstones)) {
    tombstones[kind] = mergeTombstoneMap(oldS.tombstones[kind], inc.tombstones[kind]);
  }

  const tools = mergeEntities(
    oldS.tools, inc.tools, (t) => t && t.id, entityTime, tombstones.tools,
    (winner, loser) => unionAttachments(winner, loser, "files")
  );
  const tips = mergeEntities(
    oldS.tips, inc.tips, (t) => t && t.id, entityTime, tombstones.tips,
    (winner, loser) => unionAttachments(winner, loser, "images")
  );
  const categories = mergeEntities(
    oldS.categories, inc.categories, (c) => c && c.name, entityTime, tombstones.categories
  );
  const creators = mergeNames(oldS.creators, inc.creators, tombstones.creators);
  const brands = mergeNames(oldS.brands, inc.brands, tombstones.brands);

  return { tools, categories, creators, brands, tips, tombstones, rev: 0, trash: {} };
}

/* When both sides hold a copy of the same tool/tip, the newer copy wins the
   fields — but attachments are unioned by key so a concurrent edit from a
   stale device can't silently drop a file someone else just uploaded. */
function unionAttachments(winner, loser, field) {
  const wFiles = Array.isArray(winner[field]) ? winner[field] : [];
  const lFiles = Array.isArray(loser?.[field]) ? loser[field] : [];
  const known = new Set(wFiles.map((f) => f && f.key).filter(Boolean));
  const extra = lFiles.filter((f) => f && f.key && !known.has(f.key));
  return extra.length ? { ...winner, [field]: [...wFiles, ...extra] } : winner;
}

function entityTime(e) {
  const t = Date.parse(e?.updated || e?.updatedAt || e?.createdAt || "");
  return Number.isFinite(t) ? t : 0;
}

function mergeTombstoneMap(a, b) {
  const out = { ...(a || {}) };
  for (const [key, at] of Object.entries(b || {})) {
    if (!out[key] || Date.parse(at) > Date.parse(out[key])) out[key] = at;
  }
  return out;
}

function mergeEntities(oldArr, incArr, keyFn, timeFn, tombMap, combine) {
  const oldByKey = new Map();
  for (const e of oldArr) if (keyFn(e)) oldByKey.set(keyFn(e), e);
  const out = [];
  const seen = new Set();
  // Incoming order first (preserves the writing client's sort intent)…
  for (const e of incArr) {
    const key = keyFn(e);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const old = oldByKey.get(key);
    if (!old) { out.push(e); continue; }
    const winner = timeFn(old) > timeFn(e) ? old : e;
    const loser = winner === old ? e : old;
    out.push(combine ? combine(winner, loser) : winner);
  }
  // …then anything only the server knows about (added by someone else).
  for (const e of oldArr) {
    const key = keyFn(e);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  // Tombstones win unless the entity was touched after the deletion.
  return out.filter((e) => {
    const at = tombMap[keyFn(e)];
    return !at || timeFn(e) > Date.parse(at);
  });
}

function mergeNames(oldArr, incArr, tombMap) {
  const out = [];
  for (const name of [...incArr, ...oldArr]) {
    if (typeof name !== "string" || !name || out.includes(name)) continue;
    if (tombMap[name]) continue;
    out.push(name);
  }
  return out;
}

function purgeTombstones(tombstones) {
  const now = Date.now();
  const cutoff = now - TOMBSTONE_TTL_MS;
  for (const kind of Object.keys(tombstones)) {
    for (const [key, at] of Object.entries(tombstones[kind])) {
      const t = Date.parse(at);
      if (!Number.isFinite(t) || t < cutoff) delete tombstones[kind][key];
      // A device with a fast clock must not write a future-dated delete
      // marker that swallows other devices' genuine edits for hours.
      else if (t > now) tombstones[kind][key] = new Date(now).toISOString();
    }
  }
}

/* Physically delete R2 objects (and their metadata rows) whose trash grace
   period has expired — so the bucket doesn't accumulate orphans forever. */
async function deleteFiles(env, keys) {
  if (!keys.length) return;
  for (const key of keys) {
    try {
      await env.FILES.delete(key);
    } catch {}
  }
  const placeholders = keys.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM files WHERE key IN (${placeholders})`)
    .bind(...keys)
    .run();
}

function collectFileKeys(tools, tips) {
  const set = new Set();
  for (const t of tools || []) {
    if (Array.isArray(t.files)) {
      for (const f of t.files) if (f && f.key) set.add(f.key);
    }
  }
  for (const tip of tips || []) {
    if (Array.isArray(tip.images)) {
      for (const img of tip.images) if (img && img.key) set.add(img.key);
    }
  }
  return set;
}

async function uploadFile(request, env) {
  const toolId = request.headers.get("X-Tool-Id") || "misc";
  const filename = decodeMaybe(request.headers.get("X-Filename")) || "file";
  const uploadedBy = decodeMaybe(request.headers.get("X-Uploaded-By")) || "";
  const mime = request.headers.get("Content-Type") || "application/octet-stream";

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return jsonError("empty file", 400);
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    return jsonError(`file too large (max ${MAX_UPLOAD_BYTES} bytes)`, 413);
  }

  const key = `${sanitize(toolId)}/${Date.now()}-${randomId()}-${sanitize(filename)}`;
  await env.FILES.put(key, buf, { httpMetadata: { contentType: mime } });

  const uploadedAt = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO files (key, tool_id, name, size, mime, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(key, toolId, filename, buf.byteLength, mime, uploadedAt, uploadedBy)
    .run();

  return json({ key, name: filename, size: buf.byteLength, uploadedAt, uploadedBy });
}

async function servePage(env, url) {
  // /p/<tool-id>            → serve latest HTML inline
  // /p/<tool-id>/?v=<idx>   → serve files[idx] (0 = latest, 1 = previous, ...)
  // /p/<tool-id>/<anything> → 404 (single-file pages only)
  const rest = url.pathname.slice("/p/".length).replace(/\/$/, "");
  if (!rest) return new Response("Not found", { status: 404 });
  const segments = rest.split("/");
  if (segments.length > 1) {
    return new Response("Sub-assets are not supported for single-file pages.", { status: 404 });
  }
  const toolId = decodeURIComponent(segments[0] || "");
  if (!toolId) return new Response("Not found", { status: 404 });

  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind("state").first();
  if (!row) return new Response("Not found", { status: 404 });
  let state;
  try { state = JSON.parse(row.v); } catch { return new Response("Not found", { status: 404 }); }
  const tool = (state.tools || []).find((t) => t && t.id === toolId);
  if (!tool || !Array.isArray(tool.files) || !tool.files.length) {
    return new Response("Not found", { status: 404 });
  }

  const versionParam = url.searchParams.get("v");
  let idx = 0;
  if (versionParam != null) {
    const n = parseInt(versionParam, 10);
    if (!Number.isFinite(n) || n < 0 || n >= tool.files.length) {
      return new Response("Version not found", { status: 404 });
    }
    idx = n;
  }
  const file = tool.files[idx];
  if (!file || !file.key) return new Response("Not found", { status: 404 });
  if (!isHtmlFile(file)) {
    return new Response("Not an HTML page", { status: 415 });
  }

  const obj = await env.FILES.get(file.key);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  // Don't cache aggressively — uploading a new version should be visible immediately.
  headers.set("Cache-Control", "no-cache, must-revalidate");
  headers.set("X-Tool-Id", toolId);
  headers.set("X-Page-Version", String(idx));
  // Uploaded pages run in an opaque origin: scripts work, but they get no
  // cookies/storage and their writes to /api/* are rejected by the Origin
  // check (they send Origin: "null").
  headers.set(
    "Content-Security-Policy",
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads"
  );
  return new Response(obj.body, { headers });
}

function isHtmlFile(f) {
  if (!f) return false;
  const name = (f.name || "").toLowerCase();
  if (name.endsWith(".html") || name.endsWith(".htm")) return true;
  const mime = (f.mime || "").toLowerCase();
  return mime.startsWith("text/html");
}

async function downloadFile(env, key) {
  const obj = await env.FILES.get(key);
  if (!obj) return new Response("Not found", { status: 404, headers: CORS });
  const filename = key.split("/").pop().replace(/^\d+-[a-z0-9]+-/, "");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(obj.body, { headers });
}

function sanitize(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80) || "file";
}
function randomId() {
  return Math.random().toString(36).slice(2, 10);
}
function decodeMaybe(s) {
  if (!s) return "";
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Named exports for tests/merge.test.mjs — the Workers runtime ignores them.
export {
  normalizeState,
  mergeStates,
  mergeEntities,
  mergeNames,
  mergeTombstoneMap,
  unionAttachments,
  purgeTombstones,
  computeTrash,
  computeDeletedTools,
  appendActivity,
  writeOriginAllowed,
};
