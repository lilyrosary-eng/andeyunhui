import { describe, expect, it, vi } from 'vitest';
import {
  BATCH_WRITABLE_FIELDS,
  MIN_AUTO_COVER_SCORE,
  MIN_AUTO_WRITE_SCORE,
  buildBatchArgs,
  buildBatchReport,
  newClientBatchId,
  planBatchAutoTag,
  type BatchTrackInput,
  type TopCandidate,
} from './batchAutoTag';

const local = (over: Partial<BatchTrackInput> = {}): BatchTrackInput => ({
  filePath: '/m/a.flac',
  title: '晴天',
  artist: '周杰伦',
  album: '叶惠美',
  ...over,
});

const top = (over: Partial<TopCandidate> = {}): TopCandidate => ({
  title: '晴天',
  artist: '周杰伦',
  album: '叶惠美',
  score: MIN_AUTO_WRITE_SCORE,
  source: 'netease',
  ...over,
});

const oneShot = (cand: TopCandidate | null) => async () => cand;

describe('批量自动写入的门槛', () => {
  it('分数够才写，且只写 title/artist/album 三项', async () => {
    const plan = await planBatchAutoTag([local({ album: '旧专辑' })], oneShot(top({ album: '叶惠美' })));
    expect(plan.items.length).toBe(1);
    expect(Object.keys(plan.items[0].draft).sort()).toEqual(['album']);
    expect(plan.items[0].draft.album).toBe('叶惠美');
    expect(BATCH_WRITABLE_FIELDS).toEqual(['title', 'artist', 'album']);
  });

  it('分数不够 → 不写，并把门槛写进原因（静默少改是最难排查的坏结果）', async () => {
    const plan = await planBatchAutoTag([local()], oneShot(top({ title: '另一首', score: MIN_AUTO_WRITE_SCORE - 1 })));
    expect(plan.items).toEqual([]);
    expect(plan.skipped[0].reason).toContain(String(MIN_AUTO_WRITE_SCORE));
  });

  it('打分没跑成（score 缺失按 0 传进来）→ 一首都不写', async () => {
    const plan = await planBatchAutoTag([local()], oneShot(top({ score: 0 })));
    expect(plan.items).toEqual([]);
    expect(plan.skipped[0].reason).toContain('门槛');
  });

  it('没检索到候选 → 跳过并说明', async () => {
    const plan = await planBatchAutoTag([local()], oneShot(null));
    expect(plan.skipped[0].reason).toContain('没检索到候选');
  });

  it('没有可写回路径的条目单独跳过，不影响同批别的文件', async () => {
    const plan = await planBatchAutoTag(
      [local({ filePath: '' }), local({ filePath: '/m/b.flac' })],
      oneShot(top({ title: '新标题' })),
    );
    expect(plan.skipped[0].reason).toContain('文件路径');
    expect(plan.items.length).toBe(1);
  });
});

describe('字段筛选（空值语义与单条编辑一致）', () => {
  it('候选给不出的字段不写：空串在后端是「清除」，不能抹掉用户已有标签', async () => {
    const plan = await planBatchAutoTag(
      [local()],
      oneShot(top({ title: '新标题', artist: '', album: '   ' })),
    );
    expect(Object.keys(plan.items[0].draft)).toEqual(['title']);
  });

  it('已经是一样的值就不写（大小写与首尾空白算一样）', async () => {
    const plan = await planBatchAutoTag([local()], oneShot(top({ artist: ' 周杰伦 ' })));
    expect(plan.items).toEqual([]);
    expect(plan.skipped[0].reason).toContain('无需写');
  });

  it('只把真改动的字段放进 draft，三项都不同时 draft 三项齐全', async () => {
    const plan = await planBatchAutoTag(
      [local()],
      oneShot(top({ title: 'T', artist: 'A', album: 'B' })),
    );
    expect(Object.keys(plan.items[0].draft).sort()).toEqual(['album', 'artist', 'title']);
  });
});

describe('发给后端的参数形状', () => {
  it('items[].draft 里不含 filePath，批次号是 batch_<毫秒>（与后端 new_batch_id 同形）', async () => {
    const plan = await planBatchAutoTag([local()], oneShot(top({ title: 'T' })));
    const args = buildBatchArgs(plan, newClientBatchId(1700000000000));
    expect(args.batchId).toBe('batch_1700000000000');
    expect(args.items).toEqual([{ filePath: '/m/a.flac', draft: { title: 'T' } }]);
    expect('filePath' in args.items[0].draft).toBe(false);
  });

  it('全部跳过时 items 为空数组 —— 调用方据此不发请求', async () => {
    const plan = await planBatchAutoTag([local()], oneShot(top({ score: -2 })));
    expect(buildBatchArgs(plan, 'batch_1').items).toEqual([]);
  });
});

describe('结果汇总', () => {
  it('written 只算后端点头的；被格式丢掉的字段去重点名', () => {
    const plan = {
      items: [{ filePath: '/m/a.flac', draft: {}, score: 4, source: 'netease' }],
      skipped: [{ filePath: '/m/b.flac', title: 'x', reason: 'r' }],
    };
    const r = buildBatchReport(
      plan,
      'batch_1',
      [
        { filePath: '/m/a.flac', ok: true, dropped: ['流派', '流派'] },
        { filePath: '/m/b.flac', ok: false, error: '读取音频失败' },
      ],
    );
    expect(r.written).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.droppedFields).toEqual(['流派']);
    expect(r.summary).toContain('成功 1/2');
    expect(r.summary).toContain('跳过 1 首');
    expect(r.summary).toContain('读取音频失败');
  });

  it('后端返回不是数组（老版本/异常）不炸，汇总成 0/0', () => {
    const r = buildBatchReport({ items: [], skipped: [] }, 'batch_1', null as unknown as never[]);
    expect(r.written).toBe(0);
    expect(r.summary).toContain('成功 0/0');
  });

  it('计划里没跳过的批次，汇总不出现「跳过」字样', () => {
    const r = buildBatchReport({ items: [], skipped: [] }, 'batch_1', [{ ok: true }]);
    expect(r.summary).not.toContain('跳过');
  });
});

describe('逐首派发', () => {
  it('resolveTop 按传入顺序调用，且拿到的就是那条输入', async () => {
    const spy = vi.fn(async (t: BatchTrackInput) => (t.title === '晴天' ? top({ title: 'T' }) : null));
    const plan = await planBatchAutoTag([local(), local({ filePath: '/m/c.flac', title: '无候选' })], spy);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(plan.items.length).toBe(1);
    expect(plan.skipped.length).toBe(1);
  });
});

describe('高分才连带换封面（用户定的默认）', () => {
  const withCover = (score: number, coverUrl?: string) =>
    planBatchAutoTag([local({ album: '旧专辑' })], oneShot(top({ album: '叶惠美', score, coverUrl })));

  it('写字段的门槛（4）不足以换封面：5 分才开始动图', async () => {
    const p4 = await withCover(MIN_AUTO_WRITE_SCORE, 'https://c/1.jpg');
    expect(p4.items[0].coverUrl).toBeUndefined();
    const p5 = await withCover(MIN_AUTO_COVER_SCORE, 'https://c/1.jpg');
    expect(p5.items[0].coverUrl).toBe('https://c/1.jpg');
    expect(MIN_AUTO_COVER_SCORE).toBeGreaterThan(MIN_AUTO_WRITE_SCORE);
  });

  it('候选没给封面 / 只给空白 → 不换', async () => {
    expect((await withCover(6, undefined)).items[0].coverUrl).toBeUndefined();
    expect((await withCover(6, '   ')).items[0].coverUrl).toBeUndefined();
  });

  it('字段全都一样时整首跳过，不做「只换封面」这一档', async () => {
    const plan = await planBatchAutoTag([local()], oneShot(top({ score: 6, coverUrl: 'https://c/1.jpg' })));
    expect(plan.items).toEqual([]);
    expect(plan.skipped[0].reason).toContain('无需写');
  });

  it('报告把封面成功/失败单独计进 summary', () => {
    const plan = { items: [], skipped: [] };
    const r = buildBatchReport(plan, 'batch_1', [{ ok: true }], [
      { ok: true },
      { ok: false, error: '下载封面失败' },
    ]);
    expect(r.coversChanged).toBe(1);
    expect(r.coverFailed).toBe(1);
    expect(r.summary).toContain('封面 1/2');
    expect(r.summary).toContain('下载封面失败');
  });

  it('没换封面的批次，summary 不出现「封面」字样', () => {
    const r = buildBatchReport({ items: [], skipped: [] }, 'batch_1', [{ ok: true }]);
    expect(r.summary).not.toContain('封面');
    expect(r.coversChanged).toBe(0);
  });
});
