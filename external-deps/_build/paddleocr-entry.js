// 本地 OCR 引擎入口（仅副作用导入，esbuild 打包为 IIFE 后挂载 window.__EXT_PADDLEOCR__）。
// onnxruntime-web 不外部化，随包体一并打入；运行于 WebView2 的 webgl EP，无需单独 wasm 二进制。
import '../全局/paddleocr/src/index';
