// 阅读排版设置（字号 / 行距）。
//
// 为什么单独一个文件：ReadingView 与设置面板都要读写，放组件里会形成循环依赖；
// 走 localStorage 而不是改书文件，保证「不触碰用户书籍目录」这条既有约束
// （见 readingHighlights.ts 顶部说明）。
//
// 取值范围：字号 13–28px（小于 13 中文已难辨，大于 28 分栏一行放不下几个字）；
// 行距 1.4–2.6（低于 1.4 行会挤在一起，高于 2.6 一页装不下多少内容）。

export interface ReadingSettings {
  fontSize: number;
  lineHeight: number;
}

export const READING_FONT_MIN = 13;
export const READING_FONT_MAX = 28;
export const READING_LINE_MIN = 1.4;
export const READING_LINE_MAX = 2.6;
export const DEFAULT_READING_SETTINGS: ReadingSettings = { fontSize: 17, lineHeight: 1.85 };

const KEY = 'reading_plugin_settings';

const clamp = (v: number, lo: number, hi: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** 读设置（损坏/手改越界都会收敛回安全区间）。 */
export function getReadingSettings(): ReadingSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_READING_SETTINGS };
    const o = JSON.parse(raw) as Partial<ReadingSettings>;
    return {
      fontSize: clamp(Number(o?.fontSize), READING_FONT_MIN, READING_FONT_MAX, DEFAULT_READING_SETTINGS.fontSize),
      lineHeight: clamp(Number(o?.lineHeight), READING_LINE_MIN, READING_LINE_MAX, DEFAULT_READING_SETTINGS.lineHeight),
    };
  } catch {
    return { ...DEFAULT_READING_SETTINGS };
  }
}

/** 写设置（部分更新），返回收敛后的完整设置。 */
export function setReadingSettings(patch: Partial<ReadingSettings>): ReadingSettings {
  const next = { ...getReadingSettings(), ...patch };
  next.fontSize = clamp(next.fontSize, READING_FONT_MIN, READING_FONT_MAX, DEFAULT_READING_SETTINGS.fontSize);
  next.lineHeight = clamp(next.lineHeight, READING_LINE_MIN, READING_LINE_MAX, DEFAULT_READING_SETTINGS.lineHeight);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 配额满/隐私模式下静默：本次仍按内存值生效 */
  }
  return next;
}
