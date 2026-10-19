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
  /** 因维度与查询向量不一致被跳过的块数（换过嵌入模型时 > 0）。 */
  skipped_dim?: number;
  /** 实际参与余弦比较的块数。 */
  compared?: number;
}

/** rag_ingest 的单个分块入参。 */
export interface RagChunkInput {
  idx: number;
  text: string;
  char_start: number;
  char_end: number;
  /** 向量：子块非空；父块传空数组（后端据此跳过向量检索，只用于命中后回填上下文）。 */
  vec: number[];
  /** 父块 idx（小-大分块）：命中子块后由后端回填父块文本；父块自身为 null/undefined。 */
  parent_idx?: number | null;
  /** 产出该向量的嵌入模型名（用于「这块是哪个模型建的」追溯）。 */
  embed_model?: string;
  meta?: Record<string, unknown>;
}

/** rag_ingest 的来源入参。 */
export interface RagSourceInput {
  title: string;
  uri: string;
  type?: string;
  /** 命名空间（默认 general）。后端缺省回落 ai-chat，所以手动知识库必须显式传 general，
   *  否则会和 AI 对话的伴侣记忆混在一起。 */
  namespace?: string;
  /** 按 uri 替换同命名空间下的旧来源（先删后写）。
   *  用于「同一份数据的重写式沉淀」（伴侣 persona / core 档案），避免每次同步都新增一条。
   *  对话记录这类天然唯一的 uri 不需要打开它。 */
  replace?: boolean;
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
  /** 后端从 1.0.0 起就返回该字段，前端此前漏声明。 */
  namespace?: string;
  /** 建库时用的嵌入模型 / 维度（自适应维度）。老数据为空 / 0。 */
  embed_model?: string;
  embed_dim?: number;
}

/** 嵌入代理选项：端点/key/模型，复用现有 ai profiles / ModelSettings Ollama 预设。 */
export interface EmbedOptions {
  endpoint?: string;
  apiKey?: string;
  model?: string;
}

// ============ 重建向量 / 统计 / 备份（2026-10-19 数据安全） ============

/** 待重建的块（只含带向量的子块）。 */
export interface RagChunkRow {
  id: string;
  idx: number;
  text: string;
  char_start: number;
  char_end: number;
  parent_idx?: number | null;
  /** 当前向量维度。 */
  dim: number;
  /** 当前向量由哪个模型产出（老数据为空串）。 */
  embed_model: string;
}

/** 单块向量更新。 */
export interface RagVecUpdate {
  id: string;
  vec: number[];
  embed_model?: string;
}

/** 命名空间内的维度/模型分布。 */
export interface RagStats {
  sources: number;
  chunks: number;
  dims: { dim: number; chunks: number }[];
  models: { model: string; chunks: number }[];
  /** 最近一次写入用的模型（未写过的库为空串）。 */
  current_model?: string;
  /** 最近一次写入用的维度。 */
  current_dim?: number;
  /** 最近一次写入时间。 */
  updated_at?: string;
}

/** 列出某来源下带向量的块（只读）。 */
export function ragListChunks(sourceId: string, namespace?: string): Promise<RagChunkRow[]> {
  return hostApi.invoke<RagChunkRow[]>('rag_list_chunks', { sourceId, namespace });
}

/** 批量写回新向量（后端全有或全无；覆盖前自动备份）。 */
export function ragUpdateVectors(
  sourceId: string,
  updates: RagVecUpdate[],
  namespace?: string,
): Promise<number> {
  return hostApi.invoke<number>('rag_update_vectors', { sourceId, updates, namespace });
}

/** 命名空间维度/模型分布。 */
export function ragStats(namespace?: string): Promise<RagStats> {
  return hostApi.invoke<RagStats>('rag_stats', { namespace });
}

// 刻意不封装 rag_backup_db / rag_prune：
// - `rag_backup_db` 是应用级运维操作（后端在每次破坏性写入前已自动 VACUUM INTO 备份 3 份），
//   插件没有「手动备份」这个需求；放开它等于把「反复导出一份完整库」暴露给插件。
// - `rag_prune` 会删数据（只清 type='chat'），归主应用启动时自管，插件无权触发。
// 两者也都**不在** pluginSandbox 的全局白名单里 —— 上层策略 + 这里不封装，双层都堵住。

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

export function ragQuery(
  queryVec: number[],
  topK = 6,
  namespace?: string,
  minScore?: number,
): Promise<RagQueryResponse> {
  return hostApi.invoke<RagQueryResponse>('rag_query', { queryVec, topK, namespace, minScore });
}

export function ragListSources(namespace?: string): Promise<RagSourceInfo[]> {
  return hostApi.invoke<RagSourceInfo[]>('rag_list_sources', { namespace });
}

/** 删除来源。必须带 namespace：后端会校验「该 source 属于这个命名空间」，
 *  防止拿到别人的 source_id 就跨模块删记忆。 */
export function ragDeleteSource(sourceId: string, namespace?: string): Promise<void> {
  return hostApi.invoke<void>('rag_delete_source', { sourceId, namespace });
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
