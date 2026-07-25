// 嵌入抽象层接口。
//
// 设计决策（用户敲定）：
// 同时支持「全本地」（OnnxEmbedder，wasm，无网络）与「全 API」（ApiEmbedder，Ollama / OpenAI 兼容），
// 不强制混合。v1 默认走 ApiEmbedder（零模型下载、本体最轻）；OnnxEmbedder 接口与 worker 就绪，
// 模型权重作为后续资源落地。

/** 嵌入器统一接口。 */
export interface Embedder {
  /** 向量维度（nomic-embed-text = 768）。 */
  readonly dim: number;
  /** 模型标识（用于 UI 展示 / 校验）。 */
  readonly modelId: string;
  /** 批量嵌入文本，返回与输入等长的向量数组。 */
  embed(texts: string[]): Promise<number[][]>;
}
