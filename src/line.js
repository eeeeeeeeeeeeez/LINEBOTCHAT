import { queryRelevant } from './rag.js';

const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const MAX_TURNS = 10; // 每位使用者保留的對話輪數

// ---------- 驗證 LINE Webhook 簽章 (HMAC-SHA256) ----------
export async function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  return expected === signature;
}

// ---------- 處理單一 LINE 事件 ----------
export async function handleEvent(event, env) {
  if (event.type !== 'message') return;

  const userId = event.source.userId;
  const messageType = event.message.type;

  try {
    let replyText;

    if (messageType === 'text') {
      replyText = await askGemini(userId, { text: event.message.text, retrieve: true }, env);
    } else if (messageType === 'image') {
      replyText = await handleImageMessage(userId, event.message.id, env);
    } else if (messageType === 'sticker') {
      replyText = await handleStickerMessage(userId, event.message, env);
    } else {
      // 影片、音訊、位置、檔案等先不處理
      return;
    }

    await replyToLine(event.replyToken, replyText, env);
  } catch (err) {
    console.error('handleEvent error:', err);
    try {
      await replyToLine(event.replyToken, '系統忙線中，請稍後再試一次 🙏', env);
    } catch (e) {
      console.error('fallback reply failed:', e);
    }
  }
}

// ---------- 圖片訊息：抓圖片內容 -> 轉 base64 -> 丟給 Gemini ----------
async function handleImageMessage(userId, messageId, env) {
  const contentRes = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });

  if (!contentRes.ok) {
    throw new Error(`LINE content API error ${contentRes.status}`);
  }

  const mimeType = contentRes.headers.get('content-type') || 'image/jpeg';
  const arrayBuffer = await contentRes.arrayBuffer();
  const base64 = arrayBufferToBase64(arrayBuffer);

  return askGemini(
    userId,
    {
      text: '（使用者傳送了一張圖片，請描述圖片內容並視情況回應）',
      image: { mimeType, data: base64 },
    },
    env
  );
}

// ---------- 貼圖訊息：用 keywords 讓 Gemini 產生貼合語境的回覆 ----------
async function handleStickerMessage(userId, message, env) {
  const keywords = message.keywords && message.keywords.length ? message.keywords.join('、') : null;

  const promptText = keywords
    ? `（使用者傳送了一個貼圖，代表的情緒/意思關鍵字：${keywords}，請用符合這個情緒的語氣簡短回應）`
    : '（使用者傳送了一個貼圖，請用輕鬆自然的語氣簡短回應）';

  return askGemini(userId, { text: promptText }, env);
}

// ---------- 把知識庫檢索結果組成一段參考資料文字，插入 system prompt ----------
function buildRagInstruction(matches) {
  if (!matches.length) return '';
  const context = matches
    .map((m, i) => `【參考資料 ${i + 1}】${m.title ? `（來源：${m.title}）` : ''}\n${m.text}`)
    .join('\n\n');
  return (
    '\n\n以下是知識庫中可能與使用者問題相關的參考資料。如果內容有幫助，優先根據這些資料回答；' +
    '如果跟使用者的問題無關，就忽略它們，直接正常回答，不要跟使用者提到「知識庫」或「參考資料」這些字眼：\n\n' +
    context
  );
}

// ---------- 呼叫 Gemini API ----------
async function askGemini(userId, input, env) {
  const history = await getHistory(userId, env);

  let systemPrompt =
    env.SYSTEM_PROMPT ||
    '你是一個親切、簡潔的客服助理，用繁體中文回覆用戶問題，回答盡量簡短清楚。';

  if (input.retrieve && input.text) {
    try {
      const matches = await queryRelevant(input.text, env);
      systemPrompt += buildRagInstruction(matches);
    } catch (err) {
      // 知識庫查詢失敗不應該讓整個對話掛掉，記錄下來就好，照樣正常回覆
      console.error('RAG query error:', err);
    }
  }

  const parts = [{ text: input.text }];
  if (input.image) {
    parts.push({
      inline_data: {
        mime_type: input.image.mimeType,
        data: input.image.data,
      },
    });
  }

  const contents = [...history, { role: 'user', parts }];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          maxOutputTokens: 800,
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const replyText =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ||
    '抱歉，我現在無法回答，請稍後再試。';

  // 對話記憶只存文字（圖片不存進歷史，避免 KV 資料爆量），
  // 圖片訊息在歷史紀錄裡留一個文字註記，讓後續對話還能referring到「剛剛那張圖」
  const historyNote = input.image ? '[使用者傳送了一張圖片]' : input.text;
  await pushHistory(userId, historyNote, replyText, env);

  return replyText.trim();
}

// ---------- ArrayBuffer -> base64（Workers 環境沒有 Buffer，手動轉換） ----------
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000; // 分批處理，避免超大圖片一次展開造成 stack 問題
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------- 對話記憶（用 Cloudflare KV，需綁定 CHAT_HISTORY） ----------
async function getHistory(userId, env) {
  if (!env.CHAT_HISTORY) return []; // 未綁定 KV 時退化成無記憶模式
  const raw = await env.CHAT_HISTORY.get(`history:${userId}`);
  return raw ? JSON.parse(raw) : [];
}

async function pushHistory(userId, userText, replyText, env) {
  if (!env.CHAT_HISTORY) return;
  const history = await getHistory(userId, env);
  history.push({ role: 'user', parts: [{ text: userText }] });
  history.push({ role: 'model', parts: [{ text: replyText }] });
  const trimmed = history.slice(-MAX_TURNS * 2);
  // 設定 7 天過期，避免久未互動的使用者資料一直佔用
  await env.CHAT_HISTORY.put(`history:${userId}`, JSON.stringify(trimmed), {
    expirationTtl: 60 * 60 * 24 * 7,
  });
}

// ---------- 呼叫 LINE Reply API ----------
export async function replyToLine(replyToken, text, env) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });
}
