/// <reference path="../../../../global.d.ts" />
// ============================================================================
// 本地 OCR 引擎（PaddleOCR PP-OCRv6，纯前端 WASM/WebGL，不进本体安装包）
// ----------------------------------------------------------------------------
// 打包形态：本源文件由 scripts/build-external-deps.mjs 经 esbuild 打成 IIFE，
// 产物 external-deps/全局/paddleocr/index.js 挂载 window.__EXT_PADDLEOCR__。
// 用户侧载的依赖包（.mujin）即包含此 index.js + models/ 下的 ONNX 模型与字符表。
//
// 加载链路（由 ocr 插件触发，复用 external-deps 的 read_external_dep_file + new Function）：
//   plugin -> new Function(index.js)() -> 本文件执行 -> window.__EXT_PADDLEOCR__ 就绪
//   recognize() 内部通过 window.__HOST_API__.invoke（真实 window 上的宿主 API，含原始 invoke）
//   按相对路径读取 models/*.onnx 与 ppocr_keys_v1.txt，二进制走 read_external_dep_bytes。
//   （引擎经 new Function 在真实全局作用域执行，故能直接拿到 window.__HOST_API__，
//    无需插件透传；沙箱 window 的 set 不写真实 window，故不能走 window 变量传递。）
//
// 设计取舍：检测采用 DB 概率图 + 连通域（轴对齐框），覆盖绝大多数水平文字场景
// （截图 / 图片取字）；旋转文本暂未做仿射校正。识别为 CRNN + CTC 贪心解码。
// 若识别质量不满足，可在 OcrWorkspace 触发处让其自动降级回云端 ai_vision_ocr。
// ============================================================================

// 直连 WebGL 后端（默认 onnxruntime-web 入口）。
// WASM 后端（ort.wasm.min.js）仅在 WebGL 不可用时作为运行时降级加载，
// 通过 read_external_dep_file + new Function 执行 IIFE 拿到含注册好 WASM 后端的 ort 命名空间。
// 不用 onnxruntime-web 包（esbuild 坚持 tree-shake 掉 WASM 后端注册代码），
// 运行时通过 INVOKE 读取 wasm 后端 IIFE 文件直接执行，拿其返回值作为 ort 命名空间。
const INVOKE = (window as any).__HOST_API__?.invoke as
  | ((cmd: string, args: Record<string, unknown>) => Promise<unknown>)
  | undefined;
const REL = '全局/paddleocr';

// 归一化参数（与 PaddleOCR 官方一致）
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// 模型与字符表相对路径（位于 .mujin 包的 models/ 下）
const DET_PATH = `${REL}/models/ch_PP-OCRv6_det_infer.onnx`;
const REC_PATH = `${REL}/models/ch_PP-OCRv6_rec_infer.onnx`;
const DICT_PATH = `${REL}/models/ppocrv6_dict.txt`;

// WASM 后端 JS 代码与 wasm 二进制的运行时加载路径
const WASM_JS_PATH = `${REL}/wasm/ort-wasm.min.js`;
const WASM_BIN_PATH = `${REL}/wasm/ort-wasm-simd.wasm`;

let detSession: ort.InferenceSession | null = null;
let recSession: ort.InferenceSession | null = null;
let dict: string[] = [];
let initPromise: Promise<void> | null = null;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

async function readBytes(relPath: string): Promise<Uint8Array> {
  if (!INVOKE) throw new Error('OCR 引擎未注入 invoke（插件未正确加载）');
  const b64 = (await INVOKE('read_external_dep_bytes', { relativePath: relPath })) as string;
  return b64ToBytes(b64.split(',')[1] ?? b64);
}

async function readText(relPath: string): Promise<string> {
  const u = await readBytes(relPath);
  return new TextDecoder('utf-8').decode(u);
}

async function readCode(relPath: string): Promise<string> {
  if (!INVOKE) throw new Error('OCR 引擎未注入 invoke（插件未正确加载）');
  return (await INVOKE('read_external_dep_file', { relativePath: relPath })) as string;
}

let _ort: any = null; // 运行时加载的 wasm ort 命名空间
let _ortReady: Promise<void> | null = null;
async function initOrt(): Promise<any> {
  if (_ort) return _ort;
  if (_ortReady) { await _ortReady; return _ort; }
  _ortReady = (async () => {
    const [code, wasmBuf] = await Promise.all([
      readCode(WASM_JS_PATH),
      readBytes(WASM_BIN_PATH),
    ]);
    _ort = new Function(code)();
    // 预加载 wasm 二进制（默认 fetch 在 new Function 上下文中不可用）
    const ab = wasmBuf.buffer.slice(wasmBuf.byteOffset, wasmBuf.byteOffset + wasmBuf.byteLength);
    _ort.env.wasm.wasmBinary = ab;
    _ort.env.wasm.numThreads = 1;
    _ort.env.wasm.simd = true;
  })();
  await _ortReady;
  return _ort!;
}

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const [det, rec, dictText] = await Promise.all([
      readBytes(DET_PATH),
      readBytes(REC_PATH),
      readText(DICT_PATH),
    ]);
    dict = dictText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (dict.length === 0) throw new Error('OCR 字符表为空');

    const ort = await initOrt();
    detSession = await ort.InferenceSession.create(det, { executionProviders: ['wasm'] });
    recSession = await ort.InferenceSession.create(rec, { executionProviders: ['wasm'] });
  })();
  return initPromise;
}

// ---- 图像工具 ----
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

function imageDataOf(img: HTMLImageElement): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 上下文');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// 将 RGBA ImageData 转为归一化 CHW Float32Array（norm: 'imagenet' 检测用；'m1' 为 PP-OCRv6 识别的 [-1,1]）
function toCHW(img: ImageData, norm: 'imagenet' | 'm1' = 'imagenet'): { data: Float32Array; w: number; h: number } {
  const { data, width: w, height: h } = img;
  const out = new Float32Array(3 * w * h);
  const m1 = (v: number) => (v / 255 - 0.5) / 0.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = y * w + x;
      if (norm === 'm1') {
        out[o] = m1(data[i]);
        out[w * h + o] = m1(data[i + 1]);
        out[2 * w * h + o] = m1(data[i + 2]);
      } else {
        out[o] = (data[i] / 255 - MEAN[0]) / STD[0];
        out[w * h + o] = (data[i + 1] / 255 - MEAN[1]) / STD[1];
        out[2 * w * h + o] = (data[i + 2] / 255 - MEAN[2]) / STD[2];
      }
    }
  }
  return { data: out, w, h };
}

function resizeCHW(
  src: { data: Float32Array; w: number; h: number },
  tw: number,
  th: number,
): Float32Array {
  // 最近邻缩放（CHW）
  const out = new Float32Array(3 * tw * th);
  const { data, w, h } = src;
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < th; y++) {
      const sy = Math.min(h - 1, Math.floor((y * h) / th));
      for (let x = 0; x < tw; x++) {
        const sx = Math.min(w - 1, Math.floor((x * w) / tw));
        out[c * tw * th + y * tw + x] = data[c * w * h + sy * w + sx];
      }
    }
  }
  return out;
}

// ---- 检测后处理：DB 概率图 + 4 连通域，返回轴对齐框（原图坐标）----
function detectBoxes(prob: Float32Array, detW: number, detH: number, scale: number): number[][] {
  const binary = new Uint8Array(detW * detH);
  for (let i = 0; i < prob.length; i++) binary[i] = prob[i] > 0.3 ? 1 : 0;

  const labels = new Int32Array(detW * detH);
  const stack: number[] = [];
  let cur = 1;
  const boxes: number[][] = [];
  const minArea = Math.max(9, Math.floor((detW * detH) / 4000));

  for (let i = 0; i < binary.length; i++) {
    if (binary[i] !== 1 || labels[i] !== 0) continue;
    labels[i] = cur;
    stack.length = 0;
    stack.push(i);
    let xmin = detW, ymin = detH, xmax = 0, ymax = 0, area = 0;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % detW;
      const py = Math.floor(p / detW);
      xmin = Math.min(xmin, px);
      ymin = Math.min(ymin, py);
      xmax = Math.max(xmax, px);
      ymax = Math.max(ymax, py);
      area++;
      const nb = [p - 1, p + 1, p - detW, p + detW];
      for (const q of nb) {
        if (q < 0 || q >= binary.length) continue;
        const qx = q % detW;
        const qy = Math.floor(q / detW);
        if (qx !== px && qy !== py) continue; // 4 连通
        if (binary[q] === 1 && labels[q] === 0) {
          labels[q] = cur;
          stack.push(q);
        }
      }
    }
    if (area >= minArea) {
      boxes.push([
        Math.round(xmin * scale),
        Math.round(ymin * scale),
        Math.round(xmax * scale),
        Math.round(ymax * scale),
      ]);
    }
    cur++;
  }
  return boxes;
}

function ctcDecode(logits: Float32Array, dims: number[], dictLen: number): string {
  // 识别输出 [1, A, B]；判定类别轴（size ≈ dictLen+1）
  const a = dims[1];
  const b = dims[2];
  const classAxis = a === dictLen + 1 ? 1 : 2;
  const timeAxis = classAxis === 1 ? 2 : 1;
  const T = classAxis === 1 ? b : a;
  const C = classAxis === 1 ? a : b;
  const blank = 0; // PaddleOCR CTC：blank 为类别 0；实际字符 class c(>=1) 对应 dict[c-1]
  let prev = -1;
  let out = '';
  for (let t = 0; t < T; t++) {
    let best = -Infinity;
    let bestC = 0;
    for (let c = 0; c < C; c++) {
      const idx = classAxis === 1 ? c * b + t : t * a + c;
      const v = logits[idx];
      if (v > best) {
        best = v;
        bestC = c;
      }
    }
    if (bestC === blank) {
      prev = -1;
      continue;
    }
    const charIdx = bestC - 1;
    if (charIdx < 0 || charIdx >= dictLen) {
      prev = bestC;
      continue;
    }
    if (bestC === prev) continue;
    out += dict[charIdx];
    prev = bestC;
  }
  return out;
}

async function recognize(dataUrl: string): Promise<string> {
  await ensureInit();
  if (!detSession || !recSession) throw new Error('OCR 引擎未初始化');

  const imgEl = await loadImage(dataUrl);
  const img = imageDataOf(imgEl);
  const ow = img.width;
  const oh = img.height;

  // ---- 检测：固定画布尺寸，规避 onnxruntime-web 在可变输入尺寸下触发的缓冲区复用崩溃（wasm/webgl 均触发）----
  const DET_CANVAS = 1536;
  const s = DET_CANVAS / Math.max(ow, oh);
  const rw = Math.max(1, Math.round(ow * s));
  const rh = Math.max(1, Math.round(oh * s));
  // 构建固定 DET_CANVAS×DET_CANVAS 画布，原图左上对齐缩放放入，其余填 0（黑底）
  const canvasImg = new ImageData(DET_CANVAS, DET_CANVAS);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const sx = Math.min(ow - 1, Math.floor(x / s));
      const sy = Math.min(oh - 1, Math.floor(y / s));
      const si = (sy * ow + sx) * 4;
      const di = (y * DET_CANVAS + x) * 4;
      canvasImg.data[di] = img.data[si];
      canvasImg.data[di + 1] = img.data[si + 1];
      canvasImg.data[di + 2] = img.data[si + 2];
      canvasImg.data[di + 3] = 255;
    }
  }
  const detCHW = toCHW(canvasImg).data;
  const detInput = new (_ort!.Tensor)('float32', detCHW, [1, 3, DET_CANVAS, DET_CANVAS]);
  const detOut = await detSession.run({ [detSession.inputNames[0]]: detInput });
  const detData = detOut[detSession.outputNames[0]].data as Float32Array;
  // 输出 [1,1,H,W] 概率图（det onnx 内含 sigmoid），取最后一维展开
  const prob = detData;
  const mapScale = ow / rw; // det 空间 -> 原图坐标映射
  const boxes = detectBoxes(prob, DET_CANVAS, DET_CANVAS, mapScale).filter(
    ([x1, y1, x2, y2]) => x2 - x1 > 2 && y2 - y1 > 2,
  );

  if (boxes.length === 0) return '';

  // 阅读顺序：先按行（y），再按列（x）
  boxes.sort((p, q) => p[1] - q[1] || p[0] - q[0]);

  const lines: string[] = [];
  for (const [x1, y1, x2, y2] of boxes) {
    // 从原图裁切（clamp）
    const cx1 = Math.max(0, x1);
    const cy1 = Math.max(0, y1);
    const cx2 = Math.min(ow - 1, x2);
    const cy2 = Math.min(oh - 1, y2);
    if (cx2 <= cx1 || cy2 <= cy1) continue;
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cx2 - cx1;
    cropCanvas.height = cy2 - cy1;
    const cctx = cropCanvas.getContext('2d');
    if (!cctx) continue;
    cctx.drawImage(imgEl, cx1, cy1, cropCanvas.width, cropCanvas.height, 0, 0, cropCanvas.width, cropCanvas.height);
    const cropImg = cctx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
    const cw = cropCanvas.width;
    const ch = cropCanvas.height;
    const recW = Math.max(48, Math.min(320, Math.round((48 * cw) / ch)));
    const recCHW = resizeCHW(toCHW(cropImg, 'm1'), recW, 48);
    const recInput = new (_ort!.Tensor)('float32', recCHW, [1, 3, 48, recW]);
    const recOut = await recSession.run({ [recSession.inputNames[0]]: recInput });
    const recData = recOut[recSession.outputNames[0]].data as Float32Array;
    const text = ctcDecode(recData, recOut[recSession.outputNames[0]].dims, dict.length);
    if (text.trim()) lines.push(text);
  }
  return lines.join('\n');
}

(window as any).__EXT_PADDLEOCR__ = {
  recognize,
  ready: () => !!detSession && !!recSession,
  // 版本标记，用于 loadPaddleOcr() 判断缓存是否仍为当前构建（HMR 可能残留旧 IIFE）
  _v: 2,
};
