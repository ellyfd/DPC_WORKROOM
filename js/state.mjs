// DPC Hub — 共用狀態物件、localStorage 鍵、常數

const LS_DRAFT_KEY = "dpcHub.draft.v1";

const LS_COLLAPSE_KEY = "dpcHub.collapsed.v1";

const LS_ME_KEY = "dpcHub.me.v1";

const LS_NEW_SEEN_KEY = "dpcHub.newSeen.v1";

const NUM_COLORS = 7;

const MAX_FILE_BYTES = 25 * 1024 * 1024;  // 25 MB per upload (R2 backed)

const MAX_VERSIONS = 5;                    // keep at most this many file versions per tool


const state = {
  seedTools: [],
  localTools: [],
  categories: [],
  creators: [],
  brands: [],
  // shared free-text knowledge snippets ("小知識")
  tips: [],
  filter: "all",
  brandFilter: "",
  query: "",
  // header search scope — "" 全部 | "tips" 小知識 | "tools" 工具
  searchScope: "",
  editingId: null,
  editingCat: null,
  prefillCategory: null,
  anchorEl: null,
  collapsed: {},
  // versions list for the file-type tool currently open in the popover
  editingFiles: [],
  // persistent "current user" name (tagged on each file upload)
  me: "",
  // id of the tool currently being dragged between categories
  draggingToolId: null,
  // name of the category currently being dragged for reordering
  draggingCategoryName: null,
  // delete-markers synced with the server: { kind: { key: ISO time } }.
  // A plain "missing from the array" is NOT a deletion on the server any
  // more — only these tombstones delete, so a stale tab can't resurrect
  // removed tools or wipe ones it never saw.
  tombstones: { tools: {}, tips: {}, categories: {}, creators: {}, brands: {} },
  // server state revision we last loaded — sent with each sync so the
  // server knows whether we're up to date (replace) or stale (merge).
  rev: 0,
  // server-managed, read-only on the client: the recycle bin (full copies
  // of deleted tools, restorable for 30 days) and the recent-changes feed.
  deletedTools: [],
  activity: [],
  // per-tool usage counters from the server: { toolId: {opens, downloads, lastAt} }
  stats: {},
  // monthly usage rollup, fetched lazily when the stats pane opens:
  // { toolId: { "YYYY-MM": {opens, downloads} } }
  monthlyStats: {},
};


function addTombstone(kind, key) {
  if (!key) return;
  state.tombstones[kind][key] = new Date().toISOString();
}

function clearTombstone(kind, key) {
  if (key) delete state.tombstones[kind][key];
}

export { LS_COLLAPSE_KEY, LS_DRAFT_KEY, LS_ME_KEY, LS_NEW_SEEN_KEY, MAX_FILE_BYTES, MAX_VERSIONS, NUM_COLORS, addTombstone, clearTombstone, state };
