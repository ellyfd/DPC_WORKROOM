const LS_DRAFT_KEY = "dpcHub.draft.v1";
const LS_COLLAPSE_KEY = "dpcHub.collapsed.v1";
const LS_ME_KEY = "dpcHub.me.v1";
const LS_NEW_SEEN_KEY = "dpcHub.newSeen.v1";
const NUM_COLORS = 7;
const MAX_FILE_BYTES = 25 * 1024 * 1024;  // 25 MB per upload (R2 backed)
const MAX_VERSIONS = 5;                    // keep at most this many file versions per tool

const state = {
  seedTools: [],
  localTools: [],
  categories: [],
  creators: [],
  brands: [],
  filter: "all",
  brandFilter: "",
  query: "",
  editingId: null,
  editingCat: null,
  prefillCategory: null,
  anchorEl: null,
  collapsed: {},
  // versions list for the file-type tool currently open in the popover
  editingFiles: [],
  // persistent "current user" name (tagged on each file upload)
  me: "",
  // id of the tool currently being dragged between categories
  draggingToolId: null,
  // name of the category currently being dragged for reordering
  draggingCategoryName: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const CANONICAL_HOST = "dpcwork.ellyfd.workers.dev";

document.addEventListener("DOMContentLoaded", init);

async function init() {
  // Anything that isn't the canonical Worker host (or local dev) gets
  // redirected. If the visitor still has legacy localStorage data from
  // the old GitHub Pages deployment, we pack it into the URL hash so
  // the destination site can offer to import it.
  const host = location.hostname;
  if (
    host !== CANONICAL_HOST &&
    host !== "localhost" &&
    !host.startsWith("127.")
  ) {
    return redirectToCanonical();
  }

  state.seedTools = [];
  state.collapsed = loadJSON(LS_COLLAPSE_KEY, {});
  state.me = (localStorage.getItem(LS_ME_KEY) || "").trim();

  await loadRemoteState();

  // First-time seed: if the server is empty, pull the static tools.json
  // (if present) and push it up as the initial state.
  if (
    state.localTools.length === 0 &&
    state.categories.length === 0 &&
    state.creators.length === 0 &&
    state.brands.length === 0
  ) {
    try {
      const res = await fetch("tools.json", { cache: "no-cache" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.tools) && data.tools.length) {
          state.localTools = data.tools;
          migrateToolsSchema();
          ensureCategoriesFromTools();
          ensureCreatorsFromTools();
          ensureBrandsFromTools();
          await syncStateNow();
        }
      }
    } catch {}
  }
  migrateToolsSchema();
  ensureCategoriesFromTools();
  ensureCreatorsFromTools();
  ensureBrandsFromTools();

  // If the URL has #data=..., offer to import before rendering.
  await maybeImportFromHash();

  render();

  // After the board is up, surface a dismissable "本週上新" notice (once per batch).
  maybeShowNewArrivalsNotice();

  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    renderSections();
  });
  $("#brand-filter")?.addEventListener("change", (e) => {
    state.brandFilter = e.target.value || "";
    renderSections();
  });
  $("#open-add").addEventListener("click", (e) => openToolPopover(null, e.currentTarget));
  $("#open-add-cat").addEventListener("click", (e) => openCatPopover(null, e.currentTarget));
  $("#empty-cta").addEventListener("click", (e) => openToolPopover(null, e.currentTarget));
  $("#expand-all")?.addEventListener("click", () => setAllCollapsed(false));
  $("#collapse-all")?.addEventListener("click", () => setAllCollapsed(true));

  initToolPopover();
  initCatPopover();
  initMiniPopover();
  initCreatorPicker();
  initCategoryPicker();
  initBrandPicker();
  initIconPicker();
  initTypeSelector();
  initFileUpload();
  initTileFileMenu();
  initTileContextMenu();
  initTileTooltip();
  initFilePopover();
  initShortcuts();
}

function initShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.key === "/") {
      e.preventDefault();
      document.getElementById("search")?.focus();
    } else if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      openToolPopover(null, document.getElementById("open-add"));
    }
  });
}

function setAllCollapsed(collapsed) {
  state.collapsed = {};
  if (collapsed) {
    for (const g of groupedTools()) state.collapsed[g.name] = true;
  }
  saveJSON(LS_COLLAPSE_KEY, state.collapsed);
  renderSections();
}

/* ===== legacy redirect (old GitHub Pages → Worker) =====
   The old deployment kept everything in localStorage. We pull whatever
   we find under the legacy keys, pack it into a URL hash and forward
   the visitor to the canonical Worker URL — where the existing
   maybeImportFromHash() flow asks them to confirm the import. */
function redirectToCanonical() {
  let hash = "";
  try {
    const tools = JSON.parse(localStorage.getItem("dpcHub.tools.v1") || "null");
    const cats = JSON.parse(localStorage.getItem("dpcHub.categories.v1") || "null");
    const creators = JSON.parse(localStorage.getItem("dpcHub.creators.v1") || "null");
    const brands = JSON.parse(localStorage.getItem("dpcHub.brands.v1") || "null");
    const hasAny =
      (Array.isArray(tools) && tools.length) ||
      (Array.isArray(cats) && cats.length) ||
      (Array.isArray(creators) && creators.length) ||
      (Array.isArray(brands) && brands.length);
    if (hasAny) {
      const slimTools = (Array.isArray(tools) ? tools : []).map((t) => {
        if (t && t.type === "file" && Array.isArray(t.files)) {
          // Strip file content; URL hashes have practical length limits and
          // file bytes now belong in R2 anyway.
          return {
            ...t,
            files: t.files.map((f) => ({
              name: f.name, size: f.size,
              uploadedAt: f.uploadedAt, uploadedBy: f.uploadedBy,
            })),
          };
        }
        return t;
      });
      const data = {
        app: "dpcHub",
        v: 2,
        tools: slimTools,
        categories: Array.isArray(cats) ? cats : [],
        creators: Array.isArray(creators) ? creators : [],
        brands: Array.isArray(brands) ? brands : [],
      };
      const json = JSON.stringify(data);
      hash = "#data=" + btoa(unescape(encodeURIComponent(json)));
    }
  } catch {}
  location.replace("https://" + CANONICAL_HOST + "/" + hash);
}

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

async function loadRemoteState() {
  try {
    const res = await fetch("/api/state", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.localTools = Array.isArray(data.tools) ? data.tools : [];
    state.categories = Array.isArray(data.categories) ? data.categories : [];
    state.creators = Array.isArray(data.creators) ? data.creators : [];
    state.brands = Array.isArray(data.brands) ? data.brands : [];
  } catch (e) {
    toast?.("無法載入伺服器資料,先用空白起頭");
    state.localTools = [];
    state.categories = [];
    state.creators = [];
    state.brands = [];
  }
}

let _syncTimer = null;
let _syncing = false;
let _syncPending = false;

function scheduleSync() {
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(syncStateNow, 250);
}

async function syncStateNow() {
  if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
  if (_syncing) { _syncPending = true; return; }
  _syncing = true;
  try {
    const res = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tools: state.localTools,
        categories: state.categories,
        creators: state.creators,
        brands: state.brands,
      }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
  } catch (e) {
    toast?.("同步到伺服器失敗,稍後再試");
  } finally {
    _syncing = false;
    if (_syncPending) {
      _syncPending = false;
      scheduleSync();
    }
  }
}

const saveTools = scheduleSync;
const saveCats = scheduleSync;
const saveCreators = scheduleSync;
const saveBrands = scheduleSync;

/* ===== data helpers ===== */
function allTools() {
  const localIds = new Set(state.localTools.map((t) => t.id));
  const seed = state.seedTools.filter((t) => !localIds.has(t.id));
  return [...seed, ...state.localTools];
}
function uniq(arr) { return Array.from(new Set(arr)); }

function ensureCategoriesFromTools() {
  const used = uniq(allTools().map((t) => t.category).filter(Boolean));
  let changed = false;
  for (const name of used) {
    if (!state.categories.find((c) => c.name === name)) {
      state.categories.push({ name, color: state.categories.length % NUM_COLORS });
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
    const ok = confirm(`從網址讀到一份分享資料(${counts})。要匯入嗎?\n(會覆蓋目前裝置上的資料)`);
    if (ok) {
      if (Array.isArray(data.tools)) state.localTools = data.tools;
      if (Array.isArray(data.categories)) state.categories = data.categories;
      if (Array.isArray(data.creators)) state.creators = data.creators;
      if (Array.isArray(data.brands)) state.brands = data.brands;
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
      changed = true;
    }
  }
  if (changed) saveBrands();
}

function ensureBrand(name) {
  if (!name) return;
  if (!state.brands.includes(name)) {
    state.brands.push(name);
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
      changed = true;
    }
  }
  if (changed) saveCreators();
}

function ensureCreator(name) {
  if (!name) return;
  if (!state.creators.includes(name)) {
    state.creators.push(name);
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
    if (typeof color === "number") { existing.color = color; saveCats(); }
    return existing;
  }
  const next = { name, color: typeof color === "number" ? color : state.categories.length % NUM_COLORS };
  state.categories.push(next);
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

/* ===== 本週上新 (new this week) ===== */
const NEW_WINDOW_DAYS = 7;
const NEW_WINDOW_MS = NEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// The timestamp we treat as "when this tool first appeared". New tools get an
// explicit createdAt; older records (saved before that field existed) fall
// back to `updated` so the 本週上新 board still works for them.
function toolBirthTime(t) {
  const iso = (t && (t.createdAt || t.updated)) || "";
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? 0 : ms;
}

function isNewTool(t) {
  const born = toolBirthTime(t);
  if (!born) return false;
  const now = Date.now();
  return born <= now && (now - born) <= NEW_WINDOW_MS;
}

function newToolsThisWeek() {
  return allTools()
    .filter(isNewTool)
    .sort((a, b) => toolBirthTime(b) - toolBirthTime(a));
}

// A short signature of the current "new this week" set, so we only auto-show
// the notice once per distinct batch. When a newer tool arrives the signature
// changes and the notice pops again on next load.
function newToolsSignature(tools) {
  return tools.map((t) => t.id).sort().join("|");
}

// 本週上新通知 — a dismissable popover shown once on load. Pure text: groups
// the week's new tools by category, no icons or logos. Clicking a tool name
// opens it; there's a "don't show again for this batch" affordance.
function maybeShowNewArrivalsNotice() {
  const fresh = newToolsThisWeek();
  if (!fresh.length) return;
  const sig = newToolsSignature(fresh);
  if (loadJSON(LS_NEW_SEEN_KEY, "") === sig) return;  // already dismissed this batch
  renderNewArrivalsNotice(fresh, sig);
}

function renderNewArrivalsNotice(tools, sig) {
  const pop = document.getElementById("new-popover");
  if (!pop) return;

  // Group by category, preserving the category order already on screen.
  const order = state.categories.map((c) => c.name);
  const byCat = new Map();
  for (const t of tools) {
    const cat = t.category || "未分類";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(t);
  }
  const cats = [...byCat.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });

  const groupsHTML = cats.map((cat) => {
    const catObj = state.categories.find((c) => c.name === cat);
    const cv = catObj ? catObj.color : NUM_COLORS;
    const items = byCat.get(cat).map((t) => {
      const who = t.creator
        ? `<span class="new-item-who"><span class="new-item-ava">${escapeHTML(initial(t.creator))}</span>${escapeHTML(t.creator)}</span>`
        : "";
      const note = t.description
        ? `<span class="new-item-note">${escapeHTML(t.description)}</span>`
        : "";
      const meta = (who || note)
        ? `<span class="new-item-meta">${who}${note}</span>`
        : "";
      return `<button type="button" class="new-item" data-open-new="${escapeAttr(t.id)}">
          <span class="new-item-row">
            <span class="new-item-name">${escapeHTML(t.name)}</span>
            <svg class="new-item-go" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </span>
          ${meta}
        </button>`;
    }).join("");
    return `
      <div class="new-group" data-cv="${cv}">
        <div class="new-group-head">
          <span class="new-group-dot"></span>
          <span class="new-group-name">${escapeHTML(cat)}</span>
          <span class="new-group-count">${byCat.get(cat).length}</span>
        </div>
        <div class="new-group-items">${items}</div>
      </div>`;
  }).join("");

  pop.querySelector("#new-popover-count").textContent = tools.length;
  pop.querySelector("#new-popover-body").innerHTML = groupsHTML;
  pop.hidden = false;

  const close = () => { pop.hidden = true; };
  const dismiss = () => { saveJSON(LS_NEW_SEEN_KEY, sig); close(); };

  pop.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", close, { once: true })
  );
  pop.querySelector("#new-popover-dismiss").addEventListener("click", dismiss, { once: true });
  pop.querySelectorAll("[data-open-new]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const t = allTools().find((x) => x.id === btn.dataset.openNew);
      close();
      if (t) openTool(t, btn);
    })
  );
}

function matchesQuery(t) {
  if (!state.query) return true;
  const hay = [t.name, t.creator, t.description, t.category, t.brand]
    .join(" ").toLowerCase();
  return hay.includes(state.query);
}

/* ===== render ===== */
function render() {
  renderFilters();
  renderSections();
  renderStats();
  renderHeadContext();
}

function renderHeadContext() {
  const el = document.getElementById("head-context");
  if (!el) return;
  el.textContent = state.filter === "all" ? "所有工具" : state.filter;
}

function renderStats() {
  const list = allTools();
  $("#stat-total").textContent = list.length;
  $("#stat-creators").textContent = uniq(list.map((t) => t.creator)).length;
  $("#stat-categories").textContent = state.categories.length;

  // datalist is no longer used (category is a select); keep this guarded
  const catList = document.getElementById("cat-list");
  if (catList) catList.innerHTML = state.categories
    .map((c) => `<option value="${escapeAttr(c.name)}"></option>`).join("");
}

function renderFilters() {
  const bar = $("#filters");
  bar.innerHTML = "";

  const tools = allTools();
  if (!state.categories.length && !tools.length) return;

  const countOf = (name) =>
    name === "all" ? tools.length : tools.filter((t) => t.category === name).length;

  bar.appendChild(makeTab("全部", "all", null, countOf("all"), false));
  state.categories.forEach((c) =>
    bar.appendChild(makeTab(c.name, c.name, c.color, countOf(c.name), true))
  );

  const addBtn = document.createElement("button");
  addBtn.className = "tab-add";
  addBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>
    新增分類
  `;
  addBtn.addEventListener("click", (e) => openCatPopover(null, e.currentTarget));
  bar.appendChild(addBtn);

  function makeTab(label, key, cv, count, editable) {
    const el = document.createElement("button");
    const isActive = state.filter === key;
    el.className = "tab" + (isActive ? " active" : "");
    if (typeof cv === "number") el.dataset.cv = String(cv);
    const dot = typeof cv === "number" ? `<span class="tab-dot"></span>` : "";
    const editIcon = isActive && editable ? `
      <span class="tab-edit" data-edit-cat-tab="${escapeAttr(key)}" title="編輯分類">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
      </span>` : "";
    el.innerHTML = `${dot}<span class="tab-name">${escapeHTML(label)}</span><span class="tab-count">${count}</span>${editIcon}`;
    el.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-edit-cat-tab]")) {
        ev.stopPropagation();
        openCatPopover(key, ev.target.closest("[data-edit-cat-tab]"));
        return;
      }
      state.filter = key;
      renderFilters();
      renderSections();
    });
    return el;
  }
}

const TYPE_META = {
  link:   { label: "LINK",  icon: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>` },
  page:   { label: "PAGE",  icon: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c2.5 3 2.5 13 0 16M12 4c-2.5 3-2.5 13 0 16"/></svg>` },
  file:   { label: "FILE",  icon: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>` },
  // legacy fallbacks
  url:    { label: "URL",   icon: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>` },
  python: { label: "PY",    icon: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>` },
  iframe: { label: "EMBED", icon: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c2.5 3 2.5 13 0 16M12 4c-2.5 3-2.5 13 0 16"/></svg>` },
};

function normalizeType(t) {
  if (t === "page" || t === "file" || t === "link") return t;
  if (t === "url" || t === "iframe") return "link";
  if (t === "python") return "file";
  return "link";
}

function renderBrandFilter() {
  const sel = document.getElementById("brand-filter");
  if (!sel) return;
  const brands = listAllBrands();
  const want = state.brandFilter || "";
  sel.innerHTML = `
    <option value="">所有客人</option>
    ${brands.map((b) => `<option value="${escapeAttr(b)}">${escapeHTML(b)}</option>`).join("")}
  `;
  sel.value = brands.includes(want) ? want : "";
  if (sel.value !== want) state.brandFilter = sel.value;
}

function renderSections() {
  const area = $("#sections-area");
  const empty = $("#empty");

  renderBrandFilter();

  if (!allTools().length && !state.categories.length) {
    area.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  let groups = groupedTools();
  if (state.filter !== "all") {
    groups = groups.filter((g) => g.name === state.filter);
  }
  if (state.brandFilter) {
    groups = groups
      .map((g) => ({ ...g, tools: g.tools.filter((t) => t.brand === state.brandFilter) }))
      .filter((g) => g.tools.length);
  }
  if (state.query) {
    groups = groups
      .map((g) => ({ ...g, tools: g.tools.filter(matchesQuery) }))
      .filter((g) => g.tools.length);
  }

  if (!groups.length) {
    area.innerHTML = `<div class="section"><div class="section-body"><div class="section-grid"><div class="section-empty">沒有符合條件的工具</div></div></div></div>`;
    return;
  }

  area.innerHTML = groups.map((g) => sectionHTML(g, true)).join("");
  wireSections();
}

function sectionHTML(g, showHeader = true) {
  const cv = g.color;
  const isSystem = g.system;
  const cards = g.tools.map((t) => cardHTML(t, cv)).join("");

  const header = !showHeader ? "" : `
    <div class="section-head">
      <div class="section-title-row">
        <span class="section-color-dot"></span>
        <span class="section-title">${escapeHTML(g.name)}</span>
        <span class="section-count">${g.tools.length}</span>
      </div>
      ${isSystem ? "" : `
        <div class="section-actions">
          <button class="section-action" title="編輯分類" data-edit-cat="${escapeAttr(g.name)}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
          </button>
          <button class="section-action danger" title="刪除分類" data-del-cat="${escapeAttr(g.name)}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      `}
    </div>
  `;

  const grid = `<div class="section-grid">${cards}</div>`;

  return `
    <section class="section" data-cv="${cv}" data-cat="${escapeAttr(g.name)}"${isSystem ? ' data-system="1"' : ''}>
      ${header}
      <div class="section-body">${grid}</div>
    </section>
  `;
}

function cardHTML(t, cv) {
  const tType = t.type || "link";
  const type = TYPE_META[tType] || TYPE_META.link;
  const iconImg = t.icon
    ? `<img src="${escapeAttr(t.icon)}" alt="" draggable="false" onerror="this.remove()" />`
    : "";
  const isPage = isPageTool(t);
  const noteAttr = t.description ? ` data-note="${escapeAttr(t.description)}"` : "";

  const locked = isToolLocked(t);
  const lockSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  const fresh = isNewTool(t);

  return `
    <article class="card${isPage ? " is-page" : ""}${locked ? " is-locked" : ""}${fresh ? " is-new" : ""}" data-cv="${cv}" data-id="${escapeAttr(t.id)}"${noteAttr} draggable="true">
      <button type="button" class="card-tile" data-open="${escapeAttr(t.id)}" aria-label="${escapeAttr(t.name)}">
        <div class="card-top">
          <div class="card-icon">
            <span class="ic-letter">${escapeHTML(initial(t.name))}</span>
            ${iconImg}
            <span class="tile-type-chip tile-type-${tType}" aria-label="${escapeAttr(type.label)}">${type.icon}</span>
          </div>
          ${locked ? `<span class="lock-badge" title="已鎖定 — 只有 ${escapeAttr(t.lockedBy)} 能編輯/刪除">${lockSvg}</span>` : ""}
          ${fresh ? `<span class="new-badge" title="本週上新">NEW</span>` : ""}
        </div>
        <h3 class="card-title">${escapeHTML(t.name)}</h3>
      </button>
    </article>
  `;
}

function isToolLocked(t) {
  return !!(t && t.lockedBy);
}

function canEditTool(t) {
  if (!isToolLocked(t)) return true;
  return t.lockedBy === state.me;
}

function wireSections() {
  // Main tile click = open the tool
  $$("#sections-area [data-open]").forEach((tile) => {
    tile.addEventListener("click", (e) => {
      const id = tile.dataset.open;
      const tool = allTools().find((t) => t.id === id);
      if (tool) openTool(tool, e.currentTarget);
    });
  });
  // Right-click on a tile opens the context menu (edit / copy / download)
  $$("#sections-area .card[data-id]").forEach((card) => {
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openTileContextMenu(card.dataset.id, e.clientX, e.clientY);
    });
  });
  $$("#sections-area [data-edit-cat]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openCatPopover(btn.dataset.editCat, btn);
    });
  });
  $$("#sections-area [data-del-cat]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteCategory(btn.dataset.delCat);
    });
  });
  $$("#sections-area [data-toggle-cat]").forEach((head) => {
    head.addEventListener("click", (e) => {
      if (e.target.closest(".section-action")) return;
      toggleSection(head.dataset.toggleCat);
    });
  });
  wireCardDrag();
}

function wireCardDrag() {
  $$("#sections-area .card[data-id]").forEach((card) => {
    const id = card.dataset.id;
    const tool = allTools().find((t) => t.id === id);
    if (!tool || !canEditTool(tool)) {
      card.removeAttribute("draggable");
      return;
    }
    card.addEventListener("dragstart", (e) => {
      state.draggingToolId = id;
      card.classList.add("dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", id);
      } catch (_) {}
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      state.draggingToolId = null;
      clearAllDragMarks();
    });
  });

  $$("#sections-area .section").forEach((sec) => {
    const isSystem = sec.dataset.system === "1";
    const head = sec.querySelector(".section-head");

    if (head && !isSystem) {
      head.setAttribute("draggable", "true");
      head.addEventListener("dragstart", (e) => {
        if (e.target.closest(".section-action")) {
          e.preventDefault();
          return;
        }
        state.draggingCategoryName = sec.dataset.cat;
        sec.classList.add("section-dragging");
        try {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", "cat:" + sec.dataset.cat);
        } catch (_) {}
      });
      head.addEventListener("dragend", () => {
        state.draggingCategoryName = null;
        clearAllDragMarks();
      });
    }

    sec.addEventListener("dragover", (e) => {
      if (state.draggingToolId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        clearCardDropMarks();
        const targetCard = findCardAtPoint(sec, e.clientX, e.clientY);
        if (targetCard && targetCard.dataset.id !== state.draggingToolId) {
          const rect = targetCard.getBoundingClientRect();
          const before = (e.clientX - rect.left) < rect.width / 2;
          targetCard.classList.toggle("card-drop-before", before);
          targetCard.classList.toggle("card-drop-after", !before);
          sec.classList.remove("drag-over");
        } else {
          sec.classList.add("drag-over");
        }
        return;
      }
      if (state.draggingCategoryName) {
        if (isSystem) return;
        if (sec.dataset.cat === state.draggingCategoryName) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = sec.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        sec.classList.toggle("section-drop-before", before);
        sec.classList.toggle("section-drop-after", !before);
      }
    });
    sec.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && sec.contains(e.relatedTarget)) return;
      sec.classList.remove("drag-over", "section-drop-before", "section-drop-after");
      $$(".card", sec).forEach((c) => c.classList.remove("card-drop-before", "card-drop-after"));
    });
    sec.addEventListener("drop", (e) => {
      if (state.draggingToolId) {
        e.preventDefault();
        const id = state.draggingToolId;
        const targetCard = findCardAtPoint(sec, e.clientX, e.clientY);
        clearAllDragMarks();
        if (targetCard && targetCard.dataset.id !== id) {
          const rect = targetCard.getBoundingClientRect();
          const before = (e.clientX - rect.left) < rect.width / 2;
          reorderToolNear(id, targetCard.dataset.id, before ? "before" : "after");
        } else {
          const targetCat = isSystem ? "" : (sec.dataset.cat || "");
          moveToolToCategory(id, targetCat);
        }
        return;
      }
      if (state.draggingCategoryName && !isSystem) {
        e.preventDefault();
        const draggedName = state.draggingCategoryName;
        const targetName = sec.dataset.cat;
        const rect = sec.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        clearAllDragMarks();
        reorderCategory(draggedName, targetName, before ? "before" : "after");
      }
    });
  });
}

function findCardAtPoint(sec, x, y) {
  const cards = sec.querySelectorAll(".card[data-id]");
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return c;
  }
  return null;
}

function clearCardDropMarks() {
  $$("#sections-area .card.card-drop-before, #sections-area .card.card-drop-after").forEach((c) =>
    c.classList.remove("card-drop-before", "card-drop-after")
  );
}

function clearAllDragMarks() {
  clearCardDropMarks();
  $$("#sections-area .section").forEach((s) =>
    s.classList.remove("drag-over", "section-drop-before", "section-drop-after", "section-dragging")
  );
}


function reorderCategory(draggedName, targetName, position) {
  if (!draggedName || !targetName || draggedName === targetName) return;
  const cats = state.categories.slice();
  const fromIdx = cats.findIndex((c) => c.name === draggedName);
  if (fromIdx < 0) return;
  const [moved] = cats.splice(fromIdx, 1);
  let toIdx = cats.findIndex((c) => c.name === targetName);
  if (toIdx < 0) {
    state.categories.splice(fromIdx, 0, moved);
    return;
  }
  if (position === "after") toIdx += 1;
  cats.splice(toIdx, 0, moved);
  if (sameOrder(state.categories, cats)) return;
  state.categories = cats;
  saveCats();
  render();
  toast("已重新排序");
}

function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].name !== b[i].name) return false;
  return true;
}

function reorderToolNear(draggedId, targetId, position) {
  if (!draggedId || !targetId || draggedId === targetId) return;
  const dragged = allTools().find((t) => t.id === draggedId);
  const target = allTools().find((t) => t.id === targetId);
  if (!dragged || !target) return;
  if (!canEditTool(dragged)) {
    toast(`已鎖定 — 只有「${dragged.lockedBy}」能移動`);
    return;
  }

  const targetCat = target.category || "";
  const catChanged = (dragged.category || "") !== targetCat;

  const list = sortToolsByOrder(
    allTools().filter((t) => (t.category || "") === targetCat && t.id !== draggedId)
  );
  const targetIdx = list.findIndex((t) => t.id === targetId);
  if (targetIdx < 0) return;
  const insertAt = position === "after" ? targetIdx + 1 : targetIdx;
  list.splice(insertAt, 0, dragged);

  list.forEach((t, i) => {
    let local = state.localTools.find((lt) => lt.id === t.id);
    if (!local) {
      local = {
        ...t,
        category: t.id === draggedId ? targetCat : (t.category || ""),
        sortIndex: i,
      };
      if (t.id === draggedId) local.updated = new Date().toISOString();
      state.localTools.push(local);
    } else {
      local.sortIndex = i;
      if (t.id === draggedId) {
        local.category = targetCat;
        local.updated = new Date().toISOString();
      }
    }
  });

  if (targetCat) ensureCategory(targetCat);
  saveTools();
  render();
  toast(catChanged ? (targetCat ? `已移至「${targetCat}」` : "已移出分類") : "已重新排序");
}

function moveToolToCategory(id, newCat) {
  const tool = allTools().find((t) => t.id === id);
  if (!tool) return;
  if (!canEditTool(tool)) {
    toast(`已鎖定 — 只有「${tool.lockedBy}」能移動`);
    return;
  }
  const current = tool.category || "";
  const targetCat = newCat || "";
  const catChanged = current !== targetCat;

  const previousList = sortToolsByOrder(allTools().filter((t) => (t.category || "") === targetCat));
  if (!catChanged && previousList.length && previousList[previousList.length - 1].id === id) return;

  const list = sortToolsByOrder(allTools().filter((t) => (t.category || "") === targetCat && t.id !== id));
  list.push(tool);

  list.forEach((t, i) => {
    let local = state.localTools.find((lt) => lt.id === t.id);
    if (!local) {
      local = {
        ...t,
        category: t.id === id ? targetCat : (t.category || ""),
        sortIndex: i,
      };
      if (t.id === id) local.updated = new Date().toISOString();
      state.localTools.push(local);
    } else {
      local.sortIndex = i;
      if (t.id === id) {
        local.category = targetCat;
        local.updated = new Date().toISOString();
      }
    }
  });

  if (newCat) ensureCategory(newCat);
  saveTools();
  render();
  if (catChanged) toast(newCat ? `已移至「${newCat}」` : "已移出分類");
  else toast("已移到最後");
}

function toggleSection(name) {
  state.collapsed[name] = !state.collapsed[name];
  saveJSON(LS_COLLAPSE_KEY, state.collapsed);
  const sec = document.querySelector(`#sections-area .section[data-cat="${cssEscape(name)}"]`);
  if (sec) sec.classList.toggle("collapsed", !!state.collapsed[name]);
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
}

function initial(name) {
  if (!name) return "?";
  return name.trim().charAt(0).toUpperCase();
}

function openTool(t, anchor) {
  // Page tools open directly (single HTML, no versions).
  if (t.type === "page") {
    if (!Array.isArray(t.files) || !t.files.length) {
      if (confirm(`「${t.name}」還沒上傳 HTML。要現在上傳嗎?`)) {
        openTileFileMenuUploadOnly(t.id, anchor);
      }
      return;
    }
    window.open(pageUrl(t.id), "_blank", "noopener");
    return;
  }
  // File tools: clicking the tile downloads the latest version directly.
  // Upload / history live in the right-click menu.
  if (t.type === "file") {
    const latest = t.files?.[0];
    if (!latest?.key) {
      if (confirm(`「${t.name}」還沒上傳任何檔案。要現在上傳嗎?`)) {
        openTileFileMenuUploadOnly(t.id, anchor);
      }
      return;
    }
    downloadFile(latest);
    toast(`下載 ${latest.name}`);
    return;
  }
  if (!t.url || t.url === "#") {
    if (confirm(`「${t.name}」尚未設定連結或檔案。要現在編輯嗎?`)) {
      openToolPopover(t.id);
    }
    return;
  }
  window.open(t.url, "_blank", "noopener");
}

function copyToolUrl(t) {
  if (!t) return;
  let url = "";
  if (t.type === "link") url = t.url || "";
  else if (t.type === "page") url = new URL(pageUrl(t.id), window.location.href).href;
  if (!url) { toast("沒有可複製的網址"); return; }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(
      () => toast("已複製連結"),
      () => fallbackCopy(url)
    );
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); toast("已複製連結"); }
  catch { toast("複製失敗"); }
  document.body.removeChild(ta);
}

/* ===== mini popover (reusable single-input prompt) ===== */
let miniPopoverHandler = null;

function initMiniPopover() {
  const pop = document.getElementById("mini-popover");
  if (!pop) return;
  pop.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeMiniPopover)
  );
  const input = document.getElementById("mini-popover-input");
  const select = document.getElementById("mini-popover-select");
  const confirm = document.getElementById("mini-popover-confirm");
  confirm.addEventListener("click", () => commitMini());
  const keyHandler = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitMini(); }
    else if (e.key === "Escape") { e.preventDefault(); closeMiniPopover(); }
  };
  input.addEventListener("keydown", keyHandler);
  select?.addEventListener("keydown", keyHandler);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) closeMiniPopover();
  });
}

function openMiniPopover({ title, placeholder = "", defaultValue = "", hint = "", type = "text", options = null, onConfirm }) {
  document.getElementById("mini-popover-title").textContent = title;
  const input = document.getElementById("mini-popover-input");
  const select = document.getElementById("mini-popover-select");
  const hintEl = document.getElementById("mini-popover-hint");
  hintEl.textContent = hint || "";
  hintEl.hidden = !hint;
  if (options) {
    select.innerHTML = options
      .map((o) =>
        typeof o === "string"
          ? `<option value="${escapeAttr(o)}">${escapeHTML(o)}</option>`
          : `<option value="${escapeAttr(o.value)}"${o.disabled ? " disabled" : ""}${o.value === defaultValue ? " selected" : ""}>${escapeHTML(o.label)}</option>`
      )
      .join("");
    if (defaultValue) select.value = defaultValue;
    select.hidden = false;
    input.hidden = true;
  } else {
    input.type = type;
    input.placeholder = placeholder;
    input.value = defaultValue || "";
    input.hidden = false;
    select.hidden = true;
  }
  miniPopoverHandler = onConfirm;
  document.getElementById("mini-popover").hidden = false;
  setTimeout(() => {
    if (options) select.focus();
    else { input.focus(); input.select(); }
  }, 30);
}

function closeMiniPopover() {
  document.getElementById("mini-popover").hidden = true;
  miniPopoverHandler = null;
  document.getElementById("mini-popover-input").value = "";
}

function commitMini() {
  const select = document.getElementById("mini-popover-select");
  const input = document.getElementById("mini-popover-input");
  const val = !select.hidden ? select.value : input.value.trim();
  if (!miniPopoverHandler) { closeMiniPopover(); return; }
  const fn = miniPopoverHandler;
  closeMiniPopover();
  fn(val);
}

/* ===== creator / brand pickers (custom dropdown with per-row rename/delete) ===== */
function initCreatorPicker() {
  initCustomSelect({
    kind: "creator",
    listFn: listAllCreators,
    ensureFn: ensureCreator,
    deleteFn: deleteCreator,
    renameFn: renameCreator,
    rerenderFn: renderCreatorSelect,
    emptyLabel: "— 選擇製作人 —",
    addLabel: "＋ 新增製作人…",
    addTitle: "新增製作人",
    addPlaceholder: "輸入名稱",
    allowEmpty: false,
  });
}

function initBrandPicker() {
  initCustomSelect({
    kind: "brand",
    listFn: listAllBrands,
    ensureFn: ensureBrand,
    deleteFn: deleteBrand,
    renameFn: renameBrand,
    rerenderFn: renderBrandSelect,
    emptyLabel: "— 沒有指定 —",
    addLabel: "＋ 新增品牌…",
    addTitle: "新增品牌 / 客制",
    addPlaceholder: "輸入品牌或客制名稱",
    allowEmpty: true,
  });
}

const _customSelects = {};

function initCustomSelect(opts) {
  const selectEl = document.getElementById(`${opts.kind}-select`);
  const wrapper = document.querySelector(`[data-custom-select="${opts.kind}"]`);
  if (!selectEl || !wrapper) return;

  let custom = wrapper.querySelector(".custom-select");
  if (!custom) {
    custom = document.createElement("div");
    custom.className = "custom-select";
    custom.innerHTML = `
      <button type="button" class="custom-select-trigger">
        <span class="custom-select-label is-placeholder">${escapeHTML(opts.emptyLabel)}</span>
        <svg class="custom-select-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="custom-select-menu" hidden></div>
    `;
    wrapper.appendChild(custom);
  }

  const trigger = custom.querySelector(".custom-select-trigger");
  const label = custom.querySelector(".custom-select-label");
  const menu = custom.querySelector(".custom-select-menu");

  function syncLabel() {
    const v = selectEl.value;
    if (v) {
      label.textContent = v;
      label.classList.remove("is-placeholder");
    } else {
      label.textContent = opts.emptyLabel;
      label.classList.add("is-placeholder");
    }
  }

  function renderMenu() {
    const items = opts.listFn();
    const v = selectEl.value;
    const checkSvg = `<svg class="custom-select-check" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12l5 5L20 7"/></svg>`;
    const renameSvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    const trashSvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;

    const emptyRow = opts.allowEmpty
      ? `<div class="custom-select-row${!v ? " is-active" : ""}">
          <button type="button" class="custom-select-pick" data-act="pick" data-val="">
            <span class="custom-select-pick-label muted">${escapeHTML(opts.emptyLabel)}</span>
            ${!v ? checkSvg : ""}
          </button>
        </div>`
      : "";

    const itemRows = items.map((name) => `
      <div class="custom-select-row${name === v ? " is-active" : ""}">
        <button type="button" class="custom-select-pick" data-act="pick" data-val="${escapeAttr(name)}">
          <span class="custom-select-pick-label">${escapeHTML(name)}</span>
          ${name === v ? checkSvg : ""}
        </button>
        <div class="custom-select-row-actions">
          <button type="button" class="custom-select-action" data-act="rename" data-val="${escapeAttr(name)}" title="改名" aria-label="改名">${renameSvg}</button>
          <button type="button" class="custom-select-action danger" data-act="delete" data-val="${escapeAttr(name)}" title="刪除" aria-label="刪除">${trashSvg}</button>
        </div>
      </div>
    `).join("");

    menu.innerHTML = `
      ${emptyRow}
      ${itemRows}
      ${items.length ? `<div class="custom-select-sep"></div>` : ""}
      <button type="button" class="custom-select-add" data-act="new">${escapeHTML(opts.addLabel)}</button>
    `;
  }

  function open() {
    renderMenu();
    menu.hidden = false;
    custom.classList.add("is-open");
  }
  function close() {
    menu.hidden = true;
    custom.classList.remove("is-open");
  }
  function toggle() { menu.hidden ? open() : close(); }

  trigger.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggle(); };

  menu.onclick = (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const act = btn.dataset.act;
    const val = btn.dataset.val || "";
    if (act === "pick") {
      selectEl.value = val;
      syncLabel();
      close();
    } else if (act === "new") {
      close();
      openMiniPopover({
        title: opts.addTitle,
        placeholder: opts.addPlaceholder,
        onConfirm: (v) => {
          const name = (v || "").trim();
          if (!name) return;
          opts.ensureFn(name);
          opts.rerenderFn(name);
          syncLabel();
        },
      });
    } else if (act === "rename") {
      close();
      openMiniPopover({
        title: `改名:${val}`,
        placeholder: "輸入新名稱",
        defaultValue: val,
        onConfirm: (v) => {
          const next = (v || "").trim();
          if (!next || next === val) return;
          opts.renameFn(val, next);
        },
      });
    } else if (act === "delete") {
      close();
      opts.deleteFn(val);
    }
  };

  if (!_customSelects[opts.kind]) {
    document.addEventListener("click", (e) => {
      const c = _customSelects[opts.kind]?.custom;
      if (!c || c.classList.contains("is-open") === false) return;
      if (e.target.closest(`[data-custom-select="${opts.kind}"]`)) return;
      _customSelects[opts.kind].close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && _customSelects[opts.kind]?.custom.classList.contains("is-open")) {
        _customSelects[opts.kind].close();
      }
    });
  }

  _customSelects[opts.kind] = { custom, open, close, syncLabel, renderMenu };
  syncLabel();
}

function syncCustomSelectLabel(kind) {
  _customSelects[kind]?.syncLabel();
}

function renameCreator(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const all = listAllCreators();
  if (all.includes(newName)) {
    toast(`「${newName}」已存在`);
    return;
  }
  state.creators = state.creators.map((c) => c === oldName ? newName : c);
  state.localTools = state.localTools.map((t) => {
    const next = { ...t };
    if (t.creator === oldName) next.creator = newName;
    if (Array.isArray(t.files)) {
      next.files = t.files.map((f) =>
        f.uploadedBy === oldName ? { ...f, uploadedBy: newName } : f
      );
    }
    return next;
  });
  if (state.me === oldName) {
    state.me = newName;
    localStorage.setItem(LS_ME_KEY, newName);
  }
  saveCreators();
  saveTools();
  renderCreatorSelect(newName);
  syncCustomSelectLabel("creator");
  render();
  toast(`已改名為「${newName}」`);
}

function renameBrand(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const all = listAllBrands();
  if (all.includes(newName)) {
    toast(`「${newName}」已存在`);
    return;
  }
  state.brands = state.brands.map((b) => b === oldName ? newName : b);
  state.localTools = state.localTools.map((t) =>
    t.brand === oldName ? { ...t, brand: newName } : t
  );
  saveBrands();
  saveTools();
  renderBrandSelect(newName);
  syncCustomSelectLabel("brand");
  render();
  toast(`已改名為「${newName}」`);
}

function deleteCreator(name) {
  if (!name) return;
  const using = allTools().filter((t) => t.creator === name);
  const msg = using.length
    ? `「${name}」目前是 ${using.length} 個工具的製作人,刪了之後這些工具會變成「沒製作人」(必填,要重新指定)。確定刪除?`
    : `確定刪除製作人「${name}」?`;
  if (!confirm(msg)) return;
  state.creators = state.creators.filter((c) => c !== name);
  state.localTools = state.localTools.map((t) =>
    t.creator === name ? { ...t, creator: "" } : t
  );
  saveCreators();
  saveTools();
  renderCreatorSelect("");
  syncCustomSelectLabel?.("creator");
  render();
  toast("已刪除製作人");
}

function deleteBrand(name) {
  if (!name) return;
  const using = allTools().filter((t) => t.brand === name);
  const msg = using.length
    ? `「${name}」目前綁在 ${using.length} 個工具上,刪了之後這些工具的品牌會清空。確定刪除?`
    : `確定刪除品牌「${name}」?`;
  if (!confirm(msg)) return;
  state.brands = state.brands.filter((b) => b !== name);
  state.localTools = state.localTools.map((t) =>
    t.brand === name ? { ...t, brand: "" } : t
  );
  saveBrands();
  saveTools();
  renderBrandSelect("");
  syncCustomSelectLabel?.("brand");
  render();
  toast("已刪除品牌");
}

/* ===== type selector ===== */
function initTypeSelector() {
  const sel = document.getElementById("type-selector");
  if (!sel) return;
  sel.addEventListener("click", (e) => {
    const btn = e.target.closest(".type-opt");
    if (!btn) return;
    setType(btn.dataset.type);
  });
}

function setType(type) {
  const f = $("#add-form").elements;
  f.type.value = type;
  document.querySelectorAll("#type-selector .type-opt").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.type === type ? "true" : "false");
  });
  applyTypeMode(type);
}

function applyTypeMode(type) {
  document.querySelectorAll("[data-show-for-type]").forEach((el) => {
    const types = el.dataset.showForType.split(",").map((s) => s.trim());
    el.hidden = !types.includes(type);
  });
  const input = document.getElementById("file-input");
  if (input) input.accept = type === "page" ? ".html,.htm,text/html" : "";
  const title = document.getElementById("file-manager-title");
  const hint = document.getElementById("file-manager-hint");
  if (title) title.textContent = type === "page" ? "HTML 檔" : "版本紀錄";
  if (hint) {
    hint.textContent = type === "page"
      ? "上傳 HTML 即發佈為 /p/<工具> 頁面。再次上傳會覆蓋上一份,單檔上限 25 MB。"
      : "每次上傳自動記錄時間 / 上傳人,最新一筆是目前版本。最多保留 5 個版本,單檔上限 25 MB。";
  }
  if (type === "file") {
    renderBrandSelect(document.getElementById("brand-select")?.value || "");
  }
  if (type === "file" || type === "page") {
    renderFileList();
  }
}

/* ===== file management (versioned uploads) ===== */
function initFileUpload() {
  const input = document.getElementById("file-input");
  const zone = document.getElementById("file-dropzone");
  if (!input || !zone) return;

  input.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (file) await addFileVersion(file);
    e.target.value = "";
  });

  // The whole dropzone (file list area) is one click/drop target — no
  // separate button. Clicks inside a file row's action buttons still work
  // because those buttons stopPropagation/handle their own events.
  zone.addEventListener("click", (e) => {
    if (e.target.closest("[data-action]")) return;
    input.click();
  });
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) await addFileVersion(file);
  });
}

async function addFileVersion(file) {
  if (file.size > MAX_FILE_BYTES) {
    toast(`檔案太大(${formatBytes(file.size)},上限 ${formatBytes(MAX_FILE_BYTES)})`);
    return;
  }
  const currentType = $("#add-form").elements.type.value;
  if (currentType === "page" && !isHtmlFile({ name: file.name })) {
    toast("頁面類型只接受 .html / .htm");
    return;
  }
  const me = await getMe();
  const toolId = $("#add-form").elements.id.value || "new";
  try {
    toast("上傳中…");
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Tool-Id": toolId,
        "X-Filename": encodeURIComponent(file.name),
        "X-Uploaded-By": encodeURIComponent(me || ""),
      },
      body: file,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const meta = await res.json();
    const entry = {
      key: meta.key,
      name: meta.name,
      size: meta.size,
      uploadedAt: meta.uploadedAt,
      uploadedBy: meta.uploadedBy,
    };
    if (currentType === "page") {
      state.editingFiles = [entry];
    } else {
      state.editingFiles.unshift(entry);
      if (state.editingFiles.length > MAX_VERSIONS) {
        state.editingFiles.length = MAX_VERSIONS;
      }
    }
    renderFileList();
    autoFillFromFilename(file.name);
    toast("上傳完成");
  } catch (err) {
    toast("檔案上傳失敗");
    console.error(err);
  }
}

function autoFillFromFilename(filename) {
  const f = $("#add-form").elements;
  if (f.name.value) return;
  const base = filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  if (base) {
    const pretty = base.replace(/\b\w/g, (c) => c.toUpperCase());
    f.name.value = pretty;
    updateIconPreview();
  }
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

function renderFileList() {
  const list = document.getElementById("file-list");
  if (!list) return;
  const currentType = $("#add-form").elements.type.value;
  const isPage = currentType === "page";
  const cta = document.getElementById("file-dropzone-cta-text");
  if (cta) {
    if (isPage) {
      cta.textContent = state.editingFiles.length
        ? "點這裡或拖 HTML 進來覆蓋"
        : "還沒有 HTML — 點這裡或拖檔案進來";
    } else {
      cta.textContent = state.editingFiles.length
        ? "點這裡或拖檔案進來上傳新版本"
        : "還沒有檔案 — 點這裡或拖檔案進來";
    }
  }
  if (!state.editingFiles.length) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = state.editingFiles.map((f, i) => {
    const isLatest = i === 0;
    const canDelete = !isPage && state.editingFiles.length > 1;
    return `
      <div class="file-row${isLatest ? " file-row-latest" : ""}">
        <div class="file-row-icon">${escapeHTML(fileExt(f.name))}</div>
        <div class="file-row-meta">
          <div class="file-row-name">${escapeHTML(f.name)}</div>
          <div class="file-row-info">
            <span>${escapeHTML(formatDate(f.uploadedAt))}</span>
            ${f.uploadedBy ? `<span>·</span><span>${escapeHTML(f.uploadedBy)} 上傳</span>` : ""}
            <span>·</span>
            <span>${escapeHTML(formatBytes(f.size))}</span>
            ${isLatest && !isPage ? `<span class="file-row-latest-badge">目前版本</span>` : ""}
          </div>
        </div>
        <div class="file-row-actions">
          <button type="button" class="file-row-action" data-action="download" data-version="${i}" title="下載">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          </button>
          ${canDelete ? `
            <button type="button" class="file-row-action danger" data-action="delete" data-version="${i}" title="刪除這版">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          ` : ""}
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.version, 10);
      const action = btn.dataset.action;
      if (action === "download") downloadFile(state.editingFiles[idx]);
      else if (action === "delete") {
        if (confirm("刪掉這個版本?(無法復原)")) {
          state.editingFiles.splice(idx, 1);
          renderFileList();
        }
      }
    });
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

function downloadFile(fileObj) {
  if (!fileObj?.key) {
    toast("找不到這版的檔案");
    return;
  }
  const a = document.createElement("a");
  a.href = "/files/" + fileObj.key.split("/").map(encodeURIComponent).join("/");
  a.download = fileObj.name || "download";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function isHtmlFile(f) {
  if (!f) return false;
  const name = (f.name || "").toLowerCase();
  return name.endsWith(".html") || name.endsWith(".htm");
}

function isPageTool(t) {
  if (!t) return false;
  if (t.type === "page") return true;
  // Legacy: file-type tool whose latest is HTML (auto-migrated to "page" on load).
  return t.type === "file" && Array.isArray(t.files) && isHtmlFile(t.files[0]);
}

function isFileLikeTool(t) {
  return t?.type === "file" || t?.type === "page";
}

function pageUrl(toolId, versionIdx = 0) {
  const base = `/p/${encodeURIComponent(toolId)}`;
  return versionIdx > 0 ? `${base}?v=${versionIdx}` : base;
}


/* ===== tile file menu (click a file tile → download or upload new) ===== */
let _fileMenuTargetId = null;

function initTileFileMenu() {
  const menu = document.getElementById("tile-file-menu");
  const input = document.getElementById("tile-file-upload");
  if (!menu || !input) return;

  menu.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = _fileMenuTargetId;
      if (!id) return;
      const action = btn.dataset.action;
      if (action === "download") {
        const tool = allTools().find((t) => t.id === id);
        const latest = tool?.files?.[0];
        if (latest?.key) {
          downloadFile(latest);
          toast(`下載 ${latest.name}`);
        } else {
          toast("找不到這版的檔案");
        }
        closeTileFileMenu();
      } else if (action === "upload") {
        input.click();
      } else if (action === "page") {
        const toolId = id;
        closeTileFileMenu();
        window.open(pageUrl(toolId), "_blank", "noopener");
      } else if (action === "history") {
        const toolId = id;
        closeTileFileMenu();
        openHistoryPopover(toolId);
      }
    });
  });

  input.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    const id = _fileMenuTargetId;
    e.target.value = "";
    closeTileFileMenu();
    if (!f || !id) return;
    await addVersionToTool(id, f);
  });

  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    if (e.target.closest("#tile-file-menu")) return;
    if (e.target.closest("[data-open]")) return;
    closeTileFileMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) closeTileFileMenu();
  });
  window.addEventListener("scroll", closeTileFileMenu, true);
  window.addEventListener("resize", closeTileFileMenu);
}

function openTileFileMenu(toolId, anchor) {
  const menu = document.getElementById("tile-file-menu");
  if (!menu || !anchor) return;
  const tool = allTools().find((t) => t.id === toolId);
  const latest = tool?.files?.[0];
  const isPage = isPageTool(tool);
  const dlLabel = document.getElementById("tile-file-menu-download");
  if (dlLabel) {
    if (!latest) dlLabel.textContent = "下載最新版";
    else if (isPage) dlLabel.textContent = `下載原始檔 (${latest.name})`;
    else dlLabel.textContent = `下載 ${latest.name}`;
  }
  const pageItem = document.getElementById("tile-file-menu-page");
  if (pageItem) pageItem.hidden = !isPage;
  _fileMenuTargetId = toolId;
  menu.hidden = false;
  positionFloatingMenu(menu, anchor);
}

function openTileFileMenuUploadOnly(toolId, anchor) {
  const input = document.getElementById("tile-file-upload");
  if (!input) return;
  _fileMenuTargetId = toolId;
  // Direct file picker — no menu needed when there's nothing to download.
  const handler = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    input.removeEventListener("change", handler);
    if (f) await addVersionToTool(toolId, f);
    _fileMenuTargetId = null;
  };
  input.addEventListener("change", handler);
  input.click();
}

/* ===== tile context menu (right-click → edit / copy / download) ===== */
let _ctxMenuTargetId = null;

function initTileContextMenu() {
  const menu = document.getElementById("tile-context-menu");
  if (!menu) return;
  const uploadInput = document.getElementById("tile-context-upload-input");

  menu.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = _ctxMenuTargetId;
      const action = btn.dataset.action;
      if (action === "upload") {
        if (uploadInput) uploadInput.click();
        return;
      }
      closeTileContextMenu();
      if (!id) return;
      const tool = allTools().find((t) => t.id === id);
      if (!tool) return;
      if (action === "edit") {
        if (!canEditTool(tool)) {
          toast(`已鎖定 — 只有「${tool.lockedBy}」能編輯`);
          return;
        }
        openToolPopover(id, null);
      } else if (action === "copy") {
        copyToolUrl(tool);
      } else if (action === "download") {
        const latest = tool?.files?.[0];
        if (latest?.key) {
          downloadFile(latest);
          toast(`下載 ${latest.name}`);
        } else {
          toast("找不到檔案");
        }
      } else if (action === "history") {
        openFilePopover(id);
      }
    });
  });

  if (uploadInput) {
    uploadInput.addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      const id = _ctxMenuTargetId;
      e.target.value = "";
      closeTileContextMenu();
      if (!f || !id) return;
      await addVersionToTool(id, f);
    });
  }

  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    if (e.target.closest("#tile-context-menu")) return;
    closeTileContextMenu();
  });
  document.addEventListener("contextmenu", (e) => {
    if (menu.hidden) return;
    if (e.target.closest(".card[data-id]")) return;
    closeTileContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) closeTileContextMenu();
  });
  window.addEventListener("scroll", closeTileContextMenu, true);
  window.addEventListener("resize", closeTileContextMenu);
}

function openTileContextMenu(toolId, x, y) {
  const menu = document.getElementById("tile-context-menu");
  if (!menu) return;
  const tool = allTools().find((t) => t.id === toolId);
  if (!tool) return;
  const tType = tool.type || "link";
  const latest = tool?.files?.[0];
  const hasFile = (tType === "page" || tType === "file") && !!latest;
  const isFileType = tType === "page" || tType === "file";

  const copyItem = document.getElementById("tile-context-copy");
  const dlItem = document.getElementById("tile-context-download");
  const dlLabel = document.getElementById("tile-context-download-label");
  const upItem = document.getElementById("tile-context-upload");
  const histItem = document.getElementById("tile-context-history");

  if (copyItem) copyItem.hidden = !(tType === "link" && tool.url);
  if (dlItem) {
    // File-type tiles already download on click — only Page tools surface
    // a download action here (download the source HTML).
    const showDownload = hasFile && tType === "page";
    dlItem.hidden = !showDownload;
    if (dlLabel) {
      dlLabel.textContent = showDownload ? `下載原始檔 (${latest.name})` : "下載";
    }
  }
  if (upItem) upItem.hidden = !isFileType;
  if (histItem) histItem.hidden = !(tType === "file" && Array.isArray(tool.files) && tool.files.length > 1);

  _ctxMenuTargetId = toolId;
  menu.hidden = false;
  positionFloatingMenuAt(menu, x, y);
}

function closeTileContextMenu() {
  const menu = document.getElementById("tile-context-menu");
  if (menu) menu.hidden = true;
  _ctxMenuTargetId = null;
}

function positionFloatingMenuAt(menu, x, y) {
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 120;
  let left = x;
  let top = y;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (left < 8) left = 8;
  if (top + mh > window.innerHeight - 8) top = window.innerHeight - mh - 8;
  if (top < 8) top = 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

/* ===== tile hover tooltip — shows the description, section-wide ===== */
function initTileTooltip() {
  const area = document.getElementById("sections-area");
  if (!area) return;
  let current = null;

  const hide = () => {
    if (current) {
      current.remove();
      current = null;
    }
  };

  area.addEventListener("mouseover", (e) => {
    const card = e.target.closest(".card[data-note]");
    if (!card) return;
    if (current && current._card === card) return;
    const section = card.closest(".section");
    if (!section) return;
    const note = card.getAttribute("data-note");
    if (!note) return;
    hide();
    const tt = document.createElement("div");
    tt.className = "tile-tooltip";
    tt.textContent = note;
    tt._card = card;
    section.appendChild(tt);
    const secRect = section.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cs = getComputedStyle(section);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const innerWidth = section.clientWidth - padL - padR;
    tt.style.maxWidth = `${innerWidth}px`;
    tt.style.top = `${cardRect.bottom - secRect.top + 6}px`;
    const tw = tt.offsetWidth;
    const cardCenter = (cardRect.left + cardRect.right) / 2 - secRect.left;
    const minLeft = padL;
    const maxLeft = section.clientWidth - padR - tw;
    let left = cardCenter - tw / 2;
    if (left < minLeft) left = minLeft;
    if (left > maxLeft) left = maxLeft;
    tt.style.left = `${left}px`;
    current = tt;
  });

  area.addEventListener("mouseout", (e) => {
    const card = e.target.closest(".card[data-note]");
    if (!card) return;
    if (e.relatedTarget && card.contains(e.relatedTarget)) return;
    if (current && current._card === card) hide();
  });

  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
}

function closeTileFileMenu() {
  const menu = document.getElementById("tile-file-menu");
  if (menu) menu.hidden = true;
  _fileMenuTargetId = null;
}

/* ===== unified file panel popover (download + history + upload) ===== */
let _filePanelToolId = null;

function initFilePopover() {
  const pop = document.getElementById("file-popover");
  if (!pop) return;
  pop.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeFilePopover)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) closeFilePopover();
  });
  const uploadBtn = document.getElementById("file-panel-upload-btn");
  const uploadInput = document.getElementById("file-panel-upload");
  uploadBtn?.addEventListener("click", () => {
    if (!_filePanelToolId) return;
    const tool = allTools().find((t) => t.id === _filePanelToolId);
    uploadInput.accept = tool?.type === "page" ? ".html,.htm,text/html" : "";
    uploadInput.click();
  });
  uploadInput?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    const id = _filePanelToolId;
    e.target.value = "";
    if (!f || !id) return;
    const tool = allTools().find((t) => t.id === id);
    if (tool?.type === "page" && !isHtmlFile({ name: f.name })) {
      toast("這是頁面類型,只接受 .html / .htm");
      return;
    }
    await addVersionToTool(id, f);
    if (!document.getElementById("file-popover").hidden) openFilePopover(id);
  });
}

function openFilePopover(toolId) {
  const pop = document.getElementById("file-popover");
  if (!pop) return;
  const tool = allTools().find((t) => t.id === toolId);
  if (!tool) { toast("找不到這個工具"); return; }
  _filePanelToolId = toolId;

  const title = document.getElementById("file-popover-title");
  const sub = document.getElementById("file-popover-sub");
  const latestEl = document.getElementById("file-panel-latest");
  const histWrap = document.getElementById("file-panel-history-wrap");
  const histEl = document.getElementById("file-panel-history");

  const files = Array.isArray(tool.files) ? tool.files : [];
  const isPage = tool.type === "page";

  title.textContent = tool.name;
  sub.textContent = isPage ? "HTML 頁面" : `${files.length} 個版本`;

  const uploadBtn = document.getElementById("file-panel-upload-btn");
  const uploadLabel = uploadBtn?.querySelector("span");
  if (uploadLabel) {
    uploadLabel.textContent = isPage
      ? (files.length ? "更換 HTML" : "上傳 HTML")
      : "上傳新版本";
  }

  // Slim popup: no prominent "latest" card. Just admin actions.
  // (Download is now on the action row.)
  latestEl.innerHTML = "";

  // History list. For files: all versions (latest tagged "目前"). For pages: hidden.
  if (isPage || !files.length) {
    histWrap.hidden = true;
  } else {
    histWrap.hidden = false;
    const dlSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>`;
    histEl.innerHTML = files.map((f, i) => {
      const isLatest = i === 0;
      const ver = files.length - i;
      return `
        <div class="file-panel-row${isLatest ? " is-latest" : ""}" data-version="${i}">
          <div class="file-panel-row-ver">v${ver}</div>
          <div class="file-panel-row-meta">
            <div class="file-panel-row-name">${escapeHTML(f.name || "(未命名)")}${isLatest ? ` <span class="file-panel-row-tag">目前</span>` : ""}</div>
            <div class="file-panel-row-info muted small">
              ${escapeHTML(formatDate(f.uploadedAt))}
              ${f.uploadedBy ? ` · ${escapeHTML(f.uploadedBy)}` : ""}
              · ${escapeHTML(formatBytes(f.size || 0))}
            </div>
          </div>
          <div class="file-panel-row-actions">
            <button type="button" class="file-panel-row-btn" data-act="download" data-version="${i}" title="下載這版">${dlSvg}</button>
          </div>
        </div>
      `;
    }).join("");
    histEl.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.dataset.version, 10);
        const f = files[i];
        if (!f) return;
        if (btn.dataset.act === "download") {
          downloadFile(f);
          toast(`下載 ${f.name}`);
        } else if (btn.dataset.act === "preview") {
          window.open(pageUrl(tool.id, i), "_blank", "noopener");
        }
      });
    });
  }

  pop.hidden = false;
}

function closeFilePopover() {
  const pop = document.getElementById("file-popover");
  if (pop) pop.hidden = true;
  _filePanelToolId = null;
}

function positionFloatingMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 120;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (left < 8) left = 8;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
  if (top < 8) top = 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

async function addVersionToTool(toolId, file) {
  if (file.size > MAX_FILE_BYTES) {
    toast(`檔案太大(${formatBytes(file.size)},上限 ${formatBytes(MAX_FILE_BYTES)})`);
    return;
  }
  const existing = allTools().find((t) => t.id === toolId);
  if (!canEditTool(existing)) {
    toast(`已鎖定 — 只有「${existing.lockedBy}」能上傳新版`);
    return;
  }
  const me = await getMe();
  try {
    toast("上傳中…");
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Tool-Id": toolId,
        "X-Filename": encodeURIComponent(file.name),
        "X-Uploaded-By": encodeURIComponent(me || ""),
      },
      body: file,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const meta = await res.json();
    let tool = state.localTools.find((t) => t.id === toolId);
    if (!tool) {
      const seed = state.seedTools.find((t) => t.id === toolId);
      if (seed) {
        tool = { ...seed };
        state.localTools.push(tool);
      }
    }
    if (!tool) { toast("找不到這個工具"); return; }
    if (!Array.isArray(tool.files)) tool.files = [];
    const entry = {
      key: meta.key,
      name: meta.name,
      size: meta.size,
      uploadedAt: meta.uploadedAt,
      uploadedBy: meta.uploadedBy,
    };
    if (tool.type === "page") {
      // Pages don't keep history — replace whatever's there.
      tool.files = [entry];
    } else {
      tool.files.unshift(entry);
      if (tool.files.length > MAX_VERSIONS) tool.files.length = MAX_VERSIONS;
    }
    tool.updated = new Date().toISOString();
    saveTools();
    render();
    toast(tool.type === "page" ? `已更新 ${meta.name}` : `已上傳 ${meta.name}`);
  } catch (err) {
    toast("上傳失敗");
    console.error(err);
  }
}


/* ===== "current user" (uploader tag) ===== */
async function getMe() {
  if (state.me) return state.me;
  return pickCreatorAsMe();
}

function pickCreatorAsMe() {
  return new Promise((resolve) => {
    const all = listAllCreators();
    const options = [
      { value: "", label: "— 選一個 —", disabled: true },
      ...all.map((c) => ({ value: c, label: c })),
      { value: "__new__", label: "＋ 新增製作人…" },
    ];
    openMiniPopover({
      title: "你是?",
      hint: "從製作人裡選一個。之後上傳檔案會記錄是你傳的。",
      options,
      onConfirm: (picked) => {
        if (picked === "__new__") {
          openMiniPopover({
            title: "新增製作人",
            placeholder: "輸入名稱",
            onConfirm: (val) => {
              const name = (val || "").trim();
              if (name) {
                ensureCreator(name);
                state.me = name;
                localStorage.setItem(LS_ME_KEY, name);
              }
              resolve(name || "");
            },
          });
        } else {
          const name = (picked || "").trim();
          if (name) {
            state.me = name;
            localStorage.setItem(LS_ME_KEY, name);
          }
          resolve(name || "");
        }
      },
    });
  });
}

/* ===== category picker (native select; manage via the category chip / popover) ===== */
function initCategoryPicker() {
  const sel = document.getElementById("category-select");
  if (!sel) return;
  sel.addEventListener("change", (e) => {
    if (e.target.value === "__new__") {
      e.target.value = "";
      openMiniPopover({
        title: "新增分類",
        placeholder: "例如:生活 / CLO / 查詢",
        onConfirm: (val) => {
          if (!val) return;
          ensureCategory(val);
          renderCategorySelect(val);
        },
      });
    }
  });
}

function renderCategorySelect(keepValue) {
  const sel = document.getElementById("category-select");
  if (!sel) return;
  const want = keepValue != null ? keepValue : sel.value;
  sel.innerHTML = `
    <option value="">— 沒有分類 —</option>
    ${state.categories.map((c) => `<option value="${escapeAttr(c.name)}">${escapeHTML(c.name)}</option>`).join("")}
    <option value="__new__">＋ 新增分類…</option>
  `;
  if (want && state.categories.some((c) => c.name === want)) sel.value = want;
  else sel.value = "";
}

/* Icon picker lives inside the add/edit popover — preview + 上傳 / 網址 /
   預設 buttons that update the form's hidden `icon` input. The actual
   save happens with the rest of the form, on 儲存. */
function initIconPicker() {
  const picker = document.getElementById("icon-picker");
  const fileInput = document.getElementById("icon-picker-file");
  if (!picker || !fileInput) return;

  picker.querySelectorAll("[data-icon-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const action = btn.dataset.iconAction;
      const f = $("#add-form").elements;
      if (action === "upload") {
        fileInput.click();
      } else if (action === "url") {
        const current = f.icon.value || "";
        openMiniPopover({
          title: "圖片網址",
          placeholder: "https://…",
          defaultValue: current.startsWith("data:") ? "" : current,
          type: "url",
          onConfirm: (val) => {
            f.icon.value = (val || "").trim();
            updateIconPreview();
          },
        });
      } else if (action === "clear") {
        f.icon.value = "";
        updateIconPreview();
      }
    });
  });

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await readAndResize(file, 256);
      $("#add-form").elements.icon.value = dataUrl;
      updateIconPreview();
    } catch {
      toast("圖片讀取失敗");
    }
  });
}

function updateIconPreview() {
  const preview = document.getElementById("icon-preview");
  const letter = document.getElementById("icon-preview-letter");
  if (!preview || !letter) return;
  const f = $("#add-form").elements;
  const iconUrl = (f.icon.value || "").trim();
  const name = (f.name.value || "").trim();
  letter.textContent = initial(name);
  const oldImg = preview.querySelector("img");
  if (oldImg) oldImg.remove();
  if (iconUrl) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = "";
    img.addEventListener("error", () => img.remove());
    preview.appendChild(img);
  }
}

async function readAndResize(file, maxSize) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        const ratio = Math.min(maxSize / width, maxSize / height, 1);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        // Keep alpha if the source has any (rough heuristic — PNG/SVG)
        const usePng = /image\/(png|svg)/i.test(file.type);
        resolve(canvas.toDataURL(usePng ? "image/png" : "image/jpeg", 0.86));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ===== tool popover ===== */
function initToolPopover() {
  const pop = $("#popover");
  pop.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeToolPopover)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) closeToolPopover();
  });
  $("#save-tool").addEventListener("click", saveTool);
  $("#delete-tool").addEventListener("click", deleteTool);
  $("#auto-fetch").addEventListener("click", autoFetch);
  // Auto-trigger on paste into the URL field, and on Enter.
  $("#url-input")?.addEventListener("paste", () => setTimeout(autoFetch, 30));
  $("#url-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); autoFetch(); }
  });

  $("#add-form").addEventListener("input", (e) => {
    if (e.target.name === "name" || e.target.name === "category") {
      updateIconPreview();
    }
    if (state.editingId) return;
    saveJSON(LS_DRAFT_KEY, formData());
  });
  $("#add-form").addEventListener("change", (e) => {
    if (e.target.name === "category") updateIconPreview();
  });

  window.addEventListener("resize", () => {
    if (!pop.hidden) positionPopover(pop, state.anchorEl);
  });
}

function openToolPopover(id = null, anchor = null) {
  state.editingId = id;
  const form = $("#add-form");
  form.reset();
  resetAutoFill();
  $("#popover-title").textContent = id ? "編輯工具" : "新增工具";
  $("#popover-sub").textContent = id ? "修改後按儲存" : "貼上連結自動讀取,或手動填寫";
  $("#delete-tool").hidden = !id;
  // Editing locks the type — you're updating the existing tool's content,
  // not converting it to a different kind.
  $("#type-selector").hidden = !!id;

  state.editingFiles = [];

  if (id) {
    const t = allTools().find((x) => x.id === id);
    if (t) {
      form.elements.id.value = t.id;
      form.elements.name.value = t.name || "";
      if (t.creator) ensureCreator(t.creator);
      renderCreatorSelect(t.creator || "");
      renderCategorySelect(t.category || "");
      setType(normalizeType(t.type));
      form.elements.url.value = t.url === "#" ? "" : (t.url || "");
      form.elements.description.value = t.description || "";
      form.elements.icon.value = t.icon || "";
      if (t.brand) ensureBrand(t.brand);
      renderBrandSelect(t.brand || "");
      if (Array.isArray(t.files)) {
        state.editingFiles = t.files.map((f) => ({ ...f }));
      }
      if (form.elements.lock) form.elements.lock.checked = !!t.lockedBy;
    }
  } else {
    renderCreatorSelect("");
    renderCategorySelect(state.prefillCategory || "");
    renderBrandSelect("");
    form.elements.icon.value = "";
    if (form.elements.lock) form.elements.lock.checked = false;
    setType("link");
    restoreDraft();
    if (state.prefillCategory) {
      renderCategorySelect(state.prefillCategory);
      state.prefillCategory = null;
    }
  }
  renderFileList();
  updateIconPreview();

  const anchorEl = anchor || $("#open-add");
  state.anchorEl = anchorEl;
  $("#popover").hidden = true;
  $("#cat-popover").hidden = true;
  $("#popover").hidden = false;
  positionPopover($("#popover"), anchorEl);
  setTimeout(() => {
    if (id) form.elements.name.focus();
    else document.getElementById("url-input")?.focus();
  }, 50);
}

function closeToolPopover() {
  $("#popover").hidden = true;
  state.editingId = null;
  state.anchorEl = null;
}

function formData() {
  const f = $("#add-form").elements;
  return {
    id: f.id.value || "",
    name: f.name.value.trim(),
    creator: (f.creator.value || "").trim(),
    category: (f.category.value || "").trim(),
    type: f.type.value,
    url: f.url.value.trim(),
    description: f.description.value.trim(),
    icon: f.icon.value.trim(),
    brand: (f.brand?.value || "").trim(),
    lock: !!f.lock?.checked,
  };
}

function restoreDraft() {
  const d = loadJSON(LS_DRAFT_KEY, null);
  if (!d) return;
  const f = $("#add-form").elements;
  if (d.name) f.name.value = d.name;
  if (d.creator) {
    const opts = Array.from(f.creator.options || []);
    if (opts.some((o) => o.value === d.creator)) f.creator.value = d.creator;
  }
  if (d.category) {
    const opts = Array.from(f.category.options || []);
    if (opts.some((o) => o.value === d.category)) f.category.value = d.category;
  }
  if (d.type) {
    let t = d.type;
    if (t === "url" || t === "iframe") t = "link";
    else if (t === "python") t = "file";
    if (t === "link" || t === "file") setType(t);
  }
  if (d.url) f.url.value = d.url;
  if (d.description) f.description.value = d.description;
  if (d.icon) f.icon.value = d.icon;
}

function saveTool() {
  const d = formData();
  if (!d.name || !d.creator) {
    toast("請填寫工具名稱與製作人");
    return;
  }
  if (state.editingId) {
    const existing = allTools().find((t) => t.id === state.editingId);
    if (!canEditTool(existing)) {
      toast(`已鎖定 — 只有「${existing.lockedBy}」能修改`);
      return;
    }
  }
  if (d.type === "file" || d.type === "page") {
    if (!state.editingFiles.length) {
      toast(d.type === "page" ? "請上傳 HTML 檔案" : "請上傳至少一個檔案");
      return;
    }
    if (d.type === "page" && !isHtmlFile(state.editingFiles[0])) {
      toast("頁面類型只接受 .html / .htm");
      return;
    }
  } else {
    // link
    if (!d.url) {
      toast("請填 URL");
      return;
    }
  }

  // Determine final id. For edits, always reuse the tool being edited so the
  // record updates in place. For new tools, generate a fresh unique slug —
  // ignore d.id (which auto-fetch may have written) so we never silently
  // overwrite an existing tool that happens to share a slug.
  const isNew = !state.editingId;
  const id = isNew ? uniqueSlug(d.name) : state.editingId;
  const existing = isNew ? null : state.localTools.find((t) => t.id === id);

  const record = {
    ...(existing || {}),
    id,
    name: d.name,
    description: d.description,
    creator: d.creator,
    version: existing?.version || "1.0.0",
    category: d.category,
    type: d.type,
    url: d.type === "link" ? d.url : "",
    icon: d.icon || "",
    brand: d.type === "file" ? d.brand : "",
    files: (d.type === "file" || d.type === "page")
      ? state.editingFiles.map((f) => ({
          key: f.key,
          name: f.name,
          size: f.size,
          uploadedAt: f.uploadedAt,
          uploadedBy: f.uploadedBy || "",
        }))
      : [],
    lockedBy: d.lock ? d.creator : "",
    // Stamp creation time once. New tools get "now"; tools saved before this
    // field existed keep their original `updated` time so editing an old tool
    // doesn't make it masquerade as a fresh arrival.
    createdAt: existing?.createdAt || existing?.updated || new Date().toISOString(),
    updated: new Date().toISOString(),
  };

  // Drop the legacy single-file field if present from older records.
  delete record.file;

  const idx = state.localTools.findIndex((t) => t.id === id);
  if (idx >= 0) state.localTools[idx] = record;
  else state.localTools.push(record);

  if (d.category) ensureCategory(d.category);
  ensureCreator(d.creator);

  if (d.brand) ensureBrand(d.brand);

  saveTools();
  localStorage.removeItem(LS_DRAFT_KEY);
  state.editingFiles = [];
  closeToolPopover();
  render();
  toast(isNew ? "已新增" : "已更新");
}

function uniqueSlug(name) {
  const base = slugify(name);
  const taken = new Set(allTools().map((t) => t.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function deleteTool() {
  if (!state.editingId) return;
  const t = allTools().find((x) => x.id === state.editingId);
  if (!canEditTool(t)) {
    toast(`已鎖定 — 只有「${t.lockedBy}」能刪除`);
    return;
  }
  if (!confirm("確定要刪除這個工具?")) return;
  state.localTools = state.localTools.filter((t) => t.id !== state.editingId);
  saveTools();
  closeToolPopover();
  render();
  toast("已刪除");
}

/* ===== auto-fetch ===== */
function resetAutoFill() {
  const hint = document.getElementById("auto-hint");
  if (hint) { hint.hidden = true; hint.classList.remove("success", "error"); hint.textContent = ""; }
}

function setAutoHint(text, kind) {
  const hint = document.getElementById("auto-hint");
  if (!hint) return;
  hint.classList.remove("success", "error");
  if (kind) hint.classList.add(kind);
  hint.textContent = text;
  hint.hidden = !text;
}

async function autoFetch() {
  const urlInput = document.getElementById("url-input");
  if (!urlInput) return;
  const url = urlInput.value.trim();
  if (!url) { setAutoHint("請先在上面貼一個網址", "error"); return; }
  const btn = $("#auto-fetch");
  btn.disabled = true;
  setAutoHint("讀取中…", null);

  try {
    const gh = parseGitHub(url);
    let info = null;
    let fallbackNote = "";

    if (gh) {
      try {
        info = await fetchGitHubRepo(gh.owner, gh.repo);
      } catch (ghErr) {
        // GitHub API failed — fall back so the user still gets name + owner
        // and only needs to fill in the rest manually.
        info = parseGenericURL(url) || {
          name: gh.repo, creator: gh.owner, url, type: "link", icon: "",
        };
        info.name = info.name || gh.repo;
        info.creator = info.creator || gh.owner;
        fallbackNote = ghErr?.message || "GitHub 讀取失敗";
      }
    } else {
      info = parseGenericURL(url);
    }

    if (!info) throw new Error("找不到資訊");
    applyAutoFill(info);

    if (fallbackNote) {
      setAutoHint(`${fallbackNote}。已先填好名稱與作者,其他請自己補。`, "error");
    } else if (gh) {
      setAutoHint(`✓ 已讀取 GitHub repo:${gh.owner}/${gh.repo}`, "success");
    } else {
      setAutoHint("✓ 已從網址讀取網域,請補上名稱與描述", "success");
    }
  } catch (err) {
    setAutoHint("讀取失敗:" + (err?.message || "未知錯誤") + "。請手動填寫。", "error");
  } finally {
    btn.disabled = false;
  }
}

function parseGitHub(url) {
  const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, "").replace(/\/$/, "") };
}

async function fetchGitHubRepo(owner, repo) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
  if (res.status === 404) {
    throw new Error("這個 repo 可能是私人或不存在(GitHub 對未登入請求回 404)");
  }
  if (res.status === 403) {
    throw new Error("GitHub API 達到流量上限,稍後再試");
  }
  if (!res.ok) throw new Error("GitHub API " + res.status);
  const data = await res.json();
  return {
    name: data.name,
    description: data.description || "",
    creator: data.owner?.login || owner,
    url: data.html_url,
    icon: data.owner?.avatar_url ? `${data.owner.avatar_url}&s=200` : "",
  };
}

function parseGenericURL(url) {
  try {
    const u = new URL(url.startsWith("http") ? url : "https://" + url);
    const host = u.hostname.replace(/^www\./, "");
    const name = host.split(".")[0]
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      name,
      description: "",
      creator: "",
      url: u.href,
      icon: "",
    };
  } catch {
    return null;
  }
}

function applyAutoFill(info) {
  // Only fills fields that the auto-fetch actually returned. Never touches
  // the type — the type-selector is authoritative.
  const f = $("#add-form").elements;
  if (info.name) f.name.value = info.name;
  if (info.creator) {
    ensureCreator(info.creator);
    renderCreatorSelect(info.creator);
  }
  if (info.description) f.description.value = info.description;
  if (info.url) f.url.value = info.url;
  if (info.icon) f.icon.value = info.icon;
  updateIconPreview();
}

/* ===== category popover ===== */
function initCatPopover() {
  const pop = $("#cat-popover");
  pop.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeCatPopover)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) closeCatPopover();
  });
  $("#save-cat").addEventListener("click", saveCategory);
  $("#delete-cat").addEventListener("click", () => {
    if (state.editingCat) deleteCategory(state.editingCat, /*fromPopover*/ true);
  });
  renderColorPicker(0);
}

function renderColorPicker(active) {
  const wrap = $("#color-picker");
  wrap.innerHTML = "";
  for (let i = 0; i < NUM_COLORS; i++) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "color-swatch" + (i === active ? " active" : "");
    sw.dataset.cv = String(i);
    sw.dataset.color = String(i);
    sw.addEventListener("click", () => {
      $$("#color-picker .color-swatch").forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
    });
    wrap.appendChild(sw);
  }
}

function openCatPopover(name = null, anchor = null) {
  state.editingCat = name;
  const f = $("#cat-form").elements;
  $("#cat-popover-title").textContent = name ? "編輯分類" : "新增分類";
  $("#delete-cat").hidden = !name;
  f.originalName.value = name || "";

  if (name) {
    const c = state.categories.find((x) => x.name === name);
    f.name.value = name;
    renderColorPicker(c?.color ?? 0);
  } else {
    f.name.value = "";
    renderColorPicker(state.categories.length % NUM_COLORS);
  }

  const anchorEl = anchor || $("#open-add-cat");
  state.anchorEl = anchorEl;
  $("#popover").hidden = true;
  $("#cat-popover").hidden = true;
  $("#cat-popover").hidden = false;
  positionPopover($("#cat-popover"), anchorEl);
  setTimeout(() => f.name.focus(), 50);
}

function closeCatPopover() {
  $("#cat-popover").hidden = true;
  state.editingCat = null;
  state.anchorEl = null;
}

function saveCategory() {
  const f = $("#cat-form").elements;
  const name = f.name.value.trim();
  const original = f.originalName.value;
  const colorEl = $("#color-picker .color-swatch.active");
  const color = colorEl ? Number(colorEl.dataset.color) : 0;

  if (!name) { toast("請輸入分類名稱"); return; }

  if (original) {
    if (name !== original) {
      if (state.categories.find((c) => c.name === name)) {
        toast("已有同名分類"); return;
      }
      state.categories = state.categories.map((c) =>
        c.name === original ? { name, color } : c
      );
      state.localTools = state.localTools.map((t) =>
        t.category === original ? { ...t, category: name } : t
      );
      if (state.filter === original) state.filter = name;
      saveTools();
    } else {
      const c = state.categories.find((x) => x.name === name);
      if (c) c.color = color;
    }
    saveCats();
    toast("已更新");
  } else {
    if (state.categories.find((c) => c.name === name)) {
      toast("已有同名分類"); return;
    }
    state.categories.push({ name, color });
    saveCats();
    toast("已新增分類");
  }

  closeCatPopover();
  render();
}

function deleteCategory(name, fromPopover = false) {
  const inUse = allTools().some((t) => t.category === name);
  const msg = inUse
    ? `「${name}」內的工具會變成「未分類」,確定刪除分類?`
    : `確定刪除分類「${name}」?`;
  if (!confirm(msg)) return;
  state.categories = state.categories.filter((c) => c.name !== name);
  state.localTools = state.localTools.map((t) =>
    t.category === name ? { ...t, category: "" } : t
  );
  if (state.filter === name) state.filter = "all";
  saveCats();
  saveTools();
  if (fromPopover) closeCatPopover();
  render();
  toast("已刪除分類");
}

/* ===== positioning ===== */
function positionPopover(popEl, _anchor) {
  // Center the popover on the viewport so action buttons are always reachable.
  const panel = popEl.querySelector(".popover-panel");
  const panelWidth = panel.offsetWidth || (panel.classList.contains("popover-panel-sm") ? 360 : 460);
  const panelHeight = panel.offsetHeight || 500;
  const margin = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const top = Math.max(margin, Math.round((vh - panelHeight) / 2));
  const left = Math.max(margin, Math.round((vw - panelWidth) / 2));

  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
  panel.style.right = "auto";
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
