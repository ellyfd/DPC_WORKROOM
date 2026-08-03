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
        if (request.method === "PUT") return await putState(request, env);
        return jsonError("method not allowed", 405);
      }
      if (url.pathname === "/api/upload" && request.method === "POST") {
        return await uploadFile(request, env);
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
};

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
  };
}

async function getState(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind("state").first();
  return json(normalizeState(row ? JSON.parse(row.v) : null));
}

async function putState(request, env) {
  const body = await request.json();
  const incoming = normalizeState(body);
  const baseRev = Number.isFinite(body.baseRev) ? body.baseRev : null;

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
    if (!written.meta || written.meta.changes > 0) {
      await cleanupRemovedFiles(env, oldState, finalState);
      return upToDate
        ? json({ ok: true, rev: finalState.rev })
        : json({ ok: true, rev: finalState.rev, merged: true, state: finalState });
    }
  }
  return jsonError("write conflict, please retry", 409);
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

  const tools = mergeEntities(oldS.tools, inc.tools, (t) => t && t.id, entityTime, tombstones.tools);
  const tips = mergeEntities(oldS.tips, inc.tips, (t) => t && t.id, entityTime, tombstones.tips);
  const categories = mergeEntities(
    oldS.categories, inc.categories, (c) => c && c.name, entityTime, tombstones.categories
  );
  const creators = mergeNames(oldS.creators, inc.creators, tombstones.creators);
  const brands = mergeNames(oldS.brands, inc.brands, tombstones.brands);

  return { tools, categories, creators, brands, tips, tombstones, rev: 0 };
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

function mergeEntities(oldArr, incArr, keyFn, timeFn, tombMap) {
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
    out.push(old && timeFn(old) > timeFn(e) ? old : e);
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
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  for (const kind of Object.keys(tombstones)) {
    for (const [key, at] of Object.entries(tombstones[kind])) {
      const t = Date.parse(at);
      if (!Number.isFinite(t) || t < cutoff) delete tombstones[kind][key];
    }
  }
}

/* Anything dropped from a tool's files[] (or a tip's images[]) gets deleted
   from R2 so the bucket doesn't accumulate orphans. */
async function cleanupRemovedFiles(env, oldState, newState) {
  const oldKeys = collectFileKeys(oldState.tools, oldState.tips);
  const newKeys = collectFileKeys(newState.tools, newState.tips);
  const removed = [...oldKeys].filter((k) => !newKeys.has(k));

  for (const key of removed) {
    try {
      await env.FILES.delete(key);
    } catch {}
  }
  if (removed.length) {
    const placeholders = removed.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM files WHERE key IN (${placeholders})`)
      .bind(...removed)
      .run();
  }
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
