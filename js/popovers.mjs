// DPC Hub — 編輯介面:工具/分類表單、各種 picker、自動抓取、icon
import { canEditTool, normalizeType, render } from "./board.mjs?v=20260804e";
import { allTools, ensureBrand, ensureCategory, ensureCreator, listAllBrands, listAllCreators, renderBrandSelect, renderCreatorSelect, uniqueSlug } from "./data.mjs?v=20260804e";
import { isHtmlFile, renderFileList } from "./files.mjs?v=20260804e";
import { $, $$, escapeAttr, escapeHTML, fileUrl, initial, loadJSON, saveJSON, toast, toastUndo } from "./helpers.mjs?v=20260804e";
import { LS_DRAFT_KEY, LS_ME_KEY, NUM_COLORS, addTombstone, clearTombstone, state } from "./state.mjs?v=20260804e";
import { saveBrands, saveCats, saveCreators, saveTools, scheduleSync } from "./sync.mjs?v=20260804e";

/* ===== mini popover (reusable single-input prompt) ===== */

let miniPopoverHandler = null;


function initMiniPopover() {
  const pop = document.getElementById("mini-popover");
  if (!pop) return;
  pop.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeMiniPopover)
  );
  const input = document.getElementById("mini-popover-input");
  const select = document.getElementById("mini-popover-select");
  const confirm = document.getElementById("mini-popover-confirm");
  confirm.addEventListener("click", () => commitMini());
  const keyHandler = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitMini(); }
    else if (e.key === "Escape") { e.preventDefault(); closeMiniPopover(); }
  };
  input.addEventListener("keydown", keyHandler);
  select?.addEventListener("keydown", keyHandler);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) closeMiniPopover();
  });
}


function openMiniPopover({ title, placeholder = "", defaultValue = "", hint = "", type = "text", options = null, onConfirm }) {
  document.getElementById("mini-popover-title").textContent = title;
  const input = document.getElementById("mini-popover-input");
  const select = document.getElementById("mini-popover-select");
  const hintEl = document.getElementById("mini-popover-hint");
  hintEl.textContent = hint || "";
  hintEl.hidden = !hint;
  if (options) {
    select.innerHTML = options
      .map((o) =>
        typeof o === "string"
          ? `<option value="${escapeAttr(o)}">${escapeHTML(o)}</option>`
          : `<option value="${escapeAttr(o.value)}"${o.disabled ? " disabled" : ""}${o.value === defaultValue ? " selected" : ""}>${escapeHTML(o.label)}</option>`
      )
      .join("");
    if (defaultValue) select.value = defaultValue;
    select.hidden = false;
    input.hidden = true;
  } else {
    input.type = type;
    input.placeholder = placeholder;
    input.value = defaultValue || "";
    input.hidden = false;
    select.hidden = true;
  }
  miniPopoverHandler = onConfirm;
  document.getElementById("mini-popover").hidden = false;
  setTimeout(() => {
    if (options) select.focus();
    else { input.focus(); input.select(); }
  }, 30);
}


function closeMiniPopover() {
  document.getElementById("mini-popover").hidden = true;
  miniPopoverHandler = null;
  document.getElementById("mini-popover-input").value = "";
}


function commitMini() {
  const select = document.getElementById("mini-popover-select");
  const input = document.getElementById("mini-popover-input");
  const val = !select.hidden ? select.value : input.value.trim();
  if (!miniPopoverHandler) { closeMiniPopover(); return; }
  const fn = miniPopoverHandler;
  closeMiniPopover();
  fn(val);
}


/* ===== creator / brand pickers (custom dropdown with per-row rename/delete) ===== */

function initCreatorPicker() {
  initCustomSelect({
    kind: "creator",
    listFn: listAllCreators,
    ensureFn: ensureCreator,
    deleteFn: deleteCreator,
    renameFn: renameCreator,
    rerenderFn: renderCreatorSelect,
    emptyLabel: "— 選擇製作人 —",
    addLabel: "＋ 新增製作人…",
    addTitle: "新增製作人",
    addPlaceholder: "輸入名稱",
    allowEmpty: false,
  });
}


function initBrandPicker() {
  initCustomSelect({
    kind: "brand",
    listFn: listAllBrands,
    ensureFn: ensureBrand,
    deleteFn: deleteBrand,
    renameFn: renameBrand,
    rerenderFn: renderBrandSelect,
    emptyLabel: "— 沒有指定 —",
    addLabel: "＋ 新增品牌…",
    addTitle: "新增品牌 / 客制",
    addPlaceholder: "輸入品牌或客制名稱",
    allowEmpty: true,
  });
}


const _customSelects = {};


function initCustomSelect(opts) {
  const selectEl = document.getElementById(`${opts.kind}-select`);
  const wrapper = document.querySelector(`[data-custom-select="${opts.kind}"]`);
  if (!selectEl || !wrapper) return;

  let custom = wrapper.querySelector(".custom-select");
  if (!custom) {
    custom = document.createElement("div");
    custom.className = "custom-select";
    custom.innerHTML = `
      <button type="button" class="custom-select-trigger">
        <span class="custom-select-label is-placeholder">${escapeHTML(opts.emptyLabel)}</span>
        <svg class="custom-select-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="custom-select-menu" hidden></div>
    `;
    wrapper.appendChild(custom);
  }

  const trigger = custom.querySelector(".custom-select-trigger");
  const label = custom.querySelector(".custom-select-label");
  const menu = custom.querySelector(".custom-select-menu");

  function syncLabel() {
    const v = selectEl.value;
    if (v) {
      label.textContent = v;
      label.classList.remove("is-placeholder");
    } else {
      label.textContent = opts.emptyLabel;
      label.classList.add("is-placeholder");
    }
  }

  function renderMenu() {
    const items = opts.listFn();
    const v = selectEl.value;
    const checkSvg = `<svg class="custom-select-check" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12l5 5L20 7"/></svg>`;
    const renameSvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    const trashSvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;

    const emptyRow = opts.allowEmpty
      ? `<div class="custom-select-row${!v ? " is-active" : ""}">
          <button type="button" class="custom-select-pick" data-act="pick" data-val="">
            <span class="custom-select-pick-label muted">${escapeHTML(opts.emptyLabel)}</span>
            ${!v ? checkSvg : ""}
          </button>
        </div>`
      : "";

    const itemRows = items.map((name) => `
      <div class="custom-select-row${name === v ? " is-active" : ""}">
        <button type="button" class="custom-select-pick" data-act="pick" data-val="${escapeAttr(name)}">
          <span class="custom-select-pick-label">${escapeHTML(name)}</span>
          ${name === v ? checkSvg : ""}
        </button>
        <div class="custom-select-row-actions">
          <button type="button" class="custom-select-action" data-act="rename" data-val="${escapeAttr(name)}" title="改名" aria-label="改名">${renameSvg}</button>
          <button type="button" class="custom-select-action danger" data-act="delete" data-val="${escapeAttr(name)}" title="刪除" aria-label="刪除">${trashSvg}</button>
        </div>
      </div>
    `).join("");

    menu.innerHTML = `
      ${emptyRow}
      ${itemRows}
      ${items.length ? `<div class="custom-select-sep"></div>` : ""}
      <button type="button" class="custom-select-add" data-act="new">${escapeHTML(opts.addLabel)}</button>
    `;
  }

  function open() {
    renderMenu();
    menu.hidden = false;
    custom.classList.add("is-open");
  }
  function close() {
    menu.hidden = true;
    custom.classList.remove("is-open");
  }
  function toggle() { menu.hidden ? open() : close(); }

  trigger.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggle(); };

  menu.onclick = (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const act = btn.dataset.act;
    const val = btn.dataset.val || "";
    if (act === "pick") {
      selectEl.value = val;
      syncLabel();
      close();
    } else if (act === "new") {
      close();
      openMiniPopover({
        title: opts.addTitle,
        placeholder: opts.addPlaceholder,
        onConfirm: (v) => {
          const name = (v || "").trim();
          if (!name) return;
          opts.ensureFn(name);
          opts.rerenderFn(name);
          syncLabel();
        },
      });
    } else if (act === "rename") {
      close();
      openMiniPopover({
        title: `改名:${val}`,
        placeholder: "輸入新名稱",
        defaultValue: val,
        onConfirm: (v) => {
          const next = (v || "").trim();
          if (!next || next === val) return;
          opts.renameFn(val, next);
        },
      });
    } else if (act === "delete") {
      close();
      opts.deleteFn(val);
    }
  };

  if (!_customSelects[opts.kind]) {
    document.addEventListener("click", (e) => {
      const c = _customSelects[opts.kind]?.custom;
      if (!c || c.classList.contains("is-open") === false) return;
      if (e.target.closest(`[data-custom-select="${opts.kind}"]`)) return;
      _customSelects[opts.kind].close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && _customSelects[opts.kind]?.custom.classList.contains("is-open")) {
        _customSelects[opts.kind].close();
      }
    });
  }

  _customSelects[opts.kind] = { custom, open, close, syncLabel, renderMenu };
  syncLabel();
}


function syncCustomSelectLabel(kind) {
  _customSelects[kind]?.syncLabel();
}


function renameCreator(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const all = listAllCreators();
  if (all.includes(newName)) {
    toast(`「${newName}」已存在`);
    return;
  }
  state.creators = state.creators.map((c) => c === oldName ? newName : c);
  addTombstone("creators", oldName);
  clearTombstone("creators", newName);
  state.localTools = state.localTools.map((t) => {
    const next = { ...t };
    let changed = false;
    if (t.creator === oldName) { next.creator = newName; changed = true; }
    if (Array.isArray(t.files)) {
      next.files = t.files.map((f) => {
        if (f.uploadedBy !== oldName) return f;
        changed = true;
        return { ...f, uploadedBy: newName };
      });
    }
    if (changed) next.updated = new Date().toISOString();
    return next;
  });
  if (state.me === oldName) {
    state.me = newName;
    localStorage.setItem(LS_ME_KEY, newName);
  }
  saveCreators();
  saveTools();
  renderCreatorSelect(newName);
  syncCustomSelectLabel("creator");
  render();
  toast(`已改名為「${newName}」`);
}


function renameBrand(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const all = listAllBrands();
  if (all.includes(newName)) {
    toast(`「${newName}」已存在`);
    return;
  }
  state.brands = state.brands.map((b) => b === oldName ? newName : b);
  addTombstone("brands", oldName);
  clearTombstone("brands", newName);
  state.localTools = state.localTools.map((t) =>
    t.brand === oldName ? { ...t, brand: newName, updated: new Date().toISOString() } : t
  );
  saveBrands();
  saveTools();
  renderBrandSelect(newName);
  syncCustomSelectLabel("brand");
  render();
  toast(`已改名為「${newName}」`);
}


function deleteCreator(name) {
  if (!name) return;
  const using = allTools().filter((t) => t.creator === name);
  const msg = using.length
    ? `「${name}」目前是 ${using.length} 個工具的製作人,刪了之後這些工具會變成「沒製作人」(必填,要重新指定)。確定刪除?`
    : `確定刪除製作人「${name}」?`;
  if (!confirm(msg)) return;
  addTombstone("creators", name);
  state.creators = state.creators.filter((c) => c !== name);
  state.localTools = state.localTools.map((t) =>
    t.creator === name ? { ...t, creator: "", updated: new Date().toISOString() } : t
  );
  saveCreators();
  saveTools();
  renderCreatorSelect("");
  syncCustomSelectLabel?.("creator");
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
  addTombstone("brands", name);
  state.brands = state.brands.filter((b) => b !== name);
  state.localTools = state.localTools.map((t) =>
    t.brand === name ? { ...t, brand: "", updated: new Date().toISOString() } : t
  );
  saveBrands();
  saveTools();
  renderBrandSelect("");
  syncCustomSelectLabel?.("brand");
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
  const input = document.getElementById("file-input");
  if (input) input.accept = type === "page" ? ".html,.htm,text/html" : "";
  const title = document.getElementById("file-manager-title");
  const hint = document.getElementById("file-manager-hint");
  if (title) title.textContent = type === "page" ? "HTML 檔" : "版本紀錄";
  if (hint) {
    hint.textContent = type === "page"
      ? "上傳 HTML 即發佈為 /p/<工具> 頁面。再次上傳會覆蓋上一份,單檔上限 25 MB。"
      : "每次上傳自動記錄時間 / 上傳人,最新一筆是目前版本。最多保留 5 個版本,單檔上限 25 MB。";
  }
  // Brand applies to every type — keep the dropdown populated when the user
  // switches type inside the popover.
  renderBrandSelect(document.getElementById("brand-select")?.value || "");
  if (type === "file" || type === "page") {
    renderFileList();
  }
}


/* ===== category picker (native select; manage via the category chip / popover) ===== */

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

/* Icon picker lives inside the add/edit popover — preview + 上傳 / 網址 /
   預設 buttons that update the form's hidden `icon` input. The actual
   save happens with the rest of the form, on 儲存. */

function initIconPicker() {
  const picker = document.getElementById("icon-picker");
  const fileInput = document.getElementById("icon-picker-file");
  if (!picker || !fileInput) return;

  picker.querySelectorAll("[data-icon-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const action = btn.dataset.iconAction;
      const f = $("#add-form").elements;
      if (action === "upload") {
        fileInput.click();
      } else if (action === "url") {
        const current = f.icon.value || "";
        openMiniPopover({
          title: "圖片網址",
          placeholder: "https://…",
          defaultValue: current.startsWith("data:") ? "" : current,
          type: "url",
          onConfirm: (val) => {
            f.icon.value = (val || "").trim();
            updateIconPreview();
          },
        });
      } else if (action === "clear") {
        f.icon.value = "";
        updateIconPreview();
      }
    });
  });

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await readAndResize(file, 256);
      const f = $("#add-form").elements;
      // The resized icon goes to R2 and the tool only stores a "/files/…"
      // link — base64 blobs in the state JSON made every sync ship megabytes.
      // Offline / upload failure falls back to the old inline dataURL; the
      // background migration re-uploads it on a later launch.
      try {
        f.icon.value = await uploadIconDataUrl(dataUrl, state.editingId || "new");
      } catch {
        f.icon.value = dataUrl;
      }
      updateIconPreview();
    } catch {
      toast("圖片讀取失敗");
    }
  });
}

/* Upload a dataURL icon to R2, returning the "/files/<key>" URL to store. */

async function uploadIconDataUrl(dataUrl, toolId) {
  const blob = await (await fetch(dataUrl)).blob();
  const ext = (blob.type || "").includes("png") ? "png" : "jpg";
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: {
      "Content-Type": blob.type || "image/png",
      "X-Tool-Id": "tool-icon",
      "X-Filename": encodeURIComponent(`icon-${toolId || "new"}.${ext}`),
      "X-Uploaded-By": encodeURIComponent(state.me || ""),
    },
    body: blob,
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const out = await res.json();
  return fileUrl(out.key);
}


/* ===== icon migration: inline base64 → R2 =====
   Tools saved before icons moved to R2 carry the whole base64 image inside
   the shared state blob, so every load and every sync round-trips it. After
   startup, quietly upload each one and swap in its "/files/…" link.
   `updated` is left untouched — a migration must never outrank someone's
   real edit in the merge. Any failure just leaves the rest for next launch. */

async function migrateIconsToR2() {
  const legacy = state.localTools.filter((t) => (t.icon || "").startsWith("data:"));
  if (!legacy.length) return;
  let changed = 0;
  for (const t of legacy) {
    try {
      t.icon = await uploadIconDataUrl(t.icon, t.id);
      changed++;
    } catch {
      break; // offline or server trouble — retry the remainder next time
    }
  }
  if (changed) scheduleSync();
}


function updateIconPreview() {
  const preview = document.getElementById("icon-preview");
  const letter = document.getElementById("icon-preview-letter");
  if (!preview || !letter) return;
  const f = $("#add-form").elements;
  const iconUrl = (f.icon.value || "").trim();
  const name = (f.name.value || "").trim();
  letter.textContent = initial(name);
  const oldImg = preview.querySelector("img");
  if (oldImg) oldImg.remove();
  if (iconUrl) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = "";
    img.addEventListener("error", () => img.remove());
    preview.appendChild(img);
  }
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
    if (!pop.hidden) positionPopover(pop, state.anchorEl);
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
  // Editing locks the type — you're updating the existing tool's content,
  // not converting it to a different kind.
  $("#type-selector").hidden = !!id;

  state.editingFiles = [];

  if (id) {
    const t = allTools().find((x) => x.id === id);
    if (t) {
      form.elements.id.value = t.id;
      form.elements.name.value = t.name || "";
      if (t.creator) ensureCreator(t.creator);
      renderCreatorSelect(t.creator || "");
      renderCategorySelect(t.category || "");
      setType(normalizeType(t.type));
      form.elements.url.value = t.url === "#" ? "" : (t.url || "");
      form.elements.description.value = t.description || "";
      form.elements.icon.value = t.icon || "";
      if (t.brand) ensureBrand(t.brand);
      renderBrandSelect(t.brand || "");
      if (Array.isArray(t.files)) {
        state.editingFiles = t.files.map((f) => ({ ...f }));
      }
      if (form.elements.lock) form.elements.lock.checked = !!t.lockedBy;
    }
  } else {
    renderCreatorSelect("");
    renderCategorySelect(state.prefillCategory || "");
    renderBrandSelect("");
    form.elements.icon.value = "";
    if (form.elements.lock) form.elements.lock.checked = false;
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
    icon: f.icon.value.trim(),
    brand: (f.brand?.value || "").trim(),
    lock: !!f.lock?.checked,
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
  if (d.icon) f.icon.value = d.icon;
}


function saveTool() {
  const d = formData();
  if (!d.name || !d.creator) {
    toast("請填寫工具名稱與製作人");
    return;
  }
  if (state.editingId) {
    const existing = allTools().find((t) => t.id === state.editingId);
    if (!canEditTool(existing)) {
      toast(`已鎖定 — 只有「${existing.lockedBy}」能修改`);
      return;
    }
  }
  if (d.type === "file" || d.type === "page") {
    if (!state.editingFiles.length) {
      toast(d.type === "page" ? "請上傳 HTML 檔案" : "請上傳至少一個檔案");
      return;
    }
    if (d.type === "page" && !isHtmlFile(state.editingFiles[0])) {
      toast("頁面類型只接受 .html / .htm");
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
    icon: d.icon || "",
    // The form offers 品牌/客制 for every type (link, page, file) — keep
    // whatever was picked instead of silently dropping it for non-file tools.
    brand: d.brand,
    files: (d.type === "file" || d.type === "page")
      ? state.editingFiles.map((f) => ({
          key: f.key,
          name: f.name,
          size: f.size,
          uploadedAt: f.uploadedAt,
          uploadedBy: f.uploadedBy || "",
        }))
      : [],
    lockedBy: d.lock ? d.creator : "",
    // Stamp creation time once. New tools get "now"; tools saved before this
    // field existed keep their original `updated` time so editing an old tool
    // doesn't make it masquerade as a fresh arrival.
    createdAt: existing?.createdAt || existing?.updated || new Date().toISOString(),
    updated: new Date().toISOString(),
  };

  // Drop the legacy single-file field if present from older records.
  delete record.file;

  const idx = state.localTools.findIndex((t) => t.id === id);
  if (idx >= 0) state.localTools[idx] = record;
  else state.localTools.push(record);
  clearTombstone("tools", id);

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


function deleteTool() {
  if (!state.editingId) return;
  const t = allTools().find((x) => x.id === state.editingId);
  if (!canEditTool(t)) {
    toast(`已鎖定 — 只有「${t.lockedBy}」能刪除`);
    return;
  }
  if (!confirm("確定要刪除這個工具?")) return;
  const deletedTool = state.localTools.find((x) => x.id === state.editingId) || t;
  const deletedId = state.editingId;
  addTombstone("tools", deletedId);
  state.localTools = state.localTools.filter((x) => x.id !== deletedId);
  saveTools();
  closeToolPopover();
  render();
  // Gmail-style escape hatch: most accidental deletes are noticed instantly,
  // so offer an in-place undo before the user has to find the recycle bin.
  toastUndo(`已刪除「${deletedTool?.name || deletedId}」`, "復原", () => {
    if (state.localTools.some((x) => x.id === deletedId)) return;
    state.localTools.push({ ...deletedTool, updated: new Date().toISOString() });
    clearTombstone("tools", deletedId);
    saveTools();
    render();
    toast("已復原");
  });
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
          name: gh.repo, creator: gh.owner, url, type: "link", icon: "",
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
        c.name === original ? { name, color, updated: new Date().toISOString() } : c
      );
      addTombstone("categories", original);
      clearTombstone("categories", name);
      state.localTools = state.localTools.map((t) =>
        t.category === original ? { ...t, category: name, updated: new Date().toISOString() } : t
      );
      if (state.filter === original) state.filter = name;
      saveTools();
    } else {
      const c = state.categories.find((x) => x.name === name);
      if (c) { c.color = color; c.updated = new Date().toISOString(); }
    }
    saveCats();
    toast("已更新");
  } else {
    if (state.categories.find((c) => c.name === name)) {
      toast("已有同名分類"); return;
    }
    state.categories.push({ name, color, updated: new Date().toISOString() });
    clearTombstone("categories", name);
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
  addTombstone("categories", name);
  state.categories = state.categories.filter((c) => c.name !== name);
  state.localTools = state.localTools.map((t) =>
    t.category === name ? { ...t, category: "", updated: new Date().toISOString() } : t
  );
  if (state.filter === name) state.filter = "all";
  saveCats();
  saveTools();
  if (fromPopover) closeCatPopover();
  render();
  toast("已刪除分類");
}


/* ===== positioning ===== */

function positionPopover(popEl, _anchor) {
  // Center the popover on the viewport so action buttons are always reachable.
  const panel = popEl.querySelector(".popover-panel");
  const panelWidth = panel.offsetWidth || (panel.classList.contains("popover-panel-sm") ? 360 : 460);
  const panelHeight = panel.offsetHeight || 500;
  const margin = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const top = Math.max(margin, Math.round((vh - panelHeight) / 2));
  const left = Math.max(margin, Math.round((vw - panelWidth) / 2));

  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
  panel.style.right = "auto";
}

export { autoFetch, deleteCategory, initBrandPicker, initCatPopover, initCategoryPicker, initCreatorPicker, initIconPicker, initMiniPopover, initToolPopover, initTypeSelector, migrateIconsToR2, openCatPopover, openMiniPopover, openToolPopover, syncCustomSelectLabel, updateIconPreview };
