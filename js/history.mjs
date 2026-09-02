// DPC Hub — 紀錄面板:回收桶、使用統計(含月趨勢)、異動時間軸
import { render } from "./board.mjs?v=20260804e";
import { allTools, ensureBrand, ensureCategory, ensureCreator } from "./data.mjs?v=20260804e";
import { escapeAttr, escapeHTML, toast } from "./helpers.mjs?v=20260804e";
import { clearTombstone, state } from "./state.mjs?v=20260804e";
import { _dirty, _syncTimer, _syncing, quietRefresh, saveTools } from "./sync.mjs?v=20260804e";

/* ===== history popover (recycle bin / stats / recent changes) ===== */

function initHistoryPopover() {
  const pop = document.getElementById("history-popover");
  if (!pop) return;
  pop.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", () => { pop.hidden = true; })
  );
  document.getElementById("recycle-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-restore]");
    if (btn) restoreTool(btn.dataset.restore);
  });
  pop.querySelectorAll(".history-tab").forEach((tab) =>
    tab.addEventListener("click", () => selectHistoryTab(tab.dataset.htab))
  );
}


function selectHistoryTab(name) {
  const pop = document.getElementById("history-popover");
  if (!pop) return;
  pop.querySelectorAll(".history-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.htab === name)
  );
  pop.querySelectorAll(".history-pane").forEach((p) => {
    p.hidden = p.dataset.hpane !== name;
  });
}


async function openHistoryPopover() {
  const pop = document.getElementById("history-popover");
  if (!pop) return;
  // Pull fresh server data first — the bin and the feed live server-side.
  if (!_dirty && !_syncTimer && !_syncing) await quietRefresh();
  await loadMonthlyStats();
  renderHistoryLists();
  // Land on the bin when there's something to restore, otherwise on stats.
  selectHistoryTab(state.deletedTools?.length ? "recycle" : "stats");
  pop.hidden = false;
}


function renderHistoryLists() {
  const recycle = document.getElementById("recycle-list");
  const activity = document.getElementById("activity-list");
  if (!recycle || !activity) return;

  const bin = Array.isArray(state.deletedTools) ? state.deletedTools.slice() : [];
  bin.sort((a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || ""));
  recycle.innerHTML = bin.length
    ? bin.map((e) => {
        const t = e.tool || {};
        const files = Array.isArray(t.files) && t.files.length
          ? `<span class="history-meta">${t.files.length} 個檔案</span>` : "";
        const daysLeft = binDaysLeft(e.deletedAt);
        const by = e.deletedBy
          ? `<span class="history-meta">${escapeHTML(e.deletedBy)} 刪於 ${formatWhen(e.deletedAt)}</span>`
          : `<span class="history-meta">刪於 ${formatWhen(e.deletedAt)}</span>`;
        return `
          <div class="history-row">
            <div class="history-row-main">
              <div class="history-row-title">${escapeHTML(t.name || t.id || "")}</div>
              <div class="history-row-sub">
                ${t.category ? `<span class="history-meta">${escapeHTML(t.category)}</span>` : ""}
                ${files}
                ${by}
                <span class="history-meta history-days-left">還剩 ${daysLeft} 天</span>
              </div>
            </div>
            <button type="button" class="btn btn-secondary btn-restore" data-restore="${escapeAttr(t.id || "")}">還原</button>
          </div>`;
      }).join("")
    : `<div class="history-empty">回收桶是空的 — 刪掉的工具會在這裡保留 30 天</div>`;

  const badge = document.getElementById("htab-recycle-count");
  if (badge) {
    badge.textContent = String(bin.length);
    badge.hidden = !bin.length;
  }

  renderStatsList();
  renderActivityFeed(activity);
}


function binDaysLeft(deletedAt) {
  const t = Date.parse(deletedAt || "");
  if (!Number.isFinite(t)) return "?";
  return Math.max(0, Math.ceil(30 - (Date.now() - t) / 86400000));
}

/* 最近異動 — grouped by day, with consecutive same-actor/same-action runs
   collapsed into one line ("Elly 更新工具 ×3") so the feed reads like a
   timeline instead of a raw log. */

function renderActivityFeed(el) {
  const feed = Array.isArray(state.activity) ? state.activity.slice().reverse() : [];
  if (!feed.length) {
    el.innerHTML = `<div class="history-empty">還沒有異動紀錄</div>`;
    return;
  }

  // Collapse consecutive entries by the same person doing the same action.
  const runs = [];
  for (const a of feed.slice(0, 120)) {
    const last = runs[runs.length - 1];
    if (last && last.actor === (a.actor || "") && last.action === (a.action || "") &&
        dayLabel(last.ts) === dayLabel(a.ts)) {
      last.targets.push(a.target || "");
    } else {
      runs.push({ actor: a.actor || "", action: a.action || "", ts: a.ts, targets: [a.target || ""] });
    }
  }

  let currentDay = null;
  const parts = [];
  for (const r of runs) {
    const day = dayLabel(r.ts);
    if (day !== currentDay) {
      currentDay = day;
      parts.push(`<div class="history-day">${escapeHTML(day)}</div>`);
    }
    const shown = r.targets.slice(0, 3).map((t) => `「${escapeHTML(t)}」`).join("、");
    const more = r.targets.length > 3 ? ` 等 ${r.targets.length} 項` : "";
    parts.push(`
      <div class="history-row history-row-plain">
        <div class="history-row-main">
          <div class="history-row-title">
            <span class="history-actor">${escapeHTML(r.actor || "未具名")}</span>
            ${escapeHTML(r.action)} ${shown}${more}
          </div>
          <div class="history-row-sub"><span class="history-meta">${timeOnly(r.ts)}</span></div>
        </div>
      </div>`);
  }
  el.innerHTML = parts.join("");
}


function dayLabel(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "更早";
  const d = new Date(t);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}


function timeOnly(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


function formatWhen(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* 使用統計 — used tools ranked on top; untouched ones live in a collapsed
   neutral-gray group (zero is "no data yet", not an alarm). */
/* Monthly usage rollup — fetched lazily when the stats pane opens (it's
   deliberately not part of /api/state, whose ?since= fast path stays tiny). */

let _monthlyLoadedAt = 0;


async function loadMonthlyStats() {
  if (Date.now() - _monthlyLoadedAt < 60 * 1000) return;
  try {
    const res = await fetch("/api/stats/monthly", { cache: "no-cache" });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.months && typeof data.months === "object") {
      state.monthlyStats = data.months;
      _monthlyLoadedAt = Date.now();
    }
  } catch {} // offline → the pane just shows totals without trends
}

// The last n calendar months as "YYYY-MM", oldest first, current month last.

function lastMonths(n) {
  const d = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(m.toISOString().slice(0, 7));
  }
  return out;
}


const TREND_MONTHS = 6;

const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

/* Six tiny baseline-anchored bars, one per month; zero months keep a faint
   stub so the timeline reads as six slots. Single series → accent color,
   native title tooltip per bar. */

function trendBarsHTML(toolId) {
  const byMonth = (state.monthlyStats || {})[toolId];
  if (!byMonth) return "";
  const months = lastMonths(TREND_MONTHS);
  const vals = months.map((m) => {
    const s = byMonth[m];
    return s ? (s.opens || 0) + (s.downloads || 0) : 0;
  });
  const max = Math.max(...vals);
  if (!max) return "";
  const bars = months.map((m, i) => {
    const h = vals[i] ? Math.max(3, Math.round((vals[i] / max) * 20)) : 2;
    return `<i class="trend-bar${vals[i] ? "" : " trend-bar-zero"}" style="height:${h}px" title="${m}:${vals[i]} 次"></i>`;
  }).join("");
  return `<span class="trend">${bars}</span>`;
}


function renderStatsList() {
  const el = document.getElementById("stats-list");
  if (!el) return;
  const stats = state.stats || {};
  const rows = allTools().map((t) => {
    const s = stats[t.id] || {};
    const opens = s.opens || 0;
    const downloads = s.downloads || 0;
    return { t, opens, downloads, total: opens + downloads, lastAt: s.lastAt || 0 };
  });
  if (!rows.length) {
    el.innerHTML = `<div class="history-empty">還沒有工具</div>`;
    return;
  }
  const used = rows.filter((r) => r.total > 0).sort((a, b) => b.total - a.total || b.lastAt - a.lastAt);
  const unused = rows.filter((r) => r.total === 0).sort((a, b) =>
    (a.t.name || a.t.id).localeCompare(b.t.name || b.t.id, "zh-Hant"));

  const usedHTML = used.length
    ? used.map((r) => {
        const stale = r.lastAt && Date.now() - r.lastAt > STALE_AFTER_MS;
        return `
        <div class="history-row history-row-plain">
          <div class="history-row-main">
            <div class="history-row-title">${escapeHTML(r.t.name || r.t.id)}</div>
            <div class="history-row-sub">
              <span class="history-meta">開啟 ${r.opens} 次</span>
              <span class="history-meta">下載 ${r.downloads} 次</span>
              <span class="history-meta">最近 ${r.lastAt ? formatWhen(new Date(r.lastAt).toISOString()) : "—"}</span>
              ${stale ? `<span class="stat-stale">90 天沒人用</span>` : ""}
            </div>
          </div>
          ${trendBarsHTML(r.t.id)}
          <span class="history-count">${r.total}</span>
        </div>`;
      }).join("")
    : `<div class="history-empty">還沒有使用紀錄 — 大家開始點工具後會出現在這裡</div>`;

  const unusedHTML = unused.length
    ? `<details class="stats-unused">
        <summary>尚無使用紀錄的工具 (${unused.length})</summary>
        ${unused.map((r) => `
          <div class="history-row history-row-plain history-row-muted">
            <div class="history-row-main">
              <div class="history-row-title">${escapeHTML(r.t.name || r.t.id)}</div>
              ${r.t.category ? `<div class="history-row-sub"><span class="history-meta">${escapeHTML(r.t.category)}</span></div>` : ""}
            </div>
            <span class="history-count history-count-zero">0</span>
          </div>`).join("")}
      </details>`
    : "";

  el.innerHTML = usedHTML + unusedHTML;
}


function restoreTool(id) {
  if (!id) return;
  const entry = (state.deletedTools || []).find((e) => e && e.tool && e.tool.id === id);
  if (!entry) return;
  if (state.localTools.some((t) => t.id === id)) {
    toast("這個工具已經在架上了");
    return;
  }
  // A fresh `updated` beats the delete-marker in server merges, so the
  // restore sticks even if a stale tab syncs afterwards.
  const tool = { ...entry.tool, updated: new Date().toISOString() };
  state.localTools.push(tool);
  clearTombstone("tools", id);
  state.deletedTools = state.deletedTools.filter((e) => e !== entry);
  if (tool.category) ensureCategory(tool.category);
  if (tool.creator) ensureCreator(tool.creator);
  if (tool.brand) ensureBrand(tool.brand);
  saveTools();
  renderHistoryLists();
  render();
  toast(`已還原「${tool.name || id}」`);
}

export { initHistoryPopover, openHistoryPopover };
