// 视频模块 · 网络视频平台注册表（镜像音乐模块 network music 的平台列表）
//
// 平台选择对应音乐的三系：网易云(音乐) / 酷狗(腾讯) / 汽水(字节)。
// 视频对应：哔哩哔哩(已定) + 抖音(字节,单独处理) + 腾讯视频(腾讯) + 爱奇艺(长视频)。
//
// mode 说明：
//  - 'native'  ：原生接口（搜索/取流/下载），播放走我们自己的播放器（去广告）。
//                代表：哔哩哔哩（B 站 Web API + wbi 签名，TS 端完成，Rust 代理转发）。
//  - 'webview' ：内嵌网页观看（平台 DRM/加密严重，无法原生取流），仅做"应用内浏览器"。
//                代表：腾讯视频、爱奇艺。
//  - 'special' ：特殊处理。代表：抖音（网页 + 提取视频地址，或解析分享链接）。

export type VideoPlatformMode = 'native' | 'webview' | 'special';

export interface VideoPlatform {
  id: string;
  name: string;
  home: string;
  mode: VideoPlatformMode;
  /** 强调色（亮色），用于卡片/高亮 */
  accent: string;
  /** 强调色（暗色） */
  accentDark: string;
  desc: string;
  /** 是否能下载（native 通常能；webview/special 视情况） */
  downloadable: boolean;
  /** 原生视频引擎默认开关（存设置，按平台预设；用户可在平台视图里改） */
  nativeEngineDefault?: boolean;
}

export interface OnlineVideoItem {
  id: string; // bvid / 视频 id
  title: string;
  author?: string;
  cover?: string;
  durationSecs?: number;
  /** 原生播放地址（native 模式取流后填入，交给我们的播放器） */
  url?: string;
  /** 额外字段（bvid/cid 等），供下载/二次取流使用 */
  meta?: Record<string, unknown>;
}

export const VIDEO_PLATFORMS: VideoPlatform[] = [
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    home: 'https://www.bilibili.com',
    mode: 'native',
    accent: '#fb7299',
    accentDark: '#fc9bbb',
    desc: '原生搜索 · 去广告播放 · 可下载',
    downloadable: true,
    nativeEngineDefault: true,
  },
  {
    id: 'douyin',
    name: '抖音',
    home: 'https://www.douyin.com',
    mode: 'special',
    accent: '#161823',
    accentDark: '#3a3a44',
    desc: '网页浏览 + 提取视频',
    downloadable: false,
    nativeEngineDefault: false,
  },
  {
    id: 'tencent',
    name: '腾讯视频',
    home: 'https://v.qq.com',
    mode: 'webview',
    accent: '#ff7c00',
    accentDark: '#ff9d40',
    desc: '内嵌网页观看（DRM，无法原生取流）',
    downloadable: false,
    nativeEngineDefault: false,
  },
  {
    id: 'iqiyi',
    name: '爱奇艺',
    home: 'https://www.iqiyi.com',
    mode: 'webview',
    accent: '#00be06',
    accentDark: '#3fd443',
    desc: '内嵌网页观看（DRM，无法原生取流）',
    downloadable: false,
    nativeEngineDefault: false,
  },
];

// 小写别名，兼容既有引用（与音乐模块风格保持一致，也便于在线视图统一调用）
export const videoPlatforms = VIDEO_PLATFORMS;

export function getVideoPlatform(id: string): VideoPlatform | undefined {
  return VIDEO_PLATFORMS.find((p) => p.id === id);
}

export function platformAccent(p: VideoPlatform, dark: boolean): string {
  return dark ? p.accentDark : p.accent;
}
