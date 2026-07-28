import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';

// ---------- 依副檔名/MIME type 決定怎麼把上傳檔案轉成純文字 ----------
export async function extractTextFromFile(arrayBuffer, mimeType, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();

  if (ext === 'pdf' || mimeType === 'application/pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }

  if (
    ext === 'docx' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }

  if (ext === 'doc' || mimeType === 'application/msword') {
    throw new Error('不支援舊版 .doc 格式，請另存為 .docx 後再上傳');
  }

  // 其餘一律當純文字（.txt / .md 等）
  return new TextDecoder('utf-8').decode(arrayBuffer);
}
