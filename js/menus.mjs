// DPC Hub — 卡片選單:右鍵/長按選單、檔案面板、tooltip、使用者身分
import { canEditTool, copyToolUrl, render } from "./board.mjs?v=20260804e";
import { allTools, ensureCreator, listAllCreators } from "./data.mjs?v=20260804e";
import { downloadFile, isHtmlFile, isPageTool, pageUrl } from "./files.mjs?v=20260804e";
import { escapeHTML, formatBytes, formatDate, toast } from "./helpers.mjs?v=20260804e";
import { openHistoryPopover } from "./history.mjs?v=20260804e";
import { openMiniPopover, openToolPopover } from "./popovers.mjs?v=20260804e";
import { LS_ME_KEY, MAX_FILE_BYTES, MAX_VERSIONS, state } from "./state.mjs?v=20260804e";
import { saveTools, trackHit } from "./sync.mjs?v=20260804e";

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
          downloadFile(latest, id);
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
          downloadFile(f, tool.id);
          toast(`下載 ${f.name}`);
        } else if (btn.dataset.act === "preview") {
          trackHit(tool.id, "open");
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

export { getMe, initFilePopover, initTileContextMenu, initTileFileMenu, initTileTooltip, openTileContextMenu, openTileFileMenuUploadOnly };
