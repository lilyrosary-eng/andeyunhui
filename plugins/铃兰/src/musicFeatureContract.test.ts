/**
 * 音乐模块 UI 能力绊线（静态源码断言，2026-11-04）
 *
 * 为什么要有这个文件：音乐标签编辑的改动要动 `TrackList.tsx`（1265 行），而**歌词编辑器、
 * AI 翻译按钮、歌词对照审阅/回退、歌词来源标识**这些不相关的能力就长在同一个文件里。
 * 用户明确担心「改前端把这些改没了」，且项目历史上真出过音乐模块整体消失的事故（0fb2df3，
 * 那次是部署/扫描缓存，不是代码，但后果一样是功能不见了）。
 *
 * 定位：**绊线，不是完备验证**。只钉"关键事实还在"（符号名、命令名、i18n key），
 * 不钉措辞与样式，避免改一句注释红一片。删掉一个能力 → 这里必须变红并点名是哪个。
 *
 * 机制与 `src/core/ai/agentContract.test.ts` 一致：用 vite 的 `?raw` glob 读源码，
 * 不用 node:fs（本项目 tsconfig 把 types 清空成 []，直接引 node 类型会让根 tsc 报 TS2307）。
 */
import { describe, expect, it } from 'vitest';

const RAW = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const MANIFEST = import.meta.glob('../manifest.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function read(rel: string): string {
  const found = Object.entries(RAW).find(([k]) => k.replace(/\\/g, '/').endsWith('/' + rel));
  if (!found) throw new Error(`绊线读不到源码 ${rel}（glob 命中 ${Object.keys(RAW).length} 个文件）`);
  return found[1];
}

function readManifest(): string {
  const found = Object.entries(MANIFEST).find(([k]) => k.endsWith('manifest.json'));
  if (!found) throw new Error('绊线读不到插件 manifest.json');
  return found[1];
}

/** 断言某文件包含全部 needle；缺哪个就点名哪个（而不是只给一个 false）。 */
function mustContain(file: string, needles: string[]): void {
  const src = read(file);
  const missing = needles.filter((n) => !src.includes(n));
  expect(
    missing,
    `${file} 丢了这些能力锚点：${missing.join(' / ')}（如果是有意移除，请同步删掉本断言并说明去向）`,
  ).toEqual([]);
}

describe('绊线前置：源码确实读到了', () => {
  it('glob 命中音乐模块的主要文件', () => {
    // 空 glob 会让所有 mustContain 变成"永远通过"的假绿，必须先自证收得到对照物
    expect(Object.keys(RAW).length).toBeGreaterThan(20);
    expect(read('TrackList.tsx').length).toBeGreaterThan(20000);
    expect(readManifest()).toContain('"music"');
  });
});

describe('歌词编辑器（与标签编辑同居 TrackList.tsx，最易被误删）', () => {
  it('打开/关闭编辑器与原始文本加载', () => {
    mustContain('TrackList.tsx', ['openLyricsEditor', 'closeLyricsEditor', 'lyricsEditorTitle']);
  });

  it('歌词来源标识三态（同名 lrc / 内嵌标签 / 无）', () => {
    mustContain('TrackList.tsx', [
      'lyricsSource',
      'lyricsSourceLrc',
      'lyricsSourceEmbedded',
      'lyricsSourceNone',
    ]);
  });

  it('AI 翻译按钮与歌词对照审阅（修改前 → 修改后）及回退原文', () => {
    mustContain('TrackList.tsx', [
      'aiTranslate',
      'enterLyricsReview',
      'revertLyricsReview',
      'reviewBefore',
      'revertToOriginal',
    ]);
  });

  it('歌词在线候选「自动获取」', () => {
    mustContain('TrackList.tsx', ['fetchLyricCandidates', 'autoFetch']);
  });

  it('AI 翻译已接到宿主翻译服务（不是"开发中"空位）', () => {
    mustContain('TrackList.tsx', [
      'runAiTranslate',
      'onClick={runAiTranslate}',
      'translateLyrics',
      'translate_text',
      'loadTargetLang',
      'lyricsTranslateNotice',
    ]);
  });
});

describe('歌词翻译的时间轴保真', () => {
  it('行数对不上时不硬贴时间戳（错轴译文比无轴更坏）', () => {
    mustContain('lyricTranslate.ts', ['rejoinTranslated', 'aligned: false', '译文行数与原文不一致']);
  });

  it('元信息头不参与翻译', () => {
    mustContain('lyricTranslate.ts', ['metaRe']);
  });
});

describe('歌词「译 / 音」三态与桌面歌词联动', () => {
  it('模式类型与循环切换仍在', () => {
    mustContain('lyricsSync.ts', [
      "type LyricMode = 'off' | 'translate' | 'romaji'",
      'translation',
      'romaji',
    ]);
  });

  it('内嵌翻译拆行仍在（桌面歌词「点翻译不生效」的根因修复）', () => {
    mustContain('lyricsSync.ts', ['splitInlineTranslation']);
  });

  it('三态按钮在正在播放页与漫游页渲染', () => {
    mustContain('NowPlayingView.tsx', ['LyricModeButton']);
    mustContain('RoamView.tsx', ['LyricModeButton']);
  });
});

describe('标签编辑弹窗既有用能力', () => {
  it('四个原字段的编辑与写回入口', () => {
    mustContain('TrackList.tsx', ['editDraft', 'trackNumber', 'onEditTrack']);
  });

  it('在线元信息候选：一键获取、分项自动填充、选中候选', () => {
    mustContain('TrackList.tsx', ['fetchCandidates', 'autoFillField', 'applyCandidate']);
  });

  it('宿主侧写回与封面链路仍被调用', () => {
    mustContain('index.tsx', [
      'music_edit_track',
      'music_set_cover_url',
      'music_set_cover',
      'handleFetchMetaCandidates',
      'handleApplyCoverUrl',
      'save_track_lyrics',
    ]);
  });
});

describe('歌词浮窗与播放链路未被牵连', () => {
  it('桌面歌词组件与宿主事件仍在线', () => {
    mustContain('lyricsSync.ts', ['lyrics-update', 'degrade', 'emit']);
  });

  it('正在播放页与播放器条仍在使用歌词同步单例', () => {
    mustContain('NowPlayingView.tsx', ['lyricsSync']);
    mustContain('PlayerBar.tsx', ['lyricsSync']);
  });
});

describe('插件权限声明不能被顺手删', () => {
  it('歌词与标签写回相关命令仍在 manifest 内', () => {
    const m = readManifest();
    for (const cmd of [
      'music_edit_track',
      'music_set_cover',
      'music_set_cover_url',
      'read_track_metadata',
      'get_lyrics',
      'get_lyrics_text',
      'save_track_lyrics',
      'translate_text',
    ]) {
      expect(m, `manifest 缺少命令声明：${cmd}`).toContain(`"${cmd}"`);
    }
  });
});
