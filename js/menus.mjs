// DPC Hub — 卡片選單:右鍵/長按選單、檔案面板、tooltip、使用者身分
import { canEditTool, copyToolUrl, toolCopyTarget, markUpdateSeen, removeFromFavorites, render } from "./board.mjs?v=20260804e";
import { allTools, ensureCreator, listAllCreators } from "./data.mjs?v=20260804e";
import { downloadFile, isHtmlFile, isPageTool, pageUrl, versionEntry } from "./files.mjs?v=20260804e";
import { escapeHTML, formatBytes, formatDate, toast } from "./helpers.mjs?v=20260804e";
import { openHistoryPopover } from "./history.mjs?v=20260804e";
import { openMiniPopover, openToolPopover } from "./popovers.mjs?v=20260804e";
import { LS_ME_KEY, MAX_FILE_BYTES, MAX_NOTE_CHARS, MAX_VERSIONS, state } from "./state.mjs?v=20260804e";
import { favoriteTools, isFavRowOff, saveTools, trackHit } from "./sync.mjs?v=20260804e";

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
          downloadFile(latest, id);
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
        trackHit(toolId, "open");
        window.open(pageUrl(toolId), "_blank", "noopener");
      } else if (action === "history") {
        const toolId = id;
        closeTileFileMenu();
        // Pre-existing dangling name: this used to call the never-defined
        // openHistoryPopover(toolId) and threw. The version-history panel
        // is openFilePopover.
        openFilePopover(toolId);
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

  menu.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = _ctxMenuTargetId;
      const action = btn.dataset.action;
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
          downloadFile(latest, id);
          toast(`下載 ${latest.name}`);
        } else {
          toast("找不到檔案");
        }
      } else if (action === "unfav") {
        removeFromFavorites(id);
      } else if (action === "open") {
        trackHit(id, "open");
        markUpdateSeen(id);
        window.open(pageUrl(id), "_blank", "noopener");
      } else if (action === "versions") {
        // 版本 panel: current version, upload (+ 更新內容), older versions.
        openFilePopover(id);
      }
    });
  });

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
  const verItem = document.getElementById("tile-context-versions");
  const verLabel = document.getElementById("tile-context-versions-label");

  // Link tools copy their address; file / page tools copy a link or folder
  // path found in their description.
  const copyTarget = toolCopyTarget(tool);
  if (copyItem) copyItem.hidden = !copyTarget;
  const copyLabel = document.getElementById("tile-context-copy-label");
  if (copyLabel) copyLabel.textContent = copyTarget?.kind === "folder" ? "複製資料夾路徑" : "複製連結";
  if (dlItem) {
    // File-type tiles already download on click — only Page tools surface
    // a download action here (download the source HTML).
    const showDownload = hasFile && tType === "page";
    dlItem.hidden = !showDownload;
    if (dlLabel) {
      dlLabel.textContent = showDownload ? `下載原始檔 (${latest.name})` : "下載";
    }
  }
  if (verItem) verItem.hidden = !isFileType;
  if (verLabel) verLabel.textContent = tType === "page" ? "更換 HTML" : "版本";
  const unfavItem = document.getElementById("tile-context-unfav");
  if (unfavItem) unfavItem.hidden = isFavRowOff() || !favoriteTools().some((t) => t.id === toolId);
  const openItem = document.getElementById("tile-context-open");
  if (openItem) openItem.hidden = !(tType === "page" && hasFile);

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


/* ===== 版本 panel — the one home for a tool's files =====
   Top → bottom in order of how often people need it:
   1. 目前版本 + 更新內容 + 下載 (what most people open it for)
   2. 上傳新版本, collapsed behind a button (file + 更新內容 together)
   3. 舊版本: expand to read 更新內容, download, delete */

let _filePanelToolId = null;

let _filePanelPending = null;

let _filePanelBusy = false;

const DL_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>`;

const DEL_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;

const CHEV_SVG = `<svg class="file-panel-row-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;


function initFilePopover() {
  const pop = document.getElementById("file-popover");
  if (!pop) return;
  pop.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeFilePopover)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) closeFilePopover();
  });

  document.getElementById("file-panel-upload-toggle")?.addEventListener("click", () => {
    setUploadOpen(true);
  });
  document.getElementById("file-panel-upload-cancel")?.addEventListener("click", () => {
    _filePanelPending = null;
    document.getElementById("file-panel-note").value = "";
    setUploadOpen(false);
  });

  const drop = document.getElementById("file-panel-drop");
  const uploadBtn = document.getElementById("file-panel-upload-btn");
  const uploadInput = document.getElementById("file-panel-upload");
  const pick = () => {
    if (!_filePanelToolId || _filePanelBusy) return;
    uploadInput.click();
  };
  drop?.addEventListener("click", pick);
  drop?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
  });
  drop?.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
  drop?.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop?.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
    const f = e.dataTransfer?.files?.[0];
    if (f && !_filePanelBusy) setPendingFile(f);
  });
  uploadInput?.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) setPendingFile(f);
  });
  uploadBtn?.addEventListener("click", async () => {
    const id = _filePanelToolId;
    const f = _filePanelPending;
    if (!id || !f || _filePanelBusy) return;
    const note = document.getElementById("file-panel-note").value.trim().slice(0, MAX_NOTE_CHARS);
    _filePanelBusy = true;
    renderPanelUploadState();
    const ok = await addVersionToTool(id, f, note);
    _filePanelBusy = false;
    if (ok && _filePanelToolId === id) openFilePopover(id);  // refresh, collapse upload
    else renderPanelUploadState();
  });
}


function setUploadOpen(open) {
  const box = document.getElementById("file-panel-upload-box");
  const toggle = document.getElementById("file-panel-upload-toggle");
  if (box) box.hidden = !open;
  if (toggle) toggle.hidden = open;
  renderPanelUploadState();
  if (open) document.getElementById("file-panel-drop")?.focus();
}


function setPendingFile(f) {
  const tool = allTools().find((t) => t.id === _filePanelToolId);
  if (!tool) return;
  if (tool.type === "page" && !isHtmlFile({ name: f.name })) {
    toast("這是頁面類型,只接受 .html / .htm");
    return;
  }
  if (f.size > MAX_FILE_BYTES) {
    toast(`檔案太大(${formatBytes(f.size)},上限 ${formatBytes(MAX_FILE_BYTES)})`);
    return;
  }
  _filePanelPending = f;
  renderPanelUploadState();
  const note = document.getElementById("file-panel-note");
  if (note && !note.hidden) note.focus();
}


function renderPanelUploadState() {
  const drop = document.getElementById("file-panel-drop");
  const text = document.getElementById("file-panel-drop-text");
  const btn = document.getElementById("file-panel-upload-btn");
  const f = _filePanelPending;
  drop?.classList.toggle("has-file", !!f);
  if (text) {
    text.textContent = f
      ? `${f.name} · ${formatBytes(f.size)}(點一下換檔案)`
      : "點這裡或拖檔案進來";
  }
  if (btn) {
    btn.disabled = !f || _filePanelBusy;
    btn.querySelector("span").textContent = _filePanelBusy ? "上傳中…" : "上傳";
  }
}


function currentVersionHTML(tool, files, isPage) {
  const f = files[0];
  if (!f) return "";
  const ver = isPage ? "" : `<span class="fpc-ver">v${files.length}</span>`;
  const meta = [
    formatDate(f.uploadedAt),
    f.uploadedBy || "",
    formatBytes(f.size || 0),
  ].filter(Boolean).map(escapeHTML).join(" · ");
  const note = (f.note || "").trim();
  const actions = isPage
    ? `<button type="button" class="btn btn-primary" data-cur="open">開啟頁面</button>
       <button type="button" class="btn btn-secondary" data-cur="download">${DL_SVG}<span>下載原始檔</span></button>`
    : `<button type="button" class="btn btn-primary" data-cur="download">${DL_SVG}<span>下載最新版</span></button>`;
  return `
    <div class="file-panel-current">
      <div class="fpc-head">${ver}<span class="fpc-label">${isPage ? "目前 HTML" : "目前版本"}</span></div>
      <div class="fpc-name">${escapeHTML(f.name || "(未命名)")}</div>
      <div class="fpc-meta muted small">${meta}</div>
      ${note
        ? `<div class="fpc-note"><span class="file-panel-row-note-label">更新內容</span>${escapeHTML(note)}</div>`
        : ""}
      <div class="fpc-actions">${actions}</div>
    </div>`;
}


function openFilePopover(toolId) {
  const pop = document.getElementById("file-popover");
  if (!pop) return;
  const tool = allTools().find((t) => t.id === toolId);
  if (!tool) { toast("找不到這個工具"); return; }
  _filePanelToolId = toolId;
  _filePanelPending = null;

  const files = Array.isArray(tool.files) ? tool.files : [];
  const isPage = tool.type === "page";
  const canEdit = canEditTool(tool);

  document.getElementById("file-popover-title").textContent = tool.name;
  document.getElementById("file-popover-sub").textContent = isPage
    ? "HTML 頁面"
    : (files.length ? `${files.length} 個版本` : "還沒有檔案");

  // 1. Current version
  const cur = document.getElementById("file-panel-current");
  cur.innerHTML = currentVersionHTML(tool, files, isPage);
  cur.querySelectorAll("[data-cur]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.cur === "open") {
        trackHit(tool.id, "open");
        window.open(pageUrl(tool.id), "_blank", "noopener");
      } else {
        downloadFile(files[0], tool.id);
        toast(`下載 ${files[0].name}`);
      }
    });
  });

  // 2. Upload — collapsed when there's already a file; open straight away
  //    when there's nothing yet. Not yours (locked) → view only.
  const toggle = document.getElementById("file-panel-upload-toggle");
  const box = document.getElementById("file-panel-upload-box");
  document.getElementById("file-panel-upload-toggle-text").textContent =
    isPage ? "更換 HTML" : "上傳新版本";
  document.getElementById("file-panel-upload-title").textContent = isPage
    ? (files.length ? "更換 HTML" : "上傳 HTML")
    : (files.length ? "上傳新版本" : "上傳第一個檔案");
  document.getElementById("file-panel-upload").accept = isPage ? ".html,.htm,text/html" : "";
  const noteEl = document.getElementById("file-panel-note");
  noteEl.value = "";
  noteEl.hidden = !files.length;  // first upload has nothing to compare with
  document.getElementById("file-panel-upload-cancel").hidden = !files.length;
  if (!canEdit) {
    toggle.hidden = true;
    box.hidden = true;
  } else if (!files.length) {
    toggle.hidden = true;
    box.hidden = false;
  } else {
    toggle.hidden = false;
    box.hidden = true;
  }
  renderPanelUploadState();

  // 3. Older versions (pages keep only one, so none)
  const histWrap = document.getElementById("file-panel-history-wrap");
  const histEl = document.getElementById("file-panel-history");
  const older = isPage ? [] : files.slice(1);
  histWrap.hidden = !older.length;
  histEl.innerHTML = older.map((f, j) => {
    const i = j + 1;
    const ver = files.length - i;
    const note = (f.note || "").trim();
    return `
      <div class="file-panel-row${note ? " has-note" : ""}" data-version="${i}"${note ? ` role="button" tabindex="0" aria-expanded="false" title="點一下看更新內容"` : ""}>
        <div class="file-panel-row-ver">v${ver}</div>
        <div class="file-panel-row-meta">
          <div class="file-panel-row-name">${escapeHTML(f.name || "(未命名)")}</div>
          <div class="file-panel-row-info muted small">
            ${escapeHTML(formatDate(f.uploadedAt))}
            ${f.uploadedBy ? ` · ${escapeHTML(f.uploadedBy)}` : ""}
            · ${escapeHTML(formatBytes(f.size || 0))}
          </div>
          ${note ? `<div class="file-panel-row-note"><span class="file-panel-row-note-label">更新內容</span>${escapeHTML(note)}</div>` : ""}
        </div>
        ${note ? CHEV_SVG : ""}
        <div class="file-panel-row-actions">
          <button type="button" class="file-panel-row-btn" data-act="download" data-version="${i}" title="下載這版">${DL_SVG}</button>
          ${canEdit ? `<button type="button" class="file-panel-row-btn danger" data-act="delete" data-version="${i}" title="刪除這版">${DEL_SVG}</button>` : ""}
        </div>
      </div>`;
  }).join("");
  histEl.querySelectorAll(".file-panel-row.has-note").forEach((row) => {
    const toggleRow = () => {
      const open = row.classList.toggle("is-open");
      row.setAttribute("aria-expanded", open ? "true" : "false");
    };
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-act]")) return;
      toggleRow();
    });
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleRow(); }
    });
  });
  histEl.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.version, 10);
      const f = files[i];
      if (!f) return;
      if (btn.dataset.act === "download") {
        downloadFile(f, tool.id);
        toast(`下載 ${f.name}`);
      } else if (btn.dataset.act === "delete") {
        deleteVersion(tool.id, f.key, `v${files.length - i}`);
      }
    });
  });

  pop.hidden = false;
  markUpdateSeen(toolId);
}


function deleteVersion(toolId, key, label) {
  const existing = allTools().find((t) => t.id === toolId);
  if (!canEditTool(existing)) {
    toast(`已鎖定 — 只有「${existing.lockedBy}」能刪除`);
    return;
  }
  if (!confirm(`刪掉 ${label}?(無法復原)`)) return;
  let tool = state.localTools.find((t) => t.id === toolId);
  if (!tool) {
    const seed = state.seedTools.find((t) => t.id === toolId);
    if (!seed) return;
    tool = { ...seed };
    state.localTools.push(tool);
  }
  const idx = (tool.files || []).findIndex((f) => f.key === key);
  if (idx <= 0) return;  // never the current version
  tool.files = tool.files.filter((_, i) => i !== idx);
  tool.updated = new Date().toISOString();
  saveTools();
  render();
  toast(`已刪除 ${label}`);
  if (_filePanelToolId === toolId) openFilePopover(toolId);
}


function closeFilePopover() {
  const pop = document.getElementById("file-popover");
  if (pop) pop.hidden = true;
  _filePanelToolId = null;
  if (!_filePanelBusy) _filePanelPending = null;
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


// Upload `file` as the tool's newest version. `note` = 更新內容 (from the
// version panel). Resolves true on success.

async function addVersionToTool(toolId, file, note = "") {
  if (file.size > MAX_FILE_BYTES) {
    toast(`檔案太大(${formatBytes(file.size)},上限 ${formatBytes(MAX_FILE_BYTES)})`);
    return false;
  }
  const existing = allTools().find((t) => t.id === toolId);
  if (!canEditTool(existing)) {
    toast(`已鎖定 — 只有「${existing.lockedBy}」能上傳新版`);
    return false;
  }
  const isUpdate = Array.isArray(existing?.files) && existing.files.length > 0;
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
    if (!tool) { toast("找不到這個工具"); return false; }
    if (!Array.isArray(tool.files)) tool.files = [];
    const entry = versionEntry(meta, note, isUpdate);
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
    return true;
  } catch (err) {
    toast("上傳失敗");
    console.error(err);
    return false;
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

export { getMe, initFilePopover, openFilePopover, initTileContextMenu, initTileFileMenu, initTileTooltip, openTileContextMenu, openTileFileMenuUploadOnly };
