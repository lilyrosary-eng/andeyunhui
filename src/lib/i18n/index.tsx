import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { zhCN } from './locales/zh-CN';
import { enUS } from './locales/en-US';
import { zhTW } from './locales/zh-TW';
import { jaJP } from './locales/ja-JP';
import { koKR } from './locales/ko-KR';
import { deDE } from './locales/de-DE';
import { frFR } from './locales/fr-FR';

export type Language = 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'ko-KR' | 'de-DE' | 'fr-FR';

/** 语言选项（顺序即设置界面展示顺序），label 用各语言本身书写，便于用户识别 */
export const LANGUAGES: { code: Language; label: string }[] = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en-US', label: 'English' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'ko-KR', label: '한국어' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'fr-FR', label: 'Français' },
];

type Dict = Record<string, string>;

const DICTS: Record<Language, Dict> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'en-US': enUS,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'de-DE': deDE,
  'fr-FR': frFR,
};

const STORAGE_KEY = 'language';
/** 语言切换事件：同一窗口内跨 Provider 实例同步 */
const LANG_EVENT = 'app-language-change';
const FALLBACK: Language = 'zh-CN';

/** 依据 localStorage / 浏览器语言推断默认语言 */
function detectDefault(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Language | null;
    if (saved && DICTS[saved]) return saved;
  } catch { /* localStorage 不可用则回退检测 */ }
  const nav = (typeof navigator !== 'undefined' ? navigator.language : '') || '';
  const low = nav.toLowerCase();
  if (low.startsWith('zh')) {
    return low.includes('tw') || low.includes('hk') || low.includes('hant') ? 'zh-TW' : 'zh-CN';
  }
  if (low.startsWith('ja')) return 'ja-JP';
  if (low.startsWith('en')) return 'en-US';
  if (low.startsWith('ko')) return 'ko-KR';
  if (low.startsWith('de')) return 'de-DE';
  if (low.startsWith('fr')) return 'fr-FR';
  return FALLBACK;
}

let currentLang: Language = detectDefault();

export function getLanguage(): Language {
  return currentLang;
}

export function setLanguage(lang: Language) {
  if (!DICTS[lang] || lang === currentLang) return;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch { /* 忽略持久化失败 */ }
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', lang);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: lang }));
  }
}

/** 底层翻译：查字典 → 回退简体中文 → 回退 key 本身，支持 {var} 插值 */
export function translate(
  lang: Language,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const dict = DICTS[lang] || DICTS[FALLBACK];
  let str = dict[key];
  if (str === undefined) str = DICTS[FALLBACK][key];
  if (str === undefined) str = key;
  if (vars) {
    str = str.replace(/\{(\w+)\}/g, (_, k: string) =>
      vars[k] !== undefined ? String(vars[k]) : `{${k}}`,
    );
  }
  return str;
}

/** 全局翻译函数（非 Hook，供 React 组件外的逻辑使用，读取当前语言） */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(currentLang, key, vars);
}

interface I18nContextType {
  lang: Language;
  setLang: (l: Language) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType>({
  lang: currentLang,
  setLang: () => {},
  t: (k, v) => t(k, v),
});

export function useI18n() {
  return useContext(I18nContext);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(currentLang);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', currentLang);
    }
    const handler = (e: Event) => {
      const next = (e as CustomEvent).detail as Language;
      if (next && DICTS[next]) setLangState(next);
    };
    window.addEventListener(LANG_EVENT, handler);
    return () => window.removeEventListener(LANG_EVENT, handler);
  }, []);

  const setLang = useCallback((l: Language) => setLanguage(l), []);
  const tt = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t: tt }}>
      {children}
    </I18nContext.Provider>
  );
}
