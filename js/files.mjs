// DPC Hub — 檔案版本管理(上傳、版本列表、下載、頁面工具)
import { $, escapeHTML, fileExt, formatBytes, formatDate, toast } from "./helpers.mjs?v=20260804e";
import { getMe } from "./menus.mjs?v=20260804e";
import { updateIconPreview } from "./popovers.mjs?v=20260804e";
import { MAX_FILE_BYTES, MAX_VERSIONS, state } from "./state.mjs?v=20260804e";
import { trackHit } from "./sync.mjs?v=20260804e";

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
      if (action === "download") downloadFile(state.editingFiles[idx], state.editingId);
      else if (action === "delete") {
        if (confirm("刪掉這個版本?(無法復原)")) {
          state.editingFiles.splice(idx, 1);
          renderFileList();
        }
      }
    });
  });
}


function downloadFile(fileObj, toolId) {
  if (!fileObj?.key) {
    toast("找不到這版的檔案");
    return;
  }
  if (toolId) trackHit(toolId, "download");
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

export { downloadFile, initFileUpload, isHtmlFile, isPageTool, pageUrl, renderFileList };
