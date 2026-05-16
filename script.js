const state = {
  tools: [],
  filter: "all",
  query: "",
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

document.addEventListener("DOMContentLoaded", init);

async function init() {
  $("#year").textContent = new Date().getFullYear();
  try {
    const res = await fetch("tools.json", { cache: "no-cache" });
    const data = await res.json();
    state.tools = data.tools || [];
  } catch (e) {
    state.tools = [];
    console.error("Failed to load tools.json", e);
  }

  renderStats();
  renderFilters();
  renderGrid();

  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    renderGrid();
  });

  initAddForm();
  initModal();
}

function uniq(arr) { return Array.from(new Set(arr)); }

function renderStats() {
  $("#stat-total").textContent = state.tools.length;
  $("#stat-creators").textContent = uniq(state.tools.map((t) => t.creator)).length;
  $("#stat-categories").textContent = uniq(state.tools.map((t) => t.category).filter(Boolean)).length;
}

function renderFilters() {
  const cats = uniq(state.tools.map((t) => t.category).filter(Boolean));
  const bar = $("#filters");
  bar.innerHTML = "";

  const all = makeChip("全部", "all");
  bar.appendChild(all);
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

function filteredTools() {
  return state.tools.filter((t) => {
    if (state.filter !== "all" && t.category !== state.filter) return false;
    if (!state.query) return true;
    const hay = [
      t.name, t.creator, t.description, t.category,
      ...(t.tags || []),
    ].join(" ").toLowerCase();
    return hay.includes(state.query);
  });
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

  if (!list.length) {
    grid.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  grid.innerHTML = list.map((t, i) => cardHTML(t, i)).join("");

  $$("#tools-grid .card").forEach((card) => {
    card.addEventListener("mousemove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
    card.addEventListener("click", () => {
      const id = card.dataset.id;
      const tool = state.tools.find((t) => t.id === id);
      if (!tool) return;
      openTool(tool);
    });
  });
}

function initial(name) {
  if (!name) return "?";
  const ch = name.trim().charAt(0);
  return ch.toUpperCase();
}

function cardHTML(t, i) {
  const type = TYPE_META[t.type] || TYPE_META.url;
  const cv = i % 8;
  const tags = (t.tags || []).slice(0, 4)
    .map((tg) => `<span class="tag">${escapeHTML(tg)}</span>`).join("");

  return `
    <article class="card" data-cv="${cv}" data-id="${escapeAttr(t.id)}">
      <div class="card-top">
        <div class="card-icon">${escapeHTML(initial(t.name))}</div>
        <span class="type-badge ${t.type || "url"}">${type.icon}${type.label}</span>
      </div>
      <h3 class="card-title">${escapeHTML(t.name)}</h3>
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
    alert(`「${t.name}」尚未設定連結。請編輯 tools.json 補上 url。`);
    return;
  }
  if (t.type === "iframe") {
    $("#modal-title").textContent = t.name;
    $("#modal-sub").textContent = `${t.creator} · v${t.version}`;
    $("#modal-frame").src = t.url;
    $("#modal").hidden = false;
    document.body.style.overflow = "hidden";
  } else {
    window.open(t.url, "_blank", "noopener");
  }
}

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
    document.body.style.overflow = "";
  }
}

function initAddForm() {
  const form = $("#add-form");
  const out = $("#json-out");
  const copyBtn = $("#copy-json");

  $("#gen-json").addEventListener("click", () => {
    const data = new FormData(form);
    const name = (data.get("name") || "").trim();
    const creator = (data.get("creator") || "").trim();
    const url = (data.get("url") || "").trim();
    if (!name || !creator || !url) {
      alert("請填寫工具名稱、製作人與 URL。");
      return;
    }
    const obj = {
      id: slugify(name),
      name,
      description: (data.get("description") || "").trim(),
      creator,
      version: (data.get("version") || "1.0.0").trim(),
      category: (data.get("category") || "").trim(),
      type: data.get("type") || "url",
      url,
      tags: (data.get("tags") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      updated: new Date().toISOString().slice(0, 10),
    };
    out.hidden = false;
    out.textContent = JSON.stringify(obj, null, 2) + ",";
    copyBtn.disabled = false;
  });

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(out.textContent);
      const old = copyBtn.textContent;
      copyBtn.textContent = "已複製 ✓";
      setTimeout(() => (copyBtn.textContent = old), 1600);
    } catch {
      alert("複製失敗,請手動選取 JSON。");
    }
  });
}

function slugify(s) {
  return s
    .toLowerCase()
    .trim()
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
