// 网络书库 · 平台注册表（三色堇的「云」入口）
//
// 合规口径与视频/图片一致：**只做浏览器壳**，打开站点官方页面，
// 不抓取正文、不解析书源、不批量下载。
import { allSites, type NetworkSite } from '@shared/networkSites';

export interface BookPlatform {
  id: string;
  name: string;
  /** 站点首页（浏览器窗口的初始地址） */
  home: string;
  accent: string;
  desc: string;
  note?: string;
}

const PLATFORM_NOTES: Record<string, string> = {
  gutenberg: '古登堡计划：公共领域电子书，在线阅读与下载都在站点内完成。',
  ctext: '中国哲学书电子化计划：古籍原文与检索，均在站点内完成。',
  archive: 'Internet Archive：数字图书馆，借阅与下载规则由站点决定。',
};

export function toBookPlatform(s: NetworkSite): BookPlatform {
  return {
    id: s.id,
    name: s.name,
    home: s.url,
    accent: s.accent || '#6b7280',
    desc: s.desc || '官方页面浏览',
    note: PLATFORM_NOTES[s.id] || '只打开官方页面：登录与阅读都在站点内完成，我们不抓取内容。',
  };
}

/** 当前完整平台列表（内置 + 用户自定义） */
export function getBookPlatforms(): BookPlatform[] {
  return allSites('book').map(toBookPlatform);
}
