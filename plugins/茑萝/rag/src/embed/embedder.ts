// 嵌入抽象层接口。
//
// 现状（2026-10-19）：只有一种实现 —— ApiEmbedder（LM Studio / Ollama / 任意 OpenAI 兼容端点）。
// 原本还有 OnnxEmbedder（onnxruntime-web 本地推理），但它的 tokenizer 是占位实现
// （按空白切分、把下标当 token id），产出的向量是噪声 —— 已整体删除，不保留"半可用"的路径。
// 本地嵌入请用 LM Studio 加载 GGUF 嵌入模型（见 embed-config 的三级端点解析）。
//
// 保留这个接口的意义：嵌入器是可替换的（测试里可以塞假实现；将来接真 tokenizer 也只加一个类）。

/** 嵌入器统一接口。 */
export interface Embedder {
  /** 向量维度（nomic-embed-text = 768）。 */
  readonly dim: number;
  /** 模型标识（用于 UI 展示 / 校验）。 */
  readonly modelId: string;
  /** 批量嵌入文本，返回与输入等长的向量数组。 */
  embed(texts: string[]): Promise<number[][]>;
}
