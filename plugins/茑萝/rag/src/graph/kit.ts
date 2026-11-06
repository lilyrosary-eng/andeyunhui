// 图谱视图的公共小块（命中图 / 全库图共用）。
//
// 为什么单开一个文件而不是各写一遍：**同一个来源在两张图里必须是同一个颜色**，
// 这是用户靠颜色认出「图上这个点就是列表里那篇」的唯一线索。
// 两边各自维护配色迟早会飘，所以取色规则只有这一份。

/** 来源配色（按 source_id 稳定取色，浅/深主题都可读）。 */
export const PALETTE = ['#d97706', '#059669', '#0284c7', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#c2410c'];

export function colorOf(sourceId: string): string {
  let h = 0;
  for (let i = 0; i < sourceId.length; i++) h = (h * 31 + sourceId.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function shortTitle(t: string, max = 14): string {
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * 视觉 px → viewBox 单位的比例。
 * `getBoundingClientRect()` 拿到的是**视觉 px**（含外层 CSS zoom），
 * 分子分母同单位，zoom 自己约掉，所以不需要再除一次缩放比。
 */
export function unitOf(rectWidth: number, W: number): number {
  return W / rectWidth;
}

/** 只声明用到的字段，避免从 react 引类型（插件侧 React 来自宿主 window.__HOST_REACT__）。 */
export interface PtrEvt {
  clientX: number;
  clientY: number;
  pointerId: number;
  currentTarget: Element;
}

/** key：节点序号（命中图里 -1 表示 query 节点）；value = 相对自动布局的手动位移 */
export type Offsets = Record<number, { x: number; y: number }>;

export interface Drag {
  key: number;
  /** 起手时的 client 坐标（视觉 px） */
  sx: number;
  sy: number;
  /** 起手时该节点已有的位移 */
  ox: number;
  oy: number;
  /** 视觉 px → viewBox 单位 */
  unit: number;
}
