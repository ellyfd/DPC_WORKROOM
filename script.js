const LS_DRAFT_KEY = "dpcHub.draft.v1";
const LS_COLLAPSE_KEY = "dpcHub.collapsed.v1";
const LS_ME_KEY = "dpcHub.me.v1";
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
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const CANONICAL_HOST = "dpc-hub.ellyfd.workers.dev";

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

  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    renderSections();
  });
  $("#open-add").addEventListener("click", (e) => openToolPopover(null, e.currentTarget));
  $("#open-add-cat").addEventListener("click", (e) => openCatPopover(null, e.currentTarget));
  $("#empty-cta").addEventListener("click", (e) => openToolPopover(null, e.currentTarget));
  $("#open-backup")?.addEventListener("click", openBackupPopover);
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
  initBackupPopover();
  initTileIconMenu();
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
    if (t.type === "file") {
      if (!Array.isArray(t.files)) {
        t.files = [];
        delete t.file;
        changed = true;
      }
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

/* ===== build a self-contained share URL =====
   We strip file content (way too big for a URL) but keep the rest — names,
   creators, categories, brands, all file metadata. */
function buildShareUrl() {
  const lightTools = state.localTools.map((t) => {
    if (t.type === "file" && Array.isArray(t.files)) {
      return {
        ...t,
        files: t.files.map((f) => ({
          name: f.name, size: f.size, uploadedAt: f.uploadedAt,
        })),
      };
    }
    return t;
  });
  const data = {
    app: "dpcHub",
    v: 2,
    tools: lightTools,
    categories: state.categories,
    creators: state.creators,
    brands: state.brands,
  };
  const json = JSON.stringify(data);
  const encoded = btoa(unescape(encodeURIComponent(json)));
  return `${window.location.origin}${window.location.pathname}#data=${encoded}`;
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
  updateSelectDeleteBtn?.("brand");
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
  updateSelectDeleteBtn?.("creator");
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
    tools: tools.filter((t) => t.category === c.name),
    system: false,
  }));
  const uncat = tools.filter((t) => !t.category || !state.categories.find((c) => c.name === t.category));
  if (uncat.length) {
    result.push({ name: "未分類", color: NUM_COLORS, tools: uncat, system: true });
  }
  return result;
}

function matchesQuery(t) {
  if (!state.query) return true;
  const hay = [t.name, t.creator, t.description, t.category, ...(t.tags || [])]
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
  link: { label: "LINK", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>` },
  file: { label: "FILE", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>` },
  // legacy fallbacks
  url: { label: "URL", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>` },
  python: { label: "PY", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v6h8m-8 6H4v6h6m0-12V3h6v6m0 6h4v-6h-6m0 6v6"/></svg>` },
  iframe: { label: "EMBED", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>` },
};

function renderSections() {
  const area = $("#sections-area");
  const empty = $("#empty");

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
  const addCard = !isSystem ? `
    <button class="card-add" data-add-cat="${escapeAttr(g.name)}" title="新增到「${escapeAttr(g.name)}」">
      <span class="card-add-plus">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>
      </span>
      <span>新增工具</span>
    </button>` : "";

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

  const grid = `<div class="section-grid">${cards}${addCard}</div>`;

  return `
    <section class="section" data-cv="${cv}" data-cat="${escapeAttr(g.name)}">
      ${header}
      <div class="section-body">${grid}</div>
    </section>
  `;
}

function cardHTML(t, cv) {
  const tType = t.type || "link";
  const type = TYPE_META[tType] || TYPE_META.link;
  const iconImg = t.icon
    ? `<img src="${escapeAttr(t.icon)}" alt="" onerror="this.remove()" />`
    : "";
  const bits = [];
  if (t.creator) bits.push(`製作:${t.creator}`);
  if (tType === "file" && Array.isArray(t.files) && t.files.length) {
    const latest = t.files[0];
    if (latest?.uploadedAt) bits.push(`最新:${formatDate(latest.uploadedAt)}`);
    if (t.files.length > 1) bits.push(`${t.files.length} 個版本`);
  } else if (t.version) {
    bits.push(`v${t.version}`);
  }
  if (t.description) bits.push(t.description);
  const tip = bits.length ? `${t.name}\n${bits.join(" · ")}` : t.name;

  return `
    <article class="card" data-cv="${cv}" data-id="${escapeAttr(t.id)}">
      <button type="button" class="card-tile" data-open="${escapeAttr(t.id)}" title="${escapeAttr(tip)}">
        <div class="card-top">
          <div class="card-icon">
            <span class="ic-letter">${escapeHTML(initial(t.name))}</span>
            ${iconImg}
          </div>
          <span class="type-badge ${tType}">${type.icon}</span>
        </div>
        <h3 class="card-title">${escapeHTML(t.name)}</h3>
      </button>
      <div class="card-actions">
        <button type="button" class="card-act" data-act="edit" data-id="${escapeAttr(t.id)}" title="編輯">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        </button>
        <button type="button" class="card-act" data-act="icon" data-id="${escapeAttr(t.id)}" title="換圖">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
        </button>
      </div>
    </article>
  `;
}

function wireSections() {
  // Main tile click = open the tool
  $$("#sections-area [data-open]").forEach((tile) => {
    tile.addEventListener("click", () => {
      const id = tile.dataset.open;
      const tool = allTools().find((t) => t.id === id);
      if (tool) openTool(tool);
    });
  });
  // Action row below the tile
  $$("#sections-area [data-act]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (btn.dataset.act === "edit") openToolPopover(id, btn);
      else if (btn.dataset.act === "icon") openTileIconMenu(id, btn);
    });
  });
  $$("#sections-area [data-add-cat]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.prefillCategory = btn.dataset.addCat;
      openToolPopover(null, btn);
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

function openTool(t) {
  // File tools download the latest version.
  if (t.type === "file" && Array.isArray(t.files) && t.files.length) {
    const latest = t.files[0];
    if (!latest?.key) {
      toast("找不到這版的檔案");
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

/* ===== mini popover (reusable single-input prompt) ===== */
let miniPopoverHandler = null;

function initMiniPopover() {
  const pop = document.getElementById("mini-popover");
  if (!pop) return;
  pop.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeMiniPopover)
  );
  const input = document.getElementById("mini-popover-input");
  const confirm = document.getElementById("mini-popover-confirm");
  confirm.addEventListener("click", () => commitMini());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitMini(); }
    else if (e.key === "Escape") { e.preventDefault(); closeMiniPopover(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) closeMiniPopover();
  });
}

function openMiniPopover({ title, placeholder = "", defaultValue = "", hint = "", type = "text", onConfirm }) {
  document.getElementById("mini-popover-title").textContent = title;
  const input = document.getElementById("mini-popover-input");
  input.type = type;
  input.placeholder = placeholder;
  input.value = defaultValue || "";
  const hintEl = document.getElementById("mini-popover-hint");
  hintEl.textContent = hint || "";
  hintEl.hidden = !hint;
  miniPopoverHandler = onConfirm;
  document.getElementById("mini-popover").hidden = false;
  setTimeout(() => { input.focus(); input.select(); }, 30);
}

function closeMiniPopover() {
  document.getElementById("mini-popover").hidden = true;
  miniPopoverHandler = null;
  document.getElementById("mini-popover-input").value = "";
}

function commitMini() {
  const val = document.getElementById("mini-popover-input").value.trim();
  if (!miniPopoverHandler) { closeMiniPopover(); return; }
  const fn = miniPopoverHandler;
  closeMiniPopover();
  fn(val);
}

/* ===== creator picker ===== */
function initCreatorPicker() {
  const sel = document.getElementById("creator-select");
  if (!sel) return;
  sel.addEventListener("change", (e) => {
    if (e.target.value === "__new__") {
      e.target.value = "";
      updateSelectDeleteBtn("creator");
      openMiniPopover({
        title: "新增製作人",
        placeholder: "輸入名稱",
        onConfirm: (val) => {
          if (!val) return;
          ensureCreator(val);
          renderCreatorSelect(val);
        },
      });
      return;
    }
    updateSelectDeleteBtn("creator");
  });
  document.getElementById("creator-delete")?.addEventListener("click", () => {
    const v = sel.value;
    if (v && v !== "__new__") deleteCreator(v);
  });
}

/* ===== brand picker ===== */
function initBrandPicker() {
  const sel = document.getElementById("brand-select");
  if (!sel) return;
  sel.addEventListener("change", (e) => {
    if (e.target.value === "__new__") {
      e.target.value = "";
      updateSelectDeleteBtn("brand");
      openMiniPopover({
        title: "新增品牌 / 客制",
        placeholder: "輸入品牌或客制名稱",
        onConfirm: (val) => {
          if (!val) return;
          ensureBrand(val);
          renderBrandSelect(val);
        },
      });
      return;
    }
    updateSelectDeleteBtn("brand");
  });
  document.getElementById("brand-delete")?.addEventListener("click", () => {
    const v = sel.value;
    if (v && v !== "__new__") deleteBrand(v);
  });
}

/* Shared: toggle the small ✕ next to a select based on its current value */
function updateSelectDeleteBtn(kind) {
  const sel = document.getElementById(`${kind}-select`);
  const btn = document.getElementById(`${kind}-delete`);
  if (!sel || !btn) return;
  const v = sel.value;
  btn.hidden = !v || v === "__new__";
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
  updateSelectDeleteBtn("creator");
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
  updateSelectDeleteBtn("brand");
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
  if (type === "file") {
    renderBrandSelect(document.getElementById("brand-select")?.value || "");
    renderFileList();
  }
}

/* ===== file management (versioned uploads) ===== */
function initFileUpload() {
  const input = document.getElementById("file-input");
  const addBtn = document.getElementById("file-add-version");
  if (!input) return;

  addBtn?.addEventListener("click", () => input.click());
  input.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (file) await addFileVersion(file);
    e.target.value = "";
  });

  // Drag-and-drop + click on the empty state row (rendered by renderFileList).
  const list = document.getElementById("file-list");
  if (list) {
    list.addEventListener("click", (e) => {
      if (e.target.closest(".file-empty")) input.click();
    });
    list.addEventListener("dragover", (e) => {
      const drop = e.target.closest(".file-empty");
      if (!drop) return;
      e.preventDefault();
      drop.classList.add("dragover");
    });
    list.addEventListener("dragleave", (e) => {
      const drop = e.target.closest(".file-empty");
      if (drop) drop.classList.remove("dragover");
    });
    list.addEventListener("drop", async (e) => {
      const drop = e.target.closest(".file-empty");
      if (!drop) return;
      e.preventDefault();
      drop.classList.remove("dragover");
      const file = e.dataTransfer?.files?.[0];
      if (file) await addFileVersion(file);
    });
  }
}

async function addFileVersion(file) {
  if (file.size > MAX_FILE_BYTES) {
    toast(`檔案太大(${formatBytes(file.size)},上限 ${formatBytes(MAX_FILE_BYTES)})`);
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
    state.editingFiles.unshift({
      key: meta.key,
      name: meta.name,
      size: meta.size,
      uploadedAt: meta.uploadedAt,
      uploadedBy: meta.uploadedBy,
    });
    if (state.editingFiles.length > MAX_VERSIONS) {
      state.editingFiles.length = MAX_VERSIONS;
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
  if (!state.editingFiles.length) {
    list.innerHTML = `
      <div class="file-empty">
        <div style="font-weight:600;margin-bottom:4px">還沒有上傳任何檔案</div>
        <div style="font-size:12.5px;color:var(--text-mute)">點上方「上傳新版本」,或拖檔案到這裡</div>
      </div>
    `;
    return;
  }
  list.innerHTML = state.editingFiles.map((f, i) => {
    const isLatest = i === 0;
    const canDelete = state.editingFiles.length > 1;
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
            ${isLatest ? `<span class="file-row-latest-badge">目前版本</span>` : ""}
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

/* ===== tile icon menu (change-image from the tile, no popover needed) ===== */
let _iconMenuTargetId = null;

function initTileIconMenu() {
  const menu = document.getElementById("tile-icon-menu");
  const file = document.getElementById("tile-icon-file");
  if (!menu || !file) return;

  menu.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = _iconMenuTargetId;
      if (!id) return;
      const action = btn.dataset.action;
      if (action === "upload") {
        file.click();
      } else if (action === "url") {
        const tool = allTools().find((t) => t.id === id);
        openMiniPopover({
          title: "圖片網址",
          placeholder: "https://…",
          defaultValue: (tool?.icon || "").startsWith("data:") ? "" : (tool?.icon || ""),
          type: "url",
          onConfirm: (val) => setToolIcon(id, val || ""),
        });
        closeTileIconMenu();
      } else if (action === "clear") {
        setToolIcon(id, "");
        closeTileIconMenu();
      }
    });
  });

  file.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    const id = _iconMenuTargetId;
    e.target.value = "";
    if (!f || !id) return;
    try {
      const dataUrl = await readAndResize(f, 256);
      setToolIcon(id, dataUrl);
    } catch {
      toast("圖片讀取失敗");
    }
    closeTileIconMenu();
  });

  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    if (e.target.closest("#tile-icon-menu")) return;
    if (e.target.closest("[data-act='icon']")) return;
    closeTileIconMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) closeTileIconMenu();
  });
  window.addEventListener("scroll", closeTileIconMenu, true);
  window.addEventListener("resize", closeTileIconMenu);
}

function openTileIconMenu(toolId, anchor) {
  const menu = document.getElementById("tile-icon-menu");
  if (!menu) return;
  _iconMenuTargetId = toolId;
  menu.hidden = false;
  // Measure after un-hiding
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 140;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (left < 8) left = 8;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
  if (top < 8) top = 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function closeTileIconMenu() {
  const menu = document.getElementById("tile-icon-menu");
  if (menu) menu.hidden = true;
  _iconMenuTargetId = null;
}

function setToolIcon(toolId, value) {
  // If the tool only exists as a seed (from tools.json), copy it to localTools
  // first so the change persists.
  let tool = state.localTools.find((t) => t.id === toolId);
  if (!tool) {
    const seed = state.seedTools.find((t) => t.id === toolId);
    if (!seed) return;
    tool = { ...seed };
    state.localTools.push(tool);
  }
  tool.icon = value || "";
  tool.updated = new Date().toISOString();
  saveTools();
  render();
  toast(value ? "已更新圖示" : "已用預設圖示");
}

/* ===== "current user" (uploader tag) ===== */
async function getMe() {
  if (state.me) return state.me;
  return new Promise((resolve) => {
    openMiniPopover({
      title: "你是?",
      placeholder: "輸入你的名字",
      hint: "之後上傳檔案會記錄是你傳的。隨時可以在「備份 / 還原」改。",
      onConfirm: (val) => {
        const name = (val || "").trim();
        if (name) {
          state.me = name;
          localStorage.setItem(LS_ME_KEY, name);
        }
        resolve(name || "");
      },
    });
  });
}

/* ===== backup / restore ===== */
function initBackupPopover() {
  const pop = document.getElementById("backup-popover");
  if (!pop) return;
  pop.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", () => { pop.hidden = true; })
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) pop.hidden = true;
  });
  document.getElementById("backup-export").addEventListener("click", exportBackup);
  document.getElementById("backup-import").addEventListener("click", () => {
    document.getElementById("backup-file").click();
  });
  document.getElementById("backup-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (file) await importBackup(file);
    e.target.value = "";
  });
  document.getElementById("backup-share-url")?.addEventListener("click", shareViaUrl);
}

async function shareViaUrl() {
  const url = buildShareUrl();
  try {
    if (navigator.clipboard && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(url);
      toast(`已複製分享連結(${formatBytes(url.length)})`);
    } else {
      prompt("複製這個網址:", url);
    }
  } catch {
    prompt("複製這個網址:", url);
  }
  document.getElementById("backup-popover").hidden = true;
}

function openBackupPopover() {
  document.getElementById("backup-popover").hidden = false;
}

function exportBackup() {
  const data = {
    app: "dpcHub",
    version: 1,
    exportedAt: new Date().toISOString(),
    tools: state.localTools,
    categories: state.categories,
    creators: state.creators,
    brands: state.brands,
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dpc-hub-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
  toast("已下載備份");
  document.getElementById("backup-popover").hidden = true;
}

async function importBackup(file) {
  try {
    const text = await readFileAsText(file);
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("不是合法 JSON");
    if (!Array.isArray(data.tools) && !Array.isArray(data.categories)) {
      throw new Error("看起來不是 DPC Hub 備份檔");
    }
    const summary = [
      Array.isArray(data.tools) ? `${data.tools.length} 個工具` : null,
      Array.isArray(data.categories) ? `${data.categories.length} 個分類` : null,
      Array.isArray(data.creators) ? `${data.creators.length} 位製作人` : null,
      Array.isArray(data.brands) ? `${data.brands.length} 個品牌` : null,
    ].filter(Boolean).join("、");
    if (!confirm(`匯入這份備份(${summary})會覆蓋目前所有資料,確定?`)) return;

    if (Array.isArray(data.tools)) state.localTools = data.tools;
    if (Array.isArray(data.categories)) state.categories = data.categories;
    if (Array.isArray(data.creators)) state.creators = data.creators;
    if (Array.isArray(data.brands)) state.brands = data.brands;

    saveTools();
    saveCats();
    saveCreators();
    saveBrands();

    render();
    toast("匯入成功");
    document.getElementById("backup-popover").hidden = true;
  } catch (err) {
    toast("匯入失敗:" + (err?.message || "未知錯誤"));
  }
}

/* ===== category picker ===== */
function initCategoryPicker() {
  const sel = document.getElementById("category-select");
  if (!sel) return;
  sel.addEventListener("change", (e) => {
    if (e.target.value === "__new__") {
      e.target.value = "";
      updateSelectDeleteBtn("category");
      openMiniPopover({
        title: "新增分類",
        placeholder: "例如:生活 / CLO / 查詢",
        onConfirm: (val) => {
          if (!val) return;
          ensureCategory(val);
          renderCategorySelect(val);
        },
      });
      return;
    }
    updateSelectDeleteBtn("category");
  });
  document.getElementById("category-delete")?.addEventListener("click", () => {
    const v = sel.value;
    if (v && v !== "__new__") deleteCategory(v);
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
  updateSelectDeleteBtn?.("category");
}

/* ===== icon picker (single dropdown) ===== */
function initIconPicker() {
  const trigger = document.getElementById("icon-menu-btn");
  const menu = document.getElementById("icon-menu");
  const file = document.getElementById("icon-file");
  if (!trigger || !menu || !file) return;

  const closeMenu = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const openMenu = () => {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  menu.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-icon-action]");
    if (!btn) return;
    e.stopPropagation();
    const action = btn.dataset.iconAction;
    closeMenu();
    if (action === "upload") {
      file.click();
    } else if (action === "url") {
      const current = $("#add-form").elements.icon.value || "";
      openMiniPopover({
        title: "圖片網址",
        placeholder: "https://...",
        defaultValue: current.startsWith("data:") ? "" : current,
        hint: "貼上任何圖片的網址,儲存後會顯示為工具圖示",
        type: "url",
        onConfirm: (val) => setIcon(val || ""),
      });
    } else if (action === "clear") {
      setIcon("");
    }
  });

  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    if (e.target.closest("#icon-menu")) return;
    if (e.target.closest("#icon-menu-btn")) return;
    closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) closeMenu();
  });

  file.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) { toast("請選圖片檔"); return; }
    try {
      const dataUrl = await readAndResize(f, 256);
      setIcon(dataUrl);
    } catch {
      toast("圖片讀取失敗");
    }
    e.target.value = "";
  });
}

function setIcon(value) {
  const f = $("#add-form").elements;
  f.icon.value = value || "";
  updateIconPreview();
}

function updateIconPreview() {
  const f = $("#add-form").elements;
  const preview = document.getElementById("icon-preview");
  const img = document.getElementById("icon-preview-img");
  const letter = document.getElementById("icon-preview-letter");
  const clearBtn = document.getElementById("icon-menu-clear");
  const sep = document.getElementById("icon-menu-sep");
  const icon = f.icon.value;
  const name = f.name.value;

  letter.textContent = initial(name);

  const showClear = (visible) => {
    if (clearBtn) clearBtn.hidden = !visible;
    if (sep) sep.hidden = !visible;
  };

  if (icon) {
    img.onerror = () => {
      img.hidden = true;
      img.removeAttribute("src");
      showClear(false);
    };
    img.src = icon;
    img.hidden = false;
    showClear(true);
  } else {
    img.hidden = true;
    img.removeAttribute("src");
    showClear(false);
  }

  const cat = state.categories.find((c) => c.name === f.category.value);
  preview.dataset.cv = cat ? String(cat.color) : "0";
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
    if (!pop.hidden && state.anchorEl) positionPopover(pop, state.anchorEl);
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

  state.editingFiles = [];

  if (id) {
    const t = allTools().find((x) => x.id === id);
    if (t) {
      form.elements.id.value = t.id;
      form.elements.name.value = t.name || "";
      if (t.creator) ensureCreator(t.creator);
      renderCreatorSelect(t.creator || "");
      renderCategorySelect(t.category || "");
      const tType = (t.type === "file" || t.type === "link") ? t.type : "link";
      setType(tType);
      form.elements.url.value = t.url === "#" ? "" : (t.url || "");
      form.elements.description.value = t.description || "";
      form.elements.tags.value = (t.tags || []).join(", ");
      form.elements.icon.value = t.icon || "";
      if (t.brand) ensureBrand(t.brand);
      renderBrandSelect(t.brand || "");
      if (Array.isArray(t.files)) {
        state.editingFiles = t.files.map((f) => ({ ...f }));
      }
    }
  } else {
    renderCreatorSelect("");
    renderCategorySelect(state.prefillCategory || "");
    renderBrandSelect("");
    form.elements.icon.value = "";
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
    tags: f.tags.value.split(",").map((s) => s.trim()).filter(Boolean),
    icon: f.icon.value.trim(),
    brand: (f.brand?.value || "").trim(),
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
  if (d.tags?.length) f.tags.value = d.tags.join(", ");
  if (d.icon) f.icon.value = d.icon;
}

function saveTool() {
  const d = formData();
  if (!d.name || !d.creator) {
    toast("請填寫工具名稱與製作人");
    return;
  }
  if (d.type === "file") {
    if (!state.editingFiles.length) {
      toast("請上傳至少一個檔案");
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
    tags: d.tags,
    icon: d.icon || "",
    brand: d.type === "file" ? d.brand : "",
    files: d.type === "file"
      ? state.editingFiles.map((f) => ({
          key: f.key,
          name: f.name,
          size: f.size,
          uploadedAt: f.uploadedAt,
          uploadedBy: f.uploadedBy || "",
        }))
      : [],
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
          name: gh.repo, creator: gh.owner, url, type: "link", tags: [], icon: "",
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
    tags: data.topics || [],
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
      tags: [],
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
  if (info.tags?.length) f.tags.value = info.tags.join(", ");
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
function positionPopover(popEl, anchor) {
  const panel = popEl.querySelector(".popover-panel");
  const arrow = popEl.querySelector(".popover-arrow");
  const r = anchor.getBoundingClientRect();
  const panelWidth = panel.offsetWidth || (panel.classList.contains("popover-panel-sm") ? 360 : 460);
  const panelHeight = panel.offsetHeight || 500;
  const gap = 10;
  const margin = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const anchorCenterX = r.left + r.width / 2;
  // Anchor on the left half → open to the right; right half → open to the left.
  const anchorOnLeft = anchorCenterX < vw / 2;

  let top = r.bottom + gap;
  if (top + panelHeight > vh - margin && r.top > panelHeight + margin) {
    top = Math.max(margin, r.top - panelHeight - gap);
  }
  top = Math.max(margin, Math.min(top, vh - panelHeight - margin));

  let left;
  if (anchorOnLeft) {
    left = r.left;
    if (left + panelWidth > vw - margin) left = vw - panelWidth - margin;
    if (left < margin) left = margin;
  } else {
    left = r.right - panelWidth;
    if (left < margin) left = margin;
    if (left + panelWidth > vw - margin) left = vw - panelWidth - margin;
  }

  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
  panel.style.right = "auto";

  const arrowFromLeft = Math.max(12, Math.min(panelWidth - 24, anchorCenterX - left - 6));
  arrow.style.left = `${arrowFromLeft}px`;
  arrow.style.right = "auto";
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
