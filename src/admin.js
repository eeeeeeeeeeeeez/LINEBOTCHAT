import { extractTextFromFile } from './parse.js';
import { upsertDocument, deleteDocument, listDocuments } from './rag.js';

function checkAuth(request, env) {
  if (!env.ADMIN_PASSWORD) return false; // 沒設密碼就整個鎖起來，避免忘記設定造成後台裸奔
  const supplied = request.headers.get('x-admin-password') || '';
  return supplied === env.ADMIN_PASSWORD;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ---------- /admin/api/* 路由 ----------
export async function handleAdminApi(request, env, url) {
  const path = url.pathname;

  // 登入驗證用：只檢查密碼對不對，不回傳任何敏感資料
  if (path === '/admin/api/login' && request.method === 'POST') {
    return checkAuth(request, env) ? json({ ok: true }) : json({ ok: false }, 401);
  }

  if (!checkAuth(request, env)) {
    return json({ ok: false, error: '密碼錯誤或未登入' }, 401);
  }

  if (path === '/admin/api/docs' && request.method === 'GET') {
    const docs = await listDocuments(env);
    return json({ ok: true, docs });
  }

  if (path === '/admin/api/upload-text' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || !body.content || !body.content.trim()) {
      return json({ ok: false, error: '內容不能是空的' }, 400);
    }
    const title = (body.title || '').trim() || `貼上的文字 ${new Date().toLocaleString('zh-TW')}`;
    const id = crypto.randomUUID();
    try {
      const result = await upsertDocument({ id, title, text: body.content, sourceType: 'text' }, env);
      return json({ ok: true, ...result });
    } catch (err) {
      return json({ ok: false, error: String(err.message || err) }, 500);
    }
  }

  if (path === '/admin/api/upload' && request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    const file = form && form.get('file');
    if (!file || typeof file === 'string') {
      return json({ ok: false, error: '沒有收到檔案' }, 400);
    }

    const titleInput = (form.get('title') || '').toString().trim();
    const title = titleInput || file.name;
    const id = crypto.randomUUID();

    try {
      const buffer = await file.arrayBuffer();
      const text = await extractTextFromFile(buffer, file.type, file.name);
      if (!text || !text.trim()) {
        return json({ ok: false, error: '這個檔案抓不到任何文字內容（可能是掃描圖片 PDF）' }, 400);
      }
      const result = await upsertDocument(
        { id, title, text, sourceType: file.name.split('.').pop().toLowerCase() },
        env
      );
      return json({ ok: true, ...result });
    } catch (err) {
      return json({ ok: false, error: String(err.message || err) }, 500);
    }
  }

  const deleteMatch = path.match(/^\/admin\/api\/docs\/([^/]+)$/);
  if (deleteMatch && request.method === 'DELETE') {
    const ok = await deleteDocument(decodeURIComponent(deleteMatch[1]), env);
    return json({ ok });
  }

  return json({ ok: false, error: 'Not found' }, 404);
}

// ---------- /admin 後台頁面（單一 HTML，內嵌 JS） ----------
export function renderAdminPage() {
  return new Response(ADMIN_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>知識庫後台</title>
<style>
  :root {
    --bg: #0f1115;
    --card: #171a21;
    --border: #2a2f3a;
    --text: #e8eaed;
    --muted: #8b93a3;
    --accent: #4f8cff;
    --danger: #e5484d;
    --ok: #35c48f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 24px 16px 80px;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  p.sub { color: var(--muted); font-size: 13px; margin-top: 0; margin-bottom: 24px; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 20px;
  }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  input[type=text], input[type=password], textarea {
    width: 100%;
    background: #0f1115;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--text);
    font-size: 14px;
    margin-bottom: 14px;
    font-family: inherit;
  }
  textarea { min-height: 140px; resize: vertical; }
  input[type=file] { margin-bottom: 14px; color: var(--muted); font-size: 13px; }
  button {
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 8px;
    padding: 10px 18px;
    font-size: 14px;
    cursor: pointer;
    font-weight: 600;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary { background: transparent; border: 1px solid var(--border); color: var(--text); }
  button.danger { background: transparent; border: 1px solid var(--danger); color: var(--danger); padding: 6px 12px; font-size: 12px; }
  .row { display: flex; gap: 10px; align-items: center; }
  .msg { font-size: 13px; margin-top: 10px; min-height: 18px; }
  .msg.ok { color: var(--ok); }
  .msg.err { color: var(--danger); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 6px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  .empty { color: var(--muted); font-size: 13px; padding: 12px 0; }
  .tag { display: inline-block; background: #232838; color: var(--muted); border-radius: 6px; padding: 2px 8px; font-size: 11px; }
  #loginCard { max-width: 360px; margin: 60px auto 0; }
  #appArea { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <div id="loginCard" class="card">
    <h1>知識庫後台</h1>
    <p class="sub">輸入管理密碼登入</p>
    <label for="pw">管理密碼</label>
    <input type="password" id="pw" placeholder="password" />
    <button id="loginBtn">登入</button>
    <div id="loginMsg" class="msg"></div>
  </div>

  <div id="appArea">
    <h1>知識庫後台</h1>
    <p class="sub">上傳的文件會被切成段落、轉成向量，LINE 機器人回覆時會自動參考相關內容</p>

    <div class="card">
      <h3 style="margin-top:0">貼上文字</h3>
      <label for="textTitle">標題（選填）</label>
      <input type="text" id="textTitle" placeholder="例如：常見問題 FAQ" />
      <label for="textContent">內容</label>
      <textarea id="textContent" placeholder="貼上要讓機器人參考的文字內容..."></textarea>
      <button id="submitText">新增到知識庫</button>
      <div id="textMsg" class="msg"></div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">上傳檔案</h3>
      <p class="sub" style="margin-bottom:10px">支援 .pdf .docx .txt .md</p>
      <label for="fileTitle">標題（選填，預設用檔名）</label>
      <input type="text" id="fileTitle" placeholder="例如：產品手冊" />
      <label for="fileInput">檔案</label>
      <input type="file" id="fileInput" accept=".pdf,.docx,.txt,.md" />
      <button id="submitFile">上傳並加入知識庫</button>
      <div id="fileMsg" class="msg"></div>
    </div>

    <div class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
        <h3 style="margin:0">已建立的文件</h3>
        <button class="secondary" id="refreshBtn">重新整理</button>
      </div>
      <div id="docsArea"><div class="empty">載入中...</div></div>
    </div>
  </div>
</div>

<script>
let PW = sessionStorage.getItem('kb_admin_pw') || '';

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), 'X-Admin-Password': PW },
  });
  const data = await res.json().catch(() => ({ ok: false, error: '伺服器回應錯誤' }));
  if (!res.ok || !data.ok) throw new Error(data.error || ('請求失敗 (' + res.status + ')'));
  return data;
}

function showMsg(el, text, ok) {
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

async function tryLogin(pw) {
  const res = await fetch('/admin/api/login', { method: 'POST', headers: { 'X-Admin-Password': pw } });
  return res.ok;
}

async function enterApp() {
  document.getElementById('loginCard').style.display = 'none';
  document.getElementById('appArea').style.display = 'block';
  await loadDocs();
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const pw = document.getElementById('pw').value;
  const msg = document.getElementById('loginMsg');
  const ok = await tryLogin(pw);
  if (ok) {
    PW = pw;
    sessionStorage.setItem('kb_admin_pw', pw);
    enterApp();
  } else {
    showMsg(msg, '密碼錯誤', false);
  }
});
document.getElementById('pw').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

document.getElementById('submitText').addEventListener('click', async () => {
  const btn = document.getElementById('submitText');
  const msg = document.getElementById('textMsg');
  const content = document.getElementById('textContent').value;
  const title = document.getElementById('textTitle').value;
  if (!content.trim()) { showMsg(msg, '請輸入內容', false); return; }
  btn.disabled = true; showMsg(msg, '處理中（切塊 + 向量化）...', true);
  try {
    await api('/admin/api/upload-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content }),
    });
    showMsg(msg, '新增成功', true);
    document.getElementById('textContent').value = '';
    document.getElementById('textTitle').value = '';
    loadDocs();
  } catch (e) {
    showMsg(msg, e.message, false);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('submitFile').addEventListener('click', async () => {
  const btn = document.getElementById('submitFile');
  const msg = document.getElementById('fileMsg');
  const fileInput = document.getElementById('fileInput');
  const title = document.getElementById('fileTitle').value;
  if (!fileInput.files[0]) { showMsg(msg, '請選擇檔案', false); return; }
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  fd.append('title', title);
  btn.disabled = true; showMsg(msg, '上傳並處理中（解析文件 + 向量化）...', true);
  try {
    await api('/admin/api/upload', { method: 'POST', body: fd });
    showMsg(msg, '新增成功', true);
    fileInput.value = '';
    document.getElementById('fileTitle').value = '';
    loadDocs();
  } catch (e) {
    showMsg(msg, e.message, false);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('refreshBtn').addEventListener('click', loadDocs);

async function loadDocs() {
  const area = document.getElementById('docsArea');
  try {
    const { docs } = await api('/admin/api/docs');
    if (!docs.length) {
      area.innerHTML = '<div class="empty">還沒有任何文件</div>';
      return;
    }
    const rows = docs.map((d) => \`
      <tr>
        <td>\${escapeHtml(d.title)}<div><span class="tag">\${d.sourceType}</span> <span class="tag">\${d.chunkCount} 段</span></div></td>
        <td>\${new Date(d.createdAt).toLocaleString('zh-TW')}</td>
        <td><button class="danger" onclick="removeDoc('\${d.id}')">刪除</button></td>
      </tr>
    \`).join('');
    area.innerHTML = \`<table><thead><tr><th>標題</th><th>建立時間</th><th></th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch (e) {
    area.innerHTML = '<div class="empty">載入失敗：' + escapeHtml(e.message) + '</div>';
  }
}

async function removeDoc(id) {
  if (!confirm('確定要刪除這份文件嗎？')) return;
  try {
    await api('/admin/api/docs/' + encodeURIComponent(id), { method: 'DELETE' });
    loadDocs();
  } catch (e) {
    alert(e.message);
  }
}
window.removeDoc = removeDoc;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

if (PW) { tryLogin(PW).then((ok) => { if (ok) enterApp(); }); }
</script>
</body>
</html>`;
