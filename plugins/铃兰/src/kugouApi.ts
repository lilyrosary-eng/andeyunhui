// 酷狗音乐 API 层（对齐 neteaseApi.ts 范式）
//
// 加密在 kugouCrypto.ts 完成（MD5 盐签名 signature），本层负责：
//   - 统一请求 helper（拼 query + signature，经宿主 kugou_http_post 代理转发）
//   - 游客态设备标识（dfid/mid/uuid）持久化
//   - 搜索 / 播放 URL / 歌词 / 歌单 / 榜单 业务函数
//   - KugouTrack 等类型（形状对齐 NeteaseTrack，便于视图层共用渲染）

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => ({}) };
import { makeKugouDevice, kugouSign, KUGOU_WEB_SALT } from './kugouCrypto';

// ============ 常量 ============
// 酷狗网关：gateway.kugou.com 是带 x-router 路由层的网关，必须带 x-router 指向后端 CDN 域名，
// 否则直打 path 会 502。后端 CDN 域名（mobilecdnbj/msearchcdnbj）只有 IPv6 记录，本机 rustls
// 链路不通，故统一走 gateway（有 IPv4）并透传 x-router。
const RANK_HOST = 'https://gateway.kugou.com'; // 榜单列表 / 榜单歌曲 / 歌单（走 x-router）
const SEARCH_HOST = 'https://gateway.kugou.com'; // 搜索（走 x-router）
const WWWAPI = 'https://wwwapi.kugou.com'; // play/getdata 播放地址 + 内联歌词（直连，有 IPv4）
const M_HOST = 'https://m.kugou.com'; // 老式歌单详情（直连，有 IPv4）
const RANK_ROUTER = 'mobilecdnbj.kugou.com'; // x-router 值（榜单/歌单后端）
const SEARCH_ROUTER = 'msearchcdnbj.kugou.com'; // x-router 值（搜索后端）
const REFERER = 'https://www.kugou.com/';
// 伪造国内出口 IP，避免非 CN 出口被拦（与 netease 同思维）
const REAL_IP = '113.66.232.251';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 酷狗公共参数（CDN 接口需要的基础参数，含时间戳）
const APPID = '1014';

// ============ 游客态设备标识持久化 ============
function getDevice(): { dfid: string; mid: string; uuid: string; clienttime: number } {
  const cached = localStorage.getItem('kugou-device');
  if (cached) {
    try { return JSON.parse(cached); } catch { /* fallthrough */ }
  }
  const d = makeKugouDevice();
  localStorage.setItem('kugou-device', JSON.stringify(d));
  return d;
}

// ============ 请求 helper ============
interface KugouRequestOpts {
  base?: string;
  method?: 'GET' | 'POST';
  cookie?: string;
  referer?: string;
  extra?: Record<string, string>;
  router?: string; // x-router 值（gateway 网关路由到哪个后端 CDN）
  salt?: string;   // 传盐时按合并后参数计算 signature 并追加到 URL
}

/**
 * 统一酷狗请求：拼公共参数 + 业务参数 +（可选）signature，经宿主代理转发。
 * 默认 GET（酷狗只读接口多为 GET）。传 opts.salt 时使用完整参数签名。
 */
async function kugouRequest(
  path: string,
  params: Record<string, any>,
  opts: KugouRequestOpts = {},
): Promise<any> {
  const base = opts.base || RANK_HOST;
  const dev = getDevice();
  const common: Record<string, any> = {
    appid: APPID,
    version: '9108',
    plat: '0',
    area_code: '1',
    with_res_tag: '1',
    clienttime: dev.clienttime,
    mid: dev.mid,
    dfid: dev.dfid,
    uuid: dev.uuid,
  };
  const merged: Record<string, any> = { ...common, ...params };
  // 清理空值（CDN 接口对空值参数不友好）
  const cleaned: Record<string, any> = {};
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined || merged[k] === null || merged[k] === '') continue;
    cleaned[k] = merged[k];
  }

  // 若需签名，签名按 key 字典序覆盖 cleaned（不修改 cleaned 发送顺序）
  let signedQuery = '';
  if (opts.salt) {
    const signature = kugouSign(cleaned, opts.salt);
    signedQuery = `&signature=${encodeURIComponent(signature)}`;
  }

  const query = Object.keys(cleaned)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(cleaned[k])}`)
    .join('&');
  const url = `${base}${path}?${query}${signedQuery}`;

  // gateway 网关需要 x-router 路由到后端 CDN（gateway 本身有 IPv4 可达，后端 CDN 仅 IPv6）
  const extra: Record<string, string> = { ...(opts.extra || {}) };
  if (opts.router) extra['x-router'] = opts.router;

  const raw: string = await hostApi.invoke<string>('kugou_http_post', {
    method: opts.method || 'GET',
    url,
    body: '',
    cookie: opts.cookie || undefined,
    referer: opts.referer || REFERER,
    origin: undefined,
    real_ip: REAL_IP,
    user_agent: UA,
    headers: extra,
  });
  const parsed = JSON.parse(raw || '{}');
  if (parsed.status && parsed.status !== 200) {
    console.warn('[kugou]', path, 'status', parsed.status, 'body', String(parsed.body || '').slice(0, 200));
  }
  if (typeof parsed.body === 'string') {
    try {
      // 酷狗网关会在 JSON 前后包 HTML 注释标记（<!--KG_TAG_RES_START-->...<!--KG_TAG_RES_END-->），
      // 必须剥离后再 JSON.parse，否则解析失败。
      let s = parsed.body;
      const startTag = '<!--KG_TAG_RES_START-->';
      const endTag = '<!--KG_TAG_RES_END-->';
      if (s.includes(startTag)) s = s.slice(s.indexOf(startTag) + startTag.length);
      if (s.includes(endTag)) s = s.slice(0, s.indexOf(endTag));
      s = s.trim();
      return JSON.parse(s);
    } catch {
      return { raw: parsed.body };
    }
  }
  return parsed.body || {};
}

// ============ 类型（形状对齐 NeteaseTrack） ============
export interface KugouTrack {
  id: string;          // 酷狗用 hash 作为唯一标识（字符串）
  name: string;
  artist: string;      // "歌手A/歌手B"
  album: string;
  duration: number;    // ms
  cover?: string;
  url?: string;        // 实际播放地址（getSongUrl 后填充）
  hash?: string;       // 文件 hash（播放 URL 用）
  albumId?: number;
  singerId?: number;
}

export interface KugouPlaylistCard {
  id: number;
  name: string;
  cover: string;
  creator?: string;
  playCount?: number;
}

export interface KugouPlaylistItem {
  id: number;
  name: string;
  cover: string;
  trackCount: number;
  creatorName?: string;
}

// ============ 映射 ============


function assertKugouOk(body: any): any {
  if (!body) return body;
  // 酷狗错误码：errcode !== 0 表示失败
  if (body.errcode && body.errcode !== 0 && body.errcode !== 200) {
    throw new Error(`酷狗接口错误: ${body.errcode} ${body.errmsg || ''}`);
  }
  return body;
}

// ============ 业务函数 ============

// 搜索歌曲
export async function searchSongs(keyword: string, limit = 30, page = 1): Promise<KugouTrack[]> {
  const body = await kugouRequest('/api/v3/search/song', {
    keyword,
    pagesize: limit,
    page,
    showtype: 14,
    highlight: 'em',
    tag_aggr: 1,
    tagtype: '全部',
    sver: 5,
  }, { base: SEARCH_HOST, router: SEARCH_ROUTER });
  assertKugouOk(body);
  const list: any[] =
    body?.data?.info ||
    body?.data?.data ||
    body?.data?.list ||
    body?.info ||
    (Array.isArray(body?.data) ? body.data : []) ||
    [];
  return list.map(mapTrack).filter((t: KugouTrack) => t.hash);
}
function mapTrack(s: any): KugouTrack {
  // 搜索/歌单/榜单返回字段各异，做兼容
  const hash = s.hash || s.fileHash || s.audio_hash || s.HASH || '';
  const name = s.songname || s.audio_name || s.filename || s.name || '未知歌曲';

  // 歌手：优先 s.singername 字符串；其次 s.singers 数组；再次 s.singer / s.author_name
  let artist = '';
  if (typeof s.singername === 'string' && s.singername) artist = s.singername;
  else if (typeof s.singer === 'string' && s.singer) artist = s.singer;
  else if (typeof s.author_name === 'string' && s.author_name) artist = s.author_name;
  else if (Array.isArray(s.singers) && s.singers.length > 0) {
    artist = s.singers.map((a: any) => (a && a.name) || a).filter(Boolean).join('/');
  }

  // 有些老接口 filename = "歌名 - 歌手"，可作为歌手兜底
  if (!artist && typeof s.filename === 'string') {
    const parts = s.filename.split(' - ');
    if (parts.length >= 2) artist = parts[parts.length - 1].trim();
  }

  return {
    id: hash || String(s.audit_get_publish_time || s.id || ''),
    name,
    artist: artist || '未知歌手',
    album: s.album_name || s.albumname || s.album || '',
    duration: (s.duration || s.timelength || s.timeLength || 0) * 1000 || 0,
    cover: s.album_img || s.img || s.cover || s.photo || s.album_img_9x9 || '',
    hash,
    albumId: s.album_id ? Number(s.album_id) : undefined,
    singerId: s.singer_id ? Number(s.singer_id) : undefined,
  };
}

// 获取播放 URL + 内联歌词（酷狗 play/getdata，返回直链；试听为低码率片段）
// 该接口为网页端接口，必须所有 URL 参数参与 signature 签名，并带上 cookie dfid。
export async function getSongUrl(hash: string, albumId?: number): Promise<{ url: string; br: number }> {
  const dev = getDevice();
  const params: Record<string, any> = {
    r: 'play/getdata',
    hash,
    album_id: albumId || 0,
    platid: 4,
    userid: '0',
  };
  const body = await kugouRequest(
    '/yy/index.php',
    params,
    {
      base: WWWAPI,
      salt: KUGOU_WEB_SALT,
      cookie: `kg_mid=${dev.mid}; kg_dfid=${dev.dfid}`,
      referer: 'https://www.kugou.com/',
    },
  );
  const d = body?.data || {};
  const url = d.play_url || d.play_backup_url || d.url || '';
  const br = d.bitrate ? Number(d.bitrate) : 0;
  console.log('[kugou-diag] play/getdata hash=', hash, 'albumId=', albumId, 'status=', body?.status, 'errcode=', body?.errcode, 'err_code=', d.err_code, 'play_url=', url ? 'OK' : 'EMPTY', 'keys=', d && typeof d === 'object' ? Object.keys(d).slice(0, 30).join(',') : '-', 'raw=', JSON.stringify(body).slice(0, 500));
  return { url, br };
}

// 获取歌词：优先从 play/getdata 返回内联歌词（已可读文本），免去独立 KRC 接口与解密。
export async function getLyric(hash: string): Promise<{ lyric: string; trans?: string }> {
  const dev = getDevice();
  const body = await kugouRequest(
    '/yy/index.php',
    { r: 'play/getdata', hash, dfid: dev.dfid, mid: dev.mid, appid: APPID, _: Date.now() },
    { base: WWWAPI },
  );
  const d = body?.data || {};
  const lyric = d.lyrics || '';
  const trans = d.trans || '';
  return { lyric, trans };
}

// 获取歌单歌曲列表（酷狗 m.kugou.com/plist/list/{id}?json=true 老式接口，免签名）
export async function getPlaylist(specialId: number, page = 1, pagesize = 30): Promise<KugouTrack[]> {
  const body = await kugouRequest(`/plist/list/${specialId}`, {
    json: 'true',
    page,
    pagesize,
  }, { base: M_HOST });
  // 老接口返回结构：body.list.list = [...]
  const list = body?.list?.list || body?.data?.info || [];
  return list.map(mapTrack).filter((t: KugouTrack) => t.hash);
}

// 获取榜单歌曲（酷狗 /api/v3/rank/song，rankid 常见：飙升 6666 / 热歌 6668 / 新歌 6667）
export async function getTopList(rankId: number, page = 1, pagesize = 30): Promise<KugouTrack[]> {
  const body = await kugouRequest('/api/v3/rank/song', {
    rankid: rankId,
    ranktype: 2,
    page,
    pagesize,
  }, { router: RANK_ROUTER });
  assertKugouOk(body);
  const list: any[] =
    body?.data?.info ||
    body?.data?.list ||
    body?.info ||
    (Array.isArray(body?.data) ? body.data : []) ||
    [];
  return list.map(mapTrack).filter((t: KugouTrack) => t.hash);
}

// 榜单列表（用于侧栏/选择）
export async function getRankList(): Promise<KugouPlaylistCard[]> {
  const body = await kugouRequest('/api/v3/rank/list', {
    version: '9108',
    showtype: 2,
    parentid: 0,
    apiver: 6,
    withsong: 1,
  }, { router: RANK_ROUTER });
  assertKugouOk(body);
  // 兼容多种返回结构：data.info / data.list / data.rank / 顶层直接数组
  const list: any[] =
    body?.data?.info ||
    body?.data?.list ||
    body?.data?.rank ||
    body?.info ||
    body?.list ||
    (Array.isArray(body?.data) ? body.data : []) ||
    [];
  return list.map((r: any) => ({
    id: r.rankid ?? r.id,
    name: r.rankname ?? r.name ?? r.rank_name,
    cover: r.bannerurl || r.imgurl || '',
    creator: r.intro,
  }));
}

// 由播放地址接口返回的实际码率推断音质标签
export function qualityLabelFromBr(br: number): string {
  if (br >= 2000000) return 'Hi-Res';
  if (br >= 999000) return '无损';
  if (br >= 320000) return '高品质';
  if (br > 0) return '标准';
  return '';
}

// 由 fee / 码率推断徽章（酷狗无显式 fee，这里以码率近似：>=999000 标无损）
export interface TrackBadge { label: string; kind: 'vip' | 'lossless' | 'hires'; }
export function kugouTrackBadges(t: KugouTrack): TrackBadge[] {
  const out: TrackBadge[] = [];
  // 试听片段不足以标无损，这里留空；真实音质在 getSongUrl 后由 qualityLabelFromBr 给出
  return out;
}

// 重新导出一个便捷对象（与 netease 模块的导出名对齐，便于视图层 import）
export const kugou = {
  searchSongs,
  getSongUrl,
  getLyric,
  getPlaylist,
  getTopList,
  getRankList,
  qualityLabelFromBr,
  kugouTrackBadges,
};
