// 视频模块 · 网络视频平台注册表
//
// 两种模式，取决于平台是否开放可取流的接口：
//  · 'api'（哔哩哔哩）：前端调平台 API（wbi 签名在 TS 端）→ Rust 无 CORS 转发（白名单校验）→
//    播放交给我们的 VideoPlayer（去广告 + 统一控制条 + SMTC）→ 下载由 Rust 落地到本地。
//  · 'url'（抖音 / 腾讯 / 爱奇艺）：面板区作为**内嵌浏览器**（Rust 侧子 webview，
//    精确铺在面板矩形上，不是独立浮窗），视频在该平台自己的网页里播放，
//    再由「嗅探」列出页面加载的图片/视频资源供下载。
//
// ⚠️ 两种模式都**不使用 OS 浮窗**（旧方案 alwaysOnTop 的浮窗会盖住主窗 UI、
//    不跟随主窗移动、尺寸不同步 —— 已废弃）。'url' 模式用的是主窗口内的子 webview。
//
// mode 说明：
//  - 'api'：存在可用的公开接口，能原生「首页/分区/推荐 + 搜索 + 取流 + 下载」。
//           代表：哔哩哔哩（wbi 签名 + playurl + 推荐流/排行榜）。
//  - 'url'：平台页面链接受 DRM 或无签名接口保护，纯 API 拿不到播放地址；
//           因此改为**「内嵌浏览器」模式** —— 面板区就是浏览器（Rust 侧子 webview），
//           视频在该平台自己的网页里播放，再由「嗅探」列出页面加载过的
//           图片/视频资源（带缩略图与信息）供下载。
//           代表：抖音、腾讯视频、爱奇艺。
// 无论哪种模式都**不使用内嵌网页 / 浮窗**（旧方案的浮窗缺陷已移除）。

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

export const VIDEO_PLATFORMS: VideoPlatform[] = [
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    home: 'https://www.bilibili.com',
    mode: 'api',
    accent: '#fb7299',
    accentDark: '#fc9bbb',
    desc: '推荐 · 分区 · 搜索 · 去广告播放',
    downloadable: true,
    capabilities: ['推荐', '分区', '搜索', '清晰度', '下载'],
  },
  {
    id: 'douyin',
    name: '抖音',
    home: 'https://www.douyin.com',
    // ⚠️ 实测（2026-09-13）：页面链接已无法纯 HTTP 解析（详见 note），故改为网址直连模式。
    // 分享链解析实现保留在 douyinApi.ts，面板上的「解析」按钮仍会尝试（失败会给明确原因）。
    mode: 'url',
    accent: '#161823',
    accentDark: '#3a3a44',
    desc: '内嵌浏览器 · 可嗅探下载',
    downloadable: true,
    capabilities: ['浏览器', '嗅探下载'],
    note:
      '抖音的视频详情已改为客户端调用带 a_bogus 签名的接口，纯 HTTP 无法获取。' +
      '实测：分享页 window._SSR_DATA.data 为空对象、_ROUTER_DATA 仅含静态渲染配置（无 videoInfoRes/play_addr），' +
      '全部详情接口返回空响应或 403（仅能拿到反爬 Cookie __ac_nonce）。' +
      '因此「解析」可能失败；若你已有视频直链，粘贴进来即可播放或下载。',
  },
  {
    id: 'tencent',
    name: '腾讯视频',
    home: 'https://v.qq.com',
    mode: 'url',
    accent: '#ff7c00',
    accentDark: '#ff9d40',
    desc: '内嵌浏览器（DRM）',
    downloadable: true,
    capabilities: ['浏览器', '嗅探下载'],
    note:
      '腾讯视频为 DRM 加密流，播放地址与密钥均受保护，且无公开 API，纯 API 无法取流。' +
      '若你已有视频直链（.mp4 / .m3u8），粘贴进来即可播放或下载。',
  },
  {
    id: 'iqiyi',
    name: '爱奇艺',
    home: 'https://www.iqiyi.com',
    mode: 'url',
    accent: '#00be06',
    accentDark: '#3fd443',
    desc: '内嵌浏览器（DRM）',
    downloadable: true,
    capabilities: ['浏览器', '嗅探下载'],
    note:
      '爱奇艺为 DRM 加密流，播放地址与密钥均受保护，且无公开 API，纯 API 无法取流。' +
      '若你已有视频直链（.mp4 / .m3u8），粘贴进来即可播放或下载。',
  },
];

// 小写别名，兼容既有引用（与音乐模块风格保持一致，也便于在线视图统一调用）
export const videoPlatforms = VIDEO_PLATFORMS;

/** 支持纯 API 的平台数量（侧栏统计用） */
export function apiPlatformCount(): number {
  return VIDEO_PLATFORMS.filter((p) => p.mode === 'api').length;
}
