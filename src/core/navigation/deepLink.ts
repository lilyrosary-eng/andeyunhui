// 深度链接（deep link）：把「跨模块导航目标」写成一条既能被点、又能存进正文的 URL。
//
// 为什么是 URL 而不是事件：回链要活在笔记正文里 —— 用户明天打开这篇笔记，链接还得在。
// 事件只有活着的前端发得出来，正文里的字符串才能穿越重启。格式由宿主独占，插件一律走
// hostApi.buildDeepLink 生成，避免两侧各自拼串导致漂移。
//
// 形态：andy-nav:///<module>?e=<entity>&<prop>=<value>
//   · module 放 path，不放 host：URL 解析会把 host 强制小写，模块 id 不该受这个约束
//   · props 只能是字符串：需要数字/布尔的模块自己转（导航处理器本来就要容忍缺参与脏值）
//   · tabs 不进 URL：目前没有需要多级 tab 的回链场景，加了就是没有消费者的死代码

import { navigateTo, type NavigationTarget } from './navigation';

/** 深链协议名（带冒号，与 href 前缀比较用） */
export const DEEP_LINK_SCHEME = 'andy-nav:';
/** 实体用的保留参数名 */
const ENTITY_PARAM = 'e';

/** 拼出深链；target 不合法时抛错（调用方是代码而非用户输入，早炸比静默好） */
export function buildDeepLink(target: NavigationTarget): string {
  if (!target || typeof target.module !== 'string' || !target.module) {
    throw new Error('buildDeepLink: 需要 { module, entity?, props? }');
  }
  const params = new URLSearchParams();
  if (typeof target.entity === 'string' && target.entity) params.set(ENTITY_PARAM, target.entity);
  for (const [key, value] of Object.entries(target.props || {})) {
    // 保留名让给实体，否则同一条链接里会出现两个含义
    if (key === ENTITY_PARAM) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return `${DEEP_LINK_SCHEME}///${encodeURIComponent(target.module)}${query ? `?${query}` : ''}`;
}

function decodePart(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // 手改过的正文里出现裸 `%` 是常态，不能因此让整条链接解析抛错
    return raw;
  }
}

/** 解析 href；不是深链或读不出模块就返回 null（正文里任何字符串都可能被点） */
export function parseDeepLink(href: string | null | undefined): NavigationTarget | null {
  const trimmed = (href || '').trim();
  if (!trimmed.toLowerCase().startsWith(DEEP_LINK_SCHEME)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== DEEP_LINK_SCHEME) return null;
  const module = decodePart(url.pathname.replace(/^\/+/, ''));
  if (!module) return null;
  const target: NavigationTarget = { module };
  const entity = url.searchParams.get(ENTITY_PARAM);
  if (entity) target.entity = entity;
  const props: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key === ENTITY_PARAM) continue;
    props[key] = value;
  }
  if (Object.keys(props).length > 0) target.props = props;
  return target;
}

/** 从被点击的元素往上找最近的锚点，命中深链就给出导航目标 */
export function resolveDeepLinkFromClick(el: Element | null): NavigationTarget | null {
  const anchor = el?.closest?.('a[href]');
  if (!anchor) return null;
  // getAttribute 而非 .href：自定义协议下 .href 会被绝对化改写，属性值才是正文里写的那串
  return parseDeepLink(anchor.getAttribute('href'));
}

/**
 * 全局点击代理：命中深链就交给导航契约。
 * 必须捕获阶段 + 显式 preventDefault —— 预览区 HTML 由 dangerouslySetInnerHTML 注入，
 * 挂不了 React onClick；而渲染器给链接统一加了 target="_blank"，放过去就是开新窗口。
 * 返回注销函数（与 attachMarkdownCopyHandler 同一套用法）。
 */
export function attachDeepLinkClickHandler(): () => void {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => {};
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const target = resolveDeepLinkFromClick(e.target as Element | null);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    void navigateTo(target).then((handled) => {
      if (!handled) console.warn('[deep-link] 没有模块接收这个导航目标:', target.module);
    });
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
