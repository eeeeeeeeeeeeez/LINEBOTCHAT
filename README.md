# LINE 官方帳號 x Gemini 3.5 Flash-Lite 聊天機器人（Cloudflare Workers 版）

用 Cloudflare Workers 接收 LINE Messaging API 的 webhook，呼叫 Gemini 3.5 Flash-Lite 產生回覆。對話記憶用 Cloudflare KV 存放（可選，不綁定也能跑，只是沒有記憶）。

現在還內建一個**知識庫後台**：透過網頁上傳文字或檔案（PDF/Word/TXT），機器人回覆前會自動去查有沒有相關資料，查到就優先參考，讓回答更貼近你自己的內容（常見問題、產品資訊、SOP 等）。

## 1. 前置準備

### A. LINE 官方帳號 / Messaging API
1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建立 Provider → 建立 **Messaging API** Channel
2. 「Messaging API」頁籤：Issue 一組 **Channel access token**（長期）
3. 「Basic settings」頁籤：取得 **Channel secret**
4. 關閉 Auto-reply messages / Greeting messages

### B. Gemini API Key
到 [Google AI Studio](https://aistudio.google.com/apikey) 建立一組 API Key（同一把 key 會用來呼叫聊天模型，也會用來呼叫 embedding 模型做知識庫向量化）

### C. Cloudflare 帳號
到 [dash.cloudflare.com](https://dash.cloudflare.com) 註冊（免費方案即可，Workers 每天 10 萬次請求額度；Vectorize 免費額度足夠中小型知識庫使用）

## 2. 本機安裝

```bash
npm install
cp .dev.vars.example .dev.vars
# 編輯 .dev.vars 填入四把金鑰（含新增的 ADMIN_PASSWORD，自己設一個後台登入密碼）
```

## 3. 建立 KV Namespace（對話記憶用，選用）

```bash
npx wrangler login
npx wrangler kv namespace create CHAT_HISTORY
```

指令會印出類似：
```
{ binding = "CHAT_HISTORY", id = "abcd1234..." }
```
把這段貼回 `wrangler.toml`，取消 `[[kv_namespaces]]` 那幾行的註解並填入 id。不需要對話記憶的話可以跳過這步，程式會自動退化成無記憶模式。

## 4. 建立知識庫用的資源（RAG，要用自行上傳知識庫功能就一定要做這步）

### A. 建立 Vectorize 向量索引
```bash
npx wrangler vectorize create kb-vectors --dimensions=768 --metric=cosine
```
`wrangler.toml` 裡的 `[[vectorize]]` 區塊已經指向 `kb-vectors` 這個名字，通常不用再改，除非你想自訂索引名稱。

### B. 建立存放文件清單的 KV Namespace
```bash
npx wrangler kv namespace create KB_DOCS
```
一樣把印出來的 id 貼到 `wrangler.toml` 裡 `KB_DOCS` 那個 binding 的 `id = "..."`。

### C. 設定後台登入密碼
本機測試：填在 `.dev.vars` 的 `ADMIN_PASSWORD`。
正式部署見下方第 5 節。

## 5. 本機測試

```bash
npm run dev
```
會啟動一個本機網址（例如 `http://localhost:8787`）。
- LINE webhook 測試需要用 `cloudflared tunnel` 或 `ngrok` 曝露出去，或直接跳到下一步部署正式環境測試。
- 知識庫後台可以直接在本機打開 `http://localhost:8787/admin` 測試上傳。

## 6. 部署到 Cloudflare（透過 GitHub）

### 方法一：Cloudflare Dashboard 連接 GitHub（推薦，之後 push 就自動部署）
1. 把專案 push 到 GitHub：
   ```bash
   git init
   git add .
   git commit -m "init"
   # 建立 GitHub repo 後
   git remote add origin <你的repo網址>
   git push -u origin main
   ```
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Import a repository**，選你的 GitHub repo
3. Build 設定：
   - Build command: `npm install`
   - Deploy command: `npx wrangler deploy`
4. 部署完後，到該 Worker 的 **Settings → Variables and Secrets**，新增：
   - `LINE_CHANNEL_ACCESS_TOKEN`（Secret）
   - `LINE_CHANNEL_SECRET`（Secret）
   - `GEMINI_API_KEY`（Secret）
   - `ADMIN_PASSWORD`（Secret，知識庫後台登入密碼，務必設定，沒設定的話 `/admin` 會整個鎖住無法使用）
5. 到 **Settings → Bindings** 加上：
   - KV Namespace binding：`CHAT_HISTORY`（要對話記憶才需要）
   - KV Namespace binding：`KB_DOCS`
   - Vectorize binding：`KB_VECTORS` → 指向 `kb-vectors` 索引
6. 之後每次 `git push` 到 main branch，Cloudflare 會自動重新部署

### 方法二：CLI 直接部署（不透過 GitHub）
```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```
部署完會得到一個網址，例如 `https://line-gemini-bot.<你的subdomain>.workers.dev`

## 7. 設定 LINE Webhook

拿到 Cloudflare 給的網址後，回到 LINE Developers Console → Messaging API 頁籤：
- Webhook URL 填入：`https://line-gemini-bot.xxx.workers.dev/webhook`
- 按 **Verify** 確認能連通
- 打開 **Use webhook** 開關

## 8. 使用知識庫後台

打開 `https://line-gemini-bot.xxx.workers.dev/admin`：
1. 輸入你設定的 `ADMIN_PASSWORD` 登入
2. 兩種新增知識庫內容的方式：
   - **貼上文字**：直接貼內容，填個標題，按新增
   - **上傳檔案**：支援 `.pdf` `.docx` `.txt` `.md`
3. 系統會自動把文件切成小段落、轉成向量存進 Vectorize
4. 之後使用者在 LINE 問問題時，機器人會自動去知識庫找相關段落，找到就優先參考回答；找不到相關內容就照原本的方式正常回答
5. 文件列表可以看到每份文件切了幾段、什麼時候建立，也可以直接刪除

**注意事項：**
- PDF 如果是「掃描圖片」而不是可選取文字的 PDF，抓不到文字內容，上傳會失敗（之後有需要可以加 OCR 支援）
- `.doc`（舊版 Word 格式）不支援，請另存新檔成 `.docx`
- `/admin` 後台沒有做 IP 限制，純密碼保護，密碼請設複雜一點，也建議定期更換

## 9. 測試

掃描 LINE Developers Console 上的 QR code 加官方帳號好友，直接傳文字訊息。

## 檔案結構
```
line-gemini-bot/
├── src/
│   ├── index.js         # Worker 進入點（路由：/webhook、/admin、/admin/api/*）
│   ├── line.js           # LINE webhook 驗證 + Gemini 對話 + KV 對話記憶
│   ├── rag.js             # 知識庫核心：切塊、Gemini embedding、Vectorize 存取
│   ├── parse.js           # PDF / DOCX / TXT 文字擷取
│   └── admin.js            # 知識庫後台頁面 + API（上傳/列表/刪除）
├── wrangler.toml            # Cloudflare Workers 設定（KV + Vectorize bindings）
├── package.json
├── .dev.vars.example         # 本機測試用環境變數範例
├── .gitignore
└── README.md
```

## 補充說明
- 這個版本用原生 `fetch` 直接打 LINE 和 Gemini 的 REST API，沒有依賴 Node.js 專用的 SDK（PDF/DOCX 解析套件例外，已用 `nodejs_compat` 相容模式處理），確保在 Cloudflare Workers 的 V8 isolate 環境下能正常運作。
- 對話記憶存在 Cloudflare KV，設定 7 天沒互動就過期，避免資料無限累積。
- 知識庫向量化用的是 `gemini-embedding-001`（輸出維度設為 768，跟 Vectorize 索引的 dimensions 對齊），查詢時只取相似度 0.6 以上的段落，避免硬塞不相關內容進去讓機器人亂回答。
- 若流量大到需要更即時的記憶一致性，可以考慮改用 Durable Objects，之後有需要我可以幫你改。

## 支援的訊息類型
- **文字**：先去知識庫查相關段落，再連同對話記憶一起丟給 Gemini 回答
- **圖片**：透過 LINE Content API 抓取圖片內容，轉成 base64 後連同文字提示一起送給 Gemini（Gemini 支援讀圖），讓它描述或回答關於圖片的問題
- **貼圖**：LINE 傳來的貼圖事件通常附帶 `keywords`（貼圖代表的情緒/語意關鍵字），會把這些關鍵字丟給 Gemini，產生貼合語境的簡短回覆；沒有 keywords 時則用通用的輕鬆語氣回應
- 影片、音訊、位置、檔案等類型目前不處理（webhook 會直接忽略，不會回覆）

對話記憶的部分，圖片訊息不會把完整圖片存進 KV（避免資料量爆量），只會留一筆「[使用者傳送了一張圖片]」的文字註記，讓後續對話還能延續「剛剛那張圖」的語境。
