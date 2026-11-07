import { invoke } from '@tauri-apps/api/core';

/**
 * 笔记模块「网络」的源定义与调用封装。
 *
 * 合规章节（与 Rust 端 `services/note_sources.rs` 对齐）：
 * - 只调用站点**公开文档化的开放接口**，不解析网页、不抓正文、不绕登录/付费墙；
 * - 源是编译期固定的四个适配器，不提供「自定义源 / 源市场 / 订阅」；
 * - 「收藏为笔记」只保存标题、摘要与原文链接（属引用），不复制全文。
 */

export type NoteSourceId = 'arxiv' | 'huggingface' | 'github' | 'semantic';

export interface NoteSourceDef {
  id: NoteSourceId;
  name: string;
  /** 站点首页，仅用于说明，不参与请求 */
  home: string;
  desc: string;
  accent: string;
}

export const NOTE_SOURCES: NoteSourceDef[] = [
  {
    id: 'arxiv',
    name: 'arXiv',
    home: 'https://arxiv.org',
    desc: '预印本论文（官方 Atom 接口，间隔 ≥3 秒）',
    accent: '#b31b1b',
  },
  {
    id: 'huggingface',
    name: 'HuggingFace',
    home: 'https://huggingface.co',
    desc: '模型仓库（官方 models API）',
    accent: '#ffb400',
  },
  {
    id: 'github',
    name: 'GitHub',
    home: 'https://github.com',
    desc: '开源仓库（官方 search API，匿名 60 次/小时）',
    accent: '#24292f',
  },
  {
    id: 'semantic',
    name: 'Semantic Scholar',
    home: 'https://www.semanticscholar.org',
    desc: '论文元数据与引用数（官方 Graph API，约 1 次/秒）',
    accent: '#1857b6',
  },
];

export interface NoteWebResult {
  /** 源内唯一标识（arXiv 编号 / repo 全名 / paperId） */
  id: string;
  title: string;
  summary: string;
  url: string;
  authors: string;
  date: string;
  /** 一句话附加信息（星标、下载量、引用数、venue 等） */
  meta: string;
}

/** 按源搜索。失败时 Rust 会返回可读的中文原因，这里原样抛给调用方展示。 */
export async function searchNoteSource(
  source: NoteSourceId,
  query: string,
  limit = 12,
): Promise<NoteWebResult[]> {
  return invoke<NoteWebResult[]>('note_web_search', { source, query, limit });
}

/** 把一条检索结果转成 Markdown 笔记内容（标题行 + 引用信息 + 摘要）。 */
export function toNoteMarkdown(item: NoteWebResult, sourceName: string): string {
  const lines: string[] = [`# ${item.title}`, ''];
  const facts: string[] = [`- 来源：${sourceName}`];
  if (item.authors) facts.push(`- 作者：${item.authors}`);
  if (item.date) facts.push(`- 日期：${item.date}`);
  if (item.meta) facts.push(`- 信息：${item.meta}`);
  facts.push(`- 原文：${item.url}`);
  lines.push(...facts);
  if (item.summary) {
    lines.push('', '## 摘要', '', item.summary);
  }
  return lines.join('\n');
}
