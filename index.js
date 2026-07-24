const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const MAX_TURNS = 10; // 每位使用者保留的對話輪數

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('LINE x Gemini bot is running.', { status: 200 });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/webhook') {
      return new Response('Not found', { status: 404 });
    }

    const rawBody = await request.text();

    // 1. 驗證 LINE 簽章
    const signature = request.headers.get('x-line-signature');
    const valid = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
    if (!valid) {
      return new Response('Invalid signature', { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const events = body.events || [];

    // 先回 200，事件處理用 waitUntil 背景執行，避免 LINE 因逾時重送
    ctx.waitUntil(
      Promise.all(events.map((event) => handleEvent(event, env))).catch((err) =>
        console.error('handleEvent error:', err)
      )
    );

    return new Response('OK', { status: 200 });
  },
};

// ---------- 驗證 LINE Webhook 簽章 (HMAC-SHA256) ----------
async function verifyLineSignature(rawBody, signature, channelSecret) {
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
async function handleEvent(event, env) {
  if (event.type !== 'message') return;

  const userId = event.source.userId;
  const messageType = event.message.type;

  try {
    let replyText;

    if (messageType === 'text') {
      replyText = await askGemini(userId, { text: event.message.text }, env);
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

// ---------- 呼叫 Gemini API（含 Google 搜尋 grounding） ----------
async function askGemini(userId, input, env) {
  const history = await getHistory(userId, env);

  const systemPrompt =
    env.SYSTEM_PROMPT ||
    '你是一個親切、簡潔的客服助理，用繁體中文回覆用戶問題，回答盡量簡短清楚。如果問題涉及即時性資訊（例如新聞、天氣、股價、最新動態、你不確定的事實），請使用搜尋工具查證後再回答，並在回答中自然帶出資訊來源。';

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
        // 讓模型自主判斷是否需要上網查資料（Google 搜尋 grounding）
        tools: [{ google_search: {} }],
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
  const candidate = data.candidates?.[0];
  let replyText = candidate?.content?.parts?.map((p) => p.text).join('') || '抱歉，我現在無法回答，請稍後再試。';

  // 如果這次有用到搜尋，附上參考來源連結（最多列 3 個，避免訊息太長）
  const sources = candidate?.groundingMetadata?.groundingChunks
    ?.map((chunk) => chunk?.web?.uri)
    .filter(Boolean);

  if (sources && sources.length > 0) {
    const uniqueSources = [...new Set(sources)].slice(0, 3);
    replyText += `\n\n參考來源：\n${uniqueSources.join('\n')}`;
  }

  // 對話記憶只存文字（圖片不存進歷史，避免 KV 資料爆量）
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
async function replyToLine(replyToken, text, env) {
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
