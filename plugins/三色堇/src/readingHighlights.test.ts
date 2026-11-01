// readingHighlights 纯逻辑单测（hash / 分片 CRUD / quote 漂移校验 / Markdown 幂等导出）。
// 运行环境：vitest node（无 localStorage → 模块自动回退内存存储，测试互不污染前用 __resetMemoryStorageForTests 清空）。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetMemoryStorageForTests,
  addHighlight,
  addHighlights,
  buildChapterIndexMap,
  buildReadingNoteMarkdown,
  deleteHighlight,
  findQuotePosition,
  hashBookPath,
  listHighlights,
  noteIdForBook,
  shardKeyFor,
  updateHighlight,
  validateHighlightAgainstText,
  type HighlightRecord,
  type NewHighlight,
} from './readingHighlights';

const BOOK = 'D:/Books/三体.txt';
const BOOK_ALT = 'd:\\books\\三体.txt\\'; // 同一本书：大小写/斜杠/尾斜杠不同

function makeInput(over: Partial<NewHighlight> = {}): NewHighlight {
  return {
    chapterId: 'ch-1',
    chapterIndex: 0,
    start: 3,
    end: 7,
    quote: '弱小',
    prefix: '这是人类的',
    suffix: '，但',
    color: 'yellow',
    note: '',
    ...over,
  };
}

describe('书路径 hash 与分片 key', () => {
  it('同一路径的不同写法（大小写/反斜杠/尾斜杠）hash 相同', () => {
    expect(hashBookPath(BOOK)).toBe(hashBookPath(BOOK_ALT));
    expect(shardKeyFor(BOOK)).toBe(shardKeyFor(BOOK_ALT));
  });

  it('不同书籍 hash / 分片 key / noteId 互不相同，noteId 为 reading- + 稳定 hash', () => {
    const other = 'D:/Books/活着.txt';
    expect(hashBookPath(BOOK)).not.toBe(hashBookPath(other));
    expect(shardKeyFor(BOOK)).not.toBe(shardKeyFor(other));
    expect(noteIdForBook(BOOK)).toBe(`reading-${hashBookPath(BOOK)}`);
    expect(noteIdForBook(BOOK)).toBe(noteIdForBook(BOOK_ALT));
    // safe_join 友好：不含 / \ .. 与控制字符
    expect(noteIdForBook(BOOK)).toMatch(/^reading-[0-9a-f]{1,8}$/);
  });
});

describe('分片 CRUD 与按章索引', () => {
  beforeEach(() => __resetMemoryStorageForTests());

  it('add/update/delete 作用于正确的分片并按 章序+偏移 排序', () => {
    const a = addHighlight(BOOK, makeInput({ start: 10, end: 14, quote: '不要回答' }));
    const b = addHighlight(BOOK, makeInput({ chapterId: 'ch-2', chapterIndex: 1, start: 0, end: 2, quote: '给岁月' }));
    const c = addHighlight(BOOK, makeInput({ start: 0, end: 3, quote: '大自然' }));
    // 另一本书写入不同分片，互不可见
    addHighlight('D:/Books/别的书.txt', makeInput({ quote: '他书' }));

    const all = listHighlights(BOOK);
    expect(all.map((h) => h.id)).toEqual([c.id, a.id, b.id]); // 章0内按 start，然后章1
    expect(all.every((h) => h.createdAt > 0)).toBe(true);

    const upd = updateHighlight(BOOK, a.id, { note: '批注内容', color: 'green' });
    expect(upd?.note).toBe('批注内容');
    expect(upd?.color).toBe('green');

    expect(deleteHighlight(BOOK, c.id)).toBe(true);
    expect(deleteHighlight(BOOK, c.id)).toBe(false);
    expect(listHighlights(BOOK).map((h) => h.id)).toEqual([a.id, b.id]);
  });

  it('buildChapterIndexMap 以 chapterId 为主锚分组，无 id 时兜底 idx:chapterIndex', () => {
    const recs = addHighlights(BOOK, [
      makeInput({ chapterId: 'ch-1', start: 5, end: 7, quote: '弱小' }),
      makeInput({ chapterId: 'ch-1', start: 0, end: 2, quote: '失去' }),
      makeInput({ chapterId: '', chapterIndex: 3, start: 1, end: 2, quote: '星' }),
    ]);
    const map = buildChapterIndexMap(recs);
    expect([...map.keys()].sort()).toEqual(['ch-1', 'idx:3']);
    expect(map.get('ch-1')!.map((h) => h.start)).toEqual([0, 5]);
  });
});

describe('quote 漂移校验', () => {
  const text = '大自然之美在于其变化莫测；失去的从来不会再回来；给岁月以文明。';

  it('位置精确命中 → 不变；唯一漂移 → 返回新位置；找不到 → 只标 stale 不删除', () => {
    // 原文位置（"给岁月"起点 24）
    const exact = { start: 24, end: 27, quote: '给岁月', prefix: '', suffix: '以文明' };
    expect(findQuotePosition(text, exact)).toBe(24);

    // 漂移：把"给岁月"从句中移到开头（原位置被删）→ 全文唯一命中新位置
    const driftedText = '给岁月' + text.slice(0, 24) + text.slice(27);
    expect(findQuotePosition(driftedText, exact)).toBe(0);

    // 彻底找不到：返回 null，validate 只标 stale，记录仍在
    const r: HighlightRecord = {
      id: 'x', chapterId: 'c', chapterIndex: 0, start: 40, end: 44,
      quote: '原文已被删掉', prefix: 'aa', suffix: 'bb',
      color: 'yellow', note: '重要批注', createdAt: 1, updatedAt: 1,
    };
    expect(findQuotePosition(text, r)).toBeNull();
    const v = validateHighlightAgainstText(r, text);
    expect(v.stale).toBe(true);
    expect(v.record.stale).toBe(true);
    expect(v.record.note).toBe('重要批注'); // 数据未丢
  });

  it('stale 记录重新命中时恢复（清 stale 并回写新位置）', () => {
    const r: HighlightRecord = {
      id: 'y', chapterId: 'c', chapterIndex: 0, start: 0, end: 5,
      quote: '不会再回', prefix: '失去的', suffix: '来', color: 'blue',
      note: '', createdAt: 1, updatedAt: 1, stale: true,
    };
    const v = validateHighlightAgainstText(r, text);
    expect(v.stale).toBe(false);
    expect(v.record.stale).toBeUndefined();
    expect(v.record.start).toBe(text.indexOf('不会再回'));
    expect(v.record.end - v.record.start).toBe(r.quote.length);
    expect(v.changed).toBe(true);
  });
});

describe('读书笔记 Markdown 导出（幂等）', () => {
  beforeEach(() => __resetMemoryStorageForTests());

  const chapters = [
    { index: 0, id: 'ch-1', title: '寂静太空' },
    { index: 1, id: 'ch-2', title: '三体问题' },
  ];

  function records(): HighlightRecord[] {
    return addHighlights(BOOK, [
      makeInput({ chapterId: 'ch-2', chapterIndex: 1, start: 3, end: 5, quote: '弱小', note: '第二章批注', color: 'green' }),
      makeInput({ chapterId: 'ch-1', chapterIndex: 0, start: 9, end: 13, quote: '不要回答', note: '' }),
      makeInput({ chapterId: 'ch-1', chapterIndex: 0, start: 0, end: 2, quote: '失去', note: '第一章批注' }),
    ]);
  }

  it('同一输入两次导出逐字节一致（幂等，与插入顺序无关的确定性排序）', () => {
    const recs = records();
    const a = buildReadingNoteMarkdown('三体', BOOK, chapters, recs);
    const b = buildReadingNoteMarkdown('三体', BOOK, chapters, recs.slice().reverse());
    const c = buildReadingNoteMarkdown('三体', BOOK, chapters, recs);
    expect(a).toBe(c);
    expect(a).toBe(b);
  });

  it('按章分组：章标题、quote 引用块、批注、HTML 注释高亮 id 齐全', () => {
    const md = buildReadingNoteMarkdown('三体', BOOK, chapters, records());
    expect(md).toContain('# 三体 读书笔记');
    expect(md).toContain(`<!-- reading-note:${noteIdForBook(BOOK)}`);
    expect(md.indexOf('1. 寂静太空')).toBeLessThan(md.indexOf('2. 三体问题'));
    // 章内按 start 排序：失去 在 不要回答 之前
    expect(md.indexOf('> 失去')).toBeLessThan(md.indexOf('> 不要回答'));
    expect(md).toContain('<!-- highlight:');
    expect(md).toContain('第一章批注');
    expect(md).toContain('第二章批注');
  });

  it('给回链生成器时每条高亮换成可点深链，不再输出注释标记', () => {
    const recs = records();
    const seen: Array<[string, string]> = [];
    const md = buildReadingNoteMarkdown('三体', BOOK, chapters, recs, {
      label: '回到原文',
      buildHref: (bookPath, highlightId) => {
        seen.push([bookPath, highlightId]);
        return `andy-nav:///reading?e=${encodeURIComponent(bookPath)}&highlightId=${highlightId}`;
      },
    });
    expect(md).not.toContain('<!-- highlight:');
    expect(seen.length).toBe(3);
    for (const h of recs) {
      expect(seen).toContainEqual([BOOK, h.id]);
      expect(md).toContain(`[回到原文](andy-nav:///reading?e=${encodeURIComponent(BOOK)}&highlightId=${h.id})`);
    }
  });

  it('stale 高亮不进正文，但空列表仍生成合法笔记', () => {
    const recs = records();
    recs[0] = { ...recs[0], stale: true };
    const md = buildReadingNoteMarkdown('三体', BOOK, chapters, recs);
    expect(md).not.toContain('第二章批注');
    const empty = buildReadingNoteMarkdown('三体', BOOK, [], []);
    expect(empty).toContain('# 三体 读书笔记');
  });
});
