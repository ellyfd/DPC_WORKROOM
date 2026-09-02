// DPC Hub — 進入點:init、快捷鍵、Share Target、legacy 轉址
import { maybeShowNewArrivalsNotice, render, renderSections } from "./board.mjs?v=20260804e";
import { ensureBrandsFromTools, ensureCategoriesFromTools, ensureCreatorsFromTools, groupedTools, maybeImportFromHash, migrateToolsSchema } from "./data.mjs?v=20260804e";
import { initFileUpload } from "./files.mjs?v=20260804e";
import { $, fileUrl, initial, loadJSON, saveJSON } from "./helpers.mjs?v=20260804e";
import { initHistoryPopover, openHistoryPopover } from "./history.mjs?v=20260804e";
import { initFilePopover, initTileContextMenu, initTileFileMenu, initTileTooltip } from "./menus.mjs?v=20260804e";
import { autoFetch, initBrandPicker, initCatPopover, initCategoryPicker, initCreatorPicker, initIconPicker, initMiniPopover, initToolPopover, initTypeSelector, migrateIconsToR2, openCatPopover, openToolPopover, updateIconPreview } from "./popovers.mjs?v=20260804e";
import { LS_COLLAPSE_KEY, LS_ME_KEY, state } from "./state.mjs?v=20260804e";
import { _dirty, _lastLoadedAt, _syncTimer, _syncing, bootSyncState, quietRefresh, setupPullToRefresh, syncStateNow } from "./sync.mjs?v=20260804e";
import { initTipsPopover, openTipsPopover, openTipsWithTag, updateTipsBadge } from "./tips.mjs?v=20260804e";

const CANONICAL_HOST = "dpcwork.ellyfd.workers.dev";


document.addEventListener("DOMContentLoaded", init);


async function init() {
  // Anything that isn't the canonical Worker host (or local dev) gets
  // redirected. If the visitor still has legacy localStorage data from
  // the old GitHub Pages deployment, we pack it into the URL hash so
  // the destination site can offer to import it.
  const host = location.hostname;
  if (
    host !== CANONICAL_HOST &&
    host !== "localhost" &&
    !host.startsWith("127.")
  ) {
    return redirectToCanonical();
  }

  state.seedTools = [];
  state.collapsed = loadJSON(LS_COLLAPSE_KEY, {});
  state.me = (localStorage.getItem(LS_ME_KEY) || "").trim();

  await bootSyncState();

  // First-time seed: if the server is empty, pull the static tools.json
  // (if present) and push it up as the initial state.
  if (
    state.localTools.length === 0 &&
    state.categories.length === 0 &&
    state.creators.length === 0 &&
    state.brands.length === 0
  ) {
    try {
      const res = await fetch("tools.json", { cache: "no-cache" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.tools) && data.tools.length) {
          state.localTools = data.tools;
          migrateToolsSchema();
          ensureCategoriesFromTools();
          ensureCreatorsFromTools();
          ensureBrandsFromTools();
          await syncStateNow();
        }
      }
    } catch {}
  }
  migrateToolsSchema();
  ensureCategoriesFromTools();
  ensureCreatorsFromTools();
  ensureBrandsFromTools();

  // If the URL has #data=..., offer to import before rendering.
  await maybeImportFromHash();

  render();

  // Pull-to-refresh (mobile / installed PWA) — reload server data on pull-down.
  setupPullToRefresh();

  // Stale-tab guard: a tab/PWA that comes back to the foreground quietly
  // re-pulls server data, so edits made on other devices show up without a
  // manual reload and we never keep working on top of hours-old state.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    if (document.body.classList.contains("overlay-open")) return; // mid-edit
    if (_syncing || _syncTimer || _dirty) return; // unconfirmed local edits
    if (Date.now() - _lastLoadedAt < 30 * 1000) return;
    if (!(await quietRefresh())) return; // offline / error → keep what we have
    migrateToolsSchema();
    ensureCategoriesFromTools();
    ensureCreatorsFromTools();
    ensureBrandsFromTools();
    render();
  });

  // After the board is up, surface a dismissable "本週上新" notice (once per batch).
  maybeShowNewArrivalsNotice();

  // Move any legacy base64 icons out of the state blob into R2 (background).
  migrateIconsToR2();

  // Debounced: renderSections rebuilds the whole board, so don't do it on
  // every keystroke of a fast typist — once the input settles is enough.
  let searchTimer = null;
  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderSections, 120);
  });
  $("#brand-filter")?.addEventListener("change", (e) => {
    state.brandFilter = e.target.value || "";
    renderSections();
  });
  $("#search-scope")?.addEventListener("change", (e) => {
    state.searchScope = e.target.value || "";
    renderSections();
  });
  $("#open-add").addEventListener("click", (e) => openToolPopover(null, e.currentTarget));
  $("#open-tips")?.addEventListener("click", () => openTipsPopover());
  $("#open-history")?.addEventListener("click", () => openHistoryPopover());
  // 小知識 posts shown inside the board (from the header search) → open the popover.
  // Links / screenshots inside a post act on their own; anywhere else on the
  // post jumps to & highlights that one, the header opens the full list.
  $("#sections-area")?.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const tag = e.target.closest(".tip-tag");
    if (tag) { openTipsWithTag(tag.dataset.tag || ""); return; }
    const thumb = e.target.closest("[data-img-key]");
    if (thumb) { window.open(fileUrl(thumb.dataset.imgKey), "_blank", "noopener"); return; }
    const one = e.target.closest("[data-open-tip]");
    if (one) { openTipsPopover(one.dataset.openTip); return; }
    if (e.target.closest("[data-open-tips]")) openTipsPopover();
  });
  $("#sections-area")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const one = e.target.closest("[data-open-tip]");
    if (one && e.target === one) { e.preventDefault(); openTipsPopover(one.dataset.openTip); }
  });
  $("#open-add-cat").addEventListener("click", (e) => openCatPopover(null, e.currentTarget));
  $("#empty-cta").addEventListener("click", (e) => openToolPopover(null, e.currentTarget));
  $("#expand-all")?.addEventListener("click", () => setAllCollapsed(false));
  $("#collapse-all")?.addEventListener("click", () => setAllCollapsed(true));

  initToolPopover();
  initCatPopover();
  initMiniPopover();
  initCreatorPicker();
  initCategoryPicker();
  initBrandPicker();
  initIconPicker();
  initTypeSelector();
  initFileUpload();
  initTileFileMenu();
  initTileContextMenu();
  initTileTooltip();
  initFilePopover();
  initTipsPopover();
  initHistoryPopover();
  initShortcuts();
  initOverlayScrollLock();

  updateTipsBadge();

  // Installed-PWA share sheet → prefill the add-tool form (see share_target
  // in manifest.webmanifest). After popovers are wired, never before.
  maybeHandleShareTarget();
}


/* ===== PWA Share Target =====
   manifest.webmanifest declares a GET share_target, so "share to DPC Hub"
   from a phone lands here as ?su=<url>&sx=<text>&st=<title>. Open the
   add-tool form, prefill the URL and let the existing auto-fetch grab the
   name/icon. Many apps put the link in the text field, so fish it out of
   there too. */

function maybeHandleShareTarget() {
  const params = new URLSearchParams(location.search);
  if (!params.has("su") && !params.has("sx") && !params.has("st")) return;
  const rawUrl = (params.get("su") || "").trim();
  const text = (params.get("sx") || "").trim();
  const title = (params.get("st") || "").trim();
  // Strip the share params so a reload doesn't re-open the form.
  history.replaceState(null, "", location.pathname);

  const fromText = (text.match(/https?:\/\/\S+/) || [])[0] || "";
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : fromText;
  if (!url && !title && !text) return;

  openToolPopover(null, $("#open-add"));
  const f = $("#add-form").elements;
  if (url) f.url.value = url;
  if (title && !f.name.value) f.name.value = title;
  if (!url && text && !f.description.value) f.description.value = text;
  updateIconPreview();
  if (url) autoFetch();
}


/* ===== overlay scroll lock =====
   While any popover is open, lock the page behind it. Otherwise two live
   scrollbars show side by side: people scroll the inner list to its end,
   the wheel stops (overscroll-behavior: contain), and it looks like the
   page is stuck — they don't realize the outer scrollbar is the page's.
   Watching the `hidden` attribute covers every open/close code path. */

function initOverlayScrollLock() {
  const overlays = Array.from(
    document.querySelectorAll(".popover, .mini-popover, .modal")
  );
  if (!overlays.length) return;
  const sync = () => {
    const anyOpen = overlays.some((el) => !el.hidden);
    const body = document.body;
    if (anyOpen && !body.classList.contains("overlay-open")) {
      // Replace the page scrollbar's width so the layout doesn't shift.
      const comp = window.innerWidth - document.documentElement.clientWidth;
      body.style.setProperty("--scrollbar-comp", `${comp}px`);
      body.classList.add("overlay-open");
    } else if (!anyOpen && body.classList.contains("overlay-open")) {
      body.classList.remove("overlay-open");
      body.style.removeProperty("--scrollbar-comp");
    }
  };
  const mo = new MutationObserver(sync);
  overlays.forEach((el) =>
    mo.observe(el, { attributes: true, attributeFilter: ["hidden"] })
  );
  sync();
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


/* ===== legacy redirect (old GitHub Pages → Worker) =====
   The old deployment kept everything in localStorage. We pull whatever
   we find under the legacy keys, pack it into a URL hash and forward
   the visitor to the canonical Worker URL — where the existing
   maybeImportFromHash() flow asks them to confirm the import. */

function redirectToCanonical() {
  let hash = "";
  try {
    const tools = JSON.parse(localStorage.getItem("dpcHub.tools.v1") || "null");
    const cats = JSON.parse(localStorage.getItem("dpcHub.categories.v1") || "null");
    const creators = JSON.parse(localStorage.getItem("dpcHub.creators.v1") || "null");
    const brands = JSON.parse(localStorage.getItem("dpcHub.brands.v1") || "null");
    const hasAny =
      (Array.isArray(tools) && tools.length) ||
      (Array.isArray(cats) && cats.length) ||
      (Array.isArray(creators) && creators.length) ||
      (Array.isArray(brands) && brands.length);
    if (hasAny) {
      const slimTools = (Array.isArray(tools) ? tools : []).map((t) => {
        if (t && t.type === "file" && Array.isArray(t.files)) {
          // Strip file content; URL hashes have practical length limits and
          // file bytes now belong in R2 anyway.
          return {
            ...t,
            files: t.files.map((f) => ({
              name: f.name, size: f.size,
              uploadedAt: f.uploadedAt, uploadedBy: f.uploadedBy,
            })),
          };
        }
        return t;
      });
      const data = {
        app: "dpcHub",
        v: 2,
        tools: slimTools,
        categories: Array.isArray(cats) ? cats : [],
        creators: Array.isArray(creators) ? creators : [],
        brands: Array.isArray(brands) ? brands : [],
      };
      const json = JSON.stringify(data);
      hash = "#data=" + btoa(unescape(encodeURIComponent(json)));
    }
  } catch {}
  location.replace("https://" + CANONICAL_HOST + "/" + hash);
}
