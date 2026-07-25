// 摄取管线：文档 → Markdown → 分块 → 嵌入 → 入库。
//
// 首步复用 Rust 命令 convert_to_markdown（原生解析 docx/pptx/xlsx/pdf 等）；
// 分块复用 chunkText 4000/200；嵌入默认走 ApiEmbedder（rag_embed_api 代理 Ollama/OpenAI），
// 也可注入 OnnxEmbedder（全本地）；最后调用 rag_ingest 入库。

import {
  convertBytesToMarkdown,
  convertToMarkdown,
  ragIngest,
  type RagChunkInput,
  type RagSourceInput,
} from '../api/host';
import { ApiEmbedder, type ApiEmbedderOptions } from '../embed/api-embedder';
import type { Embedder } from '../embed/embedder';
import { chunkText } from './chunker';

export interface IngestInput {
  /** 来源标题（展示用）。 */
  title: string;
  /** 来源 URI（文件路径 / URL / 标识）。 */
  uri: string;
  /** 来源类型（默认 file）。 */
  type?: string;
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
  /** 嵌入器（默认 ApiEmbedder）。 */
  embedder?: Embedder;
  /** ApiEmbedder 选项（默认 Ollama + nomic-embed-text）。 */
  embedderOptions?: ApiEmbedderOptions;
  /** 分块大小 / 重叠（默认 4000 / 200）。 */
  chunkSize?: number;
  chunkOverlap?: number;
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

  // 2) 分块
  const chunks = chunkText(md, input.chunkSize, input.chunkOverlap);

  // 3) 嵌入
  const embedder = input.embedder ?? new ApiEmbedder(input.embedderOptions ?? {});
  const texts = chunks.map((c) => c.text);
  const vecs = await embedder.embed(texts);
  if (vecs.length !== chunks.length) {
    throw new Error(`嵌入数量不匹配：期望 ${chunks.length}，实际 ${vecs.length}`);
  }

  // 4) 入库
  const source: RagSourceInput = {
    title: input.title,
    uri: input.uri,
    type: input.type ?? 'file',
  };
  const payload: RagChunkInput[] = chunks.map((c, i) => ({
    idx: c.idx,
    text: c.text,
    char_start: c.charStart,
    char_end: c.charEnd,
    vec: vecs[i] ?? [],
    meta: { char_start: c.charStart, char_end: c.charEnd },
  }));
  return ragIngest(source, payload);
}
