// 酷狗音乐 API 层（对齐 neteaseApi.ts 范式）
//
// 加密在 kugouCrypto.ts 完成（MD5 盐签名），本层负责：
//   - 统一请求 helper（拼 query + signature + POST body，经宿主 kugou_http_post 代理转发）
//   - 游客态设备标识（dfid/mid/uuid）持久化
//   - 搜索 / 播放 URL / 歌词 / 歌单 / 榜单 业务函数
//   - KugouTrack 等类型（形状对齐 NeteaseTrack，便于视图层共用渲染）
//
// 当前接口对齐社区维护中的 kugou_api（Dart）：
//   - 搜索：gateway /v3/search/song + Android 签名
//   - 播放：gateway /v5/url + key 签名
//   - 榜单：gateway /ocean/v6/rank/list、/ocean/v6/rank/info
//   - 我的歌单：gateway /v7/get_all_list（POST body + Android 签名）
//   - 歌单歌曲：gateway /pubsongs/v2/get_other_list_file_nofilt

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => ({}) };
import {
  makeKugouDevice,
  kugouSign,
  kugouInfSign,
  KUGOU_WEB_SALT,
  kugouAndroidSign,
  kugouKeySign,
  KUGOU_ANDROID_APPID,
  KUGOU_ANDROID_CLIENTVER,
} from './kugouCrypto';

// ============ 常量 ============
const GATEWAY = 'https://gateway.kugou.com';
const MOBILE_HOST = 'http://mobilecdn.kugou.com';
const WWWAPI = 'https://wwwapi.kugou.com';
const LYRICS_HOST = 'https://lyrics.kugou.com';
const REFERER = 'https://www.kugou.com/';
// 伪造国内出口 IP，避免非 CN 出口被拦
const REAL_IP = '113.66.232.251';
// Android 客户端 UA（当前公开客户端实现使用的形态）
const UA_ANDROID = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// 旧移动端接口公共参数（mobilecdn.kugou.com 直连可用，免签名）
const APPID = '1014';

// ============ 游客态设备标识持久化 ============
// 同时被 kugouAuth.ts 复用（扫码登录需同一设备标识），故 export
export function getDevice(): { dfid: string; mid: string; uuid: string; clienttime: number } {
  const cached = localStorage.getItem('kugou-device');
  if (cached) {
    try {
      const d = JSON.parse(cached);
      // 旧版 dfid === mid 或 clienttime 为毫秒时间戳（>1e11）的缓存都要丢弃重生成。
      if (
        d &&
        typeof d === 'object' &&
        d.dfid &&
        d.mid &&
        d.dfid !== d.mid &&
        d.uuid &&
        d.clienttime &&
        d.clienttime < 100000000000
      ) {
        return d;
      }
    } catch { /* fallthrough */ }
  }
  const d = makeKugouDevice();
  localStorage.setItem('kugou-device', JSON.stringify(d));
  return d;
}

// ============ 旧移动端请求 helper（mobilecdn / wwwapi 直连，免签名或 Web 签名） ============
interface KugouLegacyRequestOpts {
  base?: string;
  cookie?: string;
  referer?: string;
  extra?: Record<string, string>;
  router?: string;
  salt?: string;
}

/**
 * 旧移动端接口：mobilecdn.kugou.com 直连可免签名返回搜索/榜单；
 * wwwapi.kugou.com 的 play/getdata 需要 Web 签名。
 */
async function kugouLegacyRequest(
  path: string,
  params: Record<string, any>,
  opts: KugouLegacyRequestOpts = {},
): Promise<any> {
  const dev = getDevice();
  const merged: Record<string, any> = {
    appid: APPID,
    version: '9108',
    plat: '0',
    area_code: '1',
    with_res_tag: '1',
    clienttime: Date.now(),
    mid: dev.mid,
    dfid: dev.dfid,
    uuid: dev.mid,
    ...params,
  };
  const cleaned: Record<string, any> = {};
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined || merged[k] === null || merged[k] === '') continue;
    cleaned[k] = merged[k];
  }

  let signedQuery = '';
  if (opts.salt) {
    const signature = kugouSign(cleaned, opts.salt);
    signedQuery = `&signature=${encodeURIComponent(signature)}`;
  }

  const query = Object.keys(cleaned)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(cleaned[k])}`)
    .join('&');
  const url = `${opts.base || MOBILE_HOST}${path}?${query}${signedQuery}`;

  const extra: Record<string, string> = { ...(opts.extra || {}) };
  if (opts.router) extra['x-router'] = opts.router;

  const raw: string = await hostApi.invoke<string>('kugou_http_post', {
    method: 'GET',
    url,
    body: '',
    cookie: opts.cookie || undefined,
    referer: opts.referer || REFERER,
    origin: undefined,
    real_ip: REAL_IP,
    user_agent: UA_WEB,
    headers: extra,
  });
  return parseKugouRaw(raw);
}

// 原始文本 GET（用于 MV 页面 HTML 解析）
async function kugouRawGet(path: string, base: string): Promise<string> {
  const raw: string = await hostApi.invoke<string>('kugou_http_post', {
    method: 'GET',
    url: `${base}${path}`,
    body: '',
    cookie: undefined,
    referer: REFERER,
    origin: undefined,
    real_ip: REAL_IP,
    user_agent: UA_WEB,
    headers: {},
  });
  const parsed = JSON.parse(raw || '{}');
  return typeof parsed.body === 'string' ? parsed.body : '';
}

// 已签名 GET（MV 接口用），可带额外 header（如 x-router）
async function kugouSignedGet(url: string, extraHeaders: Record<string, string> = {}): Promise<any> {
  const raw: string = await hostApi.invoke<string>('kugou_http_post', {
    method: 'GET',
    url,
    body: '',
    cookie: undefined,
    referer: REFERER,
    origin: undefined,
    real_ip: REAL_IP,
    user_agent: UA_WEB,
    headers: extraHeaders,
  });
  return parseKugouRaw(raw);
}

function toQuery(obj: Record<string, any>): string {
  return Object.keys(obj)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k])}`)
    .join('&');
}

// ============ 请求 helper ============
interface KugouRequestOpts {
  base?: string;
  method?: 'GET' | 'POST';
  /** POST 请求体，对象会被 JSON.stringify，字符串原样发送。 */
  body?: Record<string, any> | string;
  cookie?: string;
  referer?: string;
  /** 额外请求头（会覆盖 Rust 侧默认头）。 */
  extra?: Record<string, string>;
  /** gateway 的 x-router 值。 */
  router?: string;
  /** 登录态：自动把 userid/token 放进 query/签名。 */
  auth?: KugouAuth | null;
  /** 使用 Android 签名（默认 true，业务接口都走这个）。 */
  android?: boolean;
  /** 使用 Web 签名（登录/二维码用）。 */
  web?: boolean;
  /** Web 盐覆盖。 */
  salt?: string;
  /** 是否计算 /v5/url 的 key 参数。 */
  signKey?: boolean;
  /** 跳过签名。 */
  notSignature?: boolean;
  /** 不注入默认设备参数（歌词接口等纯参数接口用）。 */
  clearDefaultParams?: boolean;
}

/**
 * 统一酷狗请求：拼默认参数 + 业务参数 + signature，经宿主代理转发。
 */
async function kugouRequest(
  path: string,
  params: Record<string, any>,
  opts: KugouRequestOpts = {},
): Promise<any> {
  const dev = getDevice();
  const clienttime = Math.floor(Date.now() / 1000);
  const allParams: Record<string, any> = opts.clearDefaultParams
    ? {}
    : {
        dfid: dev.dfid,
        mid: dev.mid,
        uuid: dev.uuid,
        appid: KUGOU_ANDROID_APPID,
        clientver: KUGOU_ANDROID_CLIENTVER,
        clienttime,
      };
  Object.assign(allParams, params);

  if (opts.auth?.userid && opts.auth?.token) {
    allParams.userid = Number(opts.auth.userid) || opts.auth.userid;
    allParams.token = opts.auth.token;
  }

  if (opts.signKey) {
    const hash = String(allParams.hash || allParams.file_hash || '');
    allParams.key = kugouKeySign(
      hash,
      dev.mid,
      allParams.userid || 0,
      allParams.appid || KUGOU_ANDROID_APPID,
    );
  }

  const bodyString = opts.body == null ? '' : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);

  if (!opts.notSignature) {
    if (opts.web || opts.salt) {
      allParams.signature = kugouSign(allParams, opts.salt || KUGOU_WEB_SALT);
    } else {
      allParams.signature = kugouAndroidSign(allParams, bodyString);
    }
  }

  const query = Object.keys(allParams)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');
  const url = `${opts.base || GATEWAY}${path}?${query}`;

  const extra: Record<string, string> = { ...(opts.extra || {}) };
  if (opts.router) extra['x-router'] = opts.router;
  // Android 风格设备头（网关/风控会看；歌词等纯参数接口也会带上）
  extra['dfid'] = dev.dfid;
  extra['clienttime'] = String(clienttime);
  extra['mid'] = dev.mid;
  if (!('kg-rc' in extra)) extra['kg-rc'] = '1';
  if (!('kg-thash' in extra)) extra['kg-thash'] = '5d816a0';
  if (!('kg-rec' in extra)) extra['kg-rec'] = '1';
  if (!('kg-rf' in extra)) extra['kg-rf'] = 'B9EDA08A64250DEFFBCADDEE00F8F25F';
  if (opts.body != null && typeof opts.body === 'object') {
    extra['Content-Type'] = 'application/json';
  }

  const raw: string = await hostApi.invoke<string>('kugou_http_post', {
    method: opts.method || 'GET',
    url,
    body: bodyString,
    cookie: opts.cookie || undefined,
    referer: opts.referer || REFERER,
    origin: undefined,
    real_ip: REAL_IP,
    user_agent: opts.web ? UA_WEB : UA_ANDROID,
    headers: extra,
  });
  return parseKugouRaw(raw);
}

/**
 * 解析 kugou_http_post 返回的原始字符串。
 */
function parseKugouRaw(raw: string): any {
  const parsed = JSON.parse(raw || '{}');
  if (parsed.status && parsed.status !== 200) {
    console.warn('[kugou] proxy status', parsed.status, 'body', String(parsed.body || '').slice(0, 200));
  }
  if (typeof parsed.body === 'string') {
    try {
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
  hash320?: string;    // 320k 音质 hash
  sqHash?: string;     // 无损音质 hash
  mvHash?: string;     // MV hash（若搜索接口返回）
  albumId?: number;
  albumAudioId?: number;
  singerId?: number;
}

export interface KugouPlaylistCard {
  id: number;
  gid?: string;        // global_collection_id（歌单歌曲接口需要）
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

function assertKugouOk(body: any, label = 'kugou'): any {
  if (!body) return body;
  const errcode = body.errcode ?? body.error_code ?? body.status ?? 0;
  if (errcode && errcode !== 0 && errcode !== 1 && errcode !== 200) {
    const extra = body.errmsg || body.error_msg || body.message || body.tip || '';
    if (errcode === 20017) {
      throw new Error(`登录态已过期或不适用于该接口[${label}:20017]，请退出登录后重新扫码登录。${extra}`);
    }
    throw new Error(`酷狗接口错误[${label}]: ${errcode} ${extra}`);
  }
  return body;
}

function stripHtml(v: any): string {
  if (!v) return '';
  return String(v).replace(/<\/?[^>]+>/g, '').trim();
}

function mapTrack(s: any): KugouTrack {
  const hash = s.hash || s.fileHash || s.audio_hash || s.HASH || '';
  const name = stripHtml(s.songname || s.songname_original || s.audio_name || s.song_name || s.filename || s.name || '未知歌曲');

  let artist = '';
  if (typeof s.singername === 'string' && s.singername) artist = s.singername;
  else if (typeof s.singer === 'string' && s.singer) artist = s.singer;
  else if (typeof s.author_name === 'string' && s.author_name) artist = s.author_name;
  else if (Array.isArray(s.singers) && s.singers.length > 0) {
    artist = s.singers.map((a: any) => (a && a.name) || a).filter(Boolean).join('/');
  }
  artist = stripHtml(artist);

  if (!artist && typeof s.filename === 'string') {
    const parts = s.filename.split(' - ');
    if (parts.length >= 2) artist = stripHtml(parts[parts.length - 1]);
  }

  return {
    id: hash || String(s.audit_get_publish_time || s.id || ''),
    name,
    artist: artist || '未知歌手',
    album: stripHtml(s.album_name || s.albumname || s.album || ''),
    duration: (s.duration || s.timelength || s.timeLength || 0) * 1000 || 0,
    cover: kugouImg(s.album_img || s.img || s.cover || s.photo || s.album_img_9x9 || s.trans_param?.union_cover || '', 240),
    hash,
    hash320: s['320hash'] || s.hash_320 || undefined,
    sqHash: s.sqhash || s.hash_flac || undefined,
    mvHash: s.mvhash || s.mv_hash || undefined,
    albumId: s.album_id ? Number(s.album_id) : undefined,
    albumAudioId: s.album_audio_id ? Number(s.album_audio_id) : undefined,
    singerId: s.singer_id ? Number(s.singer_id) : undefined,
  };
}

// ============ 业务函数 ============

// 搜索歌曲（mobilecdn 直连，免签名，实测可用）
export async function searchSongs(keyword: string, limit = 30, page = 1): Promise<KugouTrack[]> {
  const body = await kugouLegacyRequest('/api/v3/search/song', {
    keyword,
    pagesize: limit,
    page,
    showtype: 14,
    highlight: 'em',
    tag_aggr: 1,
    tagtype: '全部',
    sver: 5,
  }, { base: MOBILE_HOST });
  assertKugouOk(body);
  const list: any[] = body?.data?.info || body?.info || body?.data?.lists || body?.lists || [];
  return list.map(mapTrack).filter((t: KugouTrack) => t.hash);
}

// 获取播放 URL（当前 Android /v5/url）
// quality: 'standard' | 'high' | 'lossless'，默认标准试听。
export async function getSongUrl(
  hash: string,
  albumId?: number,
  auth?: KugouAuth | null,
  quality: 'standard' | 'high' | 'lossless' = 'standard',
): Promise<{ url: string; br: number }> {
  const body = await kugouLegacyRequest('/app/i/getSongInfo.php', {
    cmd: 'playInfo',
    hash,
  }, { base: 'https://m.kugou.com' });

  const url = body?.url || (Array.isArray(body?.backup_url) ? body.backup_url[0] : body?.backup_url) || '';
  const br = Number(body?.bitRate || body?.bitrate || 0);
  const status = Number(body?.status ?? 0);

  try {
    const bodySample = JSON.stringify(body).slice(0, 800);
    (window as any).__HOST_API__?.invoke('debug_log', {
      msg: `[music-play] getSongInfo hash=${hash} albumId=${albumId} status=${status} url=${url ? 'OK' : 'EMPTY'} body=${bodySample}`,
    }).catch(() => {});
  } catch {}

  if (!url) {
    if (status === 0) {
      throw new Error('该歌曲暂无可播放地址（可能需会员或已下架）');
    }
    throw new Error(`该歌曲暂无可播放地址（status=${status}）`);
  }
  return { url, br };
}

// 获取歌词：lyrics.kugou.com/search + /download，LRC 内容 base64 解码（实测可用）
export async function getLyric(hash: string, keyword = ''): Promise<{ lyric: string; trans?: string }> {
  const searchBody = await kugouLegacyRequest('/search', {
    ver: 1,
    man: 'yes',
    client: 'pc',
    keyword: keyword || '',
    hash: hash || '',
    duration: 0,
  }, { base: LYRICS_HOST });
  const cand = searchBody?.candidates?.[0];
  if (!cand?.id || !cand?.accesskey) return { lyric: '' };

  const dlBody = await kugouLegacyRequest('/download', {
    ver: 1,
    client: 'pc',
    id: cand.id,
    accesskey: cand.accesskey,
    fmt: 'lrc',
    charset: 'utf8',
  }, { base: LYRICS_HOST });
  const content = dlBody?.content || '';
  if (!content) return { lyric: '' };
  try {
    const lrc = decodeURIComponent(escape(atob(content)));
    return { lyric: lrc, trans: dlBody?.trans ? decodeURIComponent(escape(atob(dlBody.trans))) : undefined };
  } catch {
    return { lyric: content };
  }
}

// ========== MV 播放 ==========
// 1) 通过 mvhash 抓 MV 页面 HTML，解析 encode_mvid
// 2) play/mv 拿到 h264 各音质 hash
// 3) v2/interface/index 换取 MP4 直链
export async function getMvUrl(mvHash: string): Promise<string> {
  const dev = getDevice();
  const html = await kugouRawGet(`/mvweb/html/mv_${mvHash}.html`, 'https://www.kugou.com');
  const encMatch = html.match(/var encode_mvid = "([^"]+)"/);
  const encId = encMatch?.[1];
  if (!encId) throw new Error('未能解析酷狗 MV 页面 id');

  const mvParams = { id: encId, clientver: '1000' };
  const mvSigned = kugouInfSign(mvParams, undefined, { mid: dev.mid, dfid: dev.dfid });
  const mvInfo = await kugouSignedGet(`https://wwwapi.kugou.com/play/mv?${toQuery(mvSigned)}`);
  const h264 = mvInfo?.data?.info?.h264;
  const hash = h264?.fhd_hash || h264?.hd_hash || h264?.qhd_hash || h264?.sd_hash || h264?.ld_hash;
  if (!hash) throw new Error('未获取到 MV 播放 hash');

  const urlParams = {
    cmd: 123,
    ext: 'mp4',
    hash,
    ismp3: 0,
    key: 'kugoumvcloud',
    pid: 6,
    ssl: 1,
    appid: '1014',
    clientver: '20000',
  };
  const urlSigned = kugouInfSign(urlParams, undefined, { mid: dev.mid, dfid: dev.dfid });
  const v2 = await kugouSignedGet(
    `https://gateway.kugou.com/v2/interface/index?${toQuery(urlSigned)}`,
    { 'x-router': 'trackermv.kugou.com' },
  );
  if (v2?.status !== 1) throw new Error('MV 取流失败：' + (v2?.msg || v2?.error_msg || v2?.status));
  for (const key of Object.keys(v2?.data || {})) {
    const downurl = v2.data[key]?.downurl;
    if (downurl) return downurl;
  }
  throw new Error('MV 响应中没有可用播放地址');
}

// 获取歌单歌曲列表（当前 /pubsongs/v2/get_other_list_file_nofilt）
async function getPlaylistTracks(globalCollectionId: string, page = 1, pagesize = 30): Promise<KugouTrack[]> {
  const body = await kugouRequest('/pubsongs/v2/get_other_list_file_nofilt', {
    area_code: 1,
    begin_idx: (page - 1) * pagesize,
    plat: 1,
    type: 1,
    mode: 1,
    personal_switch: 1,
    extend_fields: 'abtags,hot_cmt,popularization',
    pagesize,
    global_collection_id: globalCollectionId,
  });
  assertKugouOk(body, 'get_other_list_file_nofilt');
  const list: any[] = body?.songs || body?.data?.songs || body?.data?.info || [];
  return list.map(mapTrack).filter((t: KugouTrack) => t.hash);
}

// 对外歌单歌曲列表（兼容旧签名：specialId 作为 global_collection_id 传入）
export async function getPlaylist(specialId: number, page = 1, pagesize = 30): Promise<KugouTrack[]> {
  return getPlaylistTracks(String(specialId), page, pagesize);
}

// 获取榜单歌曲（mobilecdn /api/v3/rank/song）
export async function getTopList(rankId: number, page = 1, pagesize = 30): Promise<KugouTrack[]> {
  const body = await kugouLegacyRequest('/api/v3/rank/song', {
    rankid: rankId,
    ranktype: 2,
    page,
    pagesize,
  }, { base: MOBILE_HOST });
  assertKugouOk(body, 'rank/song');
  const list: any[] = body?.data?.info || body?.info || body?.data?.songs || body?.songs || [];
  return list.map(mapTrack).filter((t: KugouTrack) => t.hash);
}

// 榜单列表（mobilecdn /api/v3/rank/list）
export async function getRankList(): Promise<KugouPlaylistCard[]> {
  const body = await kugouLegacyRequest('/api/v3/rank/list', {
    version: '9108',
    showtype: 2,
    parentid: 0,
    apiver: 6,
    withsong: 1,
  }, { base: MOBILE_HOST });
  assertKugouOk(body, 'rank/list');
  const list: any[] = body?.data?.info || body?.info || body?.data?.rank || body?.rank || body?.list || [];
  return list.map((r: any) => ({
    id: Number(r.rankid ?? r.id ?? 0),
    name: r.rankname ?? r.name ?? r.rank_name,
    cover: kugouImg(r.imgurl || r.bannerurl || '', 240),
    creator: r.intro,
    playCount: Number(r.play_times || r.total || r.play_count || r.count || 0),
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

// 图片地址安全化
export function kugouImg(url?: string, size = 240): string {
  if (!url) return '';
  const u = url.replace(/\{size\}/gi, String(size));
  if (/^https?:\/\//i.test(u)) return u;
  if (/^\/\//.test(u)) return 'https:' + u;
  return '';
}
export function safeImg(url?: string): string {
  return kugouImg(url, 240);
}

// ========== 登录态 / 我的 ==========
export interface KugouAuth {
  userid: string;
  token: string;
  username?: string;
  nickname?: string;
  avatar?: string;
  vipType?: number;
}

export interface KugouProfile {
  userid: string;
  nickname: string;
  avatar: string;
  vipType: number;
  signature?: string;
}

export function getKugouAuth(): KugouAuth | null {
  try {
    const raw = localStorage.getItem('kugou.auth');
    if (!raw) return null;
    const a = JSON.parse(raw) as KugouAuth;
    if (a && a.userid && a.token) return a;
    return null;
  } catch {
    return null;
  }
}

export function setKugouAuth(auth: KugouAuth | null): void {
  if (auth) localStorage.setItem('kugou.auth', JSON.stringify(auth));
  else localStorage.removeItem('kugou.auth');
}

// 获取登录用户信息：扫码成功时已带 nickname/pic，直接使用本地缓存。
export async function getUserInfo(auth: KugouAuth): Promise<KugouProfile> {
  return {
    userid: auth.userid,
    nickname: auth.nickname || '酷狗用户',
    avatar: auth.avatar || '',
    vipType: auth.vipType || 0,
    signature: '',
  };
}

// 我的歌单（当前 /v7/get_all_list，POST + Android 签名）
export async function getUserPlaylists(auth: KugouAuth, pagesize = 50): Promise<KugouPlaylistCard[]> {
  const uid = Number(auth.userid) || auth.userid;
  const body = await kugouRequest('/v7/get_all_list', {
    plat: 1,
    userid: uid,
    token: auth.token,
  }, {
    method: 'POST',
    body: {
      userid: uid,
      token: auth.token,
      total_ver: 979,
      type: 2,
      page: 1,
      pagesize,
    },
    auth,
    router: 'cloudlist.service.kugou.com',
  });
  assertKugouOk(body, 'get_all_list');
  const list: any[] = body?.info || body?.data?.info || body?.list || [];
  return list.map((r: any) => ({
    id: Number(r.specialid ?? r.id ?? r.global_collection_id ?? 0),
    gid: String(r.global_collection_id ?? r.specialid ?? r.id ?? ''),
    name: r.specialname ?? r.name ?? '未命名歌单',
    cover: kugouImg(r.pic || r.imgurl || r.cover || '', 240),
    creator: r.nickname || r.username || '',
    playCount: Number(r.play_count || 0),
  }));
}

export interface KugouFavoritesResult {
  list: KugouTrack[];
  playlists: KugouPlaylistCard[];
}

// 一次拉取「我喜欢的音乐」与全量歌单
export async function getFavorites(auth: KugouAuth, pagesize = 50): Promise<KugouFavoritesResult> {
  const playlists = await getUserPlaylists(auth, pagesize);
  const liked = playlists.find(
    (p) => p.name.includes('我喜欢') || p.name.toLowerCase().includes('favorite') || p.name.includes('默认列表'),
  );
  let list: KugouTrack[] = [];
  if (liked) {
    list = await getPlaylistTracks(liked.gid || String(liked.id), 1, 200);
  }
  return { list, playlists };
}

export interface TrackBadge { label: string; kind: 'vip' | 'lossless' | 'hires'; }
export function kugouTrackBadges(t: KugouTrack): TrackBadge[] {
  return [];
}

// 重新导出一个便捷对象（与 netease 模块的导出名对齐）
export const kugou = {
  searchSongs,
  getSongUrl,
  getLyric,
  getPlaylist,
  getTopList,
  getRankList,
  qualityLabelFromBr,
  kugouTrackBadges,
  getUserInfo,
  getFavorites,
  getUserPlaylists,
  getMvUrl,
};
