// 中转站翻译页（主站 / 浮窗）共用的语言下拉数据 + 上次选择记忆
// 2026-11-04 起还承载「多节点翻译」的节点表与设置（见 Rust translate_service.rs）。

import { mergeGlossary } from './translateGlossary';

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

/**
 * 歌词翻译的目标语言 —— 和上面那颗「翻译页目标语言」是**两个键**。
 *
 * 共用引擎是对的（同一套多节点链、同一份术语表、同一份凭证），
 * 共用目标语言是错的：中转站页上次翻成法语，跟歌词要翻成什么毫无关系。
 * 2026-11-05 用户实测到的正是这个串味（预设法语 → 歌词被翻成法语）。
 * 默认中文：播放链的行内双语只认「外语在前、中文在后」。
 */
const KEY_LYRICS_TARGET = 'music_lyrics_target';
export const DEFAULT_LYRICS_TARGET = '中文';

export function loadLyricsTargetLang(): string {
  try {
    const v = localStorage.getItem(KEY_LYRICS_TARGET);
    if (v && TARGET_LANGS.some((l) => l.code === v)) return v;
  } catch {
    /* localStorage 不可用时回默认 */
  }
  return DEFAULT_LYRICS_TARGET;
}

export function saveLyricsTargetLang(v: string): void {
  try {
    localStorage.setItem(KEY_LYRICS_TARGET, v);
  } catch {
    /* 忽略持久化失败 */
  }
}

// ==================== 多节点翻译（2026-11-04）====================
//
// 节点可用性是**本机真实请求实测**的，不是看文档猜的。Rust 侧 translate_service.rs
// 模块头部有完整实测表。这里只放 UI 需要的元信息。

export interface TranslateNode {
  id: string;
  label: string;
  /** 是否需要用户填凭证（免费节点 = false） */
  needsKey: boolean;
  /** 一句话说明；不可达/需自建的节点要如实标出来，不许装作可用 */
  note: string;
}

/** 与 Rust `translate_service::NODES` 一一对应（顺序也一致：免费在前、AI 在后）。 */
export const TRANSLATE_NODES: TranslateNode[] = [
  { id: 'auto', label: '自动（按链兜底）', needsKey: false, note: '按链依次尝试，每次失败/降级都显式提示' },
  { id: 'bing', label: 'Bing 网页版 · 免费', needsKey: false, note: '免 key；实测可用，能识别源语言' },
  { id: 'mymemory', label: 'MyMemory · 免费', needsKey: false, note: '免 key；有日额度，单段上限 500 字符' },
  { id: 'ai', label: 'AI 模型', needsKey: true, note: '复用全局 AI 配置；本地 LM Studio 可不填 key' },
  { id: 'baidu', label: '百度翻译', needsKey: true, note: '官方 API（免费额度）；需 appid + 密钥，md5 签名' },
  { id: 'youdao', label: '有道翻译', needsKey: true, note: '官方 API（免费额度）；需 appKey + 密钥，sha256 签名' },
  { id: 'deepl', label: 'DeepL', needsKey: true, note: '需 auth_key；国内可能不通' },
  { id: 'libre', label: 'LibreTranslate', needsKey: false, note: '公共实例实测 403/DNS 失败，请填自建端点' },
  { id: 'google', label: 'Google gtx', needsKey: false, note: '本机实测超时，保留供网络可达时使用' },
];

/** 自动模式的默认链：免 key 排前面，没配任何 key 也能翻译，且不会偷偷花 AI 的钱。 */
export const DEFAULT_TRANSLATE_CHAIN = ['bing', 'mymemory', 'ai'];

/** 与 Rust `TranslateSettings`（serde rename_all = "camelCase"）逐字段对应。 */
export interface TranslateSettings {
  node?: string;
  chain?: string[];
  baiduAppId?: string;
  baiduSecret?: string;
  youdaoAppKey?: string;
  youdaoSecret?: string;
  deeplKey?: string;
  libreUrl?: string;
  libreKey?: string;
  profileId?: string;
  /** 术语表，每行 `原词=译法`；只对 AI 节点生效（用了别的节点会显式提示） */
  glossary?: string;
  /** 术语表开关。false = 本次不下发术语表（后端就不注入），
   *  但用户存好的表原样留在设置里，不会因为关掉而丢词条。缺省视为启用。 */
  glossaryOn?: boolean;
  cache?: boolean;
  /** 测试模式：强制单节点、绕过缓存、返回 via/stage/detail 诊断 */
  probe?: boolean;
}

/** `translate_text` 的结构化返回。notices 是**给用户看的**，不许只进日志。 */
export interface TranslateResult {
  text: string;
  node: string;
  detectedLang?: string | null;
  notices: string[];
  fromCache: boolean;
  segments: number;
  via?: string | null;
  stage?: string | null;
  detail?: string | null;
}

const KEY_SETTINGS = 'ts_translate_settings';

/** 读设置。**坏 JSON 不该让翻译链挂掉** —— 回落成「自动」。 */
export function loadTranslateSettings(): TranslateSettings {
  try {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (raw && raw.trim()) {
      const o = JSON.parse(raw) as TranslateSettings;
      if (o && typeof o === 'object') {
        return { node: typeof o.node === 'string' ? o.node : 'auto', ...o };
      }
    }
  } catch {
    /* localStorage 不可用 / JSON 坏了 → 用默认 */
  }
  return { node: 'auto' };
}

export function saveTranslateSettings(s: TranslateSettings): void {
  try {
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(s));
  } catch {
    /* 忽略持久化失败 */
  }
}

/** 本次调用要下发的设置：把「当前选中的节点」并进去，并可强制单节点测试。 */
export function translateSettingsFor(node?: string, probe = false): TranslateSettings {
  // glossaryOn 只是前端开关，不发后端（后端契约里没有这个字段）
  const { glossaryOn, ...stored } = loadTranslateSettings();
  const out: TranslateSettings = { ...stored };
  if (node !== undefined) out.node = node;
  if (probe) {
    out.probe = true;
    out.cache = false; // 测试必须真发请求，不能被缓存命中掩盖
  }
  // 关掉 = 本次不带术语表（那是「学词条」的一条路）；开着 = 手写的加上学到的整句
  if (glossaryOn === false) out.glossary = undefined;
  else out.glossary = mergeGlossary(out.glossary);
  return out;
}

/** 把后端的显式提示拼成可展示的一段文本（保持换行，不做截断）。 */
export function formatNotices(notices?: string[] | null): string {
  if (!notices?.length) return '';
  // 用 String.fromCharCode(10) 而不是 '\n'：脚本生成时反斜杠转义容易被吃掉
  return notices.map((n) => (n.startsWith('⚠️') ? n : `⚠️ ${n}`)).join(String.fromCharCode(10));
}
