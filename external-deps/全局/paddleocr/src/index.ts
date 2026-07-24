// ============================================================================
// 本地 OCR 引擎（主线程入口，由 build-external-deps.mjs 打包为 IIFE 后通过
// new Function 注入 window.__EXT_PADDLEOCR__）。
// ----------------------------------------------------------------------------
// 设计要点：
//   - 推理默认在 Web Worker（ocr-worker.js）中执行，主线程仅派发图片 dataURL 并
//     等待结果，因此即便 WASM 单线程同步推理也不会冻结整个软件 UI。
//   - 若 Worker 不可用（创建/初始化失败），回退到主线程直接执行同一管线（此时会
//     阻塞主线程，但保证功能可用）。
//   - onnxruntime-web 通过 fetch UMD（/ocr-wasm/ort.wasm.min.js）加载，注入到
//     engine-core 的 _ort，引擎与 worker 共用同一份推理实现。
// ============================================================================
import { setOrt, runPipeline, setDict, getOrt } from './engine-core';

const INVOKE = (window as any).__HOST_API__?.invoke;
const REL = (window as any).__HOST_API__?.rel ?? ((p: string) => p);

const DET_PATH = REL('全局/paddleocr/models/ch_PP-OCRv6_det_infer.onnx');
const REC_PATH = REL('全局/paddleocr/models/ch_PP-OCRv6_rec_infer.onnx');
const DICT_PATH = REL('全局/paddleocr/models/ppocrv6_dict.txt');
const WASM_BASE = REL('ocr-wasm/');

// 在 v6 基础上：① rec 裁剪改用双线性缩放（最近邻压扁宽文本行会丢失笔画→乱码）；
// ② 识别整体搬入 Web Worker，主线程不再被 session.run() 阻塞→解决卡死。
// ③ 仍是 BGR 通道顺序 + ctcDecode 偏移 t*b+c（v6 已修）。
const _v = 7;

function b64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function readBytes(path: string): Promise<Uint8Array> {
  const b64: string = await INVOKE('read_external_dep_bytes', { relativePath: path });
  return b64ToBytes(b64);
}
async function readText(path: string): Promise<string> {
  const b64: string = await INVOKE('read_external_dep_bytes', { relativePath: path });
  return new TextDecoder('utf-8').decode(b64ToBytes(b64));
}

// 加载 onnxruntime-web（仅主线程回退路径使用；worker 内由 importScripts 注入）。
async function initOrt(): Promise<any> {
  if (getOrt()) return getOrt();
  const wasmJs = await (await fetch(REL('ocr-wasm/ort.wasm.min.js'))).text();
  const mod = { exports: {} as any };
  new Function('module', 'exports', wasmJs)(mod, mod.exports);
  const ort = mod.exports;
  if (!ort || typeof ort.InferenceSession !== 'function') throw new Error('ort 加载失败');
  ort.env.wasm.wasmPaths = WASM_BASE;
  const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
  ort.env.wasm.numThreads = typeof SharedArrayBuffer !== 'undefined' ? Math.max(1, Math.min(4, hw)) : 1;
  setOrt(ort);
  return ort;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}
function imageDataOf(img: HTMLImageElement): ImageData {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

// ---- Worker 状态 ----
let worker: Worker | null = null;
let useWorker = false;
let workerReady: Promise<void> | null = null;
// 主线程回退会话
let _det: any = null;
let _rec: any = null;
let _dict: string[] = [];
let pending = new Map<number, { resolve: (v: string) => void; reject: (e: any) => void }>();
let reqId = 0;

async function ensureInit(): Promise<void> {
  if (workerReady) return workerReady;
  workerReady = (async () => {
    const [detBuf, recBuf, dictText] = await Promise.all([readBytes(DET_PATH), readBytes(REC_PATH), readText(DICT_PATH)]);
    // 注意：绝不能过滤空行。ppocrv6_dict.txt 内含空行，它们是模型词表位置的占位符；
    // 过滤后 dict[index] 与模型类别序号错位，导致中文（空行之后）整段乱码、ASCII 正常。
    // 保留空行（trim 仅去首尾空白，不改变行数），使索引与模型 18709 个类别严格对齐。
    _dict = dictText.split(/\r?\n/).map((s) => s.trim());
    setDict(_dict);
    // 尝试启动 Worker
    try {
      const w = new Worker('/ocr-worker.js');
      await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => rej(new Error('worker 初始化超时')), 30000);
        w.onmessage = (e: MessageEvent) => {
          const d = e.data;
          if (d.type === 'ready') {
            clearTimeout(timer);
            res();
          } else if (d.type === 'error') {
            clearTimeout(timer);
            rej(new Error('worker init: ' + d.message));
          }
        };
        w.onerror = (err: any) => {
          clearTimeout(timer);
          rej(new Error('worker load error: ' + (err?.message || err)));
        };
        // 注意：不 transfer（否则 worker 初始化失败时主线程 buffer 被 detach，回退路径失效）。
        // 结构化克隆会拷贝一次（约 26MB，仅启动期一次，可接受）。
        w.postMessage({ type: 'init', det: detBuf.buffer, rec: recBuf.buffer, dict: dictText });
      });
      // 设置识别消息路由（按 id 分发，支持并发）
      w.onmessage = (e: MessageEvent) => {
        const d = e.data;
        if (d.type === 'result' || d.type === 'error') {
          const p = pending.get(d.id);
          if (!p) return;
          pending.delete(d.id);
          if (d.type === 'result') p.resolve(d.text);
          else p.reject(new Error(d.message));
        }
      };
      w.onerror = (err: any) => {
        // worker 运行期崩溃：拒绝所有挂起请求并标记回退
        for (const p of pending.values()) p.reject(new Error('worker runtime error: ' + (err?.message || err)));
        pending.clear();
        useWorker = false;
      };
      worker = w;
      useWorker = true;
    } catch (e) {
      console.warn('[OCR] Web Worker 不可用，回退主线程执行：', e);
      useWorker = false;
      const ort = await initOrt();
      _det = await ort.InferenceSession.create(detBuf, { executionProviders: ['wasm'] });
      _rec = await ort.InferenceSession.create(recBuf, { executionProviders: ['wasm'] });
    }
  })();
  return workerReady;
}

async function recognize(dataUrl: string): Promise<string> {
  await ensureInit();
  if (useWorker && worker) {
    const id = ++reqId;
    return new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker!.postMessage({ type: 'recognize', id, dataUrl });
    });
  }
  // 主线程回退
  const imgEl = await loadImage(dataUrl);
  const img = imageDataOf(imgEl);
  return runPipeline(img, img.width, img.height, _det, _rec, _dict);
}

(window as any).__EXT_PADDLEOCR__ = {
  recognize,
  ready: () => (useWorker ? !!worker : !!(getOrt() && _det && _rec)),
  _v,
};
