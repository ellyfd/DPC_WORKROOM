// DPC Hub — 啟動台板面:render、卡片、拖曳、篩選、本週上新
import { allTools, ensureCategory, groupedTools, listAllBrands, sortToolsByOrder } from "./data.mjs?v=20260804e";
import { downloadFile, isPageTool, pageUrl } from "./files.mjs?v=20260804e";
import { $, $$, cssEscape, escapeAttr, escapeHTML, initial, loadJSON, queryTokens, saveJSON, toast, uniq } from "./helpers.mjs?v=20260804e";
import { openTileContextMenu, openTileFileMenuUploadOnly } from "./menus.mjs?v=20260804e";
import { deleteCategory, openCatPopover, openToolPopover } from "./popovers.mjs?v=20260804e";
import { LS_COLLAPSE_KEY, LS_NEW_SEEN_KEY, NUM_COLORS, state } from "./state.mjs?v=20260804e";
import { favoriteTools, saveCats, saveTools, trackHit } from "./sync.mjs?v=20260804e";
import { matchingTips, tipResultsHTML } from "./tips.mjs?v=20260804e";

/* ===== 本週上新 (new arrivals) ===== */

const NEW_WINDOW_DAYS = 3;

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

// Multi-keyword search: split the query on spaces and require every keyword
// to appear somewhere (any order) —「Cowork 本機」hits "Cowork 在本機做事情".

function matchesQuery(t) {
  const tokens = queryTokens(state.query);
  if (!tokens.length) return true;
  // Filenames of uploaded versions count too — "上次那個 xxx.py" is exactly
  // how people remember file tools.
  const fileNames = (t.files || []).map((f) => (f && f.name) || "").join(" ");
  const hay = [t.name, t.creator, t.description, t.category, t.brand, fileNames]
    .join(" ").toLowerCase();
  return tokens.every((tk) => hay.includes(tk));
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

  // The header search also looks through 小知識 — every match shows as its
  // own post above the tool sections. The scope filter narrows the search:
  // 「小知識」shows only tips (the whole wall when there's no query yet),
  // 「工具」skips them entirely.
  const scope = state.searchScope;
  let tipsBlock = "";
  if (scope !== "tools" && (state.query || scope === "tips")) {
    const tipMatches = matchingTips(state.query);
    tipsBlock = tipMatches.length ? tipResultsHTML(tipMatches, state.query) : "";
  }

  if (scope === "tips") {
    area.innerHTML = tipsBlock ||
      `<div class="section"><div class="section-body"><div class="section-grid"><div class="section-empty">沒有符合條件的小知識</div></div></div></div>`;
    return;
  }

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
    // Found tips but no tools → just show the tips block (no "no tools" noise).
    area.innerHTML = tipsBlock ||
      `<div class="section"><div class="section-body"><div class="section-grid"><div class="section-empty">沒有符合條件的工具</div></div></div></div>`;
    return;
  }

  // 我的常用 — only on the unfiltered board (searches/filters answer a
  // different question, and the row would just duplicate results there).
  const showFav = !state.query && !state.brandFilter && state.filter === "all";
  const favBlock = showFav ? favoritesSectionHTML() : "";

  // Category sections flow in a masonry wrapper so a one-tool category only
  // takes the height it needs instead of stretching to its row's tallest.
  area.innerHTML =
    tipsBlock + favBlock +
    `<div class="board-cols">${groups.map((g) => sectionHTML(g, true)).join("")}</div>`;
  wireSections();
}


function favoritesSectionHTML() {
  const tools = favoriteTools();
  if (!tools.length) return "";
  const catColor = new Map(state.categories.map((c) => [c.name, c.color]));
  // Favorites are shortcuts, not a category — no dragging in or out.
  const cards = tools
    .map((t) => cardHTML(t, catColor.get(t.category) ?? 0).replace('draggable="true"', 'draggable="false"'))
    .join("");
  return `
    <section class="section section-fav" data-fav="1">
      <div class="section-head">
        <div class="section-title-row">
          <span class="fav-star" aria-hidden="true">⭐</span>
          <span class="section-title">我的常用</span>
          <span class="section-count">${tools.length}</span>
        </div>
        <span class="fav-hint">依你在這台裝置的使用習慣自動排序</span>
      </div>
      <div class="section-body"><div class="section-grid">${cards}</div></div>
    </section>
  `;
}

// Tips whose text or author matches every search keyword, newest first.
// An empty query matches everything (used by the「小知識」search scope).

function sectionHTML(g, showHeader = true) {
  const cv = g.color;
  const isSystem = g.system;
  const cards = g.tools.map((t) => cardHTML(t, cv)).join("");

  const addBtn = `
    <button class="section-action section-action-add" title="在「${escapeAttr(g.name)}」新增工具" aria-label="在「${escapeAttr(g.name)}」新增工具" data-add-tool="${escapeAttr(isSystem ? "" : g.name)}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>
    </button>`;

  const header = !showHeader ? "" : `
    <div class="section-head">
      <div class="section-title-row">
        <span class="section-color-dot"></span>
        <span class="section-title">${escapeHTML(g.name)}</span>
        <span class="section-count">${g.tools.length}</span>
      </div>
      <div class="section-actions">
        ${addBtn}
        ${isSystem ? "" : `
          <button class="section-action" title="編輯分類" data-edit-cat="${escapeAttr(g.name)}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
          </button>
          <button class="section-action danger" title="刪除分類" data-del-cat="${escapeAttr(g.name)}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        `}
      </div>
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

/* Long-press (~550ms without moving) on touch devices — the mobile stand-in
   for right-click. Sets _longPressFired so the trailing click is swallowed. */

let _longPressFired = false;


function attachLongPress(el, fn) {
  if (!("ontouchstart" in window)) return;
  let timer = null, startX = 0, startY = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { cancel(); return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    timer = setTimeout(() => {
      timer = null;
      _longPressFired = true;
      // Failsafe: if no click follows (e.g. finger slides off), don't let the
      // suppression leak onto the next genuine tap.
      setTimeout(() => { _longPressFired = false; }, 700);
      fn(startX, startY);
    }, 550);
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (!t || Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) cancel();
  }, { passive: true });
  el.addEventListener("touchend", cancel, { passive: true });
  el.addEventListener("touchcancel", cancel, { passive: true });
}


function wireSections() {
  // Main tile click = open the tool
  $$("#sections-area [data-open]").forEach((tile) => {
    tile.addEventListener("click", (e) => {
      // The click that follows a completed long-press must not open the tool.
      if (_longPressFired) { _longPressFired = false; return; }
      const id = tile.dataset.open;
      const tool = allTools().find((t) => t.id === id);
      if (tool) openTool(tool, e.currentTarget);
    });
  });
  // Right-click on a tile opens the context menu (edit / copy / download).
  // On touch devices the same menu opens with a long-press — iOS never
  // fires contextmenu on plain elements, so without this, phones can't
  // edit tools at all.
  $$("#sections-area .card[data-id]").forEach((card) => {
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openTileContextMenu(card.dataset.id, e.clientX, e.clientY);
    });
    attachLongPress(card, (x, y) => {
      try { navigator.vibrate?.(10); } catch {}
      openTileContextMenu(card.dataset.id, x, y);
    });
  });
  // "+ 新增" in a section header → new-tool popover with that category preselected
  $$("#sections-area [data-add-tool]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.prefillCategory = btn.dataset.addTool || null;
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
    // 我的常用 is a read-only shortcut row — never a drag source or target.
    if (sec.dataset.fav === "1") return;
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


function openTool(t, anchor) {
  // Page tools open directly (single HTML, no versions).
  if (t.type === "page") {
    if (!Array.isArray(t.files) || !t.files.length) {
      if (confirm(`「${t.name}」還沒上傳 HTML。要現在上傳嗎?`)) {
        openTileFileMenuUploadOnly(t.id, anchor);
      }
      return;
    }
    trackHit(t.id, "open");
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
    downloadFile(latest, t.id);
    toast(`下載 ${latest.name}`);
    return;
  }
  if (!t.url || t.url === "#") {
    if (confirm(`「${t.name}」尚未設定連結或檔案。要現在編輯嗎?`)) {
      openToolPopover(t.id);
    }
    return;
  }
  trackHit(t.id, "open");
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

export { canEditTool, copyToolUrl, maybeShowNewArrivalsNotice, normalizeType, render, renderSections };
