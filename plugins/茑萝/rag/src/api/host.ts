// hostApi.invoke 薄封装：把 RAG / AI / 文档转换 等 Rust 命令暴露为类型化前端函数。
// 插件沙箱屏蔽 fetch，所有外部/系统能力必须经 Rust 命令代理（hostApi.invoke → Tauri invoke）。

const hostApi = (window as unknown as {
  __HOST_API__: {
    invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    listen: <T = unknown>(
      event: string,
      handler: (event: { payload: T }) => void,
    ) => Promise<() => void>;
  };
}).__HOST_API__;

// ============ 类型 ============

/** 单条语义检索命中（与后端 RagHit 对齐）。 */
export interface RagHit {
  source_id: string;
  source_title: string;
  text: string;
  score: number;
  char_start: number;
  char_end: number;
}

/** rag_query 响应。 */
export interface RagQueryResponse {
  results: RagHit[];
  total: number;
}

/** rag_ingest 的单个分块入参。 */
export interface RagChunkInput {
  idx: number;
  text: string;
  char_start: number;
  char_end: number;
  vec: number[];
  meta?: Record<string, unknown>;
}

/** rag_ingest 的来源入参。 */
export interface RagSourceInput {
  title: string;
  uri: string;
  type?: string;
}

/** rag_ingest 响应。 */
export interface RagIngestResult {
  source_id: string;
  chunk_count: number;
}

/** rag_embed_api 响应。 */
export interface RagEmbedResponse {
  embeddings: number[][];
  dim: number;
}

/** 来源列表项（rag_list_sources）。 */
export interface RagSourceInfo {
  id: string;
  title: string;
  uri: string;
  type: string;
  created_at: string;
  chunk_count: number;
  status: string;
}

/** 嵌入代理选项：端点/key/模型，复用现有 ai profiles / ModelSettings Ollama 预设。 */
export interface EmbedOptions {
  endpoint?: string;
  apiKey?: string;
  model?: string;
}

// ============ RAG 命令 ============

export function ragInitDb(): Promise<void> {
  return hostApi.invoke<void>('rag_init_db');
}

export function ragIngest(
  source: RagSourceInput,
  chunks: RagChunkInput[],
): Promise<RagIngestResult> {
  return hostApi.invoke<RagIngestResult>('rag_ingest', { source, chunks });
}

export function ragQuery(queryVec: number[], topK = 6): Promise<RagQueryResponse> {
  return hostApi.invoke<RagQueryResponse>('rag_query', { queryVec, topK });
}

export function ragListSources(): Promise<RagSourceInfo[]> {
  return hostApi.invoke<RagSourceInfo[]>('rag_list_sources');
}

export function ragDeleteSource(sourceId: string): Promise<void> {
  return hostApi.invoke<void>('rag_delete_source', { sourceId });
}

export function ragEmbedApi(texts: string[], opts: EmbedOptions = {}): Promise<RagEmbedResponse> {
  return hostApi.invoke<RagEmbedResponse>('rag_embed_api', {
    texts,
    endpoint: opts.endpoint,
    apiKey: opts.apiKey,
    model: opts.model,
  });
}

// ============ 文档 → Markdown（摄取首步） ============

export function convertToMarkdown(filePath: string): Promise<string> {
  return hostApi.invoke<string>('convert_to_markdown', { filePath });
}

export function convertBytesToMarkdown(
  base64: string,
  extension: string,
  originalName?: string,
): Promise<string> {
  return hostApi.invoke<string>('convert_bytes_to_markdown', {
    base64,
    extension,
    originalName,
  });
}

/** 读取外部依赖文件的原始字节（如 onnx 模型权重），沙箱内需经 Rust 代理。
 * 后端返回 base64 编码字符串（紧凑传输），此处解码为 number[] 供调用方 toArrayBuffer。 */
export async function readExternalDepBytes(relativePath: string): Promise<number[]> {
  const base64 = await hostApi.invoke<string>('read_external_dep_bytes', {
    relativePath,
  });
  if (!base64) return [];
  const binary = atob(base64);
  const bytes = new Array<number>(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ============ AI 对话（生成答案，流式） ============

export interface ChatMessage {
  role: string;
  content: string;
}

export interface StreamChatOptions {
  requestId: string;
  messages: ChatMessage[];
  profileId?: string;
  onDelta: (delta: string) => void;
  onDone?: (usage?: unknown) => void;
  onError?: (error: string) => void;
}

/**
 * 调用后端 ai_chat（OpenAI 兼容流式），通过事件 ai-delta/ai-done/ai-error 推流。
 * 返回取消监听函数（cleanup 时调用）。
 */
export async function streamAiChat(opts: StreamChatOptions): Promise<() => void> {
  const unDelta = await hostApi.listen<{ requestId: string; delta: string }>(
    'ai-delta',
    (e) => {
      if (e.payload.requestId === opts.requestId) opts.onDelta(e.payload.delta);
    },
  );
  const unDone = await hostApi.listen<{ requestId: string; usage?: unknown }>(
    'ai-done',
    (e) => {
      if (e.payload.requestId === opts.requestId) opts.onDone?.(e.payload.usage);
    },
  );
  const unErr = await hostApi.listen<{ requestId: string; error: string }>(
    'ai-error',
    (e) => {
      if (e.payload.requestId === opts.requestId) opts.onError?.(e.payload.error);
    },
  );
  await hostApi.invoke<void>('ai_chat', {
    requestId: opts.requestId,
    messages: opts.messages,
    profileId: opts.profileId,
  });
  return () => {
    unDelta();
    unDone();
    unErr();
  };
}
