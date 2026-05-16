const LS_TOOLS_KEY = "dpcHub.tools.v1";
const LS_DRAFT_KEY = "dpcHub.draft.v1";

const state = {
  seedTools: [],
  localTools: [],
  filter: "all",
  query: "",
  editingId: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    const res = await fetch("tools.json", { cache: "no-cache" });
    const data = await res.json();
    state.seedTools = data.tools || [];
  } catch (e) {
    state.seedTools = [];
  }
  state.localTools = loadLocalTools();

  renderFilters();
  renderGrid();
  renderStats();

  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    renderGrid();
  });

  $("#open-add").addEventListener("click", () => openDrawer());

  initDrawer();
  initModal();
  restoreDraft();
}

/* ----- storage ----- */
function loadLocalTools() {
  try {
    return JSON.parse(localStorage.getItem(LS_TOOLS_KEY) || "[]");
  } catch { return []; }
}
function saveLocalTools() {
  localStorage.setItem(LS_TOOLS_KEY, JSON.stringify(state.localTools));
}

/* ----- data helpers ----- */
function allTools() {
  const localIds = new Set(state.localTools.map((t) => t.id));
  const seed = state.seedTools.filter((t) => !localIds.has(t.id));
  return [...seed, ...state.localTools];
}
function uniq(arr) { return Array.from(new Set(arr)); }

function filteredTools() {
  return allTools().filter((t) => {
    if (state.filter !== "all" && t.category !== state.filter) return false;
    if (!state.query) return true;
    const hay = [t.name, t.creator, t.description, t.category, ...(t.tags || [])]
      .join(" ").toLowerCase();
    return hay.includes(state.query);
  });
}

/* ----- render ----- */
function renderStats() {
  const list = allTools();
  $("#stat-total").textContent = list.length;
  $("#stat-creators").textContent = uniq(list.map((t) => t.creator)).length;
  $("#stat-categories").textContent = uniq(list.map((t) => t.category).filter(Boolean)).length;

  const dl = $("#cat-list");
  dl.innerHTML = uniq(list.map((t) => t.category).filter(Boolean))
    .map((c) => `<option value="${escapeAttr(c)}"></option>`).join("");
}

function renderFilters() {
  const cats = uniq(allTools().map((t) => t.category).filter(Boolean));
  const bar = $("#filters");
  bar.innerHTML = "";

  bar.appendChild(makeChip("全部", "all"));
  cats.forEach((c) => bar.appendChild(makeChip(c, c)));

  function makeChip(label, key) {
    const el = document.createElement("button");
    el.className = "chip" + (state.filter === key ? " active" : "");
    el.textContent = label;
    el.addEventListener("click", () => {
      state.filter = key;
      $$("#filters .chip").forEach((c) => c.classList.remove("active"));
      el.classList.add("active");
      renderGrid();
    });
    return el;
  }
}

const TYPE_META = {
  url: { label: "URL", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>` },
  python: { label: "PY", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v6h8m-8 6H4v6h6m0-12V3h6v6m0 6h4v-6h-6m0 6v6"/></svg>` },
  iframe: { label: "EMBED", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>` },
};

function renderGrid() {
  const grid = $("#tools-grid");
  const empty = $("#empty");
  const list = filteredTools();
  const localIds = new Set(state.localTools.map((t) => t.id));

  if (!list.length) {
    grid.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  grid.innerHTML = list.map((t, i) => cardHTML(t, i, localIds.has(t.id))).join("");

  $$("#tools-grid .card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".card-edit")) {
        openDrawer(card.dataset.id);
        return;
      }
      const id = card.dataset.id;
      const tool = allTools().find((t) => t.id === id);
      if (tool) openTool(tool);
    });
  });
}

function initial(name) {
  if (!name) return "?";
  return name.trim().charAt(0).toUpperCase();
}

function cardHTML(t, i, isLocal) {
  const type = TYPE_META[t.type] || TYPE_META.url;
  const cv = i % 8;
  const tags = (t.tags || []).slice(0, 3)
    .map((tg) => `<span class="tag">${escapeHTML(tg)}</span>`).join("");
  const pill = isLocal ? `<span class="local-pill">本機</span>` : "";
  const editBtn = isLocal
    ? `<button class="card-edit" title="編輯"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button>`
    : "";

  return `
    <article class="card ${isLocal ? "editable" : ""}" data-cv="${cv}" data-id="${escapeAttr(t.id)}">
      ${editBtn}
      <div class="card-top">
        <div class="card-icon">${escapeHTML(initial(t.name))}</div>
        <span class="type-badge ${t.type || "url"}">${type.icon}${type.label}</span>
      </div>
      <h3 class="card-title">${escapeHTML(t.name)} ${pill}</h3>
      <p class="card-desc">${escapeHTML(t.description || "—")}</p>
      <div class="card-tags">${tags}</div>
      <div class="card-foot">
        <span class="creator">
          <span class="avatar">${escapeHTML(initial(t.creator))}</span>
          ${escapeHTML(t.creator || "Unknown")}
        </span>
        <span class="version-badge">v${escapeHTML(t.version || "0.0.0")}</span>
      </div>
    </article>
  `;
}

function openTool(t) {
  if (!t.url || t.url === "#") {
    const yes = confirm(`「${t.name}」尚未設定連結。要現在編輯嗎?`);
    if (yes) openDrawer(t.id, /*forceLocal*/ true);
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

/* ----- drawer (add / edit) ----- */
function initDrawer() {
  const drawer = $("#drawer");
  drawer.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeDrawer)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !drawer.hidden) closeDrawer();
  });

  $("#save-tool").addEventListener("click", saveTool);
  $("#delete-tool").addEventListener("click", deleteTool);

  $("#add-form").addEventListener("input", () => {
    if (state.editingId) return;
    const data = formData();
    localStorage.setItem(LS_DRAFT_KEY, JSON.stringify(data));
  });
}

function openDrawer(id = null, forceLocal = false) {
  state.editingId = id;
  const form = $("#add-form");
  form.reset();
  $("#drawer-title").textContent = id ? "編輯工具" : "新增工具";
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
  }

  $("#drawer").hidden = false;
}

function closeDrawer() {
  $("#drawer").hidden = true;
  state.editingId = null;
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
  try {
    const raw = localStorage.getItem(LS_DRAFT_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    const f = $("#add-form").elements;
    if (d.name) f.name.value = d.name;
    if (d.creator) f.creator.value = d.creator;
    if (d.version) f.version.value = d.version;
    if (d.category) f.category.value = d.category;
    if (d.type) f.type.value = d.type;
    if (d.url) f.url.value = d.url;
    if (d.description) f.description.value = d.description;
    if (d.tags && d.tags.length) f.tags.value = d.tags.join(", ");
  } catch {}
}

function saveTool() {
  const d = formData();
  if (!d.name || !d.creator || !d.url) {
    alert("請填寫工具名稱、製作人與 URL。");
    return;
  }
  const id = d.id || slugify(d.name);
  const record = {
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

  const idx = state.localTools.findIndex((t) => t.id === id);
  if (idx >= 0) state.localTools[idx] = record;
  else state.localTools.push(record);

  saveLocalTools();
  localStorage.removeItem(LS_DRAFT_KEY);
  closeDrawer();
  renderFilters();
  renderGrid();
  renderStats();
}

function deleteTool() {
  if (!state.editingId) return;
  if (!confirm("確定要刪除這個工具?")) return;
  state.localTools = state.localTools.filter((t) => t.id !== state.editingId);
  saveLocalTools();
  closeDrawer();
  renderFilters();
  renderGrid();
  renderStats();
}

/* ----- iframe modal ----- */
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

/* ----- utils ----- */
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
