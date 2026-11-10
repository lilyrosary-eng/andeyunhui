// 网络图片 · 平台注册表
//
// 数据来自 `plugins/_shared/networkSites.ts` 的共享注册表（内置 5 个 + 用户自定义）。
// 用户可在「设置 → 茑萝 → 网络拓展」里为 image 这一组增删站点，抽屉与平台列表会立即刷新。
//
// 合规口径与视频模块一致：**只做浏览器壳**。
//   · 打开平台官方页面，登录 / 浏览都由站点自己完成；
//   · 不调用未公开的 API、不解析页面、不批量抓取、不绕登录与会员限制。
//
// 为什么不走 API：pixiv 未开放公开 API（官方仅对合作方提供），其条款明确禁止爬虫与
// 自动化抓取；社区第三方客户端长期处于被发函/下架状态。做「壳」是唯一稳定且低风险的路。
import { allSites, type NetworkSite } from '@shared/networkSites';

export interface ImagePlatform {
  id: string;
  name: string;
  /** 平台首页（也是浏览器窗口的初始地址） */
  home: string;
  accent: string;
  desc: string;
  note?: string;
  /** 该站点在部分网络环境需代理（pixiv 在大陆被阻断） */
  needsProxy?: boolean;
}

/** 内置平台的说明文案（按 id 取；自定义站点走默认文案） */
const PLATFORM_NOTES: Record<string, string> = {
  pixiv:
    'pixiv 没有面向第三方的公开 API，条款也禁止自动化抓取。因此这里只把官方站点装进浏览器窗口：' +
    '登录、浏览、收藏都在 pixiv 自己的页面里完成，我们不解析内容、不批量下载。',
  huaban: '花瓣网官方页面：登录、采集、浏览都在站点内完成。',
  zcool: '站酷官方页面：作品浏览与登录都在站点内完成。',
  poocg: '涂鸦王国官方页面：作品浏览与登录都在站点内完成。',
  unsplash: 'Unsplash 官方页面：免费图库浏览与下载都在站点内完成（请遵守其许可条款）。',
};

/** 共享注册表条目 → 本模块的平台结构 */
export function toImagePlatform(s: NetworkSite): ImagePlatform {
  return {
    id: s.id,
    name: s.name,
    home: s.url,
    accent: s.accent || '#6b7280',
    desc: s.desc || '官方页面浏览',
    needsProxy: s.needsProxy,
    note: PLATFORM_NOTES[s.id] || '只打开官方页面：登录与浏览都在站点内完成，我们不抓取内容。',
  };
}

/** 当前完整平台列表（内置 + 用户自定义） */
export function getImagePlatforms(): ImagePlatform[] {
  return allSites('image').map(toImagePlatform);
}

/** 静态快照（渲染请用 useNetworkSites('image')，以便用户增删后立即刷新） */
export const IMAGE_PLATFORMS: ImagePlatform[] = getImagePlatforms();

// 小写别名，与音乐/视频模块的命名习惯一致
export const imagePlatforms = IMAGE_PLATFORMS;
