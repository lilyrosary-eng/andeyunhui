// QQ 音乐 API 层（对齐 kugouApi.ts / neteaseApi.ts 范式）
//
// QQ 这三个接口实测**免签名**（2026-11-04 探针，见 src-tauri/src/services/qq_proxy.rs 顶部
// 的实测结论），所以本层没有 crypto 兄弟文件，只负责：
//   - 构造 musicu.fcg 的请求体、解析响应
//   - ★ 节流与「空即重试」：搜索接口有 burst 限流，失败形态是
//     HTTP 200 + code=0 + **空列表**（响应从 ~50KB 掉到 ~1KB），不报错。
//     把它当「没搜到」会静默毁掉自动匹配，所以空结果一律按可重试处理。
//   - 歌词 base64 解码成 LRC 文本
//   - 封面 URL 模板（尺寸可调大）
//
// 通过宿主 qq_http_post / qq_http_get 代理转发（域名/路径白名单在 Rust 侧）。

// node（vitest）环境没有 window：退化成空实现，单测通过 deps.invoke 注入替身
const hostApi: any =
  (typeof window !== 'undefined' ? (window as any).__HOST_API__ : null) || {
    invoke: async () => ({}) as unknown,
  };

// ============ 常量 ============
const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const LYRIC_URL =
  'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?g_tk=5381&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1&ct=121&cv=0&songmid=';
const COVER_BASE = 'https://y.qq.com/music/photo_new/';

// 相邻两次搜索请求的最小间隔。实测：连打会拿到空列表、间隔 2.5s 以上稳定有数据；
// 精确阈值没有测准，这里取保守值并配合重试，不去赌它的具体数字。
const MIN_SEARCH_INTERVAL_MS = 1200;
// 空结果重试的退避节奏（次数 = 数组长度）
const EMPTY_RETRY_DELAYS_MS = [1500, 3500];

// ============ 类型 ============
export interface QqSong {
  mid: string;
  title: string;
  artist: string;
  album: string;
  albumMid: string;
  durationSecs: number;
  /** 发行日原文，如 "2003-07-31"；QQ 的 genre 只是数字 id，不给流派名 */
  timePublic: string;
  trackNo: number | null;
  discNo: number | null;
  coverUrl: string;
}

interface QqInvokeDeps {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
  sleep?: (ms: number) => Promise<void>;
}

// ============ 纯函数（可单测）============

/** 构造 musicu.fcg 的搜索请求体。`searchId` 必须是新鲜 UUID（参考实现也用 uuid1）。 */
export function buildSearchBody(keyword: string, limit = 10, page = 1, searchId: string): string {
  return JSON.stringify({
    comm: {
      wid: '',
      tmeAppID: 'qqmusic',
      authst: '',
      uid: '',
      gray: '0',
      OpenUDID: '2d484d3157d4ed482e406e6c5fdcf8c3d3275deb',
      ct: '6',
      patch: '2',
      psrf_qqopenid: '',
      sid: '',
      psrf_access_token_expiresAt: '',
      cv: '80600',
      gzip: '0',
      qq: '',
      nettype: '2',
      psrf_qqunionid: '',
      psrf_qqaccess_token: '',
      tmeLoginType: '2',
    },
    'music.search.SearchCgiService.DoSearchForQQMusicDesktop': {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: {
        num_per_page: limit,
        page_num: page,
        remoteplace: 'txt.mac.search',
        search_type: 0,
        query: keyword,
        grp: 1,
        searchid: searchId,
        nqc_flag: 0,
      },
    },
  });
}

function songList(parsed: any): any[] | null {
  const wrapper = parsed?.['music.search.SearchCgiService.DoSearchForQQMusicDesktop'];
  const list = wrapper?.data?.body?.song?.list;
  return Array.isArray(list) ? list : null;
}

/**
 * 判断「业务成功但没有条目」。
 *
 * 这是 QQ 的静默限流形态：HTTP 200、`code=0`、列表为空。搜索词确实无结果时也是这个形状，
 * 所以调用方重试耗尽后仍要把它当「没搜到」返回 —— 区别只在于值得先重试两次再说。
 */
export function isEmptySearchResult(rawBody: string): boolean {
  let parsed: any = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false; // 不是 JSON 属于另一种异常，交给解析方报错
  }
  if (parsed?.code !== 0) return false;
  const list = songList(parsed);
  return list !== null && list.length === 0;
}

/** 解析搜索响应为 QqSong 列表；结构不认识时返回 null（区别于「空列表」）。 */
export function parseSearchResponse(rawBody: string): QqSong[] | null {
  let parsed: any = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const list = songList(parsed);
  if (!list) return null;
  return list
    .map(mapSong)
    .filter((s: QqSong | null): s is QqSong => !!s && !!s.mid);
}

function mapSong(s: any): QqSong | null {
  if (!s || typeof s.mid !== 'string' || !s.mid) return null;
  const singers: string = Array.isArray(s.singer)
    ? s.singer.map((x: any) => x?.name || x?.title || '').filter(Boolean).join(' / ')
    : String(s?.singer?.name || '');
  const intervalSec = Number(s.interval) || 0;
  return {
    mid: s.mid,
    title: String(s.title || s.name || ''),
    artist: singers,
    album: String(s.album?.name || s.album?.title || ''),
    albumMid: String(s.album?.mid || ''),
    durationSecs: intervalSec,
    timePublic: String(s.time_public || ''),
    trackNo: Number.isFinite(s.index_album) && s.index_album > 0 ? s.index_album : null,
    discNo: Number.isFinite(s.index_cd) && s.index_cd > 0 ? s.index_cd : null,
    coverUrl: s.album?.mid ? qqCoverUrl(String(s.album.mid)) : '',
  };
}

/**
 * 解码歌词响应。
 *
 * 实测：`lyric` 是 base64 的标准 LRC（含 [ti:][ar:][al:] 头）。缺 Referer 时上游返回
 * `retcode=-1310` 且 lyric 为空 —— Referer 由 Rust 代理兜底补上，这里只负责如实报错。
 */
export function decodeLyricResponse(rawBody: string): { text: string; retcode: number } {
  let parsed: any = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { text: '', retcode: -1 };
  }
  const retcode = Number(parsed?.retcode ?? parsed?.code ?? -1);
  const payload = String(parsed?.lyric || '');
  if (!payload) return { text: '', retcode };
  try {
    return { text: atobToUtf8(payload), retcode };
  } catch {
    // base64 解不动就当原文（个别接口直接回明文 LRC）
    return { text: payload, retcode };
  }
}

/** base64 → UTF-8 文本（atob 只处理 latin1，中文必须再过一层） */
function atobToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 专辑封面 URL。QQ 的模板把尺寸写死在路径里，换尺寸就是换字符串。
 * 实测 R300 约 33KB、R800 约 183KB（真 JPEG，无需 Referer，支持 Range）。
 */
export function qqCoverUrl(albumMid: string, size: '300x300' | '800x800' = '800x800'): string {
  if (!albumMid) return '';
  return `${COVER_BASE}T002R${size}M000${albumMid}.jpg`;
}

// ============ 调用（带节流与空即重试）============

let lastSearchAt = 0;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 等到距离上一次搜索至少 MIN_SEARCH_INTERVAL_MS */
async function gateSearch(sleep: (ms: number) => Promise<void>): Promise<void> {
  const wait = lastSearchAt + MIN_SEARCH_INTERVAL_MS - Date.now();
  lastSearchAt = Date.now() + Math.max(0, wait);
  if (wait > 0) await sleep(wait);
}

/**
 * 搜索歌曲。空结果按「可能被限流」处理：退避重试，最多 `EMPTY_RETRY_DELAYS_MS.length` 次，
 * 仍然空才当成真的没搜到。
 */
export async function qqSearchSongs(
  keyword: string,
  limit = 10,
  deps: QqInvokeDeps = {},
): Promise<QqSong[]> {
  const invoke = deps.invoke ?? hostApi.invoke;
  const sleep = deps.sleep ?? defaultSleep;
  const trimmed = keyword.trim();
  if (!trimmed) return [];

  for (let attempt = 0; ; attempt++) {
    await gateSearch(sleep);
    const res = await invoke('qq_http_post', {
      url: MUSICU,
      body: buildSearchBody(trimmed, limit, 1, newUuid()),
    });
    const raw = typeof res === 'string' ? res : String(res?.body ?? '');
    const parsed = parseSearchResponse(raw);
    if (parsed && parsed.length > 0) return parsed;
    if (parsed && parsed.length === 0 && attempt < EMPTY_RETRY_DELAYS_MS.length) {
      await sleep(EMPTY_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    return parsed ?? [];
  }
}

/** 取歌词（base64 已解码成 LRC 文本）。失败返回空串，由调用方决定如何降级。 */
export async function qqGetLyric(mid: string, deps: QqInvokeDeps = {}): Promise<string> {
  if (!mid) return '';
  const invoke = deps.invoke ?? hostApi.invoke;
  const res = await invoke('qq_http_get', { url: `${LYRIC_URL}${encodeURIComponent(mid)}` });
  const raw = typeof res === 'string' ? res : String(res?.body ?? '');
  return decodeLyricResponse(raw).text;
}

function newUuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // 非安全上下文兜底：拼一个 v4 形状
  let s = '';
  for (let i = 0; i < 32; i++) s += ((Math.random() * 16) | 0).toString(16);
  s = s.slice(0, 13) + '4' + s.slice(14, 17) + (((parseInt(s[19], 16) & 0x3) | 0x8).toString(16)) + s.slice(20);
  return [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20, 32)].join('-');
}
