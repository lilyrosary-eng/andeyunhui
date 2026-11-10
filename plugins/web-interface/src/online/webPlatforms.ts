// Web 接口 · 网络站点视图（「云」入口）的注册表
//
// 数据来自 `plugins/_shared/networkSites.ts` 的共享注册表：
//   · 内置站点：Bing / 本项目 GitHub / 本项目 Gitee；
//   · 用户可在「设置 → 茑萝 → 网络拓展」里增删（web 这一组）。
//
// 合规口径与视频 / 图片一致：**只做浏览器壳**，打开官方页面，
// 不调用未公开 API、不解析页面、不批量抓取。
import { allSites, type NetworkSite } from '@shared/networkSites';

export interface WebSite {
  id: string;
  name: string;
  /** 站点首页（也是浏览器窗口的初始地址） */
  home: string;
  accent: string;
  desc: string;
  note?: string;
}

/** 内置站点的说明文案（按 id 取；自定义站点走默认文案） */
const SITE_NOTES: Record<string, string> = {
  bing: '在独立浏览器窗口里用 Bing 搜你想搜的内容；地址栏可随时改地址。',
  github: '本项目 GitHub 仓库：Issue / Release 等都在站点内查看，不做 API 抓取。',
  gitee: '本项目 Gitee 镜像仓库：大陆访问更稳定，同样只做官方页面浏览。',
};

/** 共享注册表条目 → 本模块的站点结构 */
export function toWebSite(s: NetworkSite): WebSite {
  return {
    id: s.id,
    name: s.name,
    home: s.url,
    accent: s.accent || '#0d6efd',
    desc: s.desc || '官方页面浏览',
    note: SITE_NOTES[s.id],
  };
}

/** 当前完整站点列表（内置 + 用户自定义） */
export function getWebSites(): WebSite[] {
  return allSites('web').map(toWebSite);
}

/** 静态快照（仅用于不关心实时变更的场景；渲染请用 useNetworkSites('web')） */
export const WEB_SITES: WebSite[] = getWebSites();
