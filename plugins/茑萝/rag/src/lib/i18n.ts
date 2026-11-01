// 插件侧 i18n 薄封装。
//
// 宿主在 PluginHost 挂载 `window.__HOST_I18N__`（t / translate / getLanguage / LANGUAGES），
// 语言切换由主应用 `setLanguage` 广播 `app-language-change` 事件。
// 这里**不**直接 import `plugins/_shared/pluginRuntime`：那个模块把整套媒体模块共用
// 运行时（根目录管理 / 扫描流 / 帧缓冲）一起打进 RAG 的 IIFE 产物，为几个文案不值得。
//
// 文案策略（与需求一致）：**中文为主**。
// 新 key 一律写进 `src/lib/i18n/locales/*.ts` 的 `rag.retrieve.*` 段（7 种语言齐全，
// 由 locales.test.ts 的基线卡口保证不再出现「只翻译源语言」的缺口）；
// `t()` 查不到时会回落简体中文、再回落 key 本身，所以插件在旧宿主（没有这些 key 的版本）
// 上也不会显示空白。
//
// ⚠️ 兜底表必须与 zh-CN 的那批 key **逐条同文**：宿主字典缺失时（老版本 / 沙箱被拒）
// 走的就是这里，两边不一致就会出现「同一个按钮两种说法」。
const FALLBACK_ZH: Record<string, string> = {
  'rag.retrieve.title': '检索排序',
  'rag.retrieve.modeOff': '向量排序',
  'rag.retrieve.modeOn': '重排（rerank）',
  'rag.retrieve.degraded': '已降级为向量排序',
  'rag.retrieve.enable': '启用重排',
  'rag.retrieve.candidateK': '候选数量',
  'rag.retrieve.finalK': '最终数量',
  'rag.retrieve.timeout': '超时（毫秒）',
  'rag.retrieve.mode': '端点来源',
  'rag.retrieve.modeAuto': '自动匹配重排模型',
  'rag.retrieve.modeManual': '手动填端点',
  'rag.retrieve.baseUrl': '重排端点（baseURL 或完整 /v1/rerank）',
  'rag.retrieve.apiKey': 'API Key（本地服务可留空）',
  'rag.retrieve.model': '重排模型名',
  'rag.retrieve.probe': '探测',
  'rag.retrieve.probing': '探测中…',
  'rag.retrieve.save': '保存',
  'rag.retrieve.clear': '清除',
  'rag.retrieve.probeFirst': '保存前会真实发送 2 条短文档做探测，探测不过不会启用。',
  'rag.retrieve.probeFail': '探测失败：{reason}',
  'rag.retrieve.noRerankProfile':
    '算力来源里没找到名字写着 rerank/ranker 的模型；不会拿对话模型凑数。',
  'rag.retrieve.degradedHint': '当前检索结果按向量余弦排序（未做交叉编码重排）。',
  'rag.retrieve.range': '候选 {candidate} 条 → 最终 {final} 条',
  'rag.retrieve.rerankBadge': '重排',
};

/** 取宿主注入的翻译函数（拿不到就返回 null，走本地兜底）。 */
function hostT(): ((key: string, vars?: Record<string, string | number>) => string) | null {
  try {
    const i18n = (window as unknown as {
      __HOST_I18N__?: { t?: (key: string, vars?: Record<string, string | number>) => string };
    }).__HOST_I18N__;
    return typeof i18n?.t === 'function' ? i18n.t : null;
  } catch {
    return null;
  }
}

/** `{var}` 插值（与主应用 translate 同规则）。 */
function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`,
  );
}

/**
 * 翻译一个 key。
 *
 * 宿主 `t()` 在字典缺 key 时会**原样返回 key**（`rag.retrieve.save`），那对中文用户是
 * 一串标识符而不是文案 —— 所以这里判「返回值 === key」视为没查到，改用本地中文兜底。
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const fn = hostT();
  if (fn) {
    try {
      const out = fn(key, vars);
      if (out && out !== key) return out;
    } catch (e) {
      console.warn('[rag] 宿主翻译失败，改用内置中文:', key, e);
    }
  }
  return interpolate(FALLBACK_ZH[key] ?? key, vars);
}

/** 语言变化时强制重渲染（宿主切换语言只广播事件，不会重挂插件组件）。 */
const React = (window as unknown as { __HOST_REACT__: typeof import('react') }).__HOST_REACT__;

export function useLang(): number {
  const [v, setV] = React.useState(0);
  React.useEffect(() => {
    const h = () => setV((x: number) => x + 1);
    window.addEventListener('app-language-change', h);
    return () => window.removeEventListener('app-language-change', h);
  }, []);
  return v;
}
