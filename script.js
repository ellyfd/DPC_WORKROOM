const LS_TOOLS_KEY = "dpcHub.tools.v1";
const LS_CATS_KEY = "dpcHub.categories.v1";
const LS_DRAFT_KEY = "dpcHub.draft.v1";
const LS_COLLAPSE_KEY = "dpcHub.collapsed.v1";
const NUM_COLORS = 7;

const state = {
  seedTools: [],
  localTools: [],
  categories: [],
  filter: "all",
  query: "",
  editingId: null,
  editingCat: null,
  prefillCategory: null,
  anchorEl: null,
  collapsed: {},
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
  state.collapsed = loadJSON(LS_COLLAPSE_KEY, {});
  ensureCategoriesFromTools();

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
  el.textContent = state.filter === "all" ? "ALL TOOLS" : state.filter;
}

function renderStats() {
  const list = allTools();
  $("#stat-total").textContent = list.length;
  $("#stat-creators").textContent = uniq(list.map((t) => t.creator)).length;
  $("#stat-categories").textContent = state.categories.length;

  $("#cat-list").innerHTML = state.categories
    .map((c) => `<option value="${escapeAttr(c.name)}"></option>`).join("");
}

function renderFilters() {
  const bar = $("#filters");
  bar.innerHTML = "";
  if (!state.categories.length) return;

  bar.appendChild(makeChip("全部", "all"));
  state.categories.forEach((c) => bar.appendChild(makeChip(c.name, c.name, c.color)));

  function makeChip(label, key, cv) {
    const el = document.createElement("button");
    el.className = "chip" + (state.filter === key ? " active" : "");
    if (typeof cv === "number") el.dataset.cv = String(cv);
    el.innerHTML = (typeof cv === "number" ? `<span class="chip-dot"></span>` : "") + escapeHTML(label);
    el.addEventListener("click", () => {
      state.filter = key;
      $$("#filters .chip").forEach((c) => c.classList.remove("active"));
      el.classList.add("active");
      renderSections();
      renderHeadContext();
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
    area.innerHTML = `<div class="section"><div class="section-empty">沒有符合條件的工具</div></div>`;
    return;
  }

  area.innerHTML = groups.map(sectionHTML).join("");
  wireSections();
}

function sectionHTML(g) {
  const cv = g.color;
  const isSystem = g.system;
  const collapsed = !!state.collapsed[g.name];
  const cards = g.tools.map((t, i) => cardHTML(t, i, cv)).join("");
  const addCard = !isSystem ? `
    <button class="card-add" data-add-cat="${escapeAttr(g.name)}">
      <span class="card-add-plus"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg></span>
      新增到「${escapeHTML(g.name)}」
    </button>
  ` : "";

  const actions = isSystem ? "" : `
    <button class="section-action" title="新增工具" data-add-cat="${escapeAttr(g.name)}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
    </button>
    <button class="section-action" title="編輯分類" data-edit-cat="${escapeAttr(g.name)}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
    </button>
    <button class="section-action danger" title="刪除分類" data-del-cat="${escapeAttr(g.name)}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
    </button>
  `;

  const grid = g.tools.length
    ? `<div class="section-grid">${cards}${addCard}</div>`
    : `<div class="section-grid">
         <div class="section-empty">這個分類還沒有工具${isSystem ? "" : ",按 + 新增"}</div>
         ${addCard}
       </div>`;

  return `
    <section class="section${collapsed ? " collapsed" : ""}" data-cv="${cv}" data-cat="${escapeAttr(g.name)}">
      <div class="section-head" data-toggle-cat="${escapeAttr(g.name)}">
        <div class="section-title-row">
          <span class="section-chevron">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          </span>
          <span class="section-color-dot"></span>
          <span class="section-title">${escapeHTML(g.name)}</span>
          <span class="section-count">${g.tools.length} TOOLS</span>
        </div>
        <div class="section-actions">${actions}</div>
      </div>
      <div class="section-body">${grid}</div>
    </section>
  `;
}

function cardHTML(t, i, cv) {
  const type = TYPE_META[t.type] || TYPE_META.url;
  const tags = (t.tags || []).slice(0, 3)
    .map((tg) => `<span class="tag">${escapeHTML(tg)}</span>`).join("");
  const iconImg = t.icon
    ? `<img src="${escapeAttr(t.icon)}" alt="" onerror="this.remove()" />`
    : "";

  return `
    <article class="card" data-cv="${cv}" data-id="${escapeAttr(t.id)}">
      <button class="card-edit" title="編輯">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
      </button>
      <div class="card-top">
        <div class="card-icon"><span class="ic-letter">${escapeHTML(initial(t.name))}</span>${iconImg}</div>
        <span class="type-badge ${t.type || "url"}">${type.icon}${type.label}</span>
      </div>
      <h3 class="card-title">${escapeHTML(t.name)}</h3>
      <p class="card-desc">${escapeHTML(t.description || "—")}</p>
      <div class="card-tags">${tags}</div>
      <div class="card-foot">
        <span class="creator">
          <span class="avatar">${escapeHTML(initial(t.creator))}</span>
          <span>${escapeHTML(t.creator || "Unknown")}</span>
        </span>
        <span class="version-badge">v${escapeHTML(t.version || "0.0.0")}</span>
      </div>
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
  if (!t.url || t.url === "#") {
    if (confirm(`「${t.name}」尚未設定連結。要現在編輯嗎?`)) {
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

  $("#add-form").addEventListener("input", () => {
    if (state.editingId) return;
    saveJSON(LS_DRAFT_KEY, formData());
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

  if (id) {
    const t = allTools().find((x) => x.id === id);
    if (t) {
      form.elements.id.value = t.id;
      form.elements.name.value = t.name || "";
      form.elements.creator.value = t.creator || "";
      form.elements.version.value = t.version || "1.0.0";
      form.elements.category.value = t.category || "";
      form.elements.type.value = t.type || "url";
      form.elements.url.value = t.url === "#" ? "" : (t.url || "");
      form.elements.description.value = t.description || "";
      form.elements.tags.value = (t.tags || []).join(", ");
    }
  } else {
    restoreDraft();
    if (state.prefillCategory) {
      form.elements.category.value = state.prefillCategory;
      state.prefillCategory = null;
    }
  }

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
    creator: f.creator.value.trim(),
    version: f.version.value.trim() || "1.0.0",
    category: f.category.value.trim(),
    type: f.type.value,
    url: f.url.value.trim(),
    description: f.description.value.trim(),
    tags: f.tags.value.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function restoreDraft() {
  const d = loadJSON(LS_DRAFT_KEY, null);
  if (!d) return;
  const f = $("#add-form").elements;
  if (d.name) f.name.value = d.name;
  if (d.creator) f.creator.value = d.creator;
  if (d.version) f.version.value = d.version;
  if (d.category) f.category.value = d.category;
  if (d.type) f.type.value = d.type;
  if (d.url) f.url.value = d.url;
  if (d.description) f.description.value = d.description;
  if (d.tags?.length) f.tags.value = d.tags.join(", ");
}

function saveTool() {
  const d = formData();
  if (!d.name || !d.creator || !d.url) {
    toast("請填寫工具名稱、製作人與 URL");
    return;
  }
  const id = d.id || slugify(d.name);

  const existing = state.localTools.find((t) => t.id === id);
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
    updated: new Date().toISOString().slice(0, 10),
  };
  if (pendingIcon[id]) {
    record.icon = pendingIcon[id];
    delete pendingIcon[id];
  }
  if (pendingIcon[d.id]) {
    record.icon = pendingIcon[d.id];
    delete pendingIcon[d.id];
  }

  const idx = state.localTools.findIndex((t) => t.id === id);
  if (idx >= 0) state.localTools[idx] = record;
  else state.localTools.push(record);

  if (d.category) ensureCategory(d.category);

  saveTools();
  localStorage.removeItem(LS_DRAFT_KEY);
  closeToolPopover();
  render();
  toast(idx >= 0 ? "已更新" : "已新增");
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
    let info = null;
    const gh = parseGitHub(url);
    if (gh) info = await fetchGitHubRepo(gh.owner, gh.repo);
    else info = parseGenericURL(url);

    if (!info) throw new Error("找不到資訊");
    applyAutoFill(info);
    box.classList.add("success");
    $("#auto-hint").textContent = gh
      ? `✓ 已讀取 GitHub repo:${gh.owner}/${gh.repo}`
      : "✓ 已從網址讀取網域,請補上名稱與描述";
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
    icon: data.owner?.avatar_url ? `${data.owner.avatar_url}&s=80` : "",
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
      type: "url",
      tags: [],
      icon: `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`,
    };
  } catch {
    return null;
  }
}

function applyAutoFill(info) {
  const f = $("#add-form").elements;
  if (info.name) f.name.value = info.name;
  if (info.creator) f.creator.value = info.creator;
  if (info.description) f.description.value = info.description;
  if (info.url) f.url.value = info.url;
  if (info.type) f.type.value = info.type;
  if (info.tags?.length) f.tags.value = info.tags.join(", ");
  if (info.icon) {
    const id = f.id.value || slugify(f.name.value);
    f.id.value = id;
    pendingIcon[id] = info.icon;
  }
}

const pendingIcon = {};

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
