const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIM = 768; // 要跟 `wrangler vectorize create` 時的 dimensions 對齊
const DOCS_LIST_KEY = 'kb:docs:list';

// ---------- 文字切塊：盡量在段落/句子邊界切，並保留一段 overlap 讓語意不斷裂 ----------
export function chunkText(text, { maxLen = 700, overlap = 100 } = {}) {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxLen, clean.length);

    if (end < clean.length) {
      const window = clean.slice(start, end);
      const lastBreak = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('。'),
        window.lastIndexOf('！'),
        window.lastIndexOf('？'),
        window.lastIndexOf('. ')
      );
      if (lastBreak > maxLen * 0.5) {
        end = start + lastBreak + 1;
      }
    }

    const chunk = clean.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

// ---------- 呼叫 Gemini Embedding API（一次一批，最多 batchEmbedContents 限制） ----------
async function embedBatch(texts, env, taskType) {
  if (texts.length === 0) return [];

  const results = [];
  const BATCH_SIZE = 20;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          requests: slice.map((text) => ({
            model: `models/${EMBED_MODEL}`,
            content: { parts: [{ text }] },
            outputDimensionality: EMBED_DIM,
            taskType,
          })),
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini embedding API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    for (const e of data.embeddings || []) {
      results.push(e.values);
    }
  }

  return results;
}

async function embedOne(text, env, taskType) {
  const [values] = await embedBatch([text], env, taskType);
  return values;
}

// ---------- 文件清單（存在 KV，binding: KB_DOCS） ----------
export async function listDocuments(env) {
  if (!env.KB_DOCS) return [];
  const raw = await env.KB_DOCS.get(DOCS_LIST_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveDocsList(env, docs) {
  await env.KB_DOCS.put(DOCS_LIST_KEY, JSON.stringify(docs));
}

// ---------- 新增/更新一份知識庫文件：切塊 -> 向量化 -> 存進 Vectorize + KV ----------
export async function upsertDocument({ id, title, text, sourceType }, env) {
  if (!env.KB_VECTORS) throw new Error('尚未綁定 Vectorize (KB_VECTORS)，請參考 README 建立索引');
  if (!env.KB_DOCS) throw new Error('尚未綁定 KV (KB_DOCS)，請參考 README 建立命名空間');

  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error('文件內容是空的，無法建立知識庫');

  const vectors = await embedBatch(chunks, env, 'RETRIEVAL_DOCUMENT');

  const items = chunks.map((chunkContent, idx) => ({
    id: `${id}::${idx}`,
    values: vectors[idx],
    metadata: {
      docId: id,
      title,
      chunkIndex: idx,
      text: chunkContent,
    },
  }));

  // Vectorize 一次 upsert 建議不要塞太多，分批送
  const UPSERT_BATCH = 50;
  for (let i = 0; i < items.length; i += UPSERT_BATCH) {
    await env.KB_VECTORS.upsert(items.slice(i, i + UPSERT_BATCH));
  }

  const docs = await listDocuments(env);
  const filtered = docs.filter((d) => d.id !== id);
  filtered.unshift({
    id,
    title,
    sourceType: sourceType || 'text',
    chunkCount: chunks.length,
    createdAt: new Date().toISOString(),
  });
  await saveDocsList(env, filtered);

  return { id, chunkCount: chunks.length };
}

// ---------- 刪除一份文件（連同它所有的向量） ----------
export async function deleteDocument(id, env) {
  const docs = await listDocuments(env);
  const doc = docs.find((d) => d.id === id);
  if (!doc) return false;

  const ids = Array.from({ length: doc.chunkCount }, (_, idx) => `${id}::${idx}`);
  const DELETE_BATCH = 200;
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    await env.KB_VECTORS.deleteByIds(ids.slice(i, i + DELETE_BATCH));
  }

  await saveDocsList(env, docs.filter((d) => d.id !== id));
  return true;
}

// ---------- 查詢：把使用者問題向量化，去 Vectorize 找最相關的段落 ----------
export async function queryRelevant(query, env, { topK = 4, minScore = 0.6 } = {}) {
  if (!env.KB_VECTORS) return [];

  const docs = await listDocuments(env);
  if (docs.length === 0) return []; // 知識庫是空的，不用查

  const vector = await embedOne(query, env, 'RETRIEVAL_QUERY');
  const result = await env.KB_VECTORS.query(vector, { topK, returnMetadata: true });

  return (result.matches || [])
    .filter((m) => m.score >= minScore)
    .map((m) => ({
      score: m.score,
      title: m.metadata?.title,
      text: m.metadata?.text,
    }));
}
