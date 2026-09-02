// DPC Hub — 資料層:工具/分類/製作人/品牌的維護與遷移
import { isHtmlFile } from "./files.mjs?v=20260804e";
import { escapeAttr, escapeHTML, slugify, uniq } from "./helpers.mjs?v=20260804e";
import { syncCustomSelectLabel } from "./popovers.mjs?v=20260804e";
import { NUM_COLORS, clearTombstone, state } from "./state.mjs?v=20260804e";
import { saveBrands, saveCats, saveCreators, saveTools } from "./sync.mjs?v=20260804e";

/* ===== data helpers ===== */

function allTools() {
  const localIds = new Set(state.localTools.map((t) => t.id));
  const seed = state.seedTools.filter((t) => !localIds.has(t.id));
  return [...seed, ...state.localTools];
}

function ensureCategoriesFromTools() {
  const used = uniq(allTools().map((t) => t.category).filter(Boolean));
  let changed = false;
  for (const name of used) {
    if (!state.categories.find((c) => c.name === name)) {
      state.categories.push({
        name,
        color: state.categories.length % NUM_COLORS,
        updated: new Date().toISOString(),
      });
      clearTombstone("categories", name);
      changed = true;
    }
  }
  if (changed) saveCats();
}


/* ===== schema migration =====
   Old: type ∈ {"url", "iframe", "python"}; python tools used `file` (singular);
   link tools carried an `asIframe` boolean.
   New: type ∈ {"link", "file"}; files[] array for file tools; all link
   tools open in a new tab (no embedded iframe view).
*/

function migrateToolsSchema() {
  let changed = false;
  for (const t of state.localTools) {
    if (t.type === "url" || t.type === "iframe") {
      t.type = "link";
      changed = true;
    } else if (t.type === "python") {
      t.type = "file";
      changed = true;
    }
    if ("asIframe" in t) { delete t.asIframe; changed = true; }
    if (t.type === "file" || t.type === "page") {
      if (!Array.isArray(t.files)) {
        t.files = [];
        delete t.file;
        changed = true;
      }
    }
    // Reclassify legacy file-type HTML tools as the new "page" type.
    if (t.type === "file" && Array.isArray(t.files) && t.files.length && isHtmlFile(t.files[0])) {
      t.type = "page";
      changed = true;
    }
    // Pages keep only the latest file — drop any historical versions.
    if (t.type === "page" && Array.isArray(t.files) && t.files.length > 1) {
      t.files = t.files.slice(0, 1);
      changed = true;
    }
  }
  if (changed) saveTools();
}


/* ===== URL-hash data import ===== */

async function maybeImportFromHash() {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#data=")) return;
  const encoded = hash.slice("#data=".length);
  if (!encoded) return;
  try {
    const json = decodeURIComponent(escape(atob(encoded)));
    const data = JSON.parse(json);
    if (!data || data.app !== "dpcHub") return;
    const counts = [
      Array.isArray(data.tools) ? `${data.tools.length} 個工具` : null,
      Array.isArray(data.categories) ? `${data.categories.length} 個分類` : null,
      Array.isArray(data.creators) ? `${data.creators.length} 位製作人` : null,
      Array.isArray(data.brands) ? `${data.brands.length} 個品牌` : null,
    ].filter(Boolean).join("、");
    const ok = confirm(`從網址讀到一份分享資料(${counts})。要匯入嗎?\n(只會新增缺少的項目,不會刪除現有資料)`);
    if (ok) {
      // Additive merge — never replace/remove what's already on the server.
      // A wholesale replace here would delete every tool missing from the
      // legacy blob (with no tombstones, and their uploaded files with them).
      if (Array.isArray(data.tools)) {
        for (const t of data.tools) {
          if (t && t.id && !state.localTools.some((x) => x.id === t.id)) {
            state.localTools.push(t);
          }
        }
      }
      if (Array.isArray(data.categories)) {
        for (const c of data.categories) {
          if (c && c.name && !state.categories.some((x) => x.name === c.name)) {
            state.categories.push({ ...c, updated: new Date().toISOString() });
          }
        }
      }
      if (Array.isArray(data.creators)) {
        for (const n of data.creators) {
          if (n && !state.creators.includes(n)) state.creators.push(n);
        }
      }
      if (Array.isArray(data.brands)) {
        for (const n of data.brands) {
          if (n && !state.brands.includes(n)) state.brands.push(n);
        }
      }
      migrateToolsSchema();
      saveTools();
      saveCats();
      saveCreators();
      saveBrands();
    }
    history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch (err) {
    console.warn("Hash import failed:", err);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}


function ensureBrandsFromTools() {
  const used = uniq(allTools().map((t) => t.brand).filter(Boolean));
  let changed = false;
  for (const name of used) {
    if (!state.brands.includes(name)) {
      state.brands.push(name);
      clearTombstone("brands", name);
      changed = true;
    }
  }
  if (changed) saveBrands();
}


function ensureBrand(name) {
  if (!name) return;
  if (!state.brands.includes(name)) {
    state.brands.push(name);
    clearTombstone("brands", name);
    saveBrands();
  }
}


function listAllBrands() {
  const fromTools = uniq(allTools().map((t) => t.brand).filter(Boolean));
  return uniq([...state.brands, ...fromTools])
    .sort((a, b) => a.localeCompare(b, "zh-Hant"));
}


function renderBrandSelect(keepValue) {
  const sel = document.getElementById("brand-select");
  if (!sel) return;
  const all = listAllBrands();
  const want = keepValue != null ? keepValue : sel.value;
  sel.innerHTML = `
    <option value="">— 沒有指定 —</option>
    ${all.map((b) => `<option value="${escapeAttr(b)}">${escapeHTML(b)}</option>`).join("")}
    <option value="__new__">＋ 新增品牌…</option>
  `;
  if (want && all.includes(want)) sel.value = want;
  else sel.value = "";
  syncCustomSelectLabel?.("brand");
}


function ensureCreatorsFromTools() {
  const used = uniq(allTools().map((t) => t.creator).filter(Boolean));
  let changed = false;
  for (const name of used) {
    if (!state.creators.includes(name)) {
      state.creators.push(name);
      clearTombstone("creators", name);
      changed = true;
    }
  }
  if (changed) saveCreators();
}


function ensureCreator(name) {
  if (!name) return;
  if (!state.creators.includes(name)) {
    state.creators.push(name);
    clearTombstone("creators", name);
    saveCreators();
  }
}


function listAllCreators() {
  const fromTools = uniq(allTools().map((t) => t.creator).filter(Boolean));
  return uniq([...state.creators, ...fromTools])
    .sort((a, b) => a.localeCompare(b, "zh-Hant"));
}


function renderCreatorSelect(keepValue) {
  const sel = document.getElementById("creator-select");
  if (!sel) return;
  const all = listAllCreators();
  const want = keepValue != null ? keepValue : sel.value;
  sel.innerHTML = `
    <option value="" disabled${want ? "" : " selected"}>— 選擇製作人 —</option>
    ${all.map((c) => `<option value="${escapeAttr(c)}">${escapeHTML(c)}</option>`).join("")}
    <option value="__new__">＋ 新增製作人…</option>
  `;
  if (want && all.includes(want)) sel.value = want;
  else sel.value = "";
  syncCustomSelectLabel?.("creator");
}


function ensureCategory(name, color) {
  if (!name) return;
  const existing = state.categories.find((c) => c.name === name);
  if (existing) {
    if (typeof color === "number") {
      existing.color = color;
      existing.updated = new Date().toISOString();
      saveCats();
    }
    return existing;
  }
  const next = {
    name,
    color: typeof color === "number" ? color : state.categories.length % NUM_COLORS,
    updated: new Date().toISOString(),
  };
  state.categories.push(next);
  clearTombstone("categories", name);
  saveCats();
  return next;
}


function groupedTools() {
  const tools = allTools();
  const result = state.categories.map((c) => ({
    name: c.name,
    color: c.color,
    tools: sortToolsByOrder(tools.filter((t) => t.category === c.name)),
    system: false,
  }));
  const uncat = tools.filter((t) => !t.category || !state.categories.find((c) => c.name === t.category));
  if (uncat.length) {
    result.push({ name: "未分類", color: NUM_COLORS, tools: sortToolsByOrder(uncat), system: true });
  }
  return result;
}


function sortToolsByOrder(arr) {
  return arr.slice().sort((a, b) => {
    const ai = (typeof a.sortIndex === "number") ? a.sortIndex : Number.MAX_SAFE_INTEGER;
    const bi = (typeof b.sortIndex === "number") ? b.sortIndex : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}


function uniqueSlug(name) {
  const base = slugify(name);
  const taken = new Set(allTools().map((t) => t.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export { allTools, ensureBrand, ensureBrandsFromTools, ensureCategoriesFromTools, ensureCategory, ensureCreator, ensureCreatorsFromTools, groupedTools, listAllBrands, listAllCreators, maybeImportFromHash, migrateToolsSchema, renderBrandSelect, renderCreatorSelect, sortToolsByOrder, uniqueSlug };
