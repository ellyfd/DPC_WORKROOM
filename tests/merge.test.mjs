/* 同步合併邏輯的回歸測試 — 部署前由 deploy.yml 執行。
   直接 import worker 的具名匯出,不需要任何測試框架:
   任何一項失敗會以非零碼結束,CI 就不會部署。 */
import {
  normalizeState,
  mergeStates,
  purgeTombstones,
  computeTrash,
  computeDeletedTools,
  appendActivity,
  writeOriginAllowed,
  monthKey,
  monthFloor,
} from "../worker/index.js";

const now = Date.now();
const iso = (offsetMin) => new Date(now + offsetMin * 60000).toISOString();
let fails = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error("FAIL:", msg); fails = 1; }
  else console.log("PASS:", msg);
};

/* ---- 情境:多人同步互相覆蓋(原始 bug) ---- */
const server = normalizeState({
  tools: [
    { id: "gap-fabric", name: "GAP代用布查找", updated: iso(-60) },
    { id: "kohs", name: "KOHS 圖片命名", updated: iso(-5), files: [{ key: "k/f1" }] },
  ],
  categories: [{ name: "DIGITAL FABRIC", color: 1, updated: iso(-60) }],
  creators: ["葇"],
  brands: ["GAP"],
  tips: [{ id: "tip1", text: "hi", createdAt: iso(-40) }],
  tombstones: { tools: { dead: iso(-30) }, tips: {}, categories: {}, creators: { 丙: iso(-20) }, brands: {} },
  rev: 9,
});

// 刪除 gap-fabric 的用戶端(帶 tombstone)
const deleter = normalizeState({
  tools: [{ id: "kohs", name: "KOHS 圖片命名", updated: iso(-5), files: [{ key: "k/f1" }] }],
  creators: ["葇"], brands: ["GAP"],
  tombstones: { tools: { "gap-fabric": iso(0), dead: iso(-30) }, tips: {}, categories: {}, creators: { 丙: iso(-20) }, brands: {} },
});
const afterDelete = mergeStates(server, deleter);
assert(!afterDelete.tools.some((t) => t.id === "gap-fabric"), "帶 tombstone 的刪除生效");

// 過期分頁(不知道 kohs 存在)做任意編輯
const staleTab = normalizeState({
  tools: [{ id: "gap-fabric", name: "GAP代用布查找", updated: iso(-60) }],
});
const afterStale = mergeStates(afterDelete, staleTab);
assert(afterStale.tools.some((t) => t.id === "kohs"), "過期分頁蓋不掉別人新增的工具");
assert(!afterStale.tools.some((t) => t.id === "gap-fabric"), "已刪除的工具不會被過期分頁復活");

/* ---- 空白用戶端(載入失敗)只加不刪 ---- */
const blank = normalizeState({ tools: [{ id: "new", name: "NEW", updated: iso(0) }] });
const m2 = mergeStates(server, blank);
assert(m2.tools.length === 3 && m2.tools.some((t) => t.id === "new"), "空白用戶端只會加不會洗掉資料");
assert(m2.creators.includes("葇") && m2.brands.includes("GAP"), "製作人/品牌保留");

/* ---- 同工具併發編輯:檔案聯集 ---- */
const fileServer = normalizeState({
  tools: [{ id: "t", name: "T", updated: iso(-1), files: [{ key: "new" }, { key: "old" }] }],
  rev: 5,
});
const fileStale = normalizeState({
  tools: [{ id: "t", name: "T", description: "改", updated: iso(0), files: [{ key: "old" }] }],
});
const fm = mergeStates(fileServer, fileStale);
const ft = fm.tools[0];
assert(ft.description === "改" && ft.files.some((f) => f.key === "new"), "同工具併發:欄位取新、檔案聯集不掉檔");

/* ---- 回收暫存(trash):緩刪 + 救回 + 期滿真刪 ---- */
const oldS = normalizeState({
  tools: [{ id: "x", updated: iso(-10), files: [{ key: "k1" }, { key: "k2" }] }],
  trash: { k9: iso(-31 * 24 * 60), k8: iso(-1 * 24 * 60) },
});
const finS = normalizeState({
  tools: [
    { id: "x", updated: iso(0), files: [{ key: "k1" }] },
    { id: "y", updated: iso(0), files: [{ key: "k8" }] },
  ],
});
const { trash, expired } = computeTrash(oldS, finS);
assert(trash.k2 && !expired.includes("k2"), "剛失去引用的檔案進回收暫存");
assert(!trash.k8, "重新引用的檔案被救回");
assert(expired.includes("k9"), "超過 30 天才真正刪除");

/* ---- R2 icon(/files/ 連結)跟檔案走同一套 trash 生命週期 ---- */
const iconOld = normalizeState({
  tools: [
    { id: "a", updated: iso(-10), icon: "/files/tool-icon/icon-a.png" },
    { id: "b", updated: iso(-10), icon: "/files/tool-icon/icon-b.png" },
  ],
  trash: { "tool-icon/icon-c.png": iso(-1 * 24 * 60) },
});
const iconFin = normalizeState({
  tools: [
    { id: "a", updated: iso(0), icon: "" }, // a 換掉 icon
    { id: "d", updated: iso(0), icon: "/files/tool-icon/icon-c.png" }, // c 被重新引用
    // b 整個被刪
  ],
});
const iconTrash = computeTrash(iconOld, iconFin);
assert(iconTrash.trash["tool-icon/icon-a.png"], "被換掉的 icon 進回收暫存");
assert(iconTrash.trash["tool-icon/icon-b.png"], "被刪工具的 icon 進回收暫存");
assert(!iconTrash.trash["tool-icon/icon-c.png"], "重新引用的 icon 被救回");
assert(
  !iconTrash.trash["data:image/png;base64,xxx"] && !iconTrash.trash["https://example.com/x.png"],
  "dataURL / 外部網址 icon 不進 trash 機制"
);

/* ---- tombstone:期限清除 + 未來時間壓回 ---- */
const tomb = { tools: { old: iso(-31 * 24 * 60), fresh: iso(-60), fast: iso(120) }, tips: {}, categories: {}, creators: {}, brands: {} };
purgeTombstones(tomb);
assert(!tomb.tools.old && !!tomb.tools.fresh, "tombstone 30 天後清除");
assert(Date.parse(tomb.tools.fast) <= Date.now(), "未來時間戳被壓回現在");

/* ---- 回收桶:刪除入桶、還原出桶 ---- */
const binOld = normalizeState({
  tools: [{ id: "a", name: "A", updated: iso(-10) }],
  deletedTools: [{ tool: { id: "b", name: "B" }, deletedAt: iso(-5) }],
  tombstones: { tools: { b: iso(-5) }, tips: {}, categories: {}, creators: {}, brands: {} },
});
const binFinal = normalizeState({
  tools: [{ id: "b", name: "B", updated: iso(0) }], // b 被還原
  tombstones: { tools: { a: iso(0) }, tips: {}, categories: {}, creators: {}, brands: {} }, // a 被刪除
});
const bin = computeDeletedTools(binOld, binFinal, "Elly");
assert(bin.some((e) => e.tool.id === "a"), "剛刪除的工具進回收桶(含完整內容)");
assert(bin.find((e) => e.tool.id === "a")?.deletedBy === "Elly", "回收桶記錄刪除人");
assert(!bin.some((e) => e.tool.id === "b"), "還原後離開回收桶");

/* ---- 異動紀錄 ---- */
const acts = appendActivity(binOld, binFinal, "小葇");
assert(acts.some((a) => a.action === "刪除工具" && a.target === "A" && a.actor === "小葇"), "刪除留下紀錄與操作人");
assert(acts.some((a) => a.action === "還原工具" && a.target === "B"), "還原被辨識為還原(而非新增)");

/* ---- 使用統計月份分桶 ---- */
assert(monthKey(Date.UTC(2026, 0, 15)) === "2026-01", "monthKey 產生 YYYY-MM 桶");
assert(monthFloor(1, Date.UTC(2026, 8, 2)) === "2026-09", "monthFloor(1) = 當月");
assert(monthFloor(12, Date.UTC(2026, 8, 2)) === "2025-10", "monthFloor(12) 含當月共 12 個月");
assert(monthFloor(6, Date.UTC(2026, 1, 10)) === "2025-09", "monthFloor 跨年正確");

/* ---- 寫入來源檢查 ---- */
const req = (origin) => ({ headers: { get: (k) => (k === "Origin" ? origin : null) } });
assert(writeOriginAllowed(req(null)), "無 Origin(同源 GET / CLI)放行");
assert(writeOriginAllowed(req("https://dpcwork.ellyfd.workers.dev")), "正式站放行");
assert(writeOriginAllowed(req("http://localhost:8787")), "本機開發放行");
assert(!writeOriginAllowed(req("null")), "沙箱頁面(Origin: null)拒絕");
assert(!writeOriginAllowed(req("https://evil.example.com")), "外部網站拒絕");

process.exit(fails);
