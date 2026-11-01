// 压感响应曲线：把 0–1 的压力映射成 0–1 的笔宽系数。
// 两种等价表达：gamma 指数（快调）与三次贝塞尔控制点（可拖拽精调）。
export type Bezier4 = [number, number, number, number];

export const CURVE_PRESETS: Array<{ name: string; value: Bezier4 | null }> = [
  { name: '线性', value: null },
  { name: '轻压', value: [0.2, 0.75, 0.45, 1] },
  { name: '缓起', value: [0.3, 0.05, 0.55, 0.45] },
  { name: '重压', value: [0.55, 0, 0.8, 0.35] },
  { name: 'S 形', value: [0.35, 0, 0.65, 1] },
];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 单位贝塞尔（P0=0、P3=1）单分量求值 */
function component(a: number, b: number, u: number): number {
  const inv = 1 - u;
  return 3 * inv * inv * u * a + 3 * inv * u * u * b + u * u * u;
}

/**
 * 以压力 t 为自变量求曲线值：先解 x(u)=t 得 u，再取 y(u)。
 * 控制点 x 分量夹在 0–1 保证单调，二分 24 次足够到亚像素精度。
 */
export function sampleBezier(p: Bezier4, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let lo = 0;
  let hi = 1;
  let u = t;
  for (let i = 0; i < 24; i++) {
    u = (lo + hi) / 2;
    if (component(p[0], p[2], u) < t) lo = u;
    else hi = u;
  }
  return clamp01(component(p[1], p[3], u));
}

export function normalizeBezier(v: unknown): Bezier4 | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const n = v.map((x) => Number(x));
  if (n.some((x) => !Number.isFinite(x))) return null;
  return [clamp01(n[0]), clamp01(n[1]), clamp01(n[2]), clamp01(n[3])];
}
