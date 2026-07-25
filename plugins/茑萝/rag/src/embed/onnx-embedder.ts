// OnnxEmbedder：全本地 wasm 嵌入（onnxruntime-web + @huggingface/tokenizers），完全离线、无网络。
//
// v1 状态（用户敲定）：接口 + worker 就绪，模型权重作为后续资源落地到
// external-deps/茑萝/rag/onnx/（onnx 模型 + tokenizer.json）。模型未落地时 embed() 会抛出明确错误，
// 引导回退到 ApiEmbedder。等权重到位后即为「全本地」嵌入，无需任何外部端点。
//
// 沙箱屏蔽 fetch：模型权重由主线程经 read_external_dep_bytes 读成 ArrayBuffer，再随消息传给 worker，
// worker 内用 onnxruntime-web 推理。

import { readExternalDepBytes } from '../api/host';
import type { Embedder } from './embedder';

export interface OnnxEmbedderOptions {
  /** onnx 模型相对 external-deps 路径（默认 茑萝/rag/onnx/model.onnx）。 */
  modelPath?: string;
  /** tokenizer.json 相对 external-deps 路径（默认 茑萝/rag/onnx/tokenizer.json）。 */
  tokenizerPath?: string;
  /** worker 入口 URL（默认同目录 embed.worker.js）。 */
  workerUrl?: string;
  /** 向量维度（默认 768）。 */
  dim?: number;
}

interface WorkerRequest {
  id: number;
  type: 'init' | 'embed';
  modelBuffer?: ArrayBuffer;
  tokenizerBuffer?: ArrayBuffer;
  texts?: string[];
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  embeddings?: number[][];
  error?: string;
}

function toArrayBuffer(bytes: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) view[i] = bytes[i];
  return buf;
}

export class OnnxEmbedder implements Embedder {
  readonly dim: number;
  readonly modelId: string;
  private modelPath: string;
  private tokenizerPath: string;
  private workerUrl: string;
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();
  private initPromise: Promise<void> | null = null;

  constructor(opts: OnnxEmbedderOptions = {}) {
    this.modelPath = opts.modelPath ?? '茑萝/rag/onnx/model.onnx';
    this.tokenizerPath = opts.tokenizerPath ?? '茑萝/rag/onnx/tokenizer.json';
    this.workerUrl = opts.workerUrl ?? './embed.worker.js';
    this.dim = opts.dim ?? 768;
    this.modelId = `onnx:${this.modelPath}`;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerUrl);
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const { id, ok, embeddings, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok && embeddings) p.resolve(embeddings);
      else p.reject(new Error(error ?? 'worker 返回未知错误'));
    };
    worker.onerror = (e) => {
      // 标记所有在途请求失败
      for (const [, p] of this.pending) p.reject(new Error(e.message || 'worker 错误'));
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  private async ensureInit(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const worker = this.ensureWorker();
      // 读取模型 + tokenizer 权重（经 Rust 代理，避免沙箱 fetch 限制）
      const [modelBytes, tokBytes] = await Promise.all([
        readExternalDepBytes(this.modelPath),
        readExternalDepBytes(this.tokenizerPath),
      ]);
      if (!modelBytes || modelBytes.length === 0) {
        throw new Error(
          `未找到 onnx 模型权重（${this.modelPath}）。请先将权重落地到 external-deps 后重试，或改用 ApiEmbedder。`,
        );
      }
      await this.post({
        id: this.nextId++,
        type: 'init',
        modelBuffer: toArrayBuffer(modelBytes),
        tokenizerBuffer: tokBytes?.length ? toArrayBuffer(tokBytes) : undefined,
      });
    })();
    return this.initPromise;
  }

  private post(req: WorkerRequest): Promise<number[][]> {
    const worker = this.ensureWorker();
    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject });
      worker.postMessage(req);
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureInit();
    return this.post({ id: this.nextId++, type: 'embed', texts });
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initPromise = null;
  }
}
