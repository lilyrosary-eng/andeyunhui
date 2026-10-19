// 摄取管线：文档 → Markdown → 分块 → 嵌入 → 入库。
//
// 首步复用 Rust 命令 convert_to_markdown（原生解析 docx/pptx/xlsx/pdf 等）；
// 分块复用 chunkDocument（结构感知 + 小-大）；嵌入默认走 ApiEmbedder（rag_embed_api 代理），
// 端点由 embed-config 三级解析决定（显式配置 → 复用算力来源 → Ollama 兜底）。
// （2026-10-19：本地 ONNX 嵌入因 tokenizer 是假实现已删除。）
//
// 2026-10-18 修复：
//   - source 的 namespace 以前在接口里没有声明（TS excess property），补上 `namespace?: string`；
//   - 默认嵌入器改为 createDefaultEmbedder()，失败时抛「带端点/模型」的可读错误。

import {
  convertBytesToMarkdown,
  convertToMarkdown,
  ragIngest,
  type RagChunkInput,
  type RagSourceInput,
} from '../api/host';
import { ApiEmbedder, type ApiEmbedderOptions } from '../embed/api-embedder';
import { createDefaultEmbedder, describeEmbedError, type EmbedConfig } from '../embed/embed-config';
import { CachedEmbedder } from '../embed/cache';
import type { Embedder } from '../embed/embedder';
import { chunkDocument } from './chunker';

/** 手动知识库的命名空间（与 AI 对话/IDE/攻防的记忆物理隔离）。 */
export const RAG_NS_GENERAL = 'general';

export interface IngestInput {
  /** 来源标题（展示用）。 */
  title: string;
  /** 来源 URI（文件路径 / URL / 标识）。 */
  uri: string;
  /** 来源类型（默认 file）。 */
  type?: string;
  /** 目标命名空间（默认 general：手动知识库）。 */
  namespace?: string;
  /** 直接文本（已转换，优先于 base64/uri）。 */
  text?: string;
  /** 已转换的 Markdown（同 text）。 */
  markdown?: string;
  /** 原始文件 base64（走 convert_bytes_to_markdown）。 */
  base64?: string;
  /** base64 文件扩展名。 */
  extension?: string;
  /** base64 原始文件名。 */
  originalName?: string;
  /** 本地文件路径（走 convert_to_markdown）。 */
  filePath?: string;
  /** 嵌入器（默认按 embed-config 解析）。 */
  embedder?: Embedder;
  /** ApiEmbedder 选项（显式指定端点时用，优先于 embed-config）。 */
  embedderOptions?: ApiEmbedderOptions;
  /** 子块最大字符数（向量单元，默认 800）。 */
  childSize?: number;
  /** 父块最大字符数（上下文单元，默认 3000）。 */
  parentSize?: number;
}

/**
 * 摄取一份文档到知识库。返回来源 id 与分块数。
 */
export async function ingestDocument(
  input: IngestInput,
): Promise<{ source_id: string; chunk_count: number }> {
  // 1) 文档 → Markdown
  let md = input.markdown ?? input.text;
  if (md == null) {
    if (input.base64) {
      md = await convertBytesToMarkdown(
        input.base64,
        input.extension ?? 'txt',
        input.originalName,
      );
    } else {
      md = await convertToMarkdown(input.filePath ?? input.uri);
    }
  }
  if (!md || md.trim().length === 0) {
    throw new Error('文档转换结果为空，无法摄取');
  }

  // 2) 分块（结构感知 + 小-大：父块只存文本，子块做向量）
  const chunks = chunkDocument(md, input.childSize, input.parentSize);
  const childs = chunks.filter((c) => !c.isParent);
  const parents = chunks.length - childs.length;
  console.info(`[rag] 分块完成：${childs.length} 个子块 / ${parents} 个父块（原文 ${md.length} 字符）`);
  if (childs.length === 0) {
    throw new Error('文档分块结果为空，无法摄取');
  }

  // 3) 嵌入（只算子块；父块不参与向量检索）
  //
  // 分批（2026-10-19 健壮性）：此前一次性把所有子块发给端点 —— 一份 100 页 PDF 可能有
  // 200+ 块，单请求体过大导致端点 400/超时，而且失败时完全没有进度可看。
  // 现在按 EMBED_BATCH 分批，每批打一行进度日志；再外套一层进程内缓存（重复文本不重复请求）。
  const EMBED_BATCH = 16;
  let embedder: Embedder;
  let cfg: EmbedConfig | null = null;
  if (input.embedder) {
    embedder = input.embedder;
  } else if (input.embedderOptions) {
    embedder = new ApiEmbedder(input.embedderOptions);
  } else {
    const picked = await createDefaultEmbedder();
    embedder = picked.embedder;
    cfg = picked.cfg;
  }
  const cached = new CachedEmbedder(embedder);

  const vecs: number[][] = [];
  try {
    for (let i = 0; i < childs.length; i += EMBED_BATCH) {
      const slice = childs.slice(i, i + EMBED_BATCH);
      // document 侧**不加** query 指令前缀（Qwen3 只要求 query 侧加）
      const part = await cached.embed(slice.map((c) => c.text));
      if (part.length !== slice.length) {
        throw new Error(`嵌入数量不匹配：本批期望 ${slice.length}，实际 ${part.length}`);
      }
      vecs.push(...part);
      console.info(`[rag] 嵌入进度 ${Math.min(i + EMBED_BATCH, childs.length)}/${childs.length}`);
    }
  } catch (e) {
    const msg = describeEmbedError(cfg, e);
    console.error('[rag] 摄取嵌入失败:', msg);
    throw new Error(msg);
  }
  if (vecs.length !== childs.length) {
    throw new Error(`嵌入数量不匹配：期望 ${childs.length}，实际 ${vecs.length}`);
  }
  const vecByChildIdx = new Map<number, number[]>();
  childs.forEach((c, i) => vecByChildIdx.set(c.idx, vecs[i] ?? []));

  // 4) 入库
  const source: RagSourceInput = {
    title: input.title,
    uri: input.uri,
    type: input.type ?? 'file',
    namespace: input.namespace ?? RAG_NS_GENERAL,
  };
  const payload: RagChunkInput[] = chunks.map((c) => ({
    idx: c.idx,
    text: c.text,
    char_start: c.charStart,
    char_end: c.charEnd,
    // 父块 vec 为空数组：后端据此跳过向量检索、只在命中子块后回填上下文
    vec: c.isParent ? [] : (vecByChildIdx.get(c.idx) ?? []),
    parent_idx: c.parentIdx,
    embed_model: cfg?.model,
    meta: {
      char_start: c.charStart,
      char_end: c.charEnd,
      is_parent: c.isParent,
      embed_model: cfg?.model ?? null,
      embed_dim: c.isParent ? 0 : (vecByChildIdx.get(c.idx)?.length ?? 0),
    },
  }));
  const res = await ragIngest(source, payload);
  console.info(
    `[rag] 入库完成：source=${res.source_id} 子块=${res.chunk_count} 父块=${parents} ns=${source.namespace}`,
  );
  return res;
}
