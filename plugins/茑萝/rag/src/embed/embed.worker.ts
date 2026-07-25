// onnx 嵌入 worker（全本地 wasm 推理）。
//
// 复用外部依赖的 ort UMD + setOrt() 范式（与 OCR 栈 external-deps/全局/paddleocr 一致）：
//   importScripts('/ocr-wasm/ort.wasm.min.js') 注入全局 ort，再用 setOrt(ort) 交给本 worker 使用。
// 沙箱屏蔽 fetch：模型权经由主线程 read_external_dep_bytes 读成 ArrayBuffer 随 init 消息传入，
// 不在 worker 内发起任何网络请求。

/// <reference lib="webworker" />

// 注入 onnxruntime-web UMD（宿主在 external-deps 中提供），得到全局 ort
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(self as any).importScripts?.('/ocr-wasm/ort.wasm.min.js');

interface InitMsg {
  id: number;
  type: 'init';
  modelBuffer?: ArrayBuffer;
  tokenizerBuffer?: ArrayBuffer;
}
interface EmbedMsg {
  id: number;
  type: 'embed';
  texts?: string[];
}
type ReqMsg = InitMsg | EmbedMsg;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ort: any = (self as any).ort;
let session: any = null;
// 极简 tokenizer 占位：真实场景由 @huggingface/tokenizers 提供；
// 此处若未注入 tokenizer，则退化为「按空白分词 + 长度截断」的近似（仅保证 worker 可跑通）。
let tokenizer: ((text: string) => string[]) | null = null;

function meanPool(lastHidden: Float32Array, attentionMask: number[]): number[] {
  const dims = lastHidden.length / attentionMask.length;
  const sum = new Float32Array(dims);
  let count = 0;
  for (let i = 0; i < attentionMask.length; i++) {
    if (attentionMask[i] === 0) continue;
    for (let d = 0; d < dims; d++) sum[d] += lastHidden[i * dims + d];
    count++;
  }
  const out = new Array(dims);
  for (let d = 0; d < dims; d++) out[d] = count > 0 ? sum[d] / count : 0;
  return out;
}

function tokenize(text: string): string[] {
  if (tokenizer) return tokenizer(text);
  // 退化实现：按空白切分（仅用于 worker 跑通演示，真实检索请用 @huggingface/tokenizers）
  return text.split(/\s+/).filter(Boolean);
}

self.onmessage = async (e: MessageEvent<ReqMsg>) => {
  const msg = e.data;
  // 提前取出 id：下方两个 if 分支各自 return 后，TS 会把 msg 收窄为 never，
  // 无法再访问 msg.id；这里缓存到外层变量供兜底 postMessage 使用。
  const reqId = msg.id;
  try {
    if (msg.type === 'init') {
      if (!ort) throw new Error('onnxruntime-web 未加载（缺少 /ocr-wasm/ort.wasm.min.js）');
      if (!msg.modelBuffer) throw new Error('未收到模型权重（modelBuffer 为空）');
      const modelUint8 = new Uint8Array(msg.modelBuffer);
      session = await ort.InferenceSession.create(modelUint8);
      // tokenizerBuffer 预留给 @huggingface/tokenizers 加载（v1 未强制）
      (self as any).postMessage({ id: msg.id, ok: true });
      return;
    }
    if (msg.type === 'embed') {
      if (!session) throw new Error('worker 未初始化（请先发 init）');
      const texts = msg.texts ?? [];
      const embeddings: number[][] = [];
      for (const t of texts) {
        const tokens = tokenize(t);
        const inputIds = new ort.Tensor('int64', BigInt64Array.from(tokens.map((_tok, i) => BigInt(i))), [
          tokens.length,
        ]);
        // 注：真实 nomic-embed-text 需 tokenizer 产出的 input_ids/attention_mask/token_type_ids；
        // 此处为 worker 跑通骨架，调用方应保证 tokenizer 注入后再用真实模型路径。
        const out = await session.run({ input_ids: inputIds });
        const key = Object.keys(out)[0];
        const data = out[key].data as Float32Array;
        embeddings.push(meanPool(data, new Array(tokens.length).fill(1)));
      }
      (self as any).postMessage({ id: msg.id, ok: true, embeddings });
      return;
    }
    (self as any).postMessage({ id: reqId ?? -1, ok: false, error: '未知消息类型' });
  } catch (err) {
    (self as any).postMessage({
      id: reqId ?? -1,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
