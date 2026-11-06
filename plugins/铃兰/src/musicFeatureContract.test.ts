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

  it('翻译按钮与歌词对照审阅（修改前 → 修改后）及回退原文', () => {
    mustContain('TrackList.tsx', [
      'music.lyrics.translate',
      'translateSettingsFor',
      'TRANSLATE_NODES',
      'enterLyricsReview',
      'revertLyricsReview',
      'reviewBefore',
      'revertToOriginal',
    ]);
  });

  it('歌词在线候选「自动获取」', () => {
    mustContain('TrackList.tsx', ['fetchLyricCandidates', 'autoFetch']);
  });

  it('两颗翻译按钮分工明确：取现成译文不许偷偷改用机器翻译', () => {
    const src = read('TrackList.tsx');
    const start = src.indexOf('const runFetchExistingTranslation');
    const fn = src.slice(start, src.indexOf('const fetchLyricCandidates', start));
    expect(start).toBeGreaterThan(-1);
    expect(fn.length, '切片没截到函数体，断言会假绿').toBeGreaterThan(20);
    expect(fn).toContain('onFetchExistingTranslation');
    expect(fn, '这颗按钮只许取平台现成译文').not.toContain('translateLyrics');
    // 拿不到时必须说破，不能静默空着
    expect(fn).toContain('noExistingTranslation');
  });

  it('翻译已接到宿主服务，且节点可选（不是"开发中"空位）', () => {
    mustContain('TrackList.tsx', [
      'runAiTranslate',
      'onClick={runAiTranslate}',
      'translateLyrics',
      'translate_text',
      'loadLyricsTargetLang',
      'saveLyricsTargetLang',
      'lyricsTranslateNotice',
      'setTranslateNode',
    ]);
    // 目标语言必须走歌词自己那份：共用引擎不等于共用预设。
    // 以前读的是中转站翻译页的 ts_translate_target，用户预设法语 → 歌词被翻成法语。
    const src = read('TrackList.tsx');
    expect(src, '歌词不许再借用翻译页的目标语言预设').not.toContain('targetLang: loadTargetLang()');
  });

  it('译文默认行内双语（原文保留），两条路径都是', () => {
    const tr = read('lyricTranslate.ts');
    expect(tr).toContain("mode: RejoinMode = 'bilingual'");
    expect(tr).toContain('${l.text} ${piece}');
    const pf = read('lyricPlatformTranslation.ts');
    expect(pf).toContain('${o} ${t}');
  });
});

describe('编辑弹窗字段面（13 项）与提交语义', () => {
  it('三组分组标题与 9 个新字段都在', () => {
    mustContain('TrackList.tsx', [
      'groupBasic', 'groupRelease', 'groupCredit',
      'editAlbumArtist', 'editYear', 'editTrackTotal', 'editDiscNo', 'editDiscTotal',
      'editGenre', 'editComposer', 'editLyricist', 'editComment',
    ]);
  });

  it('只下发**改动过**的字段 —— 全量下发会把用户没填的格子清掉', () => {
    const src = read('TrackList.tsx');
    const fn = src.slice(src.indexOf('const submitEdit'), src.indexOf('// ===== 自动获取元信息'));
    expect(fn.length, '切片没截到 submitEdit，断言会假绿').toBeGreaterThan(20);
    expect(fn).toContain('editDraft[k] !== editOrig[k]');
    expect(fn).not.toContain("title: editDraft.title.trim() || undefined");
  });

  it('置灰依据来自后端矩阵，不是前端猜扩展名', () => {
    const src = read('TrackList.tsx');
    expect(src).toContain('fieldSupport.unsupported.includes(key)');
    expect(src).toContain('onFetchFieldSupport');
    // 查不到矩阵时一律当作可写（宁可让人试一次看到后端跳过，也不灰错格子）
    expect(src).toContain('if (!fieldSupport) return false;');
  });

  it('写回后给出「撤销这次」入口，并显示被格式丢掉的字段', () => {
    mustContain('TrackList.tsx', ['onRollbackBatch', 'rollbackThis', 'lastSave', 'droppedHint']);
    mustContain('index.tsx', ['music_rollback_tag_edit', 'music_tag_field_support', 'buildEditArgs']);
  });

  it('弹窗必须「有界高度 + 内部滚动」，且模糊不挂在弹窗父层上', () => {
    const src = read('TrackList.tsx');
    // 13 个字段早就高过视口；没有 max-height/滚动容器时上下两头一起溢出，
    // 表现是「标题看不见、确定/取消点不到、滚轮无反应」（2026-11-05 实机抓到）
    expect(src).toContain('max-h-[86vh]');
    expect(src).toContain('flex-1 min-h-0 overflow-y-auto overscroll-contain');
    expect(src).toContain('mt-4 shrink-0 flex justify-end gap-2');
    // backdrop-filter 在父级会把整棵子树并进一个合成层，滚动时每帧重算模糊 → 手感发粘
    expect(src).toContain('absolute inset-0 bg-black/30 dark:bg-black/50 backdrop-blur-sm');
    expect(src).not.toContain('justify-center bg-black/30 dark:bg-black/50 backdrop-blur-sm');
  });
});

describe('候选点击不得直接写盘（用户实测反馈的毛病）', () => {
  it('选候选只暂存封面 URL，不立刻下载内嵌', () => {
    const src = read('TrackList.tsx');
    const fn = src.slice(src.indexOf('const applyCandidate'), src.indexOf('const autoFillField'));
    expect(fn.length, '切片没截到 applyCandidate 函数体，断言会假绿').toBeGreaterThan(20);
    expect(fn, 'applyCandidate 不该再直接调用 onApplyCoverUrl 写盘').not.toContain('onApplyCoverUrl(');
    expect(fn).toContain('setPendingCoverUrl(c.coverUrl)');
  });

  it('提交时标签与封面必须串行写（并发读-改-写会互相覆盖）', () => {
    const src = read('TrackList.tsx');
    const fn = src.slice(src.indexOf('const submitEdit'), src.indexOf('// ===== 自动获取元信息'));
    expect(fn.length, '切片没截到 submitEdit 函数体，断言会假绿').toBeGreaterThan(20);
    expect(fn).toContain('await onEditTrack?.(target');
    expect(fn).toContain('await onApplyCoverUrl(target, cover)');
    const a = fn.indexOf('await onEditTrack?.(target');
    const b = fn.indexOf('await onApplyCoverUrl(target, cover)');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
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

  it('候选链已含 QQ 音乐，且候选经过打分排序', () => {
    mustContain('index.tsx', ['qqSearchSongs', 'music_rank_tag_candidates']);
    // 全部候选被打分器淘汰时退回原顺序，不能报「没找到」
    const src = read('index.tsx');
    expect(src).toContain('sorted.length > 0 ? sorted : out');
    // 超时护栏与分段日志必须在：这条链此前没有任何超时，一次挂起就是永久转圈
    expect(src).toContain('withTimeout');
    expect(src).toContain('[meta-candidates]');
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

describe('术语表「整句回写」：关掉表时翻译要能学，且只学对得上的', () => {
  it('配对逻辑在 lyricTranslate，写入在 TrackList，两边都还得在', () => {
    mustContain('lyricTranslate.ts', ['sourceTargetPairs', 'pairs:']);
    mustContain('TrackList.tsx', ['learnGlossaryPairs', 'isGlossaryOff', 'res.pairs']);
  });

  it('未对齐时不给对子 —— 错轴译文进表比不进表坏得多', () => {
    const src = read('lyricTranslate.ts');
    expect(src).toContain('if (src.length === 0 || src.length !== dst.length) return [];');
  });
});

describe('批量「自动匹配并写入」：门槛与命令接线', () => {
  it('门槛与筛选在纯函数里；取候选处必须带 score 缺失即不写的 fail-closed', () => {
    mustContain('batchAutoTag.ts', ['MIN_AUTO_WRITE_SCORE', 'buildBatchArgs', 'buildBatchReport']);
    const src = read('index.tsx');
    expect(src).toContain('planBatchAutoTag');
    expect(src).toContain('music_batch_edit_tracks');
    expect(src).toContain('score: top.score,');
  });

  it('入口是「先看计划再落盘」两段，且写完给撤销入口（整批一个批次号）', () => {
    mustContain('TrackList.tsx', [
      'onPlanBatchAutoTag',
      'onCommitBatchAutoTag',
      'runBatchPlan',
      'commitBatchPlan',
      'rollbackBatchReport',
      'batchPlan.plan.skipped',
    ]);
    const src = read('TrackList.tsx');
    // 确认面板必须在「还没写盘」时就显示跳过原因 —— 静默少改是最难排查的坏结果
    expect(src).toContain('sk.reason');
    // 撤销用的是报告里的批次号，不是另起一个
    expect(src).toContain('onRollbackBatch(batchReport.batchId)');
  });

  it('三个候选面板都必须标出来源（用户问的：这条是网易云还是酷狗）', () => {
    const src = read('TrackList.tsx');
    expect(src).toContain("case 'netease': return '网易云'");
    expect(src).toContain("case 'qq': return 'QQ音乐'");
    // 元信息候选、歌词候选、批量确认面板三处各用一次
    const uses = src.split('sourceLabel(').length - 1;
    expect(uses, '来源徽标被删到少于三处').toBeGreaterThanOrEqual(4);
    // 分项自动获取取的是排序后的第 0 条，看不见来源就等于让人凭空信一个值
    expect(src).toContain('setFieldAutoHint');
    expect(src).toContain('fieldAutoHint &&');
  });
});

describe('批量写入的连带换封面（用户定的默认：只有高分才动图）', () => {
  it('封面门槛比写字段高，且与字段写回共用同一批次号（撤销才能一起退回）', () => {
    mustContain('batchAutoTag.ts', ['MIN_AUTO_COVER_SCORE', 'coverUrl']);
    const src = read('index.tsx');
    expect(src).toContain("await hostApi.invoke('music_set_cover_url', { filePath: it.filePath, url: it.coverUrl, batchId })");
    // 确认面板上必须看得出哪几首会动图
    expect(read('TrackList.tsx')).toContain('+封面');
  });

  it('每条候选都必须拿到分数（只检索到 1 条时也要）—— 批量的门槛靠 score', () => {
    const src = read('index.tsx');
    // 过去写成 `out.length > 1`：精确检索常常就返回一条，于是不打分 →
    // 批量按 score≥门槛判断时把它当 0 分跳过，界面表现是「批量一首都不改」
    expect(src).toContain('if (out.length > 0) {');
    expect(src).not.toContain('out.length > 1');
  });
});

describe('歌词候选的源数量：网易云 → 酷狗 → QQ（QQ 歌词此前是死代码）', () => {
  it('候选链里有 QQ 兜底，且抓取分支认得 qqMid', () => {
    const src = read('index.tsx');
    expect(src).toContain('qq-lyric-');
    expect(src).toContain('qqMid: s.mid');
    expect(src).toContain('if (c.qqMid)');
    expect(src).toContain('await qqGetLyric(');
  });

  it('歌词候选的类型也允许 qq，否则徽标与分支都会被 tsc 判死', () => {
    const src = read('TrackList.tsx');
    const iface = src.slice(src.indexOf('export interface LyricCandidate'), src.indexOf('const fieldLabelCls'));
    expect(iface.length, '切片没截到 LyricCandidate，断言会假绿').toBeGreaterThan(60);
    expect(iface).toContain("'netease' | 'kugou' | 'qq'");
    expect(iface).toContain('qqMid?: string;');
  });
});

describe('封面留底的入口（后端两个命令早就有，UI 曾经零接线）', () => {
  it('弹窗里有「旧封面…」列表与装回动作，且装回后刷新预览', () => {
    mustContain('TrackList.tsx', [
      'onListCoverBackups',
      'onRestoreCover',
      'toggleCoverBackups',
      'pickCoverBackup',
      'coverBackupLabel',
    ]);
    const src = read('TrackList.tsx');
    // 装回成功后必须把新路径写进预览，否则就是「点了没反应」
    expect(src).toContain('if (path) setDraftCoverPath(path);');
    mustContain('index.tsx', ['music_list_cover_backups', 'music_restore_cover', 'handleRestoreCover']);
  });
});

describe('写回记录面板：历史要看得见，且只有最近一批给撤销入口', () => {
  it('接线在 TrackList/index，命令在 manifest', () => {
    mustContain('TrackList.tsx', [
      'onListTagBatches',
      'toggleTagHistory',
      'rollbackHistoryBatch',
      'tagHistoryNotUndoable',
      'b.latest ?',
    ]);
    mustContain('index.tsx', ['music_list_tag_batches']);
    expect(readManifest()).toContain('"music_list_tag_batches"');
  });

  it('时间/文件名换算走独立纯函数，不在 JSX 里现搓（那里没法单测）', () => {
    mustContain('tagHistoryView.ts', ['export function formatMillis', 'export function baseName']);
    expect(read('TrackList.tsx')).toContain('formatMillis(b.createdAt)');
  });
});

describe('写完/撤销后内存必须跟到文件真值（13 字段那条线的教训）', () => {
  it('重扫是整体覆盖，不是手挑三个字段；撤销按后端给回的路径逐个重扫', () => {
    const src = read('index.tsx');
    expect(src).toContain('{ ...t, ...rescanned, coverPath: cov }');
    expect(src).toContain('music_rollback_tag_edit');
    expect(src).toContain('restoredPaths');
    // 写回成功后一律重扫，不再手拼 updateTracks
    expect(src).not.toContain('title: fields.title ?? t.title');
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
      'music_tag_field_support',
      'music_rollback_tag_edit',
      'music_batch_edit_tracks',
      'music_rank_tag_candidates',
    ]) {
      expect(m, `manifest 缺少命令声明：${cmd}`).toContain(`"${cmd}"`);
    }
  });
});
