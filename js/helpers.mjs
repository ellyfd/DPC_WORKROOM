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
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

/* Toast with an inline action button (e.g. 「已刪除 — 復原」). Stays up
   longer than a plain toast so there's time to react. */

function toastUndo(msg, label, fn) {
  const t = $("#toast");
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

export { $, $$, cssEscape, escapeAttr, escapeHTML, escapeRegex, fileExt, fileUrl, formatBytes, formatDate, imagesFromClipboard, initial, isImageFile, isThisWeek, loadJSON, queryTokens, saveJSON, slugify, toast, toastUndo, uniq };
