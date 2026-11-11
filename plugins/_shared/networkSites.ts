// 网络拓展注册表（视频 / 图片 / Web 接口 / 阅读 / 笔记 / 音乐共用）
//
// 单一事实源：
//   · 内置站点写在这里 —— 各插件的抽屉/侧栏不再各自维护一份 name/url/accent；
//   · 用户的自定义站点、对内置站的改名/换址、隐藏内置站、组内顺序都存 localStorage
//     （「设置 → 茑萝 → 网络拓展」里管理）；
//   · 插件与宿主同源，共享同一份 localStorage；宿主改完派发事件，插件即时刷新。
//
// 抽屉分组（用户视角，组与组互不影响）：
//   · video / image / web / book：本地 + 网络（内置 + 自定义在同一个列表里，顺序即这里存的那份）；
//   · note / music：本地 + 网络（API 源，代码里固定、不写入本表）+ 自定义网站（只有用户添加的网址）。
//     API 源不是「站点」，所以不展示、不可编辑；自定义网站独立成组，
//     它的顺序只作用于该组，不会影响内置站或 API 源。
//
// 为什么不落 Rust 设置：这里只是 URL 列表，localStorage 零迁移成本；
// 将来若需跨设备同步再搬到 settings.json。
//
// 安全：只允许 http/https（拒绝 file: / javascript: / data: 等），
// 因为这条链路最终会交给 WebView2 打开。

export type NetworkSiteModule = 'video' | 'image' | 'web' | 'book' | 'note' | 'music';

export interface NetworkSite {
  id: string;
  name: string;
  /** 站点地址（浏览器窗口的初始页） */
  url: string;
  desc?: string;
  accent?: string;
  /** 该站点在部分网络环境需要代理（如 pixiv） */
  needsProxy?: boolean;
}

/** 用户新增的站点：多带归属模块与创建时间 */
export interface CustomNetworkSite extends NetworkSite {
  module: NetworkSiteModule;
  addedAt: number;
}

/** 内置站点可被用户改写的字段（只存改动，恢复时直接删掉覆盖即可） */
export type NetworkSiteOverride = Partial<Pick<NetworkSite, 'name' | 'url' | 'desc' | 'accent'>>;

/**
 * 持久化结构（v2）。
 *
 * 旧版本只存「自定义站点数组」；读取时自动迁移，写回时一律写 v2 对象。
 * `overrides` / `removed` 的 key 用 `${module}:${id}`，避免不同模块同名 id 互相影响。
 */
export interface NetworkSitesState {
  version: 2;
  custom: CustomNetworkSite[];
  overrides: Record<string, NetworkSiteOverride>;
  removed: string[];
  /** 各模块「网络（或自定义）」组内的顺序；没有列到的 id 按默认顺序追加到末尾 */
  order: Partial<Record<NetworkSiteModule, string[]>>;
}

export const NETWORK_SITES_KEY = 'andeyunhui.network.sites';
/** 设置页改完 / 插件读到变更时派发（同窗口事件，storage 事件不跨同页面） */
export const NETWORK_SITES_EVENT = 'andy:network-sites-changed';

export const NETWORK_MODULE_LABEL: Record<NetworkSiteModule, string> = {
  video: '视频（玉兰）',
  image: '图片（莲花）',
  web: 'Web 接口（牵牛花）',
  book: '阅读（三色堇）',
  note: '笔记（鸢尾花）',
  music: '音乐（铃兰）',
};

/**
 * 只做「自定义网站」的模块：抽屉里网络组是固定的 API 源（笔记检索 / 音乐在线源），
 * 不能增删改；用户加的网址单独一组，所以这里没有内置站点。
 */
export const CUSTOM_ONLY_MODULES: NetworkSiteModule[] = ['note', 'music'];

/** 内置站点：升级时随代码更新；用户可改字段或隐藏（见 overrides / removed） */
export const BUILTIN_SITES: Record<NetworkSiteModule, NetworkSite[]> = {
  video: [
    {
      id: 'bilibili',
      name: '哔哩哔哩',
      url: 'https://www.bilibili.com',
      accent: '#fb7299',
      desc: '浏览器窗口 · 官方页面播放',
    },
    {
      id: 'douyin',
      name: '抖音',
      url: 'https://www.douyin.com',
      accent: '#161823',
      desc: '浏览器窗口 · 可嗅探下载',
    },
  ],
  image: [
    {
      id: 'pixiv',
      name: 'pixiv',
      url: 'https://www.pixiv.net',
      accent: '#0096fa',
      desc: '插画社区 · 官方页面浏览',
      needsProxy: true,
    },
    {
      id: 'huaban',
      name: '花瓣',
      url: 'https://huaban.com',
      accent: '#e94a4a',
      desc: '设计灵感采集 · 官方页面浏览',
    },
    {
      id: 'zcool',
      name: '站酷',
      url: 'https://www.zcool.com.cn',
      accent: '#e6a700',
      desc: '设计师作品社区 · 官方页面浏览',
    },
    {
      id: 'poocg',
      name: '涂鸦王国',
      url: 'https://www.poocg.cn',
      accent: '#6d4aff',
      desc: '插画作品社区 · 官方页面浏览',
    },
    {
      id: 'unsplash',
      name: 'Unsplash',
      url: 'https://unsplash.com',
      accent: '#111111',
      desc: '免费高质量图库 · 官方页面浏览',
    },
  ],
  web: [
    {
      id: 'bing',
      name: 'Bing',
      url: 'https://www.bing.com',
      accent: '#0d6efd',
      desc: '搜索任意网页 · 官方页面浏览',
    },
    {
      id: 'github',
      name: 'GitHub',
      url: 'https://github.com/lilyrosary-eng/andeyunhui',
      accent: '#24292f',
      desc: '本项目仓库 · 官方页面浏览',
    },
    {
      id: 'gitee',
      name: 'Gitee',
      url: 'https://gitee.com/lilyrosary/andeyunhui',
      accent: '#c71d23',
      desc: '本项目镜像仓库 · 官方页面浏览',
    },
  ],
  // 阅读：只做「官网浏览」，不抓全文、不做书源解析
  book: [
    {
      id: 'gutenberg',
      name: '古登堡计划',
      url: 'https://www.gutenberg.org',
      accent: '#6b4f2a',
      desc: '公共领域电子书 · 官方页面浏览',
    },
    {
      id: 'ctext',
      name: '中国哲学书电子化计划',
      url: 'https://ctext.org/zhs',
      accent: '#8b1e1e',
      desc: '古籍全文检索 · 官方页面浏览',
    },
    {
      id: 'archive',
      name: 'Internet Archive',
      url: 'https://archive.org',
      accent: '#1f4e79',
      desc: '数字图书馆 · 官方页面浏览',
    },
  ],
  // 笔记：抽屉里网络组是四个检索 API（不可编辑、不在设置里展示），这里没有内置站点
  note: [],
  // 音乐：抽屉里网络组是在线音乐源（不可编辑、不在设置里展示），这里没有内置站点
  music: [],
};

/** 内置站点的 id 集合（用于在 UI 上区分「内置」与「自定义」） */
export function isBuiltinSite(module: NetworkSiteModule, id: string): boolean {
  return BUILTIN_SITES[module].some((s) => s.id === id);
}

function canStore(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function siteKey(module: NetworkSiteModule, id: string): string {
  return `${module}:${id}`;
}

function emptyState(): NetworkSitesState {
  return { version: 2, custom: [], overrides: {}, removed: [], order: {} };
}

function sanitizeCustom(raw: unknown): CustomNetworkSite[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is CustomNetworkSite =>
      !!x &&
      typeof x.id === 'string' &&
      typeof x.url === 'string' &&
      typeof x.module === 'string' &&
      (x.module as string) in BUILTIN_SITES,
  );
}

function sanitizeOverrides(raw: unknown): Record<string, NetworkSiteOverride> {
  const out: Record<string, NetworkSiteOverride> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const src = v as Record<string, unknown>;
    const patch: NetworkSiteOverride = {};
    if (typeof src.name === 'string') patch.name = src.name;
    if (typeof src.url === 'string') patch.url = src.url;
    if (typeof src.desc === 'string') patch.desc = src.desc;
    if (typeof src.accent === 'string') patch.accent = src.accent;
    out[k] = patch;
  }
  return out;
}

function sanitizeOrder(raw: unknown): Partial<Record<NetworkSiteModule, string[]>> {
  const out: Partial<Record<NetworkSiteModule, string[]>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [m, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(m in BUILTIN_SITES) || !Array.isArray(v)) continue;
    out[m as NetworkSiteModule] = v.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

/**
 * 读取完整状态。容错：坏数据当空表，不打断设置页。
 * 旧格式（纯自定义数组）自动迁移为 v2。
 */
export function loadNetworkSitesState(): NetworkSitesState {
  if (!canStore()) return emptyState();
  try {
    const raw = window.localStorage.getItem(NETWORK_SITES_KEY);
    if (!raw) return emptyState();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { ...emptyState(), custom: sanitizeCustom(parsed) };
    }
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const src = parsed as Record<string, unknown>;
    return {
      version: 2,
      custom: sanitizeCustom(src.custom),
      overrides: sanitizeOverrides(src.overrides),
      removed: Array.isArray(src.removed)
        ? src.removed.filter((x): x is string => typeof x === 'string')
        : [],
      order: sanitizeOrder(src.order),
    };
  } catch {
    return emptyState();
  }
}

function writeState(state: NetworkSitesState): void {
  if (!canStore()) return;
  try {
    window.localStorage.setItem(NETWORK_SITES_KEY, JSON.stringify(state));
  } catch {
    /* 存储满/被禁用：静默失败，不阻断界面 */
  }
  try {
    window.dispatchEvent(new Event(NETWORK_SITES_EVENT));
  } catch {
    /* ignore */
  }
}

/** 读取全部自定义站点（兼容旧调用方） */
export function loadCustomSites(): CustomNetworkSite[] {
  return loadNetworkSitesState().custom;
}

/** 某模块的自定义站点 */
export function customSites(module: NetworkSiteModule): NetworkSite[] {
  return loadNetworkSitesState()
    .custom.filter((s) => s.module === module)
    .map(({ id, name, url, desc, accent, needsProxy }) => ({ id, name, url, desc, accent, needsProxy }));
}

/** 被用户隐藏的内置站点（设置页用来提供「恢复」入口） */
export function hiddenBuiltinSites(module: NetworkSiteModule): NetworkSite[] {
  const state = loadNetworkSitesState();
  return BUILTIN_SITES[module].filter((s) => state.removed.includes(siteKey(module, s.id)));
}

/**
 * 某模块的最终站点列表：
 *   · 内置站点应用用户改写（overrides），剔除已隐藏的（removed）；
 *   · 追加自定义站点；
 *   · 按用户顺序（order）排序，未列出的 id 保持默认顺序追加到末尾。
 */
export function allSites(module: NetworkSiteModule): NetworkSite[] {
  const state = loadNetworkSitesState();
  const merged = new Map<string, NetworkSite>();

  for (const s of BUILTIN_SITES[module]) {
    const key = siteKey(module, s.id);
    if (state.removed.includes(key)) continue;
    const patch = state.overrides[key];
    merged.set(s.id, patch ? { ...s, ...patch } : s);
  }
  for (const s of state.custom) {
    if (s.module !== module) continue;
    const { id, name, url, desc, accent, needsProxy } = s;
    merged.set(s.id, { id, name, url, desc, accent, needsProxy });
  }

  const list = [...merged.values()];
  const order = state.order[module];
  if (!order || order.length === 0) return list;

  const rank = new Map(order.map((id, i) => [id, i] as const));
  // sort 在现代引擎里是稳定排序：未列出的项保持「内置在前、自定义在后」的相对顺序
  return list.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

/** 规范化用户输入的网址：只接受 http/https，缺协议补 https://；非法返回 null */
export function normalizeSiteUrl(raw: string): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const withProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 校验新增/编辑站点的入参，返回可读的中文错误；null = 通过 */
export function validateSiteInput(input: {
  name?: string;
  url?: string;
  module?: string;
}): string | null {
  if (!input.module || !(input.module in BUILTIN_SITES)) return '请选择所属模块';
  if (!input.name || !input.name.trim()) return '请填写名称';
  const url = normalizeSiteUrl(input.url ?? '');
  if (!url) return '网址需为 http/https 地址（例：https://example.com）';
  return null;
}

let customSeq = 0;
function newSiteId(module: NetworkSiteModule): string {
  customSeq += 1;
  const base = `u-${module}-${Date.now().toString(36)}${customSeq.toString(36)}`;
  const exists = loadNetworkSitesState().custom.some((s) => s.id === base);
  return exists ? `${base}-${Math.random().toString(36).slice(2, 6)}` : base;
}

/** 新增自定义站点；返回本次写入的 id，失败返回错误串 */
export function addCustomSite(
  module: NetworkSiteModule,
  input: { name: string; url: string; desc?: string; accent?: string },
): { ok: true; id: string } | { ok: false; error: string } {
  const err = validateSiteInput({ name: input.name, url: input.url, module });
  if (err) return { ok: false, error: err };
  const url = normalizeSiteUrl(input.url)!;
  const state = loadNetworkSitesState();
  const id = newSiteId(module);
  state.custom.push({
    id,
    module,
    name: input.name.trim(),
    url,
    desc: input.desc?.trim() || '自定义站点 · 官方页面浏览',
    accent: input.accent,
    addedAt: Date.now(),
  });
  // 顺序表存的是「当前组内全部 id」：新项追加到末尾，已有排序不受影响
  state.order[module] = [...allSites(module).map((s) => s.id), id];
  writeState(state);
  return { ok: true, id };
}

/**
 * 编辑站点（内置 / 自定义都走这里）。
 * 内置站点把改动写进 overrides，不动代码里的默认值；自定义站点直接改自身记录。
 */
export function updateSite(
  module: NetworkSiteModule,
  id: string,
  patch: { name?: string; url?: string; desc?: string },
): { ok: true } | { ok: false; error: string } {
  const state = loadNetworkSitesState();
  const builtin = BUILTIN_SITES[module].find((s) => s.id === id);
  const customIdx = state.custom.findIndex((s) => s.id === id && s.module === module);
  if (!builtin && customIdx < 0) return { ok: false, error: '站点不存在' };

  const name = (patch.name ?? '').trim();
  if (!name) return { ok: false, error: '请填写名称' };
  const url = normalizeSiteUrl(patch.url ?? '');
  if (!url) return { ok: false, error: '网址需为 http/https 地址（例：https://example.com）' };
  const desc = patch.desc?.trim();

  if (builtin) {
    // 存空串而不是 undefined：JSON 会丢掉 undefined，导致「清空说明」在重启后失效
    state.overrides[siteKey(module, id)] = { name, url, desc: desc ?? '' };
  } else {
    const cur = state.custom[customIdx];
    state.custom[customIdx] = {
      ...cur,
      name,
      url,
      desc: desc || '自定义站点 · 官方页面浏览',
    };
  }
  writeState(state);
  return { ok: true };
}

/**
 * 删除站点：自定义项直接移除；内置项只做「隐藏」（写 removed），
 * 这样升级后仍能恢复，也不会因为删代码里的常量影响其它模块。
 */
export function removeSite(module: NetworkSiteModule, id: string): void {
  const state = loadNetworkSitesState();
  if (BUILTIN_SITES[module].some((s) => s.id === id)) {
    const key = siteKey(module, id);
    if (!state.removed.includes(key)) state.removed.push(key);
    // 隐藏后恢复应回到默认值，所以顺手丢掉改写
    delete state.overrides[key];
  } else {
    state.custom = state.custom.filter((s) => !(s.id === id && s.module === module));
  }
  const order = state.order[module];
  if (order) state.order[module] = order.filter((x) => x !== id);
  writeState(state);
}

/** 恢复被隐藏的内置站点，并插回它在内置清单里的默认位置附近 */
export function restoreBuiltinSite(module: NetworkSiteModule, id: string): void {
  const state = loadNetworkSitesState();
  const key = siteKey(module, id);
  state.removed = state.removed.filter((x) => x !== key);
  delete state.overrides[key];

  const builtin = BUILTIN_SITES[module];
  const defaultIdx = builtin.findIndex((s) => s.id === id);
  const ids = allSites(module).map((s) => s.id);
  let insertAt = ids.length;
  for (let i = defaultIdx + 1; i < builtin.length; i += 1) {
    const pos = ids.indexOf(builtin[i].id);
    if (pos >= 0) {
      insertAt = pos;
      break;
    }
  }
  ids.splice(insertAt, 0, id);
  state.order[module] = ids;
  writeState(state);
}

/** 在所属组内上移/下移一个站点（只在当前模块的列表里交换，不影响其它分组） */
export function moveSite(
  module: NetworkSiteModule,
  id: string,
  direction: 'up' | 'down',
): void {
  const ids = allSites(module).map((s) => s.id);
  const i = ids.indexOf(id);
  const j = i + (direction === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const state = loadNetworkSitesState();
  state.order[module] = ids;
  writeState(state);
}

/** 订阅变更（返回取消函数）；同窗口用自定义事件，跨窗口用 storage 事件 */
export function onNetworkSitesChange(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(NETWORK_SITES_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(NETWORK_SITES_EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}
