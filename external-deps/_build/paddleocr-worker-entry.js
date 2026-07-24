// 本地 OCR Web Worker 入口（esbuild 打包为 classic worker IIFE → public/ocr-worker.js）。
// onnxruntime-web 不随包打入，运行期由 ocr.worker.ts 内 importScripts('/ocr-wasm/ort.wasm.min.js') 注入全局 ort。
import '../全局/paddleocr/src/ocr.worker';
