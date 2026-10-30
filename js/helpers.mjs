// DPC Hub — 純工具函式(DOM 查找、escape、格式化、toast)
import { state } from "./state.mjs?v=20260804e";

const $ = (sel, root = document) => root.querySelector(sel);

const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));


/* ===== storage =====
   Tools / categories / creators / brands live on the server (D1 via the
   Worker). Per-device UI state (collapse, draft, "me" name) stays in
   localStorage.
*/

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; }
  catch { return fallback; }
}

function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }


function uniq(arr) { return Array.from(new Set(arr)); }


function queryTokens(q) {
  return String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
}


function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
}


function initial(name) {
  if (!name) return "?";
  return name.trim().charAt(0).toUpperCase();
}


function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}


function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsText(file);
  });
}


function fileExt(name) {
  const m = /\.([^.]+)$/.exec(name || "");
  return (m ? m[1] : "FILE").toUpperCase().slice(0, 4);
}


function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}


function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}


/* ===== tip image helpers ===== */

function fileUrl(key) {
  return "/files/" + String(key || "").split("/").map(encodeURIComponent).join("/");
}

function isImageFile(f) {
  if (!f) return false;
  return (f.type || "").startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name || "");
}

function imagesFromClipboard(dt) {
  const out = [];
  for (const item of dt?.items || []) {
    if (item.kind === "file" && (item.type || "").startsWith("image/")) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


function startOfWeek(ref) {
  const x = ref ? new Date(ref) : new Date();
  x.setHours(0, 0, 0, 0);
  const dow = (x.getDay() + 6) % 7; // Mon=0 … Sun=6
  x.setDate(x.getDate() - dow);
  return x;
}

function isThisWeek(iso) {
  if (!iso) return false;
  const t = new Date(iso);
  if (isNaN(t.getTime())) return false;
  return t >= startOfWeek();
}


/* ===== toast ===== */

let toastTimer;

function toast(msg) {
  const t = $("#toast");
  t.classList.remove("toast-rich");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

/* ===== network folders (\\server\share\…) =====
   Browsers never let a web page open File Explorer, so folder "links" are
   copied to the clipboard instead and the user pastes them into Win+R. */

// Normalised Windows path when `url` points at a folder/file share,
// otherwise "". Accepts \\host\x, //host/x, smb://host/x, file://host/x,
// file:///C:/x and C:\x.

function folderPath(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  let m;
  if (/^\\\\[^\\/]/.test(s) || /^\/\/[^/]/.test(s)) {
    return "\\\\" + s.replace(/^[\\/]{2}/, "").replace(/\//g, "\\");
  }
  if ((m = s.match(/^smb:\/\/(.+)$/i))) {
    return "\\\\" + safeDecode(m[1]).replace(/\//g, "\\");
  }
  if ((m = s.match(/^file:\/\/\/([a-z]:.*)$/i))) {
    return safeDecode(m[1]).replace(/\//g, "\\");
  }
  if ((m = s.match(/^file:\/\/([^/].*)$/i))) {
    return "\\\\" + safeDecode(m[1]).replace(/\//g, "\\");
  }
  if (/^[a-z]:[\\/]/i.test(s)) return s.replace(/\//g, "\\");
  return "";
}

// "https://192.168.1.220/3ddb/GAP Inc/Python" → "\\192.168.1.220\3ddb\GAP Inc\Python"
// when it looks like someone typed a share path as a web address (private
// IP + a path with spaces, which real web URLs basically never have).

function shareFromHttp(url) {
  const m = String(url || "").trim().match(/^https?:\/\/((?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}|[a-z0-9-]+)(\/[^?#]*)$/i);
  if (!m) return "";
  const path = safeDecode(m[2]);
  if (!/\s/.test(path)) return "";
  return "\\\\" + m[1] + path.replace(/\/+$/, "").replace(/\//g, "\\");
}


// Folder path for a tool's address — also catches shares that were saved as
// "https://192.168.x.x/資料夾 名稱" before this check existed, so old tools
// work without being re-saved.

function linkFolder(url) {
  return folderPath(url) || shareFromHttp(url);
}


function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}


async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  document.body.removeChild(ta);
  return ok;
}

// Copy a folder path and show which one was copied.

async function copyFolderPath(path) {
  const ok = await copyText(path);
  const t = $("#toast");
  t.textContent = "";
  const head = document.createElement("div");
  head.className = "toast-title";
  head.textContent = ok ? "已複製資料夾路徑" : "請手動複製這個路徑";
  const p = document.createElement("div");
  p.className = "toast-path";
  p.textContent = path;
  t.append(head, p);
  t.classList.add("toast-rich");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; t.classList.remove("toast-rich"); }, 4000);
  return ok;
}

/* Toast with an inline action button (e.g. 「已刪除 — 復原」). Stays up
   longer than a plain toast so there's time to react. */

function toastUndo(msg, label, fn) {
  const t = $("#toast");
  t.classList.remove("toast-rich");
  t.textContent = "";
  const span = document.createElement("span");
  span.textContent = msg;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-act";
  btn.textContent = label;
  btn.addEventListener("click", () => {
    t.hidden = true;
    clearTimeout(toastTimer);
    fn();
  });
  t.append(span, btn);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}


/* ===== utils ===== */

function slugify(s) {
  return s.toLowerCase().trim()
    .replace(/[^\w一-龥-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "tool-" + Date.now();
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function escapeAttr(s) { return escapeHTML(s); }

export { $, $$, copyFolderPath, copyText, cssEscape, escapeAttr, escapeHTML, escapeRegex, fileExt, fileUrl, folderPath, formatBytes, linkFolder, formatDate, imagesFromClipboard, initial, isImageFile, isThisWeek, loadJSON, queryTokens, saveJSON, shareFromHttp, slugify, toast, toastUndo, uniq };
