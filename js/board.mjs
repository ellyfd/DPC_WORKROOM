// DPC Hub — 啟動台板面:render、卡片、拖曳、篩選、本週上新
import { allTools, ensureCategory, groupedTools, listAllBrands, sortToolsByOrder } from "./data.mjs?v=20260804e";
import { downloadFile, isPageTool, pageUrl } from "./files.mjs?v=20260804e";
import { $, $$, cssEscape, escapeAttr, escapeHTML, formatDate, initial, loadJSON, queryTokens, saveJSON, toast, uniq } from "./helpers.mjs?v=20260804e";
import { openFilePopover, openTileContextMenu, openTileFileMenuUploadOnly } from "./menus.mjs?v=20260804e";
import { deleteCategory, openCatPopover, openToolPopover } from "./popovers.mjs?v=20260804e";
import { LS_COLLAPSE_KEY, LS_NEW_SEEN_KEY, LS_UPDATE_SEEN_KEY, NUM_COLORS, state } from "./state.mjs?v=20260804e";
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

/* ===== 版本更新 (new versions of existing tools) ===== */

const UPDATE_WINDOW_DAYS = 3;

const UPDATE_WINDOW_MS = UPDATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;


function latestVersion(t) {
  const f = Array.isArray(t?.files) ? t.files[0] : null;
  return f && f.key ? f : null;
}

// True when the tool got a new version recently that this device hasn't
// looked at yet. Your own uploads never count as "news" for you.

function isUpdatedTool(t, seen = loadJSON(LS_UPDATE_SEEN_KEY, {})) {
  const latest = latestVersion(t);
  if (!latest) return false;
  // `update` is stamped on new uploads; older data → more than one version.
  if (!latest.update && !(t.files.length > 1)) return false;
  const at = Date.parse(latest.uploadedAt || "");
  if (!Number.isFinite(at)) return false;
  const now = Date.now();
  if (at > now + 60 * 1000 || now - at > UPDATE_WINDOW_MS) return false;
  if (state.me && latest.uploadedBy === state.me) return false;
  return (seen && seen[t.id]) !== latest.key;
}


function updatedToolsRecently() {
  const seen = loadJSON(LS_UPDATE_SEEN_KEY, {});
  return allTools()
    .filter((t) => isUpdatedTool(t, seen))
    .sort((a, b) => Date.parse(latestVersion(b).uploadedAt) - Date.parse(latestVersion(a).uploadedAt));
}

// Opening / downloading / viewing the history of a tool = "seen this update".
// Drops the UPDATE badge in place without re-rendering the whole board.

function markUpdateSeen(toolId) {
  const t = allTools().find((x) => x.id === toolId);
  const latest = latestVersion(t);
  if (!latest) return;
  const seen = loadJSON(LS_UPDATE_SEEN_KEY, {});
  if (seen[toolId] === latest.key) return;
  seen[toolId] = latest.key;
  saveJSON(LS_UPDATE_SEEN_KEY, seen);
  document.querySelectorAll(`#sections-area .card[data-id="${cssEscape(toolId)}"]`).forEach((card) => {
    card.classList.remove("is-updated");
    card.querySelectorAll(".update-badge").forEach((b) => b.remove());
    card.dataset.note = t.description ? `${t.name}\n${t.description}` : t.name;
  });
}

// A short signature of the current notice contents, so we only auto-show it
// once per distinct batch. A new tool or a new version changes the signature
// and the notice pops again on next load. (New-tools-only signatures keep the
// old format so people who dismissed a batch aren't asked again.)

function updateTooltip(t, latest) {
  const ver = t.type === "page" ? "" : ` v${t.files.length}`;
  let note = (latest.note || "").trim();
  if (note.length > 140) note = note.slice(0, 140) + "…";
  const head = `🔄 新版本${ver}${note ? `:${note}` : ""}`;
  return t.description ? `${head}\n\n${t.description}` : head;
}


function newToolsSignature(tools, updates = []) {
  return [
    ...tools.map((t) => t.id),
    ...updates.map((t) => "u:" + latestVersion(t).key),
  ].sort().join("|");
}

// 本週上新通知 — a dismissable popover shown once on load. Pure text: groups
// the week's new tools by category, no icons or logos. Clicking a tool name
// opens it; there's a "don't show again for this batch" affordance.

function maybeShowNewArrivalsNotice() {
  const updates = updatedToolsRecently();
  const upIds = new Set(updates.map((t) => t.id));
  const fresh = newToolsThisWeek().filter((t) => !upIds.has(t.id));
  if (!fresh.length && !updates.length) return;
  const sig = newToolsSignature(fresh, updates);
  if (loadJSON(LS_NEW_SEEN_KEY, "") === sig) return;  // already dismissed this batch
  renderNewArrivalsNotice(fresh, sig, updates);
}


function updatesGroupHTML(updates) {
  if (!updates.length) return "";
  const items = updates.map((t) => {
    const latest = latestVersion(t);
    const ver = t.type === "page" ? "" : `<span class="upd-ver">v${t.files.length}</span>`;
    const who = latest.uploadedBy
      ? `<span class="new-item-who"><span class="new-item-ava">${escapeHTML(initial(latest.uploadedBy))}</span>${escapeHTML(latest.uploadedBy)}</span>`
      : "";
    const when = `<span class="upd-when">${escapeHTML(formatDate(latest.uploadedAt))}</span>`;
    const note = latest.note
      ? `<span class="upd-note">${escapeHTML(latest.note)}</span>`
      : `<span class="upd-note upd-note-empty">沒有填寫更新內容</span>`;
    return `<button type="button" class="new-item upd-item" data-open-upd="${escapeAttr(t.id)}">
        <span class="new-item-row">
          <span class="new-item-name">${escapeHTML(t.name)}</span>
          ${ver}
          <svg class="new-item-go" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </span>
        <span class="new-item-meta">${who}${when}</span>
        ${note}
      </button>`;
  }).join("");
  return `
    <div class="new-group upd-group">
      <div class="new-group-head">
        <span class="new-group-dot"></span>
        <span class="new-group-name">版本更新</span>
        <span class="new-group-count">${updates.length}</span>
      </div>
      <div class="new-group-items">${items}</div>
    </div>`;
}


function renderNewArrivalsNotice(tools, sig, updates = []) {
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

  const heading = pop.querySelector("#new-popover-heading");
  const sub = pop.querySelector("#new-popover-sub");
  if (heading && sub) {
    if (tools.length && updates.length) {
      heading.textContent = "最新動態";
      sub.textContent = NEW_WINDOW_DAYS === UPDATE_WINDOW_DAYS
        ? `最近 ${NEW_WINDOW_DAYS} 天新增或有新版本的工具 · 點一下即可開啟`
        : `最近 ${NEW_WINDOW_DAYS} 天新增的工具 · 最近 ${UPDATE_WINDOW_DAYS} 天有新版本的工具`;
    } else if (updates.length) {
      heading.textContent = "版本更新";
      sub.textContent = `最近 ${UPDATE_WINDOW_DAYS} 天有新版本的工具 · 點一下看完整版本歷史`;
    } else {
      heading.textContent = "本週上新";
      sub.textContent = `最近 ${NEW_WINDOW_DAYS} 天新增的工具 · 點一下即可開啟`;
    }
  }
  const body = pop.querySelector("#new-popover-body");
  pop.querySelector("#new-popover-count").textContent = tools.length + updates.length;
  body.innerHTML = updatesGroupHTML(updates) + groupsHTML;
  pop.hidden = false;

  const close = () => { pop.hidden = true; };
  const dismiss = () => { saveJSON(LS_NEW_SEEN_KEY, sig); close(); };

  pop.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", close, { once: true })
  );
  pop.querySelector("#new-popover-dismiss").addEventListener("click", dismiss, { once: true });
  pop.querySelectorAll("[data-open-upd]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const t = allTools().find((x) => x.id === btn.dataset.openUpd);
      close();
      if (!t) return;
      // File tools → version history (shows every version's 更新內容);
      // pages have no history, so just open the page.
      if (t.type === "page") openTool(t, btn);
      else openFilePopover(t.id);
    })
  );
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
    renderCatNav(null);
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
    renderCatNav(null);
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

  renderCatNav(groups);
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

  const collapsed = !!state.collapsed[g.name];
  const chev = `<svg class="section-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  const header = !showHeader ? "" : `
    <div class="section-head">
      <button type="button" class="section-title-row" data-toggle-cat="${escapeAttr(g.name)}" aria-expanded="${collapsed ? "false" : "true"}" title="${collapsed ? "展開" : "收合"}">
        <span class="section-color-dot"></span>
        <span class="section-title">${escapeHTML(g.name)}</span>
        <span class="section-count">${g.tools.length}</span>
        ${chev}
      </button>
      <div class="section-actions">
        <button type="button" class="section-action" title="分類選單" aria-label="「${escapeAttr(g.name)}」分類選單" data-cat-menu="${escapeAttr(g.name)}"${isSystem ? ' data-system="1"' : ""}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
      </div>
    </div>
  `;

  const grid = `<div class="section-grid">${cards}</div>`;

  return `
    <section class="section${collapsed ? " collapsed" : ""}" data-cv="${cv}" data-cat="${escapeAttr(g.name)}"${isSystem ? ' data-system="1"' : ''}>
      ${header}
      <div class="section-body">${grid}</div>
    </section>
  `;
}


function cardHTML(t, cv, seenMap = loadJSON(LS_UPDATE_SEEN_KEY, {})) {
  const tType = t.type || "link";
  const type = TYPE_META[tType] || TYPE_META.link;
  const iconImg = t.icon
    ? `<img src="${escapeAttr(t.icon)}" alt="" draggable="false" onerror="this.remove()" />`
    : "";
  const isPage = isPageTool(t);
  const abbr = tileAbbr(t.name);
  // Letter tiles in one category share a colour — nudge the hue per name so
  // neighbours don't look identical. Real icons are left alone.
  const hue = t.icon ? 0 : nameHue(t.name);

  const locked = isToolLocked(t);
  const lockSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  // UPDATE wins over NEW: a fresh tool that already got a new version is news
  // about the update.
  const updated = isUpdatedTool(t, seenMap);
  const fresh = !updated && isNewTool(t);
  const latest = updated ? latestVersion(t) : null;
  // Hover tooltip: lead with this update's 更新內容, then the description.
  // Tooltip always leads with the full name (titles clamp at two lines).
  const extra = updated ? updateTooltip(t, latest) : (t.description || "");
  const tip = extra ? `${t.name}\n${extra}` : t.name;
  const noteAttr = tip ? ` data-note="${escapeAttr(tip)}"` : "";

  return `
    <article class="card${isPage ? " is-page" : ""}${locked ? " is-locked" : ""}${fresh ? " is-new" : ""}${updated ? " is-updated" : ""}" data-cv="${cv}" data-id="${escapeAttr(t.id)}"${noteAttr} draggable="true">
      <button type="button" class="card-tile" data-open="${escapeAttr(t.id)}" aria-label="${escapeAttr(t.name)}">
        <div class="card-top">
          <div class="card-icon${hue ? " has-hue" : ""}"${hue ? ` style="--hue:${hue}deg"` : ""}>
            <span class="ic-letter${abbr.length > 1 ? " is-two" : ""}">${escapeHTML(abbr)}</span>
            ${iconImg}
            <span class="tile-type-chip tile-type-${tType}" aria-label="${escapeAttr(type.label)}">${type.icon}</span>
          </div>
          ${locked ? `<span class="lock-badge" title="已鎖定 — 只有 ${escapeAttr(t.lockedBy)} 能編輯/刪除">${lockSvg}</span>` : ""}
          ${fresh ? `<span class="new-badge" title="本週上新">NEW</span>` : ""}
          ${updated ? `<span class="new-badge update-badge" data-open-versions="${escapeAttr(t.id)}" title="點這裡看更新內容">UPDATE</span>` : ""}
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
      // UPDATE badge → see what changed instead of downloading straight away.
      if (e.target.closest("[data-open-versions]")) {
        openFilePopover(id);
        return;
      }
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
  $$("#sections-area [data-cat-menu]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = document.getElementById("cat-menu");
      if (menu && !menu.hidden && _catMenuTarget?.anchor === btn) { closeCatMenu(); return; }
      openCatMenu(btn);
    });
  });
  $$("#sections-area [data-toggle-cat]").forEach((head) => {
    head.addEventListener("click", (e) => {
      if (e.target.closest(".section-action")) return;
      toggleSection(head.dataset.toggleCat);
    });
  });
  wireCardDrag();
  syncCollapseAllButton();
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
  if (sec) {
    const c = !!state.collapsed[name];
    sec.classList.toggle("collapsed", c);
    const head = sec.querySelector("[data-toggle-cat]");
    if (head) {
      head.setAttribute("aria-expanded", c ? "false" : "true");
      head.title = c ? "展開" : "收合";
    }
  }
  syncCollapseAllButton();
}


/* ===== 分類快捷列 — jump to a category, collapse / expand all ===== */

function renderCatNav(groups) {
  const nav = document.getElementById("cat-nav");
  if (!nav) return;
  if (!groups || !groups.length) { nav.hidden = true; nav.innerHTML = ""; return; }
  const chips = groups.map((g) => `
    <button type="button" class="cat-chip" data-cv="${g.color}" data-jump-cat="${escapeAttr(g.name)}">
      <span class="cat-chip-dot"></span>
      <span class="cat-chip-name">${escapeHTML(g.name)}</span>
      <span class="cat-chip-count">${g.tools.length}</span>
    </button>`).join("");
  nav.innerHTML = `
    <div class="cat-nav-chips">${chips}</div>
    <button type="button" class="cat-nav-toggle" id="cat-nav-toggle"></button>`;
  nav.hidden = false;
  syncCollapseAllButton();
  nav.querySelectorAll("[data-jump-cat]").forEach((btn) =>
    btn.addEventListener("click", () => jumpToCategory(btn.dataset.jumpCat))
  );
  nav.querySelector("#cat-nav-toggle").addEventListener("click", () => {
    const names = [...document.querySelectorAll("#sections-area .board-cols .section[data-cat]")]
      .map((sec) => sec.dataset.cat);
    const anyOpen = names.some((n) => !state.collapsed[n]);
    for (const n of names) state.collapsed[n] = anyOpen;
    saveJSON(LS_COLLAPSE_KEY, state.collapsed);
    renderSections();
  });
  updateStickyOffsets();
}


function syncCollapseAllButton() {
  const btn = document.getElementById("cat-nav-toggle");
  if (!btn) return;
  const secs = [...document.querySelectorAll("#sections-area .board-cols .section[data-cat]")];
  const anyOpen = secs.some((sec) => !sec.classList.contains("collapsed"));
  btn.innerHTML = anyOpen
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 20 5-5 5 5M7 4l5 5 5-5"/></svg><span>全部收合</span>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"/></svg><span>全部展開</span>`;
}


function jumpToCategory(name) {
  if (state.collapsed[name]) toggleSection(name);
  const sec = document.querySelector(`#sections-area .section[data-cat="${cssEscape(name)}"]`);
  if (!sec) return;
  sec.scrollIntoView({ behavior: "smooth", block: "start" });
  sec.classList.remove("flash");
  void sec.offsetWidth;  // restart the highlight animation
  sec.classList.add("flash");
}

// The header (desktop) and the category bar stick to the top; sections need
// to know how much space that takes so a jump doesn't land underneath them.

let _stickyWired = false;


function updateStickyOffsets() {
  const hero = document.querySelector(".hero");
  const nav = document.getElementById("cat-nav");
  const root = document.documentElement;
  const heroSticky = hero && getComputedStyle(hero).position === "sticky";
  const heroH = heroSticky ? hero.offsetHeight : 0;
  const navH = nav && !nav.hidden ? nav.offsetHeight : 0;
  root.style.setProperty("--hero-sticky-h", `${heroH}px`);
  root.style.setProperty("--sticky-total", `${heroH + navH + 12}px`);
  if (!_stickyWired) {
    _stickyWired = true;
    let raf = 0;
    window.addEventListener("resize", () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(updateStickyOffsets);
    });
    const onScroll = () => document.body.classList.toggle("is-scrolled", window.scrollY > 4);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
}


/* ===== category "⋯" menu ===== */

let _catMenuTarget = null;


function openCatMenu(btn) {
  const menu = document.getElementById("cat-menu");
  if (!menu) return;
  if (!menu.dataset.wired) {
    menu.dataset.wired = "1";
    menu.querySelectorAll("[data-cat-act]").forEach((item) =>
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const t = _catMenuTarget;
        closeCatMenu();
        if (!t) return;
        const act = item.dataset.catAct;
        if (act === "add") {
          state.prefillCategory = t.system ? null : t.name;
          openToolPopover(null, t.anchor);
        } else if (act === "edit") {
          openCatPopover(t.name, t.anchor);
        } else if (act === "delete") {
          deleteCategory(t.name);
        }
      })
    );
    document.addEventListener("click", (e) => {
      if (menu.hidden || e.target.closest("#cat-menu") || e.target.closest("[data-cat-menu]")) return;
      closeCatMenu();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCatMenu(); });
    window.addEventListener("scroll", closeCatMenu, true);
    window.addEventListener("resize", closeCatMenu);
  }
  const system = btn.dataset.system === "1";
  _catMenuTarget = { name: btn.dataset.catMenu, system, anchor: btn };
  menu.querySelector("#cat-menu-edit").hidden = system;
  menu.querySelector("#cat-menu-delete").hidden = system;
  menu.querySelector("#cat-menu-sep").hidden = system;
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 120;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  if (left < 8) left = 8;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}


function closeCatMenu() {
  const menu = document.getElementById("cat-menu");
  if (menu) menu.hidden = true;
  _catMenuTarget = null;
}


/* ===== letter tiles: two-character abbreviation + per-name hue ===== */

// "TGT GSA PPT" → "TG", "DCSG Snapshot" → "DS", "2D印圖" → "2D",
// "人台搜尋" → "人台", "(未完成)對條碼" → "對條". Initials of the first two
// Latin words; otherwise the first two characters of the first word.

function tileAbbr(name) {
  const clean = String(name || "")
    .replace(/[(（\[【][^)）\]】]*[)）\]】]/g, " ")
    .trim() || String(name || "").trim();
  if (!clean) return "?";
  const tokens = clean.match(/[A-Za-z0-9]+|[\u3400-\u9fff\uf900-\ufaff]+/g) || [];
  if (!tokens.length) return initial(clean);
  const first = tokens[0];
  const isLatin = (t) => /^[A-Za-z0-9]/.test(t);
  if (isLatin(first)) {
    const second = tokens.slice(1).find(isLatin);
    const abbr = second ? first[0] + second[0] : first.slice(0, 2);
    return abbr.toUpperCase();
  }
  return [...first].slice(0, 2).join("");
}


function nameHue(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return [-28, -14, 0, 14, 28][h % 5];
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
    markUpdateSeen(t.id);
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

export { canEditTool, copyToolUrl, markUpdateSeen, maybeShowNewArrivalsNotice, normalizeType, render, renderSections };
