import { describe, it, expect, vi } from 'vitest';
import {
  buildSearchBody,
  isEmptySearchResult,
  parseSearchResponse,
  decodeLyricResponse,
  qqCoverUrl,
  qqSearchSongs,
} from './qqMusicApi';

const WRAPPER_KEY = 'music.search.SearchCgiService.DoSearchForQQMusicDesktop';

const envelope = (list: unknown[]) =>
  JSON.stringify({ code: 0, [WRAPPER_KEY]: { code: 0, data: { body: { song: { list } } } } });

const SONG = {
  mid: '0039MnYb0qxYhV',
  title: '晴天',
  singer: [{ name: '周杰伦' }, { name: 'Lara' }],
  album: { name: '叶惠美', mid: '000MkMni19ClKG' },
  interval: 269,
  time_public: '2003-07-31',
  index_album: 1,
  index_cd: 1,
  genre: 1,
};

describe('QQ 搜索响应判读', () => {
  it('code=0 + 空列表 认定为「静默空」（限流的失败形态）', () => {
    expect(isEmptySearchResult(envelope([]))).toBe(true);
  });

  it('有数据时不算空', () => {
    expect(isEmptySearchResult(envelope([SONG]))).toBe(false);
  });

  it('业务失败（code≠0）不当成空，避免误触发重试', () => {
    expect(isEmptySearchResult(JSON.stringify({ code: -1, msg: 'bad' }))).toBe(false);
  });

  it('非 JSON 原文不判空，交给解析方报错', () => {
    expect(isEmptySearchResult('<html>403</html>')).toBe(false);
    expect(parseSearchResponse('<html>403</html>')).toBeNull();
  });

  it('结构不认识时返回 null，而不是空数组', () => {
    expect(parseSearchResponse(JSON.stringify({ code: 0 }))).toBeNull();
  });

  it('多歌手数组拼成一条字符串并保留分隔', () => {
    const songs = parseSearchResponse(envelope([SONG]));
    expect(songs?.[0].artist).toBe('周杰伦 / Lara');
  });

  it('映射发行日/音轨/碟号/时长，并且不臆造流派名', () => {
    const s = parseSearchResponse(envelope([SONG]))?.[0];
    expect(s?.timePublic).toBe('2003-07-31');
    expect(s?.trackNo).toBe(1);
    expect(s?.discNo).toBe(1);
    expect(s?.durationSecs).toBe(269);
    // QQ 的 genre 是数字 id，本层不提供 genre 字段
    expect('genre' in (s ?? {})).toBe(false);
  });

  it('封面 URL 用专辑 mid 拼高清尺寸', () => {
    const s = parseSearchResponse(envelope([SONG]))?.[0];
    expect(s?.coverUrl).toBe('https://y.qq.com/music/photo_new/T002R800x800M000000MkMni19ClKG.jpg');
    expect(qqCoverUrl('')).toBe('');
    expect(qqCoverUrl('ABC', '300x300')).toContain('T002R300x300M000ABC.jpg');
  });

  it('请求体里 searchid 与 query 落位正确', () => {
    const body = JSON.parse(buildSearchBody('稻香', 7, 1, 'uuid-xyz'));
    const param = body[WRAPPER_KEY].param;
    expect(param.query).toBe('稻香');
    expect(param.num_per_page).toBe(7);
    expect(param.searchid).toBe('uuid-xyz');
  });
});

describe('qqSearchSongs 的空即重试', () => {
  it('第一次空、第二次有数据 → 返回数据且请求了两次', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: envelope([]) })
      .mockResolvedValueOnce({ status: 200, body: envelope([SONG]) });
    const sleep = vi.fn(async () => {});
    const out = await qqSearchSongs('晴天 周杰伦', 10, { invoke, sleep });
    expect(out).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
  });

  it('一直空 → 重试耗尽后如实返回空数组，不无限打', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: envelope([]) });
    const sleep = vi.fn(async () => {});
    const out = await qqSearchSongs('不存在的歌', 10, { invoke, sleep });
    expect(out).toEqual([]);
    // 1 次首发 + 2 次退避重试
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('有数据就不重试', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: envelope([SONG]) });
    const sleep = vi.fn(async () => {});
    const out = await qqSearchSongs('晴天', 10, { invoke, sleep });
    expect(out).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('空关键词不发请求', async () => {
    const invoke = vi.fn();
    const out = await qqSearchSongs('   ', 10, { invoke, sleep: async () => {} });
    expect(out).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('歌词解码', () => {
  it('base64 解出 UTF-8 的 LRC 原文', () => {
    const lrc = '[ti:晴天]\n[ar:周杰伦]\n[00:00.00]晴天 - 周杰伦';
    const b64 = Buffer.from(lrc, 'utf8').toString('base64');
    const got = decodeLyricResponse(JSON.stringify({ retcode: 0, lyric: b64 }));
    expect(got.retcode).toBe(0);
    expect(got.text).toBe(lrc);
  });

  it('缺 Referer 的 retcode=-1310 形态如实返回空文本', () => {
    const got = decodeLyricResponse(JSON.stringify({ retcode: -1310, lyric: '' }));
    expect(got.text).toBe('');
    expect(got.retcode).toBe(-1310);
  });
});
