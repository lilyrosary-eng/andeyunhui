// 中转站翻译页（主站 / 浮窗）共用的语言下拉数据 + 上次选择记忆

export interface TranslateLang {
  /** 传给后端的语言描述（如「中文」「英语」），自动识别用 "auto" */
  code: string;
  /** 下拉框展示名 */
  label: string;
}

/** 目标语言列表（不含自动识别），默认中文 */
export const TARGET_LANGS: TranslateLang[] = [
  { code: '中文', label: '中文' },
  { code: '英语', label: '英语' },
  { code: '日语', label: '日语' },
  { code: '韩语', label: '韩语' },
  { code: '法语', label: '法语' },
  { code: '德语', label: '德语' },
  { code: '俄语', label: '俄语' },
  { code: '西班牙语', label: '西班牙语' },
  { code: '葡萄牙语', label: '葡萄牙语' },
  { code: '意大利语', label: '意大利语' },
  { code: '阿拉伯语', label: '阿拉伯语' },
  { code: '泰语', label: '泰语' },
  { code: '越南语', label: '越南语' },
  { code: '印尼语', label: '印尼语' },
  { code: '印地语', label: '印地语' },
];

/** 源语言列表（含「自动识别」），目标语言不该出现此选项 */
export const SOURCE_LANGS: TranslateLang[] = [
  { code: 'auto', label: '自动识别' },
  ...TARGET_LANGS,
];

export const DEFAULT_TARGET = '中文';

const KEY_SOURCE = 'ts_translate_source';
const KEY_TARGET = 'ts_translate_target';

export function loadSourceLang(): string {
  try {
    const v = localStorage.getItem(KEY_SOURCE);
    if (v && SOURCE_LANGS.some((l) => l.code === v)) return v;
  } catch {
    /* localStorage 不可用时回退 */
  }
  return 'auto';
}

export function loadTargetLang(): string {
  try {
    const v = localStorage.getItem(KEY_TARGET);
    if (v && TARGET_LANGS.some((l) => l.code === v)) return v;
  } catch {
    /* localStorage 不可用时回退 */
  }
  return DEFAULT_TARGET;
}

export function saveSourceLang(v: string): void {
  try {
    localStorage.setItem(KEY_SOURCE, v);
  } catch {
    /* 忽略持久化失败 */
  }
}

export function saveTargetLang(v: string): void {
  try {
    localStorage.setItem(KEY_TARGET, v);
  } catch {
    /* 忽略持久化失败 */
  }
}
