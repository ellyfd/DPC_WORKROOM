// DPC Hub — 小知識牆:貼文、圖片、hashtag、搜尋結果
import { cssEscape, escapeAttr, escapeHTML, escapeRegex, fileUrl, formatBytes, formatDate, imagesFromClipboard, initial, isImageFile, isThisWeek, queryTokens, toast } from "./helpers.mjs?v=20260804e";
import { getMe } from "./menus.mjs?v=20260804e";
import { MAX_FILE_BYTES, addTombstone, state } from "./state.mjs?v=20260804e";
import { saveTips } from "./sync.mjs?v=20260804e";

function matchingTips(q) {
  const tokens = queryTokens(q);
  const tips = Array.isArray(state.tips) ? state.tips : [];
  return tips
    .filter((t) => {
      const hay = `${t.text || ""} ${t.author || ""}`.toLowerCase();
      return tokens.every((tk) => hay.includes(tk));
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

// 小知識 matches surfaced on the board by the header search.
// Every matching tip is its own standalone card in the board grid — complete
// text, screenshots and author, same anatomy as the popover wall. A slim
// full-width header row sits above them. Clicking a card jumps to that tip.

function tipResultsHTML(tips, q) {
  const ql = String(q || "").toLowerCase();
  const head = `
    <div class="tipres-head">
      <div class="tipres-head-title">
        <span class="tipres-spark" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/></svg>
        </span>
        <span>小知識</span>
        <span class="section-count">${tips.length}</span>
      </div>
      <button type="button" class="tipres-openall" data-open-tips>開啟小知識 →</button>
    </div>`;
  const posts = tips.map((tip) => {
    const who = tip.author
      ? `<span class="tip-who"><span class="tip-ava">${escapeHTML(initial(tip.author))}</span>${escapeHTML(tip.author)}</span>`
      : `<span class="tip-who tip-who-anon">匿名</span>`;
    const edited = tip.updatedAt ? `<span class="tip-edited">已編輯</span>` : "";
    const textHTML = tip.text ? `<div class="tip-text">${highlightTip(tip.text, ql)}</div>` : "";
    return `<section class="section tips-result tipres-post" data-open-tip="${escapeAttr(tip.id)}" role="button" tabindex="0">
        ${textHTML}
        ${tipImagesDisplayHTML(tip.images)}
        <div class="tip-foot">
          <span class="tip-meta">${who}<span class="tip-time">${escapeHTML(formatDate(tip.createdAt))}</span>${edited}</span>
        </div>
      </section>`;
  }).join("");
  return head + posts;
}


/* ===== 小知識 (shared free-text tips) =====
   A casual, natural-language knowledge board. Anyone types a one-liner,
   it gets tagged with their name + time and synced with the rest of the
   state. Newest first. Lives behind the 💡 button in the header.
   (Searching happens from the header search box, not in here.) */

let editingTipId = null;

let editingTipImages = [];      // images buffer for the tip being edited

let editDraftText = "";         // in-progress edit text (survives image re-renders)

let pendingTipImages = [];      // images attached to the tip being composed

let imgTarget = "compose";      // where the shared file input routes its picks

let tipsTagFilter = "";         // active hashtag filter on the tips wall ("" = all)


function initTipsPopover() {
  const pop = document.getElementById("tips-popover");
  if (!pop) return;

  pop.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeTipsPopover)
  );

  const input = document.getElementById("tip-input");
  const addBtn = document.getElementById("tip-add");
  addBtn?.addEventListener("click", () => submitTip());
  input?.addEventListener("keydown", (e) => {
    // Enter to send, Shift+Enter for a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitTip();
    }
  });

  // Screenshot attach — button, paste and drag-drop, all into the composer.
  const imgInput = document.getElementById("tip-image-input");
  document.getElementById("tip-image-btn")?.addEventListener("click", () => {
    imgTarget = "compose";
    imgInput?.click();
  });
  imgInput?.addEventListener("change", async (e) => {
    await attachTipImages(e.target.files, imgTarget);
    e.target.value = "";
  });
  input?.addEventListener("paste", (e) => {
    const imgs = imagesFromClipboard(e.clipboardData);
    if (imgs.length) { e.preventDefault(); attachTipImages(imgs, "compose"); }
  });
  const composer = pop.querySelector(".tips-composer");
  composer?.addEventListener("dragover", (e) => { e.preventDefault(); composer.classList.add("dragover"); });
  composer?.addEventListener("dragleave", () => composer.classList.remove("dragover"));
  composer?.addEventListener("drop", (e) => {
    e.preventDefault();
    composer.classList.remove("dragover");
    const imgs = [...(e.dataTransfer?.files || [])].filter(isImageFile);
    if (imgs.length) attachTipImages(imgs, "compose");
  });
  // Remove a pending (composer) image.
  document.getElementById("tip-image-previews")?.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm-pending]");
    if (rm) { pendingTipImages.splice(+rm.dataset.rmPending, 1); renderPendingTipImages(); }
  });

  // Delegate edit / save / cancel / delete / image clicks on the list.
  const list = document.getElementById("tips-list");
  list?.addEventListener("click", (e) => {
    const tagBtn = e.target.closest("[data-tag]");
    if (tagBtn) {
      // Same tag again = clear the filter.
      tipsTagFilter = tipsTagFilter === tagBtn.dataset.tag ? "" : tagBtn.dataset.tag;
      renderTipsList();
      return;
    }
    const del = e.target.closest("[data-del-tip]");
    if (del) { deleteTip(del.dataset.delTip); return; }
    const edit = e.target.closest("[data-edit-tip]");
    if (edit) { startEditTip(edit.dataset.editTip); return; }
    const save = e.target.closest("[data-save-tip]");
    if (save) { saveTipEdit(save.dataset.saveTip); return; }
    const cancel = e.target.closest("[data-cancel-tip]");
    if (cancel) { exitTipEdit(); return; }
    const rmImg = e.target.closest("[data-rm-edit-img]");
    if (rmImg) { captureEditDraft(); editingTipImages.splice(+rmImg.dataset.rmEditImg, 1); renderTipsList(); refocusEdit(); return; }
    const addImg = e.target.closest("[data-edit-addimg]");
    if (addImg) { captureEditDraft(); imgTarget = "edit"; document.getElementById("tip-image-input")?.click(); return; }
    const thumb = e.target.closest("[data-img-key]");
    if (thumb) { window.open(fileUrl(thumb.dataset.imgKey), "_blank", "noopener"); }
  });
  // Enter saves an edit, Shift+Enter adds a newline.
  list?.addEventListener("keydown", (e) => {
    const ta = e.target.closest(".tip-edit-input");
    if (ta && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveTipEdit(ta.dataset.editId);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) closeTipsPopover();
  });
}

/* Open the wall pre-filtered to one hashtag (e.g. a chip clicked on the
   board's search results). */

function openTipsWithTag(tag) {
  tipsTagFilter = tag || "";
  openTipsPopover();
}


function openTipsPopover(focusId) {
  const pop = document.getElementById("tips-popover");
  if (!pop) return;
  editingTipId = null;
  pendingTipImages = [];
  renderPendingTipImages();
  renderTipsList();
  pop.hidden = false;
  if (focusId) {
    // Opened from a specific 小知識 search result → jump to it and flash.
    setTimeout(() => {
      const el = document.querySelector(`.tip-item[data-tip-id="${cssEscape(focusId)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("tip-flash");
      setTimeout(() => el.classList.remove("tip-flash"), 1600);
    }, 50);
  } else {
    setTimeout(() => document.getElementById("tip-input")?.focus(), 30);
  }
}


function closeTipsPopover() {
  const pop = document.getElementById("tips-popover");
  if (pop) pop.hidden = true;
  editingTipId = null;
  pendingTipImages = [];
  tipsTagFilter = "";
}

/* Tag chips above the wall: every hashtag in use, most-used first. */

function tipTagBarHTML(tips) {
  const counts = new Map();
  for (const tip of tips) {
    for (const tag of tipTags(tip.text)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  if (!counts.size) return "";
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hant"))
    .slice(0, 12);
  const chips = top.map(([tag, n]) => `
    <button type="button" class="tip-tag tip-tag-filter${tag === tipsTagFilter ? " active" : ""}" data-tag="${escapeAttr(tag)}">
      #${escapeHTML(tag)}<span class="tip-tag-n">${n}</span>
    </button>`).join("");
  return `<div class="tip-tag-bar">${chips}</div>`;
}


function renderTipsList() {
  const wrap = document.getElementById("tips-list");
  const countEl = document.getElementById("tips-popover-count");
  if (!wrap) return;

  const tips = Array.isArray(state.tips) ? state.tips : [];
  if (countEl) countEl.textContent = tips.length;

  if (!tips.length) {
    wrap.innerHTML = `<div class="tips-empty">還沒有人分享小知識,你來開第一個 💡</div>`;
    return;
  }

  // Newest first; an active hashtag filter narrows the wall.
  let sorted = [...tips].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
  const tagBar = tipTagBarHTML(sorted);
  if (tipsTagFilter) {
    sorted = sorted.filter((tip) => tipTags(tip.text).includes(tipsTagFilter));
  }
  if (!sorted.length) {
    wrap.innerHTML = tagBar +
      `<div class="tips-empty">沒有 #${escapeHTML(tipsTagFilter)} 的小知識 — 點標籤取消過濾</div>`;
    return;
  }

  wrap.innerHTML = tagBar + sorted.map((tip) => {
    const who = tip.author
      ? `<span class="tip-who"><span class="tip-ava">${escapeHTML(initial(tip.author))}</span>${escapeHTML(tip.author)}</span>`
      : `<span class="tip-who tip-who-anon">匿名</span>`;
    const edited = tip.updatedAt ? `<span class="tip-edited">已編輯</span>` : "";

    if (tip.id === editingTipId) {
      return `<div class="tip-item is-editing" data-tip-id="${escapeAttr(tip.id)}">
          <textarea class="tip-edit-input" data-edit-id="${escapeAttr(tip.id)}" rows="3">${escapeHTML(editDraftText)}</textarea>
          ${tipImagesEditHTML(editingTipImages)}
          <div class="tip-edit-actions">
            <button type="button" class="tip-attach-btn tip-attach-sm" data-edit-addimg aria-label="加入截圖" title="加入截圖">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
            </button>
            <span class="tip-edit-actions-right">
              <button type="button" class="btn btn-secondary btn-sm" data-cancel-tip="${escapeAttr(tip.id)}">取消</button>
              <button type="button" class="btn btn-primary btn-sm" data-save-tip="${escapeAttr(tip.id)}">儲存</button>
            </span>
          </div>
        </div>`;
    }

    const textHTML = tip.text ? `<div class="tip-text">${linkifyTip(tip.text)}</div>` : "";
    return `<div class="tip-item" data-tip-id="${escapeAttr(tip.id)}">
        ${textHTML}
        ${tipImagesDisplayHTML(tip.images)}
        <div class="tip-foot">
          <span class="tip-meta">${who}<span class="tip-time">${escapeHTML(formatDate(tip.createdAt))}</span>${edited}</span>
          <span class="tip-acts">
            <button type="button" class="tip-act" data-edit-tip="${escapeAttr(tip.id)}" aria-label="編輯這則" title="編輯">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
            </button>
            <button type="button" class="tip-act tip-act-del" data-del-tip="${escapeAttr(tip.id)}" aria-label="刪除這則" title="刪除">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          </span>
        </div>
      </div>`;
  }).join("");
}


async function uploadTipImage(file, name) {
  const fname = name || file.name || "screenshot.png";
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Tool-Id": "tip-image",
      "X-Filename": encodeURIComponent(fname),
      "X-Uploaded-By": encodeURIComponent(state.me || ""),
    },
    body: file,
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
// Pasted screenshots come through as generic "image.png" / "screenshot.png" —
// show them simply as "screenshot". Real picked filenames are kept as-is.

function tipImageName(file) {
  if (!file.name || /^(image|screenshot)(\s*\(\d+\))?\.\w+$/i.test(file.name)) {
    return "screenshot";
  }
  return file.name;
}

async function attachTipImages(fileList, target) {
  const files = [...(fileList || [])].filter(isImageFile);
  if (!files.length) return;
  if (target === "edit") captureEditDraft();
  let ok = 0;
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      toast(`圖片太大(${formatBytes(file.size)},上限 ${formatBytes(MAX_FILE_BYTES)})`);
      continue;
    }
    try {
      toast("上傳截圖中…");
      const name = tipImageName(file);
      const meta = await uploadTipImage(file, name);
      const ref = { key: meta.key, name };
      if (target === "edit") editingTipImages.push(ref);
      else pendingTipImages.push(ref);
      ok++;
    } catch (err) {
      toast("截圖上傳失敗");
      console.error(err);
    }
  }
  if (target === "edit") { renderTipsList(); refocusEdit(); }
  else renderPendingTipImages();
  if (ok) toast(`已加入 ${ok} 張截圖`);
}

function tipImagesDisplayHTML(images) {
  if (!Array.isArray(images) || !images.length) return "";
  return `<div class="tip-imgs">` + images.map((img) => {
    const name = img.name || "截圖";
    return `<button type="button" class="tip-thumb" data-img-key="${escapeAttr(img.key)}" title="點開看大圖:${escapeAttr(name)}">
       <img src="${fileUrl(img.key)}" alt="${escapeAttr(name)}" loading="lazy" />
       <span class="tip-thumb-name">${escapeHTML(name)}</span>
     </button>`;
  }).join("") + `</div>`;
}

function tipFileCardHTML(img, rmAttr) {
  const name = img.name || "截圖";
  return `<div class="tip-filecard">
       <img class="tip-filecard-img" src="${fileUrl(img.key)}" alt="" />
       <span class="tip-filecard-name" title="${escapeAttr(name)}">${escapeHTML(name)}</span>
       <button type="button" class="tip-filecard-rm" ${rmAttr} aria-label="移除截圖" title="移除">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6L6 18"/></svg>
       </button>
     </div>`;
}

function tipImagesEditHTML(images) {
  if (!Array.isArray(images) || !images.length) return "";
  return `<div class="tip-files editing">` +
    images.map((img, i) => tipFileCardHTML(img, `data-rm-edit-img="${i}"`)).join("") +
    `</div>`;
}

function renderPendingTipImages() {
  const wrap = document.getElementById("tip-image-previews");
  if (!wrap) return;
  wrap.hidden = pendingTipImages.length === 0;
  wrap.innerHTML = pendingTipImages
    .map((img, i) => tipFileCardHTML(img, `data-rm-pending="${i}"`))
    .join("");
}

function captureEditDraft() {
  const ta = document.querySelector(".tip-edit-input");
  if (ta) editDraftText = ta.value;
}

function refocusEdit() {
  const ta = document.querySelector(".tip-edit-input");
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function exitTipEdit() {
  editingTipId = null;
  editingTipImages = [];
  editDraftText = "";
  renderTipsList();
}


function startEditTip(id) {
  const tip = state.tips.find((t) => t.id === id);
  if (!tip) return;
  editingTipId = id;
  editDraftText = tip.text || "";
  editingTipImages = Array.isArray(tip.images) ? tip.images.map((i) => ({ ...i })) : [];
  renderTipsList();
  refocusEdit();
}


function saveTipEdit(id) {
  const tip = state.tips.find((t) => t.id === id);
  if (!tip) { exitTipEdit(); return; }
  captureEditDraft();
  const text = editDraftText.trim();
  if (!text && !editingTipImages.length) { toast("內容不能空白"); return; }

  const imagesChanged = JSON.stringify(tip.images || []) !== JSON.stringify(editingTipImages);
  if (text !== tip.text || imagesChanged) {
    tip.text = text;
    tip.images = editingTipImages.slice();
    tip.updatedAt = new Date().toISOString();
    saveTips();
    toast("已更新");
  }
  exitTipEdit();
}

// Turn bare URLs in a tip into clickable links (everything else escaped).

/* ===== 小知識 hashtag =====
   Pure convention, zero schema: a "#標籤" in the text becomes a clickable
   chip that filters the wall. The # must sit at the start or after
   whitespace/brackets so a URL's #fragment never turns into a tag. */

const TIP_TAG_RX = /(^|[\s(（【[])#([\p{L}\p{N}_-]{1,24})/gu;


function tipTags(text) {
  const out = [];
  for (const m of String(text || "").matchAll(TIP_TAG_RX)) out.push(m[2]);
  return out;
}


function linkifyTip(text) {
  const safe = escapeHTML(text || "");
  const linked = safe.replace(/https?:\/\/[^\s<]+/g, (url) =>
    `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(url)}</a>`
  );
  // Hashtags → chips. Only rewrite text segments (never inside the <a> tags
  // just generated), mirroring how highlightTip stays markup-safe.
  return linked.replace(/<[^>]+>|[^<]+/g, (seg) =>
    seg[0] === "<" ? seg : seg.replace(TIP_TAG_RX, (m, pre, tag) =>
      `${pre}<button type="button" class="tip-tag" data-tag="${escapeAttr(tag)}">#${escapeHTML(tag)}</button>`)
  ).replace(/\n/g, "<br>");
}

// Linkified tip with the search term wrapped in <mark>. Highlighting only
// touches text segments, never the generated <a>/<br> tags, so markup stays valid.

function highlightTip(text, q) {
  const html = linkifyTip(text);
  const tokens = queryTokens(q);
  if (!tokens.length) return html;
  const rx = new RegExp("(" + tokens.map(escapeRegex).join("|") + ")", "gi");
  return html.replace(/<[^>]+>|[^<]+/g, (seg) =>
    seg[0] === "<" ? seg : seg.replace(rx, '<mark class="tip-hl">$&</mark>')
  );
}


async function submitTip() {
  const input = document.getElementById("tip-input");
  if (!input) return;
  const text = input.value.trim();
  if (!text && !pendingTipImages.length) { toast("寫點什麼,或加張截圖吧"); return; }

  const author = await getMe();

  state.tips.push({
    id: "tip-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    text,
    images: pendingTipImages.slice(),
    author: author || "",
    createdAt: new Date().toISOString(),
  });
  saveTips();

  input.value = "";
  pendingTipImages = [];
  renderPendingTipImages();
  editingTipId = null;
  renderTipsList();
  updateTipsBadge();
  input.focus();
  toast("已分享小知識");
}


function deleteTip(id) {
  const idx = state.tips.findIndex((t) => t.id === id);
  if (idx < 0) return;
  if (!confirm("刪除這則小知識?")) return;
  addTombstone("tips", id);
  state.tips.splice(idx, 1);
  saveTips();
  renderTipsList();
  updateTipsBadge();
  toast("已刪除");
}

// Reflect the count of tips ADDED THIS WEEK on the header button — a gentle
// "what's new" nudge, not the running total. Hidden when there's nothing new.

function updateTipsBadge() {
  const badge = document.getElementById("tips-count");
  if (!badge) return;
  const tips = Array.isArray(state.tips) ? state.tips : [];
  const n = tips.filter((t) => isThisWeek(t.createdAt)).length;
  badge.textContent = n;
  badge.hidden = n === 0;
  const btn = document.getElementById("open-tips");
  if (btn) btn.title = n ? `小知識 — 本週新增 ${n} 則` : "小知識 — 大家的小撇步";
}

// Monday 00:00 (local) of the current week.

export { initTipsPopover, matchingTips, openTipsPopover, openTipsWithTag, tipResultsHTML, updateTipsBadge };
