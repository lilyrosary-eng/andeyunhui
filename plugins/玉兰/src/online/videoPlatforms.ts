// 视频模块 · 网络视频平台注册表
//
// 数据来源：`plugins/_shared/networkSites.ts` 的共享注册表（内置 + 用户自定义）。
// 用户可在「设置 → 茑萝 → 网络拓展」里为 video 这一组增删站点，抽屉/侧栏会立即刷新。
//
// 2026-11 收敛后只剩一种模式：'url'（官方网页 + 独立浏览器窗口）。
//
// 历史：B 站曾走 'api'（wbi 签名 + playurl）。但 B 站没有面向第三方客户端的官方接口，
// 网页接口属未授权调用（社区客户端已收到律师函），已移除；抖音页面链接也需
// a_bogus 签名，纯 HTTP 不可解析。因此两个平台都改为：
//   · Rust 侧创建**独立浏览器窗口**（WebviewWindow，label = browser-<target>）；
//   · 登录、播放完全由官方站点自己完成，我们不解析、不代理视频流；
//   · 可选「嗅探」列出页面已加载的图片/视频资源，用户自行下载。
//
// ⚠️ 为什么不是「面板里嵌网页」：实机验证 Windows/WebView2 下子 webview 始终被
//    主 webview 的合成层盖住（白屏，z-order 无效），见 src-tauri/src/embedded_browser.rs。
// 注：腾讯视频 / 爱奇艺 因 DRM 且无公开接口，已从注册表移除。
import { allSites, type NetworkSite } from '@shared/networkSites';

export type VideoPlatformMode = 'api' | 'url';

export interface VideoPlatform {
  id: string;
  name: string;
  /** 平台首页（作为请求 Referer） */
  home: string;
  mode: VideoPlatformMode;
  /** 强调色（亮色），用于卡片/高亮 */
  accent: string;
  /** 强调色（暗色） */
  accentDark: string;
  desc: string;
  /** 是否能下载 */
  downloadable: boolean;
  /** 平台限制说明（'url' 模式下展示在面板里，解释为什么不能直接解析页面链接） */
  note?: string;
  /** 能力标签（侧栏 / 卡片展示） */
  capabilities?: string[];
}

export interface OnlineVideoItem {
  id: string; // bvid / aweme_id
  title: string;
  author?: string;
  cover?: string;
  durationSecs?: number;
  /** 已解析出的播放地址（交给我们的播放器） */
  url?: string;
  /**
   * 多段播放地址（如 B 站 durl 分段）。存在时按序播放/拼接，
   * 避免「长视频只能播第一段」。单段时为 undefined。
   */
  urls?: string[];
  /**
   * 播放地址要求的 Referer（防盗链）。
   * 实测 B 站/抖音 CDN 在无 Referer 或异源 Referer 时一律 403，
   * 因此播放前会经 mediaProxy 包一层本地协议由 Rust 代取。
   */
  referer?: string;
  /** 额外字段（bvid/cid/aweme_id 等），供下载 / 二次取流使用 */
  meta?: Record<string, unknown>;
}

/**
 * 内置平台的补充信息（共享注册表只存 id/name/url/accent/desc，
 * 视频特有的可下载性、暗色、限制说明留在这里，与代码一起演进）。
 */
const PLATFORM_META: Record<
  string,
  { accentDark?: string; downloadable?: boolean; note?: string; capabilities?: string[] }
> = {
  bilibili: {
    accentDark: '#fc9bbb',
    downloadable: false,
    capabilities: ['浏览器窗口', '官方页面', '登录态'],
    note:
      'B 站未向第三方客户端开放浏览/播放接口，直接调用网页接口存在授权与合规风险。' +
      '因此这里以「浏览器」方式打开官方站点：登录、播放都由 bilibili.com 自己完成，' +
      '我们不解析页面、不代理视频流。',
  },
  douyin: {
    accentDark: '#3a3a44',
    downloadable: true,
    capabilities: ['浏览器窗口', '嗅探下载'],
    note:
      '抖音的视频详情已改为客户端调用带 a_bogus 签名的接口，纯 HTTP 无法获取。' +
      '实测：分享页 window._SSR_DATA.data 为空对象、_ROUTER_DATA 仅含静态渲染配置（无 videoInfoRes/play_addr），' +
      '全部详情接口返回空响应或 403（仅能拿到反爬 Cookie __ac_nonce）。' +
      '因此「解析」可能失败；若你已有视频直链，粘贴进来即可播放或下载。',
  },
};

/** 共享注册表条目 → 本模块的平台结构 */
export function toVideoPlatform(s: NetworkSite): VideoPlatform {
  const meta = PLATFORM_META[s.id] ?? {};
  return {
    id: s.id,
    name: s.name,
    home: s.url,
    // 全部统一走「浏览器窗口 + 官方页面」，不再有 api 模式
    mode: 'url',
    accent: s.accent || '#6b7280',
    accentDark: meta.accentDark || s.accent || '#6b7280',
    desc: s.desc || '浏览器窗口 · 官方页面',
    downloadable: !!meta.downloadable,
    capabilities: meta.capabilities,
    note: meta.note,
  };
}

/** 当前完整平台列表（内置 + 用户自定义） */
export function getVideoPlatforms(): VideoPlatform[] {
  return allSites('video').map(toVideoPlatform);
}

/** 静态快照（渲染请用 useNetworkSites('video')，以便用户增删后立即刷新） */
export const VIDEO_PLATFORMS: VideoPlatform[] = getVideoPlatforms();

// 小写别名，兼容既有引用（与音乐模块风格保持一致，也便于在线视图统一调用）
export const videoPlatforms = VIDEO_PLATFORMS;

/** 支持纯 API 的平台数量（侧栏统计用） */
export function apiPlatformCount(): number {
  return VIDEO_PLATFORMS.filter((p) => p.mode === 'api').length;
}
