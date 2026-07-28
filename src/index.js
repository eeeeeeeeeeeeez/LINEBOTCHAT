import { verifyLineSignature, handleEvent } from './line.js';
import { renderAdminPage, handleAdminApi } from './admin.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------- 知識庫後台 ----------
    if (url.pathname === '/admin') {
      return renderAdminPage();
    }
    if (url.pathname.startsWith('/admin/api/')) {
      return handleAdminApi(request, env, url);
    }

    if (request.method !== 'POST') {
      return new Response('LINE x Gemini bot is running.', { status: 200 });
    }

    if (url.pathname !== '/webhook') {
      return new Response('Not found', { status: 404 });
    }

    const rawBody = await request.text();

    // 驗證 LINE 簽章
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
