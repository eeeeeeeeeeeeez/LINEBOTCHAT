# LINE 官方帳號 x Gemini 3.5 Flash-Lite 聊天機器人（Cloudflare Workers 版）

用 Cloudflare Workers 接收 LINE Messaging API 的 webhook，呼叫 Gemini 3.5 Flash-Lite 產生回覆。對話記憶用 Cloudflare KV 存放（可選，不綁定也能跑，只是沒有記憶）。

## 1. 前置準備

### A. LINE 官方帳號 / Messaging API
1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建立 Provider → 建立 **Messaging API** Channel
2. 「Messaging API」頁籤：Issue 一組 **Channel access token**（長期）
3. 「Basic settings」頁籤：取得 **Channel secret**
4. 關閉 Auto-reply messages / Greeting messages

### B. Gemini API Key
到 [Google AI Studio](https://aistudio.google.com/apikey) 建立一組 API Key

### C. Cloudflare 帳號
到 [dash.cloudflare.com](https://dash.cloudflare.com) 註冊（免費方案即可，Workers 每天 10 萬次請求額度）

## 2. 本機安裝

```bash
npm install
cp .dev.vars.example .dev.vars
# 編輯 .dev.vars 填入三把金鑰
```

## 3. 建立 KV Namespace（要對話記憶的話，選用）

```bash
npx wrangler login
npx wrangler kv namespace create CHAT_HISTORY
```

指令會印出類似：
```
{ binding = "CHAT_HISTORY", id = "abcd1234..." }
```
把這段貼回 `wrangler.toml`，取消 `[[kv_namespaces]]` 那幾行的註解並填入 id。不需要對話記憶的話可以跳過這步，程式會自動退化成無記憶模式。

## 4. 本機測試

```bash
npm run dev
```
會啟動一個本機網址（例如 `http://localhost:8787`）。要讓 LINE 打得到，一樣需要用 `cloudflared tunnel` 或 `ngrok` 曝露出去做測試，或直接跳到下一步部署正式環境測試。

## 5. 部署到 Cloudflare（透過 GitHub）

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
5. 若要對話記憶，到 **Settings → Bindings** 加上 KV Namespace binding：`CHAT_HISTORY`
6. 之後每次 `git push` 到 main branch，Cloudflare 會自動重新部署

### 方法二：CLI 直接部署（不透過 GitHub）
```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put GEMINI_API_KEY
npm run deploy
```
部署完會得到一個網址，例如 `https://line-gemini-bot.<你的subdomain>.workers.dev`

## 6. 設定 LINE Webhook

拿到 Cloudflare 給的網址後，回到 LINE Developers Console → Messaging API 頁籤：
- Webhook URL 填入：`https://line-gemini-bot.xxx.workers.dev/webhook`
- 按 **Verify** 確認能連通
- 打開 **Use webhook** 開關

## 7. 測試

掃描 LINE Developers Console 上的 QR code 加官方帳號好友，直接傳文字訊息。

## 檔案結構
```
line-gemini-bot/
├── index.js               # Worker 主程式（webhook 驗證 + Gemini 呼叫 + KV 記憶）
├── wrangler.toml           # Cloudflare Workers 設定
├── package.json
├── .dev.vars.example       # 本機測試用環境變數範例
├── .gitignore
└── README.md
```

## 補充說明
- 這個版本用原生 `fetch` 直接打 LINE 和 Gemini 的 REST API，沒有依賴 Node.js 專用的 SDK，確保在 Cloudflare Workers 的 V8 isolate 環境下能正常運作。
- 對話記憶存在 Cloudflare KV，設定 7 天沒互動就過期，避免資料無限累積。
- 若流量大到需要更即時的記憶一致性，可以考慮改用 Durable Objects，之後有需要我可以幫你改。

## 支援的訊息類型
- **文字**：直接丟給 Gemini 回答
- **圖片**：透過 LINE Content API 抓取圖片內容，轉成 base64 後連同文字提示一起送給 Gemini（Gemini 支援讀圖），讓它描述或回答關於圖片的問題
- **貼圖**：LINE 傳來的貼圖事件通常附帶 `keywords`（貼圖代表的情緒/語意關鍵字），會把這些關鍵字丟給 Gemini，產生貼合語境的簡短回覆；沒有 keywords 時則用通用的輕鬆語氣回應
- 影片、音訊、位置、檔案等類型目前不處理（webhook 會直接忽略，不會回覆）

對話記憶的部分，圖片訊息不會把完整圖片存進 KV（避免資料量爆量），只會留一筆「[使用者傳送了一張圖片]」的文字註記，讓後續對話還能延續「剛剛那張圖」的語境。
