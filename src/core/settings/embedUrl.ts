// 嵌入端点 URL 的归一化。
//
// 为什么需要：用户只想填「供应商地址 + v1」，不想记住 `/embeddings` 后缀。
// 但 `rag_embed_api` 是**直接 POST 到配置的 URL**，少一段就是 404；而 404 的表现是
// 「RAG 静默失效」（走关键词兜底），很难被察觉。
//
// 规则（按优先级）：
//   1. 已含 `/embeddings`（含 Ollama 的 `/api/embeddings`）→ 原样；
//   2. 以 `/v1` 结尾或已含 `/v1/` → 补 `/embeddings`；
//   3. 其它（只有域名、或以 `/api` 结尾等）→ 补 `/v1/embeddings`。
//
// 第 3 条选 `/v1/embeddings` 而不是 Ollama 的 `/api/embeddings`：新版 Ollama 同时提供
// OpenAI 兼容的 `/v1/embeddings`，而只有 OpenAI 兼容协议的服务**没有** `/api/embeddings`。
// 所以这个默认对两边的成功率更高（Ollama 用户仍可显式填 `/api/embeddings`，走第 1 条）。
export function normalizeEmbeddingEndpoint(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  // 去掉尾部斜杠、以及误填的 /embeddings 之外的多余空白
  const noSlash = s.replace(/\/+$/, '');
  if (/\/embeddings$/i.test(noSlash)) return noSlash;
  if (/\/v1$/i.test(noSlash) || /\/v1\//i.test(noSlash)) return `${noSlash}/embeddings`;
  return `${noSlash}/v1/embeddings`;
}

/** 判断用户填的这段是否「还缺后缀」——用于输入框失焦时的轻提示。 */
export function looksLikeBaseUrl(raw: string): boolean {
  const s = (raw || '').trim();
  if (!s) return false;
  return !/\/embeddings$/i.test(s.replace(/\/+$/, ''));
}
