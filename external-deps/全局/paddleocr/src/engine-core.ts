// ============================================================================
// 本地 OCR 引擎核心（纯计算，无 DOM 创建）
// ----------------------------------------------------------------------------
// 该模块被两处复用：
//   1) 主线程回退路径（index.ts）：直接用 document/Image 解码后调用 runPipeline；
//   2) Web Worker（ocr.worker.ts）：用 OffscreenCanvas/createImageBitmap 解码后调用
//      runPipeline。两者都通过 setOrt() 注入 onnxruntime-web 实例（主线程由 fetch
//      UMD 得到，worker 由 importScripts UMD 得到），从而本模块不直接依赖全局 ort。
// ============================================================================

export interface ImgData {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

// 归一化参数（与 PaddleOCR 官方一致）
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let _ort: any = null;
export function setOrt(o: any) {
  _ort = o;
}
export function getOrt(): any {
  if (!_ort) throw new Error('OCR 引擎未注入 ort（setOrt 未调用）');
  return _ort;
}

// 将 RGBA 像素转归一化 CHW Float32Array。
// 关键：PaddleOCR / PP-OCRv6 模型以 BGR 通道顺序训练（OpenCV 默认），必须把像素的
// B 送通道0、G 送通道1、R 送通道2。
// norm: 'imagenet' 检测用 ImageNet mean/std；'m1' 为 PP-OCRv6 识别的 (x/255-0.5)/0.5。
export function toCHW(img: ImgData, norm: 'imagenet' | 'm1' = 'imagenet'): { data: Float32Array; w: number; h: number } {
  const { data, width: w, height: h } = img;
  const out = new Float32Array(3 * w * h);
  const m1 = (v: number) => (v / 255 - 0.5) / 0.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = y * w + x;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (norm === 'm1') {
        out[o] = m1(b);
        out[w * h + o] = m1(g);
        out[2 * w * h + o] = m1(r);
      } else {
        out[o] = (b / 255 - MEAN[0]) / STD[0];
        out[w * h + o] = (g / 255 - MEAN[1]) / STD[1];
        out[2 * w * h + o] = (r / 255 - MEAN[2]) / STD[2];
      }
    }
  }
  return { data: out, w, h };
}

// 最近邻缩放（CHW）。仅用于检测画布等对缩放质量不敏感的场景。
export function resizeCHW(src: { data: Float32Array; w: number; h: number }, tw: number, th: number): Float32Array {
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

// 双线性缩放（CHW）。识别裁剪（尤其是宽高比大的文本行压到 320 宽）必须用双线性，
// 最近邻会丢失竖向笔画导致识别成乱码（"H" 横线被采掉 → "TTT"）。
export function resizeCHWBilinear(src: { data: Float32Array; w: number; h: number }, tw: number, th: number): Float32Array {
  const out = new Float32Array(3 * tw * th);
  const { data, w, h } = src;
  const fx = (w - 1) / (tw - 1 || 1);
  const fy = (h - 1) / (th - 1 || 1);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < th; y++) {
      const sy = y * fy;
      const y0 = Math.floor(sy);
      const y1 = Math.min(h - 1, y0 + 1);
      const wy1 = sy - y0;
      const wy0 = 1 - wy1;
      for (let x = 0; x < tw; x++) {
        const sx = x * fx;
        const x0 = Math.floor(sx);
        const x1 = Math.min(w - 1, x0 + 1);
        const wx1 = sx - x0;
        const wx0 = 1 - wx1;
        const v00 = data[c * w * h + y0 * w + x0];
        const v01 = data[c * w * h + y0 * w + x1];
        const v10 = data[c * w * h + y1 * w + x0];
        const v11 = data[c * w * h + y1 * w + x1];
        out[c * tw * th + y * tw + x] = (v00 * wx0 + v01 * wx1) * wy0 + (v10 * wx0 + v11 * wx1) * wy1;
      }
    }
  }
  return out;
}

// 检测后处理：DB 概率图 + 4 连通域，返回轴对齐框（原图坐标）
export function detectBoxes(prob: Float32Array, detW: number, detH: number, scale: number): number[][] {
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

export function ctcDecode(logits: Float32Array, dims: number[], dictLen: number): string {
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
      // classAxis=1 → 张量布局 [1,C,T]，偏移 = c*b + t；
      // classAxis=2 → 张量布局 [1,T,C]，偏移 = t*b + c（旧实现误用 t*a+c，导致 t>0 取错位置 → 乱码）。
      const idx = classAxis === 1 ? c * b + t : t * b + c;
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
    out += DICT[charIdx];
    prev = bestC;
  }
  return out;
}

// 由 setOrt 注入的宿主在调用 runPipeline 前写入的字符表（避免在纯函数中引全局 dict 变量）。
let DICT: string[] = [];
export function setDict(d: string[]) {
  DICT = d;
}

// 完整管线：输入已解码的 ImageData，输出识别文本（按阅读顺序换行）。
export async function runPipeline(
  img: ImgData,
  ow: number,
  oh: number,
  detSession: any,
  recSession: any,
  dictArr: string[],
): Promise<string> {
  const ort = getOrt();
  // 检测：固定画布尺寸，规避 onnxruntime-web 在可变输入尺寸下触发的缓冲区复用崩溃。
  const DET_CANVAS = 1536;
  const s = DET_CANVAS / Math.max(ow, oh);
  const rw = Math.max(1, Math.round(ow * s));
  const rh = Math.max(1, Math.round(oh * s));
  const canvasImg: ImgData = { data: new Uint8Array(DET_CANVAS * DET_CANVAS * 4), width: DET_CANVAS, height: DET_CANVAS };
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
  const detCHW = toCHW(canvasImg, 'imagenet').data;
  const detInput = new ort.Tensor('float32', detCHW, [1, 3, DET_CANVAS, DET_CANVAS]);
  const detOut = await detSession.run({ [detSession.inputNames[0]]: detInput });
  const detData = detOut[detSession.outputNames[0]].data as Float32Array;
  const prob = detData;
  const mapScale = ow / rw;
  const boxes = detectBoxes(prob, DET_CANVAS, DET_CANVAS, mapScale).filter(
    ([x1, y1, x2, y2]) => x2 - x1 > 2 && y2 - y1 > 2,
  );

  if (boxes.length === 0) return '';

  // 阅读顺序：先按行（y），再按列（x）
  boxes.sort((p, q) => p[1] - q[1] || p[0] - q[0]);

  const lines: string[] = [];
  for (const [x1, y1, x2, y2] of boxes) {
    const cx1 = Math.max(0, x1);
    const cy1 = Math.max(0, y1);
    const cx2 = Math.min(ow - 1, x2);
    const cy2 = Math.min(oh - 1, y2);
    if (cx2 <= cx1 || cy2 <= cy1) continue;
    const cw = cx2 - cx1;
    const ch = cy2 - cy1;
    const crop: ImgData = { data: new Uint8Array(cw * ch * 4), width: cw, height: ch };
    for (let y = cy1; y < cy2; y++) {
      for (let x = cx1; x < cx2; x++) {
        const si = (y * ow + x) * 4;
        const di = ((y - cy1) * cw + (x - cx1)) * 4;
        crop.data[di] = img.data[si];
        crop.data[di + 1] = img.data[si + 1];
        crop.data[di + 2] = img.data[si + 2];
        crop.data[di + 3] = 255;
      }
    }
    // 识别：高度固定 48，宽度按宽高比缩放并封顶 320（PP-OCR RecResizeImg 约定，
    // 模型即按此训练；超出宽度不放开，否则脱离训练分布反而更差）。
    const recW = Math.max(48, Math.min(320, Math.round((48 * cw) / ch)));
    const recCHW = resizeCHWBilinear(toCHW(crop, 'm1'), recW, 48);
    const recInput = new ort.Tensor('float32', recCHW, [1, 3, 48, recW]);
    const recOut = await recSession.run({ [recSession.inputNames[0]]: recInput });
    const recData = recOut[recSession.outputNames[0]].data as Float32Array;
    const text = ctcDecode(recData, recOut[recSession.outputNames[0]].dims, dictArr.length);
    if (text.trim()) lines.push(text);
  }
  return lines.join('\n');
}
