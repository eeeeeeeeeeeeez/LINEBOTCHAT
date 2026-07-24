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
  if (event.type !== 'message' || event.message.type !== 'text') {
    return; // 先只處理文字訊息
  }

  const userId = event.source.userId;
  const userText = event.message.text;

  let replyText;
  try {
    replyText = await askGemini(userId, userText, env);
  } catch (err) {
    console.error('Gemini error:', err);
    replyText = '系統忙線中，請稍後再試一次 🙏';
  }

  await replyToLine(event.replyToken, replyText, env);
}

// ---------- 呼叫 Gemini API ----------
async function askGemini(userId, userText, env) {
  const history = await getHistory(userId, env);

  const systemPrompt =
    env.SYSTEM_PROMPT ||
    '你是一個親切、簡潔的客服助理，用繁體中文回覆用戶問題，回答盡量簡短清楚。';

  const contents = [...history, { role: 'user', parts: [{ text: userText }] }];

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

  await pushHistory(userId, userText, replyText, env);

  return replyText.trim();
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
