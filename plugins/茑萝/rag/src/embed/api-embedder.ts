// ApiEmbedder：前端薄封装，调用 Rust 命令 rag_embed_api（reqwest 代理到配置的 embed 端点）。
//
// 默认端点 Ollama http://localhost:11434/api/embeddings，模型 nomic-embed-text；
// 也支持任意 OpenAI 兼容 embed 端点（/v1/embeddings），端点/key 复用现有 ai profiles / ModelSettings。
// 这是 v1 默认嵌入器：零模型下载、本体最轻。

import { ragEmbedApi, type EmbedOptions } from '../api/host';
import type { Embedder } from './embedder';

/** 默认 Ollama 嵌入端点（与 ModelSettings Ollama 预设同主机不同路径）。 */
export const DEFAULT_EMBED_ENDPOINT = 'http://localhost:11434/api/embeddings';
/** 默认嵌入模型（nomic-embed-text，维度 768）。 */
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
/** 共享向量维度（与后端 RAG_VECTOR_DIM 一致）。 */
export const RAG_VECTOR_DIM = 768;

export interface ApiEmbedderOptions extends EmbedOptions {}

export class ApiEmbedder implements Embedder {
  readonly dim = RAG_VECTOR_DIM;
  readonly modelId: string;
  private endpoint?: string;
  private apiKey?: string;
  private model: string;

  constructor(opts: ApiEmbedderOptions = {}) {
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_EMBED_MODEL;
    this.modelId = this.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await ragEmbedApi(texts, {
      endpoint: this.endpoint,
      apiKey: this.apiKey,
      model: this.model,
    });
    if (res.embeddings.length !== texts.length) {
      throw new Error(
        `嵌入返回数量不匹配：期望 ${texts.length}，实际 ${res.embeddings.length}`,
      );
    }
    return res.embeddings;
  }
}
