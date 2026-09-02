# DPC Hub

**把團隊散落各地的工具,通通收進一張清爽的桌面。**
一站直達 · 一眼看完 · 一點即達。

正式站:`https://dpcwork.ellyfd.workers.dev`(Cloudflare Workers)

![hero](docs/hero.png)

---

## 為什麼需要這個?

| 你之前的日常 | 用了 DPC Hub 之後 |
| --- | --- |
| 工具散在 Slack、雲端硬碟、同事 LINE、瀏覽器書籤 | **一個網址全收齊** |
| 「上次那個布料查詢的連結在哪?」 | 點圖示直接開,搜尋一下就跳出來 |
| Python 腳本到處找最新版 | 內建版本歷史,點圖示就下載最新檔 |
| 工具是誰寫的、給哪個客人客制的,要回頭問人 | 製作人、品牌、分類,**一卡看完** |
| 誰刪的?東西怎麼不見了? | **回收桶 30 天可還原 + 異動紀錄**全都查得到 |

---

## ✨ 功能總覽

### 🚀 啟動台桌面
iOS / macOS Launchpad 風格大圖標格,分類卡片瀑布流排列(小分類不佔多餘空間)。滑過浮起、按下開啟,右鍵(手機長按)開啟編輯選單。

### ⭐ 我的常用
每個人最常開的工具自動置頂成一列 — 純個人、存在自己的裝置上,點久了自己浮現、久沒用自己退場,不用手動整理。

### 🔗 三種工具類型
- **連結**:任何 URL,點了開新分頁
- **頁面**:上傳單檔 HTML,直接發佈成 `/p/<工具>` 頁面(沙箱隔離執行)
- **檔案**:`.py` / `.xlsx` / `.zip` … 任何格式,單檔上限 **25 MB**,存 Cloudflare R2

### 📂 版本歷史
檔案類工具每次上傳自動記錄檔名、大小、時間、上傳人,保留最近 5 版。最新版有 ★ 徽章,舊版可下載。

### 🏷️ 製作人 / 分類 / 品牌
全部用「選」的,三種工具類型都能綁品牌/客制,上方一鍵依客人篩選。

### 🗑️ 回收桶 + 🕒 異動紀錄 + 📊 使用統計(「紀錄」按鈕)
- 刪掉的工具**保留 30 天**,一鍵還原;刪除當下 toast 也能直接復原
- 異動紀錄:誰在什麼時候新增/更新/刪除了什麼,時間軸呈現
- 使用統計:每個工具的開啟/下載次數(全團隊合計),淘汰決策用

### 💡 小知識
團隊共用的小撇步牆,支援貼圖、搜尋、編輯。

### 📱 PWA
可安裝到手機主畫面,下拉重新整理、切回前景自動同步最新資料。

---

## 🧱 架構

```
瀏覽器(純前端,零依賴)
   │  GET/PUT /api/state     ← 整包狀態,伺服器端逐筆合併(見下)
   │  POST /api/upload       ← 檔案上傳
   │  POST /api/hit          ← 使用統計
   ▼
Cloudflare Worker(worker/index.js)
   ├── D1(dpc-hub)          ← 狀態 JSON、檔案中繼資料、使用統計
   └── R2(dpc-hub-files)    ← 上傳的檔案 + 每日備份快照
```

**多人同步**:伺服器端逐筆合併(工具/小知識依 id + 時間戳,刪除靠
tombstone 標記 30 天)。過期分頁不會蓋掉別人的新工具、也不能讓已刪除
的東西復活;失去引用的檔案先進 30 天回收暫存才真正刪除。

---

## 🔧 維運手冊

### 部署

Push 到 `main` 自動部署(`.github/workflows/deploy.yml`):

1. 語法檢查 + `tests/merge.test.mjs` 回歸測試,**紅燈不部署**
2. 用 commit SHA 自動蓋 `?v=` 版本號與 Service Worker 快取名(不用手動改)
3. `wrangler-action` 部署 Worker + 靜態資產

### 資料安全

- **每日備份**:cron(台灣時間 02:00)把整包狀態快照存到 R2 的
  `_backups/state-YYYY-MM-DD.json`,保留 30 天
- **回收桶**:刪掉的工具保留完整內容 30 天,前端「紀錄」按鈕一鍵還原
- **檔案緩刪**:失去引用的 R2 檔案進回收暫存 30 天,重新引用自動救回

### 從備份還原(最後手段)

```bash
# 1. 找出要還原的快照
npx wrangler r2 object get dpc-hub-files/_backups/state-2026-08-03.json --file=snapshot.json
# 2. 檢查內容無誤後,把它寫回 D1 的 kv 表
npx wrangler d1 execute dpc-hub --command \
  "UPDATE kv SET v = (內容), updated_at = strftime('%s','now')*1000 WHERE k = 'state'"
```

### 建議開啟:Cloudflare Access(登入牆)

API 目前沒有身分驗證,建議在 Cloudflare Zero Trust 加一層登入
(50 人以下免費、不用改程式):Zero Trust → Access → Applications →
Add application → Self-hosted → 網域填 `dpcwork.ellyfd.workers.dev`,
Policy 設定允許的公司信箱網域即可。

---

## 🗂️ 專案檔案

```
DPC_WORKROOM/
├── index.html            # 整個 UI(header / 面板 / 表單)
├── styles.css            # 所有樣式 + RWD
├── js/                   # 前端邏輯(原生 ES modules,零框架)
│   ├── main.mjs          #   進入點:init 與各面板接線
│   ├── state.mjs         #   共用狀態物件與常數
│   ├── helpers.mjs       #   純工具函式(escape / 格式化 / toast)
│   ├── sync.mjs          #   伺服器同步、離線編輯佇列、使用計數
│   ├── data.mjs          #   工具 / 分類 / 製作人 / 品牌資料層
│   ├── board.mjs         #   啟動台板面:render、卡片、拖曳、篩選
│   ├── files.mjs         #   檔案版本管理(上傳 / 下載 / 頁面工具)
│   ├── menus.mjs         #   卡片選單、檔案面板、tooltip
│   ├── popovers.mjs      #   工具 / 分類表單、pickers、自動抓取
│   ├── tips.mjs          #   小知識牆(貼文 / 圖片 / hashtag)
│   └── history.mjs       #   紀錄面板(回收桶 / 統計 / 異動)
├── sw.js                 # Service Worker(PWA 離線殼)
├── worker/index.js       # Cloudflare Worker(API / 合併 / 備份 / 沙箱)
├── wrangler.toml         # Worker 設定(D1 / R2 / cron)
├── tests/merge.test.mjs  # 同步合併邏輯回歸測試(部署前必跑)
└── .github/workflows/deploy.yml  # 測試 → 蓋版本號 → 部署
```

前端零框架、零依賴 — 打開檔案就能改,F5 就能看效果。

---

## 📄 License

MIT — 自家工作室、設計團隊、工廠、接案窗口、行銷分頁,通通拿去用。
