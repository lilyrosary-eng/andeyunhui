// 网络拓展注册表（视频 / 图片 / Web 接口三个模块共用）
//
// 单一事实源：
//   · 内置站点写在这里 —— 各插件的抽屉/侧栏不再各自维护一份 name/url/accent；
//   · 用户自定义站点存在 localStorage（「设置 → 茑萝 → 网络拓展」里增删）；
//   · 插件与宿主同源，共享同一份 localStorage；宿主改完派发事件，插件即时刷新。
//
// 为什么只做「只是一行网址」的模块：音乐（铃兰）走的是 API / 流媒体地址、
// 笔记（鸢尾花）走的是四个官方检索 API，它们的「源」不是站点 URL，不能共用这套模型。
//
// 为什么不落 Rust 设置：这里只是 URL 列表，localStorage 零迁移成本；
// 将来若需跨设备同步再搬到 settings.json。
//
// 安全：只允许 http/https（拒绝 file: / javascript: / data: 等），
// 因为这条链路最终会交给 WebView2 打开。

export type NetworkSiteModule = 'video' | 'image' | 'web';

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

export const NETWORK_SITES_KEY = 'andeyunhui.network.sites';
/** 设置页改完 / 插件读到变更时派发（同窗口事件，storage 事件不跨同页面） */
export const NETWORK_SITES_EVENT = 'andy:network-sites-changed';

export const NETWORK_MODULE_LABEL: Record<NetworkSiteModule, string> = {
  video: '视频（玉兰）',
  image: '图片（莲花）',
  web: 'Web 接口',
};

/** 内置站点：升级时随代码更新，用户不可删除（删除只针对自定义项） */
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
};

/** 内置站点的 id 集合（用于在 UI 上区分「内置」与「自定义」） */
export function isBuiltinSite(module: NetworkSiteModule, id: string): boolean {
  return BUILTIN_SITES[module].some((s) => s.id === id);
}

function canStore(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

/** 读取全部自定义站点（容错：坏数据当空表，不打断设置页） */
export function loadCustomSites(): CustomNetworkSite[] {
  if (!canStore()) return [];
  try {
    const raw = window.localStorage.getItem(NETWORK_SITES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x): x is CustomNetworkSite =>
        !!x && typeof x.id === 'string' && typeof x.url === 'string' && typeof x.module === 'string',
    );
  } catch {
    return [];
  }
}

function writeCustomSites(list: CustomNetworkSite[]): void {
  if (!canStore()) return;
  try {
    window.localStorage.setItem(NETWORK_SITES_KEY, JSON.stringify(list));
  } catch {
    /* 存储满/被禁用：静默失败，不阻断界面 */
  }
  try {
    window.dispatchEvent(new Event(NETWORK_SITES_EVENT));
  } catch {
    /* ignore */
  }
}

/** 某模块的自定义站点 */
export function customSites(module: NetworkSiteModule): NetworkSite[] {
  return loadCustomSites()
    .filter((s) => s.module === module)
    .map(({ id, name, url, desc, accent, needsProxy }) => ({ id, name, url, desc, accent, needsProxy }));
}

/**
 * 某模块的最终站点列表 = 内置 + 自定义。
 * 若自定义项与内置项 id 相同，则以自定义覆盖（方便用户改掉内置站的地址）。
 */
export function allSites(module: NetworkSiteModule): NetworkSite[] {
  const merged = new Map<string, NetworkSite>();
  for (const s of BUILTIN_SITES[module]) merged.set(s.id, s);
  for (const s of customSites(module)) merged.set(s.id, s);
  return [...merged.values()];
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
  const exists = loadCustomSites().some((s) => s.id === base);
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
  const list = loadCustomSites();
  const id = newSiteId(module);
  list.push({
    id,
    module,
    name: input.name.trim(),
    url,
    desc: input.desc?.trim() || '自定义站点 · 官方页面浏览',
    accent: input.accent,
    addedAt: Date.now(),
  });
  writeCustomSites(list);
  return { ok: true, id };
}

/** 删除自定义站点（内置项不可删） */
export function removeCustomSite(id: string): void {
  writeCustomSites(loadCustomSites().filter((s) => s.id !== id));
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
