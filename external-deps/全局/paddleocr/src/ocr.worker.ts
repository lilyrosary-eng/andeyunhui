// ============================================================================
// 本地 OCR Web Worker 入口
// ----------------------------------------------------------------------------
// 在独立线程加载 onnxruntime-web 并运行识别管线，使主线程 UI 不被 WASM 推理阻塞。
// 注意：本文件被 build-external-deps.mjs 打包为 classic worker（IIFE），通过
// importScripts 注入 onnxruntime-web UMD（全局 ort），随后即可使用。
// ============================================================================
/// <reference lib="webworker" />
importScripts('/ocr-wasm/ort.wasm.min.js');
import { setOrt, runPipeline, setDict } from './engine-core';

const ort = (self as any).ort;
setOrt(ort);
ort.env.wasm.wasmPaths = '/ocr-wasm/';
const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
ort.env.wasm.numThreads = typeof SharedArrayBuffer !== 'undefined' ? Math.max(1, Math.min(4, hw)) : 1;

let detSession: any = null;
let recSession: any = null;
let dictArr: string[] = [];

async function decodeDataUrl(dataUrl: string): Promise<ImageData> {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      const detBuf = new Uint8Array(msg.det);
      const recBuf = new Uint8Array(msg.rec);
      // 保留空行（模型词表占位符），不要过滤，否则 dict[index] 与模型类别错位→中文乱码。
      dictArr = (msg.dict as string).split(/\r?\n/).map((s) => s.trim());
      setDict(dictArr);
      detSession = await ort.InferenceSession.create(detBuf, { executionProviders: ['wasm'] });
      recSession = await ort.InferenceSession.create(recBuf, { executionProviders: ['wasm'] });
      (self as any).postMessage({ type: 'ready' });
    } catch (err: any) {
      (self as any).postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
  } else if (msg.type === 'recognize') {
    try {
      const img = await decodeDataUrl(msg.dataUrl);
      const text = await runPipeline(img, img.width, img.height, detSession, recSession, dictArr);
      (self as any).postMessage({ type: 'result', id: msg.id, text });
    } catch (err: any) {
      (self as any).postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
    }
  }
};
