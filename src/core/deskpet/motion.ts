// 桌宠运动学纯函数：朝向解析 / 多角度选帧 / 日落近似。
// 原嵌于 DeskpetPet.tsx（组件文件顶层有 window 访问，纯函数无法直接测），
// 抽出后逻辑零依赖，可在任意环境单测。

// 由文件名推断该待机图朝向（屏幕坐标 y 向下）：正脸 / 左 / 左上 / 右上 / 右下 / 左下…
// 用于「鼠标方位 → 多角度待机图」的帧选择（与 got-it/桌宠 的多角度素材命名约定一致）。
export function dirVectorOf(name: string): { x: number; y: number } | null {
  const n = name.toLowerCase();
  const hasLeft = n.includes("left") || n.includes("左");
  const hasRight = n.includes("right") || n.includes("右");
  const hasUp = n.includes("up") || n.includes("上");
  const hasDown = n.includes("down") || n.includes("下");
  const hasFront = n.includes("face") || n.includes("front") || n.includes("正脸") || n.includes("正面") || n.includes("前");
  if (hasFront && !hasLeft && !hasRight && !hasUp && !hasDown) return { x: 0, y: 0 };
  const x = (hasRight ? 1 : 0) - (hasLeft ? 1 : 0);
  const y = (hasDown ? 1 : 0) - (hasUp ? 1 : 0);
  if (x === 0 && y === 0) return null; // 无方向信息的图（如单一 idle），按普通图处理
  return { x, y };
}

// 根据鼠标相对宠物中心的向量，挑出最匹配朝向的待机图序号。
// 用「角度最近匹配」而非点积最大：纯上方向时光标 (0,-1) 与 idleup/leftup/rightup 三点积都为 1（并列），
// 点积法取「数组首个」会取到对角帧 → 纯上下左右不转向。角度法取与光标方向夹角最小的帧，根治该问题。
export function pickAngleFrame(imgs: { file: string; rel: string }[], dx: number, dy: number): number {
  const dirs = imgs.map((a, i) => ({ i, v: dirVectorOf(a.file || a.rel) }));
  const front = dirs.find((d) => d.v && d.v.x === 0 && d.v.y === 0);
  const len = Math.hypot(dx, dy);
  if (len < 18) return front ? front.i : 0; // 鼠标贴近中心 → 正脸
  const target = Math.atan2(dy, dx); // 光标方向角
  let best = -1;
  let bestDiff = Infinity;
  for (const d of dirs) {
    if (!d.v || (d.v.x === 0 && d.v.y === 0)) continue; // 跳过正脸
    const ang = Math.atan2(d.v.y, d.v.x); // 该帧朝向角
    let diff = Math.abs(target - ang);
    if (diff > Math.PI) diff = 2 * Math.PI - diff; // 取最小夹角
    if (diff < bestDiff) {
      bestDiff = diff;
      best = d.i;
    }
  }
  if (best < 0) return front ? front.i : 0;
  return best;
}

// 当地日落时间（近似，单位：小时，浮点）。无需联网/定位：用系统时区推算标准经线与
// 默认纬度，按简化天文公式（太阳赤纬 + 时差方程）估算。误差来自「用标准经线代替真实经度」，
// 在时区中部地区约 ±30 分钟，足够「天黑后播放 sleep」这种语义使用。
const DEFAULT_SUNSET_LAT = 30; // 默认纬度（北半球近似，可按需调整）
export function getSunsetHours(date: Date): number {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const tz = -date.getTimezoneOffset() / 60; // 时区偏移（小时，如 +8）
  const lng = tz * 15; // 标准经线（东经为正）
  const start = new Date(date.getFullYear(), 0, 0);
  const N = Math.floor((date.getTime() - start.getTime()) / 86400000);
  const B = (2 * Math.PI / 365) * (N - 81);
  const eqtime = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // 分钟
  const decl = 23.44 * Math.sin(B); // 度
  const ha = Math.acos(-Math.tan(DEFAULT_SUNSET_LAT * rad) * Math.tan(decl * rad)) * deg; // 度
  const noon = 12 + tz - lng / 15 - eqtime / 60; // 当地正午（时钟时）
  return noon + ha / 15;
}