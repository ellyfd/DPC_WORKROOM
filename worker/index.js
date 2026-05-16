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
    } catch (err) {
      return jsonError(err?.message || String(err), 500);
    }

    return env.ASSETS.fetch(request);
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

async function getState(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind("state").first();
  const state = row
    ? JSON.parse(row.v)
    : { tools: [], categories: [], creators: [], brands: [] };
  return json(state);
}

async function putState(request, env) {
  const body = await request.json();
  const newState = {
    tools: Array.isArray(body.tools) ? body.tools : [],
    categories: Array.isArray(body.categories) ? body.categories : [],
    creators: Array.isArray(body.creators) ? body.creators : [],
    brands: Array.isArray(body.brands) ? body.brands : [],
  };

  // Diff against old state — anything dropped from a tool's files[] gets
  // deleted from R2 so the bucket doesn't accumulate orphans.
  const oldRow = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind("state").first();
  const oldState = oldRow ? JSON.parse(oldRow.v) : { tools: [] };
  const oldKeys = collectFileKeys(oldState.tools);
  const newKeys = collectFileKeys(newState.tools);
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

  await env.DB.prepare(
    "INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at"
  )
    .bind("state", JSON.stringify(newState), Date.now())
    .run();

  return json({ ok: true });
}

function collectFileKeys(tools) {
  const set = new Set();
  for (const t of tools || []) {
    if (Array.isArray(t.files)) {
      for (const f of t.files) if (f && f.key) set.add(f.key);
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
