// DPC Hub — 伺服器同步、離線編輯佇列、使用計數、下拉更新
import { render } from "./board.mjs?v=20260804e";
import { allTools, ensureBrandsFromTools, ensureCategoriesFromTools, ensureCreatorsFromTools, migrateToolsSchema } from "./data.mjs?v=20260804e";
import { initial, loadJSON, saveJSON, toast } from "./helpers.mjs?v=20260804e";
import { state } from "./state.mjs?v=20260804e";

let _lastLoadedAt = 0;

/* Initial load. Offline edit queue first: edits the server never confirmed
   (tab closed while offline / mid-sync) were snapshotted to localStorage —
   replay them through the server merge instead of fetching fresh state over
   them. Replay confirmed → pull the full server picture (stats, recycle
   bin, activity feed) that the snapshot never carried; still offline → keep
   showing the local edits, the retry timer pushes them up later. */

async function bootSyncState() {
  const pendingEdits = loadJSON(LS_PENDING_KEY, null);
  if (pendingEdits && Array.isArray(pendingEdits.tools)) {
    adoptServerState(pendingEdits);
    state.rev = Number.isFinite(pendingEdits.baseRev) ? pendingEdits.baseRev : 0;
    _dirty = true;
    await syncStateNow();
    if (!_dirty) await quietRefresh(true);
  } else {
    await loadRemoteState();
  }
}


async function loadRemoteState() {
  try {
    const res = await fetch("/api/state", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    adoptServerState(data);
    _lastLoadedAt = Date.now();
  } catch (e) {
    toast?.("無法載入伺服器資料,先用空白起頭");
    state.localTools = [];
    state.categories = [];
    state.creators = [];
    state.brands = [];
    state.tips = [];
    state.tombstones = { tools: {}, tips: {}, categories: {}, creators: {}, brands: {} };
    state.rev = 0;
    state.deletedTools = [];
    state.activity = [];
  }
}


function adoptServerState(data) {
  state.localTools = Array.isArray(data.tools) ? data.tools : [];
  state.categories = Array.isArray(data.categories) ? data.categories : [];
  state.creators = Array.isArray(data.creators) ? data.creators : [];
  state.brands = Array.isArray(data.brands) ? data.brands : [];
  state.tips = Array.isArray(data.tips) ? data.tips : [];
  const tomb = { tools: {}, tips: {}, categories: {}, creators: {}, brands: {} };
  if (data.tombstones && typeof data.tombstones === "object") {
    for (const kind of Object.keys(tomb)) {
      if (data.tombstones[kind] && typeof data.tombstones[kind] === "object") {
        tomb[kind] = { ...data.tombstones[kind] };
      }
    }
  }
  state.tombstones = tomb;
  state.rev = Number.isFinite(data.rev) ? data.rev : 0;
  // Server-managed extras: the recycle bin and the recent-changes feed.
  state.deletedTools = Array.isArray(data.deletedTools) ? data.deletedTools : [];
  state.activity = Array.isArray(data.activity) ? data.activity : [];
  state.stats = data.stats && typeof data.stats === "object" ? data.stats : {};
}

/* Fire-and-forget usage counter — a click/download should never block or
   error the UI, and it deliberately bypasses the state-sync machinery. */

function trackHit(toolId, kind) {
  if (!toolId) return;
  bumpLocalUsage(toolId);
  try {
    fetch("/api/hit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolId, kind }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}


/* ===== 我的常用 — per-device favorites row =====
   Usage lives only in this browser's localStorage: everyone sees their own
   row, shaped by their own habits on this device. */

const LS_USAGE_KEY = "dpcHub.usage.v1";

const FAV_MAX = 8;            // show at most this many tools

const FAV_MIN = 3;            // hide the row until it has this many

const FAV_MIN_USES = 2;       // a single stray click doesn't make a favorite

const FAV_WINDOW_MS = 60 * 24 * 60 * 60 * 1000; // forget usage older than 60 days


function bumpLocalUsage(toolId) {
  try {
    const usage = loadJSON(LS_USAGE_KEY, {});
    const u = usage[toolId] || { n: 0, last: 0 };
    u.n += 1;
    u.last = Date.now();
    usage[toolId] = u;
    saveJSON(LS_USAGE_KEY, usage);
  } catch {}
}


function favoriteTools() {
  const usage = loadJSON(LS_USAGE_KEY, {});
  const cutoff = Date.now() - FAV_WINDOW_MS;
  const byId = new Map(allTools().map((t) => [t.id, t]));
  const picked = Object.entries(usage)
    .filter(([id, u]) => byId.has(id) && u && u.n >= FAV_MIN_USES && (u.last || 0) >= cutoff)
    .sort((a, b) => b[1].n - a[1].n || (b[1].last || 0) - (a[1].last || 0))
    .slice(0, FAV_MAX)
    .map(([id]) => byId.get(id));
  return picked.length >= FAV_MIN ? picked : [];
}

/* Non-destructive server re-fetch: on any failure the current in-memory
   state is left untouched (unlike loadRemoteState, whose blank-slate
   fallback is only right at initial load).
   Sends ?since=<rev> so the server can answer "unchanged" without shipping
   the whole blob — only the usage stats (which move without bumping rev)
   come back in that case. Pass full=true to force a complete re-download. */

async function quietRefresh(full = false) {
  try {
    const useSince = !full && Number.isFinite(state.rev) && state.rev > 0;
    const res = await fetch(
      "/api/state" + (useSince ? "?since=" + state.rev : ""),
      { cache: "no-cache" }
    );
    if (!res.ok) return false;
    const data = await res.json();
    if (data && data.unchanged) {
      if (data.stats && typeof data.stats === "object") state.stats = data.stats;
    } else {
      adoptServerState(data);
    }
    _lastLoadedAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

/* Re-fetch server state and repaint. Used by pull-to-refresh (and anywhere
   we want to pick up edits made on another device). */

async function refreshFromServer() {
  // Unconfirmed local edits first — push them up so the refresh can't
  // silently replace them with the server copy.
  if (_dirty || _syncTimer || _syncing) await syncStateNow();
  if (_dirty || _syncTimer || _syncing) {
    toast?.("尚未同步完成,稍後再試");
    return;
  }
  if (!(await quietRefresh())) {
    toast?.("更新失敗,請檢查網路");
    return;
  }
  migrateToolsSchema();
  ensureCategoriesFromTools();
  ensureCreatorsFromTools();
  ensureBrandsFromTools();
  render();
  // Also nudge the service worker to look for a newer app shell.
  try { (await navigator.serviceWorker?.getRegistration())?.update(); } catch {}
  toast?.("已更新");
}

/* Pull-to-refresh — the browser's native gesture is gone once the app is
   installed (standalone), so we recreate it: pull down from the very top to
   reload data from the server. */

function setupPullToRefresh() {
  if (!("ontouchstart" in window)) return; // touch devices only

  const THRESHOLD = 70;  // px of pull needed to trigger
  const MAX = 120;       // clamp the visual travel

  const ind = document.createElement("div");
  ind.className = "ptr";
  ind.innerHTML =
    '<div class="ptr-spinner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></div>';
  document.body.appendChild(ind);

  let startY = 0, dist = 0, pulling = false, refreshing = false;

  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
  const overlayOpen = () => document.body.classList.contains("overlay-open");

  function reset() {
    ind.style.transition = "";
    ind.style.setProperty("--ptr", "0px");
    ind.classList.remove("visible", "ready");
    dist = 0;
  }

  window.addEventListener("touchstart", (e) => {
    if (refreshing || overlayOpen() || !atTop() || e.touches.length !== 1) {
      pulling = false;
      return;
    }
    startY = e.touches[0].clientY;
    pulling = true;
    dist = 0;
    ind.style.transition = "none"; // follow the finger 1:1 while pulling
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { pulling = false; reset(); return; } // moving up → cancel
    dist = Math.min(MAX, dy * 0.5); // resistance
    ind.classList.add("visible");
    ind.classList.toggle("ready", dist >= THRESHOLD);
    ind.style.setProperty("--ptr", dist + "px");
    if (e.cancelable) e.preventDefault(); // suppress native overscroll
  }, { passive: false });

  async function trigger() {
    refreshing = true;
    ind.style.transition = "transform .2s ease";
    ind.classList.remove("ready");
    ind.classList.add("visible", "refreshing");
    ind.style.setProperty("--ptr", THRESHOLD + "px");
    try {
      await refreshFromServer();
    } finally {
      setTimeout(() => {
        ind.classList.remove("refreshing");
        reset();
        refreshing = false;
      }, 400);
    }
  }

  window.addEventListener("touchend", () => {
    if (!pulling) return;
    pulling = false;
    ind.style.transition = "transform .2s ease, opacity .2s ease";
    if (dist >= THRESHOLD && !refreshing) trigger();
    else reset();
  }, { passive: true });
}


let _syncTimer = null;

let _syncing = false;

let _syncPending = false;
// true while local edits exist that the server hasn't confirmed — background
// refreshes must not replace local state while this is set.

let _dirty = false;

/* The exact payload a sync PUTs up — also what gets parked in localStorage
   while the server hasn't confirmed it (the offline edit queue). */

function syncPayload() {
  return {
    tools: state.localTools,
    categories: state.categories,
    creators: state.creators,
    brands: state.brands,
    tips: state.tips,
    tombstones: state.tombstones,
    baseRev: state.rev,
    // Who is making this change — shown in the 最近異動 feed.
    actor: state.me,
  };
}


/* ===== offline edit queue =====
   Unconfirmed edits are snapshotted to localStorage the moment they happen
   and cleared once the server acknowledges the sync. If the tab is closed
   (or the device is offline) before that, the next launch finds the
   snapshot, replays it through the server merge, and nothing is lost. */

const LS_PENDING_KEY = "dpcHub.pending.v1";


function persistPending() {
  try { saveJSON(LS_PENDING_KEY, syncPayload()); } catch {}
}

function clearPending() {
  try { localStorage.removeItem(LS_PENDING_KEY); } catch {}
}


function scheduleSync() {
  _dirty = true;
  persistPending();
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(syncStateNow, 250);
}


async function syncStateNow() {
  if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
  if (_syncing) { _syncPending = true; return; }
  _syncing = true;
  try {
    const res = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(syncPayload()),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const out = await res.json().catch(() => null);
    if (out && out.merged && out.state) {
      // We were stale — the server merged our changes with someone else's.
      // Adopt the merged result, unless more local edits are already queued
      // (either mid-sync via _syncPending or debounce-queued via _syncTimer)
      // — then stay marked stale; the follow-up sync merges again.
      if (_syncPending || _syncTimer) {
        state.rev = 0;
      } else {
        adoptServerState(out.state);
        if (!document.body.classList.contains("overlay-open")) render();
      }
    } else if (out && Number.isFinite(out.rev)) {
      state.rev = out.rev;
    }
    if (!_syncPending && !_syncTimer) {
      _dirty = false;
      clearPending();
    }
  } catch (e) {
    toast?.("同步到伺服器失敗,稍後再試");
    persistPending();
    // Keep the unsent edits marked dirty and retry shortly — the _syncTimer
    // also blocks the background refreshes from clobbering them meanwhile.
    if (!_syncTimer) _syncTimer = setTimeout(syncStateNow, 5000);
  } finally {
    _syncing = false;
    if (_syncPending) {
      _syncPending = false;
      scheduleSync();
    }
  }
}


const saveTools = scheduleSync;

const saveCats = scheduleSync;

const saveCreators = scheduleSync;

const saveBrands = scheduleSync;

const saveTips = scheduleSync;

export { _dirty, _lastLoadedAt, _syncTimer, _syncing, bootSyncState, favoriteTools, quietRefresh, saveBrands, saveCats, saveCreators, saveTips, saveTools, scheduleSync, setupPullToRefresh, syncStateNow, trackHit };
