# DPC Hub

**把團隊散落各地的工具,通通收進一張清爽的桌面。**
一站直達 · 一眼看完 · 一點即達。

![hero](docs/hero.png)

---

## 為什麼需要這個?

| 你之前的日常 | 用了 DPC Hub 之後 |
| --- | --- |
| 工具散在 Slack、雲端硬碟、同事 LINE、瀏覽器書籤 | **一個網址全收齊** |
| 「上次那個布料查詢的連結在哪?」 | 點圖示直接開,搜尋一下就跳出來 |
| Python 腳本到處找最新版 | 內建版本歷史,點圖示就下載最新檔 |
| 工具是誰寫的、給哪個品牌客制的,要回頭問人 | 製作人、品牌、分類,**一卡看完** |
| 換手機就什麼都沒了 | 一鍵複製分享連結,**跨裝置秒同步** |

---

## ✨ 你會愛上的功能

### 🚀 啟動台一樣的桌面
iOS / macOS Launchpad 風格大圖標格。一格一個工具、彩色漸層、首字母,滑過浮起、按下開啟。**沒有花俏動畫,只有直覺。**

### 🔗 連結 vs 📁 檔案,二選一
- **連結**:URL、GitHub repo,或直接內嵌成 iframe 開
- **檔案**:`.py` / `.xlsx` / `.pdf` / `.zip` … **任何格式都收**,每檔 1 MB
- 表單最上面一鍵切,下方欄位自動換

### 📂 像 Google Drive 的版本歷史
檔案類工具每次上傳 = **自動加一筆版本紀錄**:檔名、大小、上傳時間,通通自動記。最新一筆有 ★「目前版本」徽章,舊版可下載、可刪。

**不用手動改 `1.0.0 → 1.0.1` — 時間戳就是版本。**

### 🤖 貼上連結自動填表
- GitHub 公開 repo → 自動讀名稱、描述、作者、語言、tags、頭像
- 私人 repo → 自動填 repo 名 + owner,其他自己補
- 一般網址 → 抓網域當預設名稱

### 🏷️ 製作人 / 分類 / 品牌,全部用「選」的
全部下拉選擇 + 「＋ 新增」小 popover。
不會再出現「Elly / elly / Eli」三個分身。

**品牌 / 客制**欄位(檔案類工具專屬),接案的人專用:這份 Python 是給哪家客戶做的?一秒選好。

### 🔄 三種跨裝置同步,純前端也辦得到
| 方法 | 適合 |
| --- | --- |
| 📋 **複製分享連結** | 臨時傳給同事看,LINE / Mail 一貼即可。連結內含整份清單(不含檔案內容)|
| 💾 **匯出 / 匯入 JSON** | 完整備份,**含檔案內容**,用 AirDrop / Mail 傳 |
| 🌱 **寫進 `tools.json`** | 一次 commit,**所有裝置永久自動同步** |

### 📱 為手機而生的 RWD
- 手機 4 欄圖標、平板 5 欄、桌面自動填滿
- 觸控優化:section 按鈕**永遠可見**(沒有 hover)、點按有反饋
- iOS Safari 不會 zoom-in,輸入框 16px 起跳

### 🎨 可換顯示圖
每個工具都能上傳自訂圖示(自動 resize 到 256px)、或貼圖片網址,或回到漸層 + 首字的預設樣式。

### ⌨️ 鍵盤捷徑
- `/` 跳到搜尋
- `N` 新增工具
- `ESC` 關閉視窗

---

## 🛠️ 30 秒上線

```bash
# 1. Fork 或 clone 這個 repo
git clone https://github.com/<your-username>/DPC_WORKROOM.git

# 2. GitHub → Settings → Pages → Branch: main, Folder: / (root)

# 3. 打開
# https://<your-username>.github.io/DPC_WORKROOM/
```

就這樣。
**沒有 npm install、沒有 build、沒有 Docker、沒有任何 token、沒有伺服器。**

---

## 🧱 技術棧

- **純前端**:一份 `index.html` + 一份 `styles.css` + 一份 vanilla JavaScript,**零依賴**
- **儲存**:`localStorage`(本機)+ `tools.json`(repo seed,跨裝置共享)
- **託管**:GitHub Pages,**免費**
- **字體**:Inter + Noto Sans TC
- **圖示**:全部內嵌 SVG,沒有圖示套件

沒有 React、沒有 Webpack、沒有 build pipeline。**打開檔案就能改,F5 就能看效果。**

---

## 📦 資料結構

連結類工具:
```json
{
  "id": "cloth-query",
  "name": "布料查詢 PAGE",
  "creator": "Elly",
  "category": "LIFESTYLE",
  "type": "link",
  "url": "https://...",
  "asIframe": false,
  "icon": "https://...",
  "description": "查詢倉庫布料",
  "tags": ["布料", "查詢"],
  "version": "1.2.0"
}
```

檔案類工具(含版本歷史):
```json
{
  "type": "file",
  "brand": "客戶 A",
  "files": [
    {
      "name": "report_v3.py",
      "size": 4218,
      "uploadedAt": "2025-05-16T17:40:00.000Z",
      "content": "data:text/x-python;base64,..."
    },
    {
      "name": "report_v2.py",
      "size": 3812,
      "uploadedAt": "2025-04-20T10:15:00.000Z",
      "content": "data:..."
    }
  ]
}
```

要把整份 hub 跨裝置同步?把 `state.localTools` 整個塞進 `tools.json` 的 `tools` 陣列、commit、push,所有裝置自動讀取。

---

## 🎨 自訂主題色

打開 `styles.css`,改 `:root` 變數:

```css
:root {
  --accent:       #2563eb;   /* 主色,改這個就會跟著全變 */
  --accent-hover: #1d4ed8;
  --accent-soft:  #e8efff;
}
```

分類顏色變體 `[data-cv="0"]` ~ `[data-cv="7"]`,八種彩色漸層,要加更多直接複製貼上。

---

## 🗂️ 專案檔案

```
DPC_WORKROOM/
├── index.html       # 整個 UI(form / popover / modal)
├── styles.css       # 所有樣式 + RWD
├── script.js        # 所有邏輯(localStorage / 匯出匯入 / 檔案上傳 / 自動讀取)
└── tools.json       # 種子工具清單(可選,跨裝置同步用)
```

四個檔案,**加起來不到 2000 行**,看完就懂、改了就動。

---

## 🔧 維運手冊(2026-08 起的雲端架構)

> 註:上面的「30 秒上線 / 技術棧」章節描述的是舊的 GitHub Pages 版本。
> 目前正式站跑在 Cloudflare Workers(`dpcwork.ellyfd.workers.dev`),
> 資料存 D1(狀態)+ R2(上傳檔案),前端仍是零依賴的三個檔案。

### 部署

Push 到 `main` 自動部署(`.github/workflows/deploy.yml`):

1. 語法檢查 + `tests/merge.test.mjs` 回歸測試,**紅燈不部署**
2. 用 commit SHA 自動蓋 `?v=` 版本號與 Service Worker 快取名(不用手動改)
3. `wrangler-action` 部署 Worker + 靜態資產

### 資料安全

- **多人同步**:伺服器端逐筆合併 + 刪除標記(tombstone,30 天),
  過期分頁不會蓋掉別人的新工具、也不能復活已刪除的項目
- **回收桶**:刪掉的工具保留完整內容 30 天,前端「紀錄」按鈕可一鍵還原
- **檔案緩刪**:失去引用的 R2 檔案先進回收暫存 30 天,重新引用自動救回
- **每日備份**:cron(台灣時間 02:00)把整包狀態快照存到 R2 的
  `_backups/state-YYYY-MM-DD.json`,保留 30 天

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

## 📄 License

MIT — 自家工作室、設計團隊、工廠、接案窗口、行銷分頁,通通拿去用。
