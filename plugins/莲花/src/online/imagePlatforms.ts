// 网络图片 · 平台注册表
//
// 合规口径与视频模块一致：**只做浏览器壳**。
//   · 打开平台官方页面，登录 / 浏览 / 播放都由站点自己完成；
//   · 不调用未公开的 API、不解析页面、不批量抓取、不绕登录与会员限制。
//
// 为什么不走 API：pixiv 未开放公开 API（官方仅对合作方提供），其条款明确禁止爬虫与
// 自动化抓取；社区第三方客户端长期处于被发函/下架状态。做「壳」是唯一稳定且低风险的路。

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

export const IMAGE_PLATFORMS: ImagePlatform[] = [
  {
    id: 'pixiv',
    name: 'pixiv',
    home: 'https://www.pixiv.net',
    accent: '#0096fa',
    desc: '插画社区 · 官方页面浏览',
    needsProxy: true,
    note:
      'pixiv 没有面向第三方的公开 API，条款也禁止自动化抓取。因此这里只把官方站点装进浏览器窗口：' +
      '登录、浏览、收藏都在 pixiv 自己的页面里完成，我们不解析内容、不批量下载。',
  },
];

// 小写别名，与音乐/视频模块的命名习惯一致
export const imagePlatforms = IMAGE_PLATFORMS;
