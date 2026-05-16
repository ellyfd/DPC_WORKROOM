const LS_TOOLS_KEY = "dpcHub.tools.v1";
const LS_CATS_KEY = "dpcHub.categories.v1";
const LS_CREATORS_KEY = "dpcHub.creators.v1";
const LS_BRANDS_KEY = "dpcHub.brands.v1";
const LS_DRAFT_KEY = "dpcHub.draft.v1";
const LS_COLLAPSE_KEY = "dpcHub.collapsed.v1";
const NUM_COLORS = 7;
const MAX_PY_BYTES = 500_000;   // 500KB cap for stored Python files

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
  // file currently attached to the open popover ({ name, size, content, isNew })
  editingFile: null,
  // version that was loaded when the popover opened (so we can detect bumps)
  editingOriginalVersion: "",
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    const res = await fetch("tools.json", { cache: "no-cache" });
    const data = await res.json();
    state.seedTools = data.tools || [];
  } catch {
    state.seedTools = [];
  }
  state.localTools = loadJSON(LS_TOOLS_KEY, []);
  state.categories = loadJSON(LS_CATS_KEY, []);
  state.creators = loadJSON(LS_CREATORS_KEY, []);
  state.brands = loadJSON(LS_BRANDS_KEY, []);
  state.collapsed = loadJSON(LS_COLLAPSE_KEY, {});
  ensureCategoriesFromTools();
  ensureCreatorsFromTools();
  ensureBrandsFromTools();

  render();

  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
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
  initModal();
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

/* ===== storage ===== */
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; }
  catch { return fallback; }
}
function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
const saveTools = () => saveJSON(LS_TOOLS_KEY, state.localTools);
const saveCats = () => saveJSON(LS_CATS_KEY, state.categories);

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

function ensureBrandsFromTools() {
  const used = uniq(allTools().map((t) => t.brand).filter(Boolean));
  let changed = false;
  for (const name of used) {
    if (!state.brands.includes(name)) {
      state.brands.push(name);
      changed = true;
    }
  }
  if (changed) saveJSON(LS_BRANDS_KEY, state.brands);
}

function ensureBrand(name) {
  if (!name) return;
  if (!state.brands.includes(name)) {
    state.brands.push(name);
    saveJSON(LS_BRANDS_KEY, state.brands);
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
  if (changed) saveJSON(LS_CREATORS_KEY, state.creators);
}

function ensureCreator(name) {
  if (!name) return;
  if (!state.creators.includes(name)) {
    state.creators.push(name);
    saveJSON(LS_CREATORS_KEY, state.creators);
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
  const type = TYPE_META[t.type] || TYPE_META.url;
  const iconImg = t.icon
    ? `<img src="${escapeAttr(t.icon)}" alt="" onerror="this.remove()" />`
    : "";
  const tipParts = [t.creator ? `製作:${t.creator}` : "", t.version ? `v${t.version}` : "", t.description].filter(Boolean);
  const tip = tipParts.length ? `${t.name}\n${tipParts.join(" · ")}` : t.name;

  return `
    <article class="card" data-cv="${cv}" data-id="${escapeAttr(t.id)}" title="${escapeAttr(tip)}">
      <button class="card-edit" title="編輯">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
      </button>
      <div class="card-top">
        <div class="card-icon">
          <span class="ic-letter">${escapeHTML(initial(t.name))}</span>
          ${iconImg}
        </div>
        <span class="type-badge ${t.type || "url"}">${type.icon}</span>
      </div>
      <h3 class="card-title">${escapeHTML(t.name)}</h3>
    </article>
  `;
}

function wireSections() {
  $$("#sections-area .card").forEach((card) => {
    card.addEventListener("click", (e) => {
      const editBtn = e.target.closest(".card-edit");
      if (editBtn) {
        openToolPopover(card.dataset.id, editBtn);
        return;
      }
      const tool = allTools().find((t) => t.id === card.dataset.id);
      if (tool) openTool(tool);
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
  // Python tools prefer the attached .py file (download); fall back to URL.
  if (t.type === "python" && t.file?.content) {
    downloadPyFile(t);
    toast(`下載 ${t.file.name}`);
    return;
  }
  if (!t.url || t.url === "#") {
    if (confirm(`「${t.name}」尚未設定連結或檔案。要現在編輯嗎?`)) {
      openToolPopover(t.id);
    }
    return;
  }
  if (t.type === "iframe") {
    $("#modal-title").textContent = t.name;
    $("#modal-sub").textContent = `${t.creator} · v${t.version}`;
    $("#modal-frame").src = t.url;
    $("#modal").hidden = false;
  } else {
    window.open(t.url, "_blank", "noopener");
  }
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
      openMiniPopover({
        title: "新增製作人",
        placeholder: "輸入名稱",
        onConfirm: (val) => {
          if (!val) return;
          ensureCreator(val);
          renderCreatorSelect(val);
        },
      });
    }
  });
}

/* ===== brand picker ===== */
function initBrandPicker() {
  const sel = document.getElementById("brand-select");
  if (!sel) return;
  sel.addEventListener("change", (e) => {
    if (e.target.value === "__new__") {
      e.target.value = "";
      openMiniPopover({
        title: "新增品牌 / 客制",
        placeholder: "輸入品牌或客制名稱",
        onConfirm: (val) => {
          if (!val) return;
          ensureBrand(val);
          renderBrandSelect(val);
        },
      });
    }
  });
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
  // Toggle elements whose data-show-for-type lists this type
  document.querySelectorAll("[data-show-for-type]").forEach((el) => {
    const types = el.dataset.showForType.split(",").map((s) => s.trim());
    el.hidden = !types.includes(type);
  });

  // URL label: required for url/iframe, optional for python
  const urlLabelText = document.getElementById("url-label");
  const urlInput = document.querySelector("#add-form input[name='url']");
  if (urlLabelText && urlInput) {
    if (type === "python") {
      urlLabelText.textContent = "URL(選填)";
      urlInput.placeholder = "若是 GitHub repo,可貼上連結";
    } else {
      urlLabelText.textContent = "URL *";
      urlInput.placeholder = "https://...";
    }
  }

  if (type === "python") {
    renderBrandSelect(document.getElementById("brand-select")?.value || "");
    renderFileInfo();
  }
}

/* ===== file upload (Python) ===== */
function initFileUpload() {
  const drop = document.getElementById("file-drop");
  const input = document.getElementById("file-input");
  const replace = document.getElementById("file-replace-btn");
  const remove = document.getElementById("file-remove-btn");
  if (!drop || !input) return;

  drop.addEventListener("click", () => input.click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
  input.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  });
  replace?.addEventListener("click", () => input.click());
  remove?.addEventListener("click", () => {
    state.editingFile = null;
    renderFileInfo();
  });
}

async function handleFile(file) {
  if (file.size > MAX_PY_BYTES) {
    toast(`檔案太大(${formatBytes(file.size)},上限 ${formatBytes(MAX_PY_BYTES)})`);
    return;
  }
  try {
    const content = await readFileAsText(file);
    state.editingFile = {
      name: file.name,
      size: file.size,
      content,
      uploadedAt: new Date().toISOString().slice(0, 10),
      isNew: true,
    };
    renderFileInfo();
    autoFillFromFilename(file.name);
  } catch {
    toast("檔案讀取失敗");
  }
}

function autoFillFromFilename(filename) {
  // Suggest tool name from the .py filename if name is still empty.
  const f = $("#add-form").elements;
  if (f.name.value) return;
  const base = filename.replace(/\.py$/i, "").replace(/[-_]+/g, " ").trim();
  if (base) {
    const pretty = base.replace(/\b\w/g, (c) => c.toUpperCase());
    f.name.value = pretty;
    updateIconPreview();
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsText(file);
  });
}

function renderFileInfo() {
  const drop = document.getElementById("file-drop");
  const info = document.getElementById("file-info");
  const nameEl = document.getElementById("file-info-name");
  const sizeEl = document.getElementById("file-info-size");
  const hint = document.getElementById("file-version-hint");
  if (!drop || !info) return;

  const file = state.editingFile;
  if (!file) {
    drop.hidden = false;
    info.hidden = true;
    if (hint) hint.hidden = true;
    return;
  }
  drop.hidden = true;
  info.hidden = false;
  if (nameEl) nameEl.textContent = file.name;
  if (sizeEl) {
    const ver = $("#add-form").elements.version?.value || "—";
    sizeEl.textContent = `${formatBytes(file.size)} · v${ver}${file.uploadedAt ? " · 上傳 " + file.uploadedAt : ""}`;
  }
  if (hint) {
    // Show the version-bump nudge only when we just attached a new file in an
    // edit session — i.e. when there's an editingId and isNew is true.
    hint.hidden = !(state.editingId && file.isNew);
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function downloadPyFile(record) {
  if (!record.file?.content) return;
  const blob = new Blob([record.file.content], { type: "text/x-python" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = record.file.name || `${record.id}.py`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

/* ===== category picker ===== */
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

/* ===== icon picker ===== */
function initIconPicker() {
  const upload = document.getElementById("icon-upload-btn");
  const urlBtn = document.getElementById("icon-url-btn");
  const clear = document.getElementById("icon-clear-btn");
  const file = document.getElementById("icon-file");
  if (!upload || !urlBtn || !clear || !file) return;

  upload.addEventListener("click", () => file.click());
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

  urlBtn.addEventListener("click", () => {
    const current = $("#add-form").elements.icon.value || "";
    openMiniPopover({
      title: "圖片網址",
      placeholder: "https://...",
      defaultValue: current.startsWith("data:") ? "" : current,
      hint: "貼上任何圖片的網址,儲存後會顯示為工具圖示",
      type: "url",
      onConfirm: (val) => setIcon(val || ""),
    });
  });

  clear.addEventListener("click", () => setIcon(""));
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
  const clearBtn = document.getElementById("icon-clear-btn");
  const icon = f.icon.value;
  const name = f.name.value;

  letter.textContent = initial(name);

  if (icon) {
    img.onerror = () => {
      img.hidden = true;
      img.removeAttribute("src");
      clearBtn.hidden = true;
    };
    img.src = icon;
    img.hidden = false;
    clearBtn.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute("src");
    clearBtn.hidden = true;
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

  $("#auto-url").addEventListener("paste", () => setTimeout(autoFetch, 30));
  $("#auto-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); autoFetch(); }
  });

  $("#add-form").addEventListener("input", (e) => {
    if (e.target.name === "name" || e.target.name === "category") {
      updateIconPreview();
    }
    if (e.target.name === "version") renderFileInfo();
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

  state.editingFile = null;
  state.editingOriginalVersion = "";

  if (id) {
    const t = allTools().find((x) => x.id === id);
    if (t) {
      form.elements.id.value = t.id;
      form.elements.name.value = t.name || "";
      if (t.creator) ensureCreator(t.creator);
      renderCreatorSelect(t.creator || "");
      renderCategorySelect(t.category || "");
      form.elements.version.value = t.version || "1.0.0";
      state.editingOriginalVersion = form.elements.version.value;
      setType(t.type || "url");
      form.elements.url.value = t.url === "#" ? "" : (t.url || "");
      form.elements.description.value = t.description || "";
      form.elements.tags.value = (t.tags || []).join(", ");
      form.elements.icon.value = t.icon || "";
      if (t.brand) ensureBrand(t.brand);
      renderBrandSelect(t.brand || "");
      if (t.file?.content) {
        state.editingFile = { ...t.file, isNew: false };
      }
    }
  } else {
    renderCreatorSelect("");
    renderCategorySelect(state.prefillCategory || "");
    renderBrandSelect("");
    form.elements.icon.value = "";
    form.elements.version.value = "1.0.0";
    setType("url");
    restoreDraft();
    if (state.prefillCategory) {
      renderCategorySelect(state.prefillCategory);
      state.prefillCategory = null;
    }
  }
  renderFileInfo();
  updateIconPreview();

  const anchorEl = anchor || $("#open-add");
  state.anchorEl = anchorEl;
  $("#popover").hidden = true;
  $("#cat-popover").hidden = true;
  $("#popover").hidden = false;
  positionPopover($("#popover"), anchorEl);
  setTimeout(() => {
    if (id) form.elements.name.focus();
    else $("#auto-url").focus();
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
    version: f.version.value.trim() || "1.0.0",
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
  if (d.version) f.version.value = d.version;
  if (d.category) {
    const opts = Array.from(f.category.options || []);
    if (opts.some((o) => o.value === d.category)) f.category.value = d.category;
  }
  if (d.type) f.type.value = d.type;
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
  if (d.type === "python") {
    if (!state.editingFile && !d.url) {
      toast("Python 工具請上傳檔案,或填一個連結");
      return;
    }
  } else {
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
    version: d.version,
    category: d.category,
    type: d.type,
    url: d.url,
    tags: d.tags,
    icon: d.icon || "",
    brand: d.type === "python" ? d.brand : "",
    file: d.type === "python" && state.editingFile
      ? {
          name: state.editingFile.name,
          size: state.editingFile.size,
          content: state.editingFile.content,
          uploadedAt: state.editingFile.uploadedAt,
        }
      : null,
    updated: new Date().toISOString().slice(0, 10),
  };

  // Warn if user replaced the file but didn't bump the version. Save anyway.
  if (state.editingFile?.isNew && state.editingId && d.version === state.editingOriginalVersion) {
    toast("提示:上傳了新檔案但版本沒改");
  }

  const idx = state.localTools.findIndex((t) => t.id === id);
  if (idx >= 0) state.localTools[idx] = record;
  else state.localTools.push(record);

  if (d.category) ensureCategory(d.category);
  ensureCreator(d.creator);

  if (d.brand) ensureBrand(d.brand);
  saveTools();
  localStorage.removeItem(LS_DRAFT_KEY);
  state.editingFile = null;
  state.editingOriginalVersion = "";
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
  const box = $(".auto-fill");
  box.classList.remove("success", "error");
  $("#auto-url").value = "";
  $("#auto-hint").textContent = "支援 GitHub repo(讀取名稱、描述、作者、語言、tags)與一般 URL(讀取網域)";
}

async function autoFetch() {
  const url = $("#auto-url").value.trim();
  if (!url) return;
  const box = $(".auto-fill");
  box.classList.remove("success", "error");
  const btn = $("#auto-fetch");
  btn.disabled = true;
  $("#auto-hint").textContent = "讀取中…";

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
          name: gh.repo, creator: gh.owner, url, type: "url", tags: [], icon: "",
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
      box.classList.add("error");
      $("#auto-hint").textContent = `${fallbackNote}。已先用 repo 名稱與 owner 填好,請手動補上描述與正確 URL。`;
    } else {
      box.classList.add("success");
      $("#auto-hint").textContent = gh
        ? `✓ 已讀取 GitHub repo:${gh.owner}/${gh.repo}`
        : "✓ 已從網址讀取網域,請補上名稱與描述";
    }
  } catch (err) {
    box.classList.add("error");
    $("#auto-hint").textContent = "讀取失敗:" + (err?.message || "未知錯誤") + "。請手動填寫。";
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
  const lang = (data.language || "").toLowerCase();
  return {
    name: data.name,
    description: data.description || "",
    creator: data.owner?.login || owner,
    url: data.html_url,
    type: lang === "python" ? "python" : "url",
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
    // Skip the favicon — at 92px it scales up blurry. The gradient + initial
    // letter looks cleaner and is more readable.
    return {
      name,
      description: "",
      creator: "",
      url: u.href,
      type: "url",
      tags: [],
      icon: "",
    };
  } catch {
    return null;
  }
}

function applyAutoFill(info) {
  const f = $("#add-form").elements;
  if (info.name) f.name.value = info.name;
  if (info.creator) {
    ensureCreator(info.creator);
    renderCreatorSelect(info.creator);
  }
  if (info.description) f.description.value = info.description;
  if (info.url) f.url.value = info.url;
  if (info.type) f.type.value = info.type;
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

/* ===== iframe modal ===== */
function initModal() {
  const modal = $("#modal");
  modal.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeModal)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeModal();
  });
  function closeModal() {
    modal.hidden = true;
    $("#modal-frame").src = "about:blank";
  }
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
