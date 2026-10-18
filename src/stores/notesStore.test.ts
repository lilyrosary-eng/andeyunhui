// notesStore 的「标签数据拉取治理」单测（P1-7）。
//
// 覆盖三条规则（实现见 src/stores/notesStore.ts 顶部 TAGS_TTL_MS 注释）：
//   1. in-flight 合并：同一时刻并发多次 refreshTags 只打一次后端；
//   2. TTL 去重：刚拉过的非 force 调用直接跳过，force 跳过 TTL；
//   3. 有界化：refreshNotes / refreshTags 把 noteTagsMap 修剪到活笔记集合，
//      删除的笔记不会永久残留；saveTags 本地增量修补，不为一次标签保存打全目录扫描。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = {
  tagsMap: 0,
  allTags: 0,
  setNoteTags: 0,
};

vi.mock('@/lib/api', () => ({
  api: {
    getAllNoteTagsMap: () => { calls.tagsMap++; return Promise.resolve({}); },
    getAllTags: () => { calls.allTags++; return Promise.resolve([]); },
    getAllNotes: () => Promise.resolve([]),
    getAllFavorites: () => Promise.resolve([]),
    setNoteTags: () => { calls.setNoteTags++; return Promise.resolve(); },
    getNoteTags: () => Promise.resolve([]),
    getNoteContent: () => Promise.resolve({ title: '', content: '' }),
    saveNote: () => Promise.resolve(),
    toggleFavoriteNote: () => Promise.resolve(false),
    archiveSnapshot: () => Promise.resolve(),
  },
}));
// logger 走 tauri invoke，测试环境里一律换成 no-op
vi.mock('@/lib/logger', () => ({
  logger: {
    notes: new Proxy({}, { get: () => () => {} }),
  },
}));

import { useNotesStore } from './notesStore';

type Note = { id: string; title: string; date: string };

function seedNotes(ids: string[]) {
  const notes = ids.map((id, i) => ({ id, title: `n${i}`, date: '2026-01-01' }) as Note);
  useNotesStore.getState().refreshNotes(notes as never);
  return notes;
}

/** 把在途微任务全部跑完（Promise.all + .catch + .finally 需要数 tick） */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('notesStore 标签拉取治理', () => {
  beforeEach(() => {
    calls.tagsMap = 0;
    calls.allTags = 0;
    calls.setNoteTags = 0;
    // 重置 store 到初始态（模块级 TTL 状态也靠"时间推进"绕过，见各用例）
    useNotesStore.setState({
      notes: [],
      noteTagsMap: {},
      allTags: [],
      currentNoteTags: [],
      currentNoteId: null,
    });
  });

  it('并发多次 refreshTags 只发起一次后端拉取（in-flight 合并）', async () => {
    const s = useNotesStore.getState();
    s.refreshTags(true);
    s.refreshTags(true);
    s.refreshTags(true);
    await flush();
    expect(calls.tagsMap).toBe(1);
    expect(calls.allTags).toBe(1);
  });

  it('TTL 内的重复 refreshTags 被跳过，force 或超过 TTL 后放行', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    try {
      useNotesStore.getState().refreshTags(true);
      await flush();
      expect(calls.tagsMap).toBe(1);

      // 距上次成功 100ms < TTL(1500ms) → 跳过
      now.mockReturnValue(1_000_100);
      useNotesStore.getState().refreshTags();
      await flush();
      expect(calls.tagsMap).toBe(1);

      // force 跳过 TTL
      useNotesStore.getState().refreshTags(true);
      await flush();
      expect(calls.tagsMap).toBe(2);

      // 超过 TTL 后放行
      now.mockReturnValue(1_000_100 + 2000);
      useNotesStore.getState().refreshTags();
      await flush();
      expect(calls.tagsMap).toBe(3);
    } finally {
      now.mockRestore();
    }
  });

  it('refreshNotes 把 noteTagsMap 修剪到活笔记（删除的笔记不残留）', () => {
    useNotesStore.setState({
      noteTagsMap: { a: ['x'], b: ['y'], gone: ['z'] },
    });
    useNotesStore.getState().refreshNotes([
      { id: 'a', title: 'A', date: '2026-01-01' },
      { id: 'b', title: 'B', date: '2026-01-01' },
    ] as never);
    expect(Object.keys(useNotesStore.getState().noteTagsMap).sort()).toEqual(['a', 'b']);
  });

  it('notes 未加载时不修剪（避免 init 竞态把整张表清空）', () => {
    useNotesStore.setState({ notes: [], noteTagsMap: { a: ['x'], b: ['y'] } });
    useNotesStore.getState().refreshNotes([] as never);
    expect(useNotesStore.getState().noteTagsMap).toEqual({ a: ['x'], b: ['y'] });
  });

  it('saveTags 本地增量修补，不为一次标签保存触发全目录扫描', async () => {
    seedNotes(['a', 'b']);
    useNotesStore.setState({ currentNoteId: 'a', allTags: ['old'] });
    await useNotesStore.getState().saveTags(['new', 'old']);
    expect(calls.tagsMap).toBe(0);
    expect(calls.allTags).toBe(0);
    const st = useNotesStore.getState();
    expect(st.noteTagsMap.a).toEqual(['new', 'old']);
    expect(st.allTags.sort()).toEqual(['new', 'old']);
    expect(st.currentNoteTags).toEqual(['new', 'old']);
  });

  it('saveTags 失败时回退全量刷新并 force 跳过 TTL', async () => {
    seedNotes(['a']);
    useNotesStore.setState({ currentNoteId: 'a' });
    // 让 setNoteTags 失败（mock 默认 resolve，这里临时替换）
    const { api } = await import('@/lib/api');
    const orig = api.setNoteTags;
    (api as unknown as { setNoteTags: () => Promise<void> }).setNoteTags = () => Promise.reject(new Error('disk'));
    try {
      await useNotesStore.getState().saveTags(['t']);
    } finally {
      (api as unknown as { setNoteTags: typeof orig }).setNoteTags = orig;
    }
    expect(calls.tagsMap).toBe(1);
  });

  it('init 走 refreshTags(true)，不绕过治理', async () => {
    useNotesStore.getState().init();
    await flush();
    expect(calls.tagsMap).toBe(1);
    expect(calls.allTags).toBe(1);
  });
});
