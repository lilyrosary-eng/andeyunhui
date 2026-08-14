// 酷狗音乐 API 层（对齐 neteaseApi.ts 范式）
//
// 加密在 kugouCrypto.ts 完成（MD5 盐签名 signature），本层负责：
//   - 统一请求 helper（拼 query + signature，经宿主 kugou_http_post 代理转发）
//   - 游客态设备标识（dfid/mid/uuid）持久化
//   - 搜索 / 播放 URL / 歌词 / 歌单 / 榜单 业务函数
//   - KugouTrack 等类型（形状对齐 NeteaseTrack，便于视图层共用渲染）

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => ({}) };
import {
  makeKugouDevice,
  kugouSign,
  KUGOU_WEB_SALT,
  kugouAndroidSign,
  KUGOU_ANDROID_APPID,
  KUGOU_ANDROID_CLIENTVER,
} from './kugouCrypto';
import { assembleKugouCookie } from './kugouAuth';

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
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// 酷狗公共参数（CDN 接口需要的基础参数，含时间戳）
const APPID = '1014';

// ============ 游客态设备标识持久化 ============
// 同时被 kugouAuth.ts 复用（扫码登录需同一设备标识），故 export
export function getDevice(): { dfid: string; mid: string; uuid: string; clienttime: number } {
  const cached = localStorage.getItem('kugou-device');
  if (cached) {
    try {
      const d = JSON.parse(cached);
      // 旧版本曾让 dfid === mid（酷狗要求两者不同，否则 20006），
      // 这种非法缓存即使重启也会一直被读回，故检测到就丢弃重生成。
      if (d && typeof d === 'object' && d.dfid && d.mid && d.dfid !== d.mid && d.uuid) {
        return d;
      }
    } catch { /* fallthrough */ }
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

/**
 * 解析 kugou_http_post 返回的原始字符串（与 kugouRequest 共用同一逻辑）。
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

/**
 * Android 登录态私有接口请求。
 * 签名时把 POST JSON body 也参与 MD5，走 gateway.kugou.com + x-router 路由到对应后端。
 * 注意：扫码登录（login-user.kugou.com）返回的 token 属于网页/移动端登录态，
 * 与 cloudlist/pubsongs 私有接口的 Android token 不是同一体系，用这套签名会返回 20017。
 */
async function kugouAndroidRequest(
  path: string,
  data: Record<string, any>,
  auth: KugouAuth,
  router: string,
): Promise<any> {
  const dev = getDevice();
  const clienttime = Date.now();
  const params: Record<string, any> = {
    appid: KUGOU_ANDROID_APPID,
    clientver: KUGOU_ANDROID_CLIENTVER,
    clienttime,
    dfid: dev.dfid,
    mid: dev.mid,
    uuid: dev.uuid || '-',
    token: auth.token,
    userid: auth.userid,
  };
  const signature = kugouAndroidSign(params, data);
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const url = `https://gateway.kugou.com${path}?${query}&signature=${encodeURIComponent(signature)}`;

  const raw: string = await hostApi.invoke<string>('kugou_http_post', {
    method: 'POST',
    url,
    body: JSON.stringify(data),
    cookie: assembleKugouCookie(auth),
    referer: REFERER,
    origin: undefined,
    real_ip: REAL_IP,
    user_agent: ANDROID_UA,
    headers: {
      'x-router': router,
      'Content-Type': 'application/json',
    },
  });
  return parseKugouRaw(raw);
}

/**
 * 网页端登录态请求（与扫码登录态同体系）。
 * 走 gateway.kugou.com + x-router 路由到后端 CDN，使用网页端盐（NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt）
 * 对 query 参数做 MD5 签名（与 kugouRequest 同一套 kugouSign，不含 body），并带上 KuGoo Cookie。
 * 扫码登录返回的 userid/token 经由 KuGoo Cookie 由网关识别，可正常拉取「我的歌单/收藏」。
 */
async function kugouWebRequest(
  path: string,
  params: Record<string, any>,
  auth: KugouAuth,
  router: string,
): Promise<any> {
  const dev = getDevice();
  const common: Record<string, any> = {
    appid: APPID,
    version: '9108',
    plat: '0',
    area_code: '1',
    clienttime: dev.clienttime,
    mid: dev.mid,
    dfid: dev.dfid,
    uuid: dev.uuid,
    userid: auth.userid,
    token: auth.token,
  };
  const merged: Record<string, any> = { ...common, ...params };
  // 清理空值（与 kugouRequest 一致）
  const cleaned: Record<string, any> = {};
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined || merged[k] === null || merged[k] === '') continue;
    cleaned[k] = merged[k];
  }
  const signature = kugouSign(cleaned, KUGOU_WEB_SALT);
  const query = Object.keys(cleaned)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(cleaned[k])}`)
    .join('&');
  const url = `https://gateway.kugou.com${path}?${query}&signature=${encodeURIComponent(signature)}`;

  const raw: string = await hostApi.invoke<string>('kugou_http_post', {
    method: 'GET',
    url,
    body: '',
    cookie: assembleKugouCookie(auth),
    referer: REFERER,
    origin: undefined,
    real_ip: REAL_IP,
    user_agent: UA,
    headers: {
      'x-router': router,
    },
  });
  return parseKugouRaw(raw);
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


function assertKugouOk(body: any, label = 'kugou'): any {
  if (!body) return body;
  // 酷狗错误码：网页端用 errcode，Android 私有接口用 error_code，
  // 两者都要判，否则错误被吞成空数据（页面静默无反馈）。
  const errcode = body.errcode ?? body.error_code ?? 0;
  if (errcode && errcode !== 0 && errcode !== 200) {
    const extra = body.errmsg || body.error_msg || body.message || body.tip || '';
    if (errcode === 20017) {
      throw new Error(`登录态已过期或不适用于该接口[${label}:20017]，请退出登录后重新扫码登录。${extra}`);
    }
    throw new Error(`酷狗接口错误[${label}]: ${errcode} ${extra}`);
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
    cover: kugouImg(s.album_img || s.img || s.cover || s.photo || s.album_img_9x9 || '', 240),
    hash,
    albumId: s.album_id ? Number(s.album_id) : undefined,
    singerId: s.singer_id ? Number(s.singer_id) : undefined,
  };
}

// 获取播放 URL + 内联歌词（酷狗 play/getdata，返回直链；试听为低码率片段）
// 该接口为网页端接口，必须所有 URL 参数参与 signature 签名，并带上 cookie dfid。
// auth 可选：登录态时把真实 userid 带入，可绕过游客态 err_code=30020 的版权限制，
// 取到可用直链（至少标准音质试听）。游客态（auth 为空）回退 userid=0。
export async function getSongUrl(
  hash: string,
  albumId?: number,
  auth?: KugouAuth | null,
): Promise<{ url: string; br: number }> {
  const dev = getDevice();
  const params: Record<string, any> = {
    r: 'play/getdata',
    hash,
    album_id: albumId || 0,
    platid: 4,
    userid: auth?.userid ? String(auth.userid) : '0',
  };
  if (auth?.token) params.token = auth.token;
  // 登录态时附上 KuGoo Cookie，配合 userid/token 参数让网关识别登录态，
  // 否则 play/getdata 仍按游客处理，受版权限制返回 err_code 30020。
  const cookie = auth?.userid
    ? `${assembleKugouCookie(auth)}; kg_mid=${dev.mid}; kg_dfid=${dev.dfid}`
    : `kg_mid=${dev.mid}; kg_dfid=${dev.dfid}`;
  const body = await kugouRequest(
    '/yy/index.php',
    params,
    {
      base: WWWAPI,
      salt: KUGOU_WEB_SALT,
      cookie,
      referer: 'https://www.kugou.com/',
    },
  );
  const d = body?.data || {};
  const url = d.play_url || d.play_backup_url || d.url || '';
  const br = d.bitrate ? Number(d.bitrate) : 0;
  const errCode = d.err_code ?? body?.errcode ?? body?.status ?? 0;
  // 用 debug_log（Rust 转发，日志面板可靠可见）替代 console.log 做诊断埋点。
  try {
    const bodySample = JSON.stringify(body).slice(0, 800);
    (window as any).__HOST_API__?.invoke('debug_log', {
      msg: `[music-play] play/getdata hash=${hash} albumId=${albumId} uid=${params.userid} errCode=${errCode} play_url=${url ? 'OK' : 'EMPTY'} cookie=${auth?.userid ? 'with_KuGoo' : 'none'} body=${bodySample}`,
    }).catch(() => {});
  } catch {}
  // 明确抛出版权/会员限制错误，让 UI 显示可读提示而非静默 EMPTY。
  if (!url) {
    if (errCode === 30020) {
      throw new Error('该歌曲需登录或会员才能播放（酷狗版权限制 30020）');
    }
    throw new Error(`该歌曲暂无可播放地址（errCode=${errCode}，可能需会员或已下架）`);
  }
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
    cover: kugouImg(r.bannerurl || r.imgurl || '', 240),
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

// 图片地址安全化：酷狗接口返回的 pic/cover 有时是裸文件名或带 {size} 模板占位符。
// 先把 {size} 替换为具体尺寸（默认 240），再判断 URL 是否完整；不完整则返回空串，
// 由视图层用占位图兜底，避免整页 404 噪音。
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
// 酷狗登录态（扫码登录后返回的明文凭证，持久化到 localStorage）
export interface KugouAuth {
  userid: string;   // 用户 ID
  token: string;    // 登录令牌
  username?: string;
  nickname?: string;
  avatar?: string;
  vipType?: number; // 会员类型
}

// 用户信息（getUserInfo 返回）
export interface KugouProfile {
  userid: string;
  nickname: string;
  avatar: string;
  vipType: number;
  signature?: string;
}

// 读取本地持久化的登录态
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

// 持久化登录态
export function setKugouAuth(auth: KugouAuth | null): void {
  if (auth) localStorage.setItem('kugou.auth', JSON.stringify(auth));
  else localStorage.removeItem('kugou.auth');
}

// 获取登录用户信息。
// 扫码成功时 /v2/get_userinfo_qrcode 已返回 nickname/pic，优先用本地缓存；
// 如缓存中无昵称/头像则返回占位信息，避免调用已下线的 /up/index.php 导致 404。
export async function getUserInfo(auth: KugouAuth): Promise<KugouProfile> {
  return {
    userid: auth.userid,
    nickname: auth.nickname || '酷狗用户',
    avatar: auth.avatar || '',
    vipType: auth.vipType || 0,
    signature: '',
  };
}

// 获取歌单详情（登录态，网页端接口体系）。
// ids 为 specialid 数组，逐个请求并合并返回歌曲列表。
async function getPlaylistDetailAndroid(auth: KugouAuth, ids: number[]): Promise<KugouTrack[]> {
  const all: KugouTrack[] = [];
  for (const id of ids) {
    const body = await kugouWebRequest(
      '/v3/get_list_info',
      {
        specialid: id,
        type: 0,
        page: 1,
        pagesize: 200,
        userid: auth.userid,
        token: auth.token,
      },
      auth,
      'pubsongs.kugou.com',
    );
    assertKugouOk(body, 'get_list_info');
    // 返回结构：data[0].song_list 或 data[0].songs 或 data.song_list
    const songList: any[] =
      body?.data?.[0]?.song_list ||
      body?.data?.[0]?.songs ||
      body?.data?.song_list ||
      body?.data?.songs ||
      [];
    for (const t of songList.map(mapTrack).filter((t: KugouTrack) => t.hash)) {
      all.push(t);
    }
  }
  return all;
}

// 我的收藏（喜欢的音乐）。
// 先从「我的歌单」中找到「我喜欢的音乐」歌单，再拉取歌曲。
export interface KugouFavoritesResult {
  list: KugouTrack[];
  playlists: KugouPlaylistCard[];
}

// 一次拉取「我喜欢的音乐」(list) 与全量歌单 (playlists)，内部复用 getUserPlaylists 结果，
// 避免视图层同时调用 getFavorites + getUserPlaylists 导致 getUserPlaylists 发两次请求。
export async function getFavorites(auth: KugouAuth, pagesize = 50): Promise<KugouFavoritesResult> {
  const playlists = await getUserPlaylists(auth, pagesize);
  const liked = playlists.find(
    (p) => p.name.includes('我喜欢') || p.name.toLowerCase().includes('favorite') || p.name.includes('默认列表'),
  );
  let list: KugouTrack[] = [];
  if (liked) {
    list = await getPlaylistDetailAndroid(auth, [liked.id]);
  }
  return { list, playlists };
}

// 诊断日志：走 debug_log（Rust 转发，日志面板可靠可见），避免 console 桥接不稳定导致看不到。
function dlog(msg: string) {
  try { (window as any).__HOST_API__?.invoke('debug_log', { msg: `[music-mine] ${msg}` }).catch(() => {}); } catch {}
}

// 我的歌单（用户创建的歌单列表）
// 改用网页端接口体系（kugouWebRequest），与扫码登录态同体系，避免 Android 私有接口返回 20017。
export async function getUserPlaylists(auth: KugouAuth, pagesize = 50): Promise<KugouPlaylistCard[]> {
  dlog(`getUserPlaylists start uid=${auth.userid}`);
  const body = await kugouWebRequest(
    '/v7/get_all_list',
    {
      page: 1,
      pagesize,
      type: 0,
      userid: auth.userid,
      token: auth.token,
    },
    auth,
    'cloudlist.service.kugou.com',
  );
  dlog(`get_all_list raw=${JSON.stringify(body).slice(0, 600)}`);
  assertKugouOk(body, 'get_all_list');
  const list: any[] =
    body?.data?.info ||
    body?.data?.list ||
    body?.info ||
    body?.list ||
    [];
  dlog(`getUserPlaylists done count=${list.length}`);
  return list.map((r: any) => ({
    id: Number(r.specialid ?? r.id ?? 0),
    name: r.specialname ?? r.name ?? r.special_name ?? '未命名歌单',
    cover: kugouImg(r.imgurl || r.photo || r.cover || '', 240),
    creator: r.intro || r.username || '',
  }));
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
  getUserInfo,
  getFavorites,
  getUserPlaylists,
};
