/// <reference path="../global.d.ts" />

import CryptoJS from 'crypto-js';
import QRCode from 'qrcode';
import { weapi, eapi } from './neteaseCrypto';

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => ({}) };

// 参考 MusicStorm：伪造国内出口 IP 绕过非 CN 出口拦截。
// 会话级随机国内 IP（对齐 MusicStorm resolveRealIp）：会话内固定、随机国内段。
// 之前硬编码 113.66.253.18，反复调试后被网易云风控标记，触发 -460「网络环境存在风险」。
const REAL_IP: string = (() => {
  const prefixes = [
    '113.66', '116.25', '120.192', '183.0', '223.64', '112.64',
    '119.96', '36.248', '39.128', '42.80', '110.80', '171.104',
    '180.96', '182.96', '218.64', '61.128',
  ];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  const a = Math.floor(Math.random() * 254) + 1;
  const b = Math.floor(Math.random() * 254) + 1;
  return `${p}.${a}.${b}`;
})();
const REFERER = 'https://music.163.com';
const ORIGIN = 'https://music.163.com';
// weapi / eapi 分别使用贴合官方的 UA（参考 MusicStorm，避免中性 UA 触发风控）。
// weapi 用 Mac Edge 形态（网易云桌面端官方 UA，风控验证过）；之前用 Windows Chrome 116 被风控。
const UA_WEAPI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
// eapi 登录/写请求强制走 iPhone CloudMusic/9.0.90 形态（对齐 MusicStorm UA_EAPI_IPHONE），
// 这是网易云 eapi 风控验证过的 UA；非登录态用 PC 桌面端形态。
const UA_EAPI_IPHONE = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)';
const UA_EAPI_PC =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117';
// 遗留别名，仅 eapi 匿名注册回落处使用（等价 iPhone 形态）
const UA_EAPI = UA_EAPI_IPHONE;

let guestCookie: string | null = null;
let guestCsrf = '';
// 登录态 cookie（MUSIC_U; __csrf; ...），优先于游客态；持久化到 localStorage 实现免登录
let loginCookie: string | null = null;
const LOGIN_COOKIE_KEY = 'netease-login-cookie';

// 取 eapi 写操作所需的真实 __csrf：优先登录态 cookie 里的 __csrf，回落游客态 guestCsrf。
// 之前 eapi header 里 __csrf 写死为空 ''，导致收藏等写操作被服务端判定为异常请求而风控拦截。
function loginCsrfEapi(): string {
  if (!loginCookie) return guestCsrf;
  const m = loginCookie.match(/__csrf=([^;]+)/);
  return m ? m[1] : guestCsrf;
}

function loadLoginCookie(): void {
  try {
    const saved = window.localStorage.getItem(LOGIN_COOKIE_KEY);
    if (saved && saved.includes('MUSIC_U=')) loginCookie = saved;
  } catch { /* ignore */ }
}
function saveLoginCookie(): void {
  if (loginCookie) writeLocal(LOGIN_COOKIE_KEY, loginCookie);
}
// 从登录态 cookie 字符串（data.cookie 形如 "MUSIC_U=..; __csrf=..;"）提取并写入 loginCookie
export function setLoginCookieFromApi(cookieStr: string): void {
  if (!cookieStr) return;
  const parts = cookieStr.split(';').map((s) => s.trim()).filter(Boolean);
  const hasMusicU = parts.some((p) => p.startsWith('MUSIC_U='));
  const csrfPart = parts.find((p) => p.startsWith('__csrf='));
  const musicAPart = parts.find((p) => p.startsWith('MUSIC_A='));
  // 情况二：已登录，但只回吐了 __csrf（如登录后 weapi 请求的 Set-Cookie），需把配对的 __csrf 合并进 loginCookie。
  // 关键：weapi 写操作要求 csrf_token 与 cookie 里的 MUSIC_U 同源，否则服务端静默返回空 body 不落库（红心假成功根因）。
  if (!hasMusicU && loginCookie && loginCookie.includes('MUSIC_U=') && csrfPart) {
    if (!loginCookie.includes('__csrf=')) {
      loginCookie = `${loginCookie}; ${csrfPart}`;
      saveLoginCookie();
      console.log('[netease] 已把配对 __csrf 合并进登录 cookie');
    }
    guestCsrf = csrfPart.replace('__csrf=', '');
    return;
  }
  if (!hasMusicU) return;
  // 情况一：首次拿到 MUSIC_U（扫码 803）。保留 MUSIC_U/__csrf/MUSIC_A。
  const wanted = parts.filter((p) => p.startsWith('MUSIC_U=') || p.startsWith('__csrf=') || p.startsWith('MUSIC_A='));
  if (!wanted.length) return;
  loginCookie = wanted.join('; ');
  saveLoginCookie();
  // 同步刷新 guestCsrf（后续 weapi 加密的 csrf_token 用 __csrf 值）
  guestCsrf = csrfPart ? csrfPart.replace('__csrf=', '') : guestCsrf;
  console.log('[netease] 登录 cookie 已保存，长度', loginCookie.length);
}

// 登录成功后，用当前 MUSIC_U 发一次 weapi 请求，触发服务端回吐与 MUSIC_U 配对的 __csrf。
// 二维码登录的 803 通常只给 MUSIC_U、不给 __csrf；而 weapi 写操作（红心/每日推荐）要求 csrf 与 MUSIC_U 同源，
// 否则静默空 body（假成功）。该函数把配对 __csrf 合并进 loginCookie（经 setLoginCookieFromApi 情况二）。
export async function refreshLoginCsrf(): Promise<void> {
  if (!loginCookie || !loginCookie.includes('MUSIC_U=')) return;
  try {
    // 用 weapi 每日推荐接口（登录态）触发回吐配对 __csrf；失败不影响主流程（红心仍可能空 body，但至少不崩）。
    await post(PATHS.recommendSongs, { limit: 1 });
    console.log('[netease] refreshLoginCsrf 完成，loginCookie 含 __csrf?', loginCookie.includes('__csrf='));
  } catch (e) {
    console.warn('[netease] refreshLoginCsrf 调用失败（可忽略）', e);
  }
}

// 有时网易云 803 把 MUSIC_U 放在 HTTP 响应头 Set-Cookie 列表里，而不是 body.cookie。
// 这里直接从完整的 Set-Cookie 字符串数组中合并 MUSIC_U / __csrf。
export function setLoginCookieFromSetCookie(setCookies: string[]): void {
  if (!setCookies || !setCookies.length) return;
  const pick = (prefix: string): string | undefined =>
    setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith(prefix));
  const musicU = pick('MUSIC_U=');
  if (!musicU) return;
  const csrf = pick('__csrf=');
  const cookieStr = [musicU, csrf].filter(Boolean).join('; ');
  setLoginCookieFromApi(cookieStr);
}
export function getLoginCookie(): string | null {
  return loginCookie;
}
export function isLoggedIn(): boolean {
  return !!loginCookie && loginCookie.includes('MUSIC_U=');
}
export function logoutNetease(): void {
  loginCookie = null;
  try { window.localStorage.removeItem(LOGIN_COOKIE_KEY); } catch { /* ignore */ }
}
loadLoginCookie();

// ============ 稳定设备身份（对齐 MusicStorm deviceId 流程） ============
const DEVICE_ID_KEY = 'netease-device-id';
const ID_XOR_KEY = '3go8&$8*3*3h0k(2)2';

function readLocal(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
}
function randomHex(len: number, upper = false): string {
  const chars = upper ? '0123456789ABCDEF' : '0123456789abcdef';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
// 52 位大写 hex 设备指纹，全程稳定（与 MUSIC_A 绑定，错位会触发风控）
function getOrCreateDeviceId(): string {
  const existing = readLocal(DEVICE_ID_KEY);
  if (existing && /^[0-9A-Fa-f]{52}$/.test(existing)) return existing;
  const next = randomHex(52, true);
  writeLocal(DEVICE_ID_KEY, next);
  return next;
}
// 对齐 CloudMusicAPI cloudmusicDllEncodeId：XOR + MD5 + Base64
function cloudmusicDllEncodeId(deviceId: string): string {
  let xored = '';
  for (let i = 0; i < deviceId.length; i++) {
    const code = deviceId.charCodeAt(i) ^ ID_XOR_KEY.charCodeAt(i % ID_XOR_KEY.length);
    xored += String.fromCharCode(code);
  }
  const digest = CryptoJS.MD5(CryptoJS.enc.Utf8.parse(xored));
  return CryptoJS.enc.Base64.stringify(digest);
}
// 匿名注册用户名：BASE64(deviceId + ' ' + encodeId)
function buildAnonymousUsername(deviceId: string): string {
  const encoded = `${deviceId} ${cloudmusicDllEncodeId(deviceId)}`;
  return CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(encoded));
}

// 对齐 MusicStorm：eapi 注册需要携带 header（含设备信息），否则服务端静默空响应
function genRequestId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out + Date.now();
}
function buildEapiHeader(deviceId: string): Record<string, any> {
  // 对齐 MusicStorm/CloudMusicAPI：eapi 的 MUSIC_U / MUSIC_A / __csrf 必须以明文
  // 作为 header 字段参与 MD5 签名，服务端才认这条写操作（否则静默拒写）。
  const header: Record<string, any> = {
    osver: 'Microsoft-Windows-10-Pro-Edition-build-19041-64bit',
    deviceId,
    appver: '3.1.17.204416',
    versioncode: '140',
    mobilename: 'Windows',
    buildver: '19041',
    resolution: '1920x1080',
    os: 'pc',
    channel: 'netease',
    requestId: genRequestId(),
  };
  const csrf = loginCsrfEapi();
  if (loginCookie) {
    const mu = loginCookie.match(/MUSIC_U=([^;]+)/);
    if (mu) header.MUSIC_U = mu[1];
    // 登录态下 Set-Cookie 经常不返 MUSIC_A，而设备 cookie（guestCookie）里有；
    // MusicStorm 会一并注入，服务端 eapi 写请求 header 签名需要它，否则风控/静默拒写。
    const ma = loginCookie.match(/MUSIC_A=([^;]+)/) || guestCookie?.match(/MUSIC_A=([^;]+)/);
    if (ma) header.MUSIC_A = ma[1];
    if (csrf) header.__csrf = csrf;
  } else if (guestCookie) {
    const ma = guestCookie.match(/MUSIC_A=([^;]+)/);
    if (ma) header.MUSIC_A = ma[1];
    if (csrf) header.__csrf = csrf;
  }
  return header;
}

// 从响应 Set-Cookie 列表里挑出需要的字段，合并回 guestCookie / guestCsrf
function absorbCookies(cookies: string[] = []): void {
  if (!cookies || !cookies.length) return;
  const pick = (prefix: string): string | undefined =>
    cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith(prefix));
  const musicA = pick('MUSIC_A=');
  const nmtid = pick('NMTID=');
  const csrf = pick('__csrf=');
  if (csrf) guestCsrf = csrf.replace('__csrf=', '');
  const parts = [musicA, nmtid].filter(Boolean);
  if (guestCookie) parts.push(guestCookie);
  if (parts.length) guestCookie = [...new Set(parts.join('; ').split('; '))].join('; ');
}

// 从响应 body（JSON 中的 cookie 字符串）里再取一次 MUSIC_A（部分接口 body 带 cookie）
// 兼容 weapi 直接返回 {cookie:"MUSIC_A=..."} 与 eapi 返回 {result:{cookie,token}} 两种结构
function absorbBodyCookie(body: any): void {
  if (!body || typeof body !== 'object') return;
  const obj: any = body.result && typeof body.result === 'object' ? body.result : body;
  const c = obj.cookie;
  if (typeof c === 'string' && c.includes('MUSIC_A=')) {
    const m = c.match(/MUSIC_A=([^;]+)/);
    if (m && !guestCookie?.includes('MUSIC_A=')) {
      guestCookie = `MUSIC_A=${m[1]}; ${guestCookie || ''}`.trim();
    }
  }
  // eapi 还会回传 token，保留备用（登录态/二次校验可能用到）
  if (typeof obj.token === 'string' && obj.token) {
    const tk = `ANON_TOKEN=${obj.token}`;
    if (!guestCookie?.includes('ANON_TOKEN=')) {
      guestCookie = `${guestCookie ? guestCookie + '; ' : ''}${tk}`;
    }
  }
}

// 对齐 MusicStorm：注册时携带完整设备 cookie jar（不仅是 NMTID）
// 缺这些字段会导致服务端静默返回空体（200 但 body 为空、无 Set-Cookie）
function buildDeviceCookieJar(deviceId: string): string {
  const nmtid = readLocal('netease-nmtid') || '';
  const wnmcid = readLocal('netease-wnmcid') || randomHex(32);
  const wevnsm = readLocal('netease-wevnsm') || randomHex(32);
  const ntesNuid = readLocal('netease-ntes-nuid') || randomHex(32);
  const ntesNnid = readLocal('netease-ntes-nnid') || randomHex(32);
  if (!readLocal('netease-wnmcid')) writeLocal('netease-wnmcid', wnmcid);
  if (!readLocal('netease-wevnsm')) writeLocal('netease-wevnsm', wevnsm);
  if (!readLocal('netease-ntes-nuid')) writeLocal('netease-ntes-nuid', ntesNuid);
  if (!readLocal('netease-ntes-nnid')) writeLocal('netease-ntes-nnid', ntesNnid);
  const parts = [
    `_ntes_nuid=${ntesNuid}`,
    `_ntes_nnid=${ntesNnid}`,
    `WNMCID=${wnmcid}`,
    `WEVNSM=${wevnsm}`,
    `__remember_me=true`,
    `ntes_kaola_ad=${wnmcid}`,
    `os=pc`,
    `appver=3.1.17.204416`,
    `osver=Microsoft-Windows-10-Pro-Edition-build-19041-64bit`,
    `resolution=1920x1080`,
    `channel=netease`,
    `deviceId=${deviceId}`,
  ];
  if (nmtid) parts.push(`NMTID=${nmtid}`);
  return parts.join('; ');
}

async function tryRegister(
  url: string,
  cookie: string,
  ua: string,
  makeBody: () => Promise<string>,
): Promise<any> {
  const body = await makeBody();
  const raw: string = await hostApi.invoke('netease_register_guest', {
    url, body, cookie, referer: REFERER, origin: ORIGIN, real_ip: REAL_IP, user_agent: ua,
  });
  return JSON.parse(raw || '{}');
}

export async function ensureGuest(): Promise<void> {
  // 注意：已登录态仍需游客 MUSIC_A 设备 token（与 MUSIC_U 不同源，但 weapi 写操作需要它）。
  // 之前因「已登录就跳过游客态」导致 post() 的 weapi cookie 缺 MUSIC_A，红心等写操作被服务端静默空 body。
  // 仅当已持有 MUSIC_A 才跳过；登录态若没有 MUSIC_A，仍走匿名注册只取设备 token。
  if (guestCookie && guestCookie.includes('MUSIC_A=')) return;
  try {
    const deviceId = getOrCreateDeviceId();
    const username = buildAnonymousUsername(deviceId);
    const jar = buildDeviceCookieJar(deviceId);

    // 通道一：weapi 匿名注册
    let parsed = await tryRegister(
      'https://music.163.com/weapi/register/anonimous',
      jar,
      UA_WEAPI,
      async () => {
        const { params, encSecKey } = await weapi({ username });
        return `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`;
      },
    );
    console.log('[netease] register guest(weapi) status', parsed.status, 'cookies', parsed.cookies, 'body', String(parsed.body || '').slice(0, 200));

    // 通道二：weapi 空响应时回落 eapi 匿名注册（interfacepc，iPhone UA）
    if ((!parsed.body || !String(parsed.body).trim()) && (!parsed.cookies || !parsed.cookies.length)) {
      const header = buildEapiHeader(deviceId);
      parsed = await tryRegister(
        'https://interfacepc.music.163.com/eapi/register/anonimous',
        jar,
        UA_EAPI,
        async () => {
          const { params } = await eapi('/api/register/anonimous', { username, header });
          return `params=${encodeURIComponent(params)}`;
        },
      );
      console.log('[netease] register guest(eapi) status', parsed.status, 'cookies', parsed.cookies, 'body', String(parsed.body || '').slice(0, 200));
    }

    if (parsed.cookies && parsed.cookies.length) {
      absorbCookies(parsed.cookies);
      const m = parsed.cookies.find((c: string) => c.startsWith('NMTID='));
      if (m) writeLocal('netease-nmtid', m.replace('NMTID=', '').split(';')[0]);
    }
    if (parsed.body) {
      try { absorbBodyCookie(JSON.parse(parsed.body)); } catch { /* ignore */ }
    }
    console.log('[netease] guest cookie set:', guestCookie);
    if (!guestCookie?.includes('MUSIC_A=')) {
      console.warn('[netease] 游客注册未拿到 MUSIC_A，body=', parsed.body);
    }
  } catch (e) {
    console.error('[netease] 游客注册失败', e);
    throw e;
  }
}

const EAPI_BASE = 'https://interfacepc.music.163.com';

// eapi 专用 POST：网易云登录/二维码相关接口现在必须走 eapi + interfacepc 域名
async function eapiPost(path: string, data: Record<string, any>, deviceId?: string): Promise<any> {
  const did = deviceId || getOrCreateDeviceId();
  const header = buildEapiHeader(did);
  const { params } = await eapi(path, data, header);
  const endpoint = path.replace(/^\/api/, '');
  const url = `${EAPI_BASE}/eapi${endpoint}`;
  const cookie = buildDeviceCookieJar(did);
  // 对齐 MusicStorm：登录态（有 MUSIC_U）eapi 请求 referer/origin 置 null、UA 用 iPhone 9.0.90；
  // 非登录态才带 music.163.com referer。去掉顶层重复的 __csrf（已在 header 签名体内）。
  const isLogin = !!loginCookie;
  const raw: string = await hostApi.invoke<string>('netease_http_post', {
    method: 'POST',
    url,
    body: `params=${encodeURIComponent(params)}`,
    cookie: loginCookie || cookie,
    referer: isLogin ? null : REFERER,
    origin: isLogin ? null : ORIGIN,
    real_ip: REAL_IP,
    user_agent: isLogin ? UA_EAPI_IPHONE : UA_EAPI_PC,
    headers: {
      ...header,
      'Request-Id': header.requestId,
    },
  });
  const parsed = JSON.parse(raw || '{}');
  if (parsed.status && parsed.status !== 200) {
    console.warn('[netease] eapi', path, 'status', parsed.status, 'body', String(parsed.body || '').slice(0, 200));
  }
  if (parsed.cookies && parsed.cookies.length) {
    absorbCookies(parsed.cookies);
    absorbBodyCookie(parsed.body);
    // 登录态 cookie（MUSIC_U）常在 Set-Cookie 头里返回，body 不一定含；自动持久化登录态
    const musicU = parsed.cookies.find((c: string) => c.startsWith('MUSIC_U='));
    if (musicU) {
      const csrf = parsed.cookies.find((c: string) => c.startsWith('__csrf='));
      setLoginCookieFromApi([musicU, csrf].filter(Boolean).join('; '));
    }
  }
  if (typeof parsed.body === 'string') {
    try { return JSON.parse(parsed.body); } catch { return { raw: parsed.body }; }
  }
  return parsed.body || {};
}

// 同 eapiPost，但额外返回原始 parsed 对象（含 cookies / body），供二维码登录后读取 Set-Cookie
async function eapiPostWithCookies(
  path: string,
  data: Record<string, any>,
  deviceId?: string,
): Promise<{ code: number; raw: any }> {
  const did = deviceId || getOrCreateDeviceId();
  const header = buildEapiHeader(did);
  const { params } = await eapi(path, data, header);
  const endpoint = path.replace(/^\/api/, '');
  const url = `${EAPI_BASE}/eapi${endpoint}`;
  const cookie = buildDeviceCookieJar(did);
  // 对齐 MusicStorm：登录态 eapi 请求 referer/origin 置 null、UA 用 iPhone 9.0.90；去重 __csrf。
  const isLogin = !!loginCookie;
  const rawResp: string = await hostApi.invoke<string>('netease_http_post', {
    method: 'POST',
    url,
    body: `params=${encodeURIComponent(params)}`,
    cookie: loginCookie || cookie,
    referer: isLogin ? null : REFERER,
    origin: isLogin ? null : ORIGIN,
    real_ip: REAL_IP,
    user_agent: isLogin ? UA_EAPI_IPHONE : UA_EAPI_PC,
    headers: {
      ...header,
      'Request-Id': header.requestId,
    },
  });
  const parsed = JSON.parse(rawResp || '{}');
  if (parsed.status && parsed.status !== 200) {
    console.warn('[netease] eapi', path, 'status', parsed.status, 'body', String(parsed.body || '').slice(0, 200));
  }
  if (parsed.cookies && parsed.cookies.length) {
    absorbCookies(parsed.cookies);
    absorbBodyCookie(parsed.body);
    const musicU = parsed.cookies.find((c: string) => c.startsWith('MUSIC_U='));
    if (musicU) {
      const csrf = parsed.cookies.find((c: string) => c.startsWith('__csrf='));
      setLoginCookieFromApi([musicU, csrf].filter(Boolean).join('; '));
    }
  }
  let body = parsed.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* keep string */ }
  }
  return { code: body?.code ?? 0, raw: parsed };
}

// ============ 统一请求层（对齐 MusicStorm resolveNativeModule + nativeNeteaseRequest） ============
// 我们把业务接口收敛为 path 常量，由本层决定走 eapi 还是 weapi、拼真实 uri。
// 关键：网易云近年已把搜索/歌单/播放地址等接口迁到 eapi（/api/...），
// 旧 /weapi/... 路径对游客态收紧、登录态也缺 csrf 闭环而返回空体。
type CryptoKind = 'weapi' | 'eapi';

const PATHS = {
  search: '/cloudsearch',
  playlistDetail: '/playlist/detail',
  recommendSongs: '/recommend/songs',
  personalFm: '/personal_fm',
  songUrl: '/song/url',
  userAccount: '/user/account',
  userPlaylist: '/user/playlist',
  toplist: '/toplist',
  personalized: '/personalized',
  likeSong: '/api/radio/like',
  subscribePlaylist: '/playlist/subscribe',
  manipulatePlaylistTracks: '/playlist/manipulate/tracks',
  // 歌手/专辑详情（铃兰顶部抽屉）
  artistDetail: '/artists',
  artistAlbums: '/artist/album',
  artistAllSongs: '/artist/all/songs',
  artistMvs: '/artist/mv',
  artistDesc: '/artist/desc',
  simiArtist: '/simi/artist',
  albumDetail: '/album',
  albumSub: '/album/sub',
  // 歌曲百科（手机版网易云「歌曲百科」）：eapi /api/song/wiki/summary，参数为歌曲 id
  songWiki: '/song/wiki',
};

function resolveModule(path: string, params: Record<string, any>): { uri: string; data: Record<string, any>; crypto: CryptoKind } {
  switch (path) {
    case PATHS.search:
      return { uri: '/api/cloudsearch/pc', data: { s: params.keywords || params.s || '', type: params.type ?? 1, limit: params.limit ?? 30, offset: params.offset ?? 0, total: true }, crypto: 'eapi' };
    case PATHS.playlistDetail:
      return { uri: '/api/v6/playlist/detail', data: { id: params.id, n: 100000, s: params.s ?? 8 }, crypto: 'eapi' };
    case PATHS.recommendSongs:
      // 每日推荐为 weapi（需登录态 + csrf 闭环）
      return { uri: '/api/v3/discovery/recommend/songs', data: { limit: params.limit ?? 20, afresh: params.afresh }, crypto: 'weapi' };
    case PATHS.personalFm:
      // 私人 FM（漫游）：返回一组根据用户口味推荐的歌曲，每次 3-5 首，可重复拉取。
      // 该接口需登录态；未登录时由业务层 fallback 到每日推荐 / 飙升榜。
      return { uri: '/api/v1/radio/get', data: { limit: params.limit ?? 5, offset: params.offset ?? 0 }, crypto: 'weapi' };
    case PATHS.songUrl:
      return { uri: '/api/song/enhance/player/url', data: { ids: JSON.stringify(params.ids || []), br: params.br ?? 999000 }, crypto: 'eapi' };
    case PATHS.userAccount:
      // 登录后的个人资料走 eapi，与扫码登录通道保持一致，避免 weapi 缺少 __csrf 返回空体
      return { uri: '/api/nuser/account/get', data: { timestamp: Date.now() }, crypto: 'eapi' };
    case PATHS.userPlaylist:
      // 我的歌单同样走 eapi，避免登录态 cookie 在 weapi 下校验失败
      return { uri: '/api/user/playlist', data: { uid: params.uid, limit: params.limit ?? 30, offset: params.offset ?? 0, includeVideo: true }, crypto: 'eapi' };
    case PATHS.toplist:
      // 对齐 MusicStorm fetchPlaylistDetail：playlist/detail 不支持真正的 offset 切片，
      // tracks 始终返回完整列表，offset/limit 会被忽略。故一次性 n=100000 全量拉取，
      // 不走分页，避免 hasMore 永真导致的下拉无限重复。
      return { uri: '/api/v6/playlist/detail', data: { id: params.id, n: 100000, s: params.s ?? 8 }, crypto: 'eapi' };
    case PATHS.personalized:
      // 为你推荐歌单：个性化（登录态）或热门（游客态）。
      // 注意：weapi 通道实测返回空 body（网易云对游客 weapi 收紧），改走 eapi（interfacepc 域），
      // 与 playlist/detail、userAccount 等已验证可用的通道一致，可稳定返回热门/个性化歌单。
      return { uri: '/api/personalized/playlist', data: { limit: params.limit ?? 24, total: true, n: 1000 }, crypto: 'eapi' };
    case PATHS.likeSong:
      // 单曲红心：对齐 MusicStorm 已验证可用的写法，走 weapi /api/radio/like。
      // 关键修正（之前反复失败的根因）：
      //  - 之前误用 /api/song/like（weapi 静默空 body 假成功；eapi 版本又报"参数错误"，本登录态不可用）；
      //  - CloudMusicAPI / MusicStorm 的红心标准端点就是 /api/radio/like（注意：它虽叫 radio/like，
      //    实为「喜欢音乐」官方写接口，trackId 即歌曲 id，并非电台专用）。
      //  - 参数必须与 MusicStorm 完全一致：trackId（非 id）、alg、like、time:'3'，且调用方带 timestamp。
      return {
        uri: '/api/radio/like',
        data: {
          alg: params.alg ?? 'itembased',
          trackId: params.id,
          like: params.like,
          time: params.time ?? '3',
        },
        crypto: 'weapi',
      };
    case PATHS.subscribePlaylist:
      // 歌单收藏/取消：对齐 MusicStorm，收藏与取消分别是两个 endpoint，
      // 统一走 eapi（interfacepc 域 + 设备 cookie）。
      // 之前把 t=2 硬塞 /api/playlist/subscribe 导致服务端返回 502。
      const sub = params.t === 1 || params.t === true ? 'subscribe' : 'unsubscribe';
      return { uri: `/api/playlist/${sub}`, data: { id: params.id }, crypto: 'eapi' };
    case PATHS.manipulatePlaylistTracks:
      return { uri: '/api/playlist/manipulate/tracks', data: { pid: params.pid, tracks: params.tracks, op: params.op }, crypto: 'weapi' };
    // 歌手/专辑详情（铃兰顶部抽屉，weapi 通道，对齐 MusicStorm modules.ts）
    case PATHS.artistDetail:
      return { uri: `/api/v1/artist/${params.id}`, data: {}, crypto: 'weapi' };
    case PATHS.artistAlbums:
      return { uri: `/api/artist/albums/${params.id}`, data: { limit: params.limit ?? 50, offset: params.offset ?? 0, total: true }, crypto: 'weapi' };
    case PATHS.artistAllSongs:
      return {
        uri: '/api/v1/artist/songs',
        data: {
          id: params.id,
          order: params.order ?? 'hot',
          offset: params.offset ?? 0,
          limit: params.limit ?? 100,
          total: true,
        },
        crypto: 'weapi',
      };
    case PATHS.artistMvs:
      return { uri: '/api/artist/mvs', data: { artistId: params.id, limit: params.limit ?? 40, offset: params.offset ?? 0, total: true }, crypto: 'weapi' };
    case PATHS.artistDesc:
      return { uri: '/api/artist/introduction', data: { id: params.id }, crypto: 'weapi' };
    case PATHS.simiArtist:
      return { uri: '/api/discovery/simiArtist', data: { artistid: params.id }, crypto: 'weapi' };
    case PATHS.albumDetail:
      return { uri: `/api/v1/album/${params.id}`, data: {}, crypto: 'weapi' };
    case PATHS.albumSub:
      return { uri: params.t === 1 ? '/api/album/sub' : '/api/album/unsub', data: { id: params.id }, crypto: 'weapi' };
    case PATHS.songWiki:
      return { uri: '/api/song/wiki/summary', data: { id: params.id, e_r: true, c_version: 'u17' }, crypto: 'eapi' };
    default:
      throw new Error(`未实现的网易云接口: ${path}`);
  }
}

// 网易云返回的通用错误码参考：200 成功，-462 需要验证码，400 参数/业务失败，401/302 未登录，-1 操作失败等。
function assertNeteaseOk(body: any, path: string): void {
  if (body && typeof body === 'object') {
    const code = body.code;
    if (code !== undefined && code !== 200) {
      const msg = body.message || body.msg || `网易云接口返回 code ${code}`;
      const err = new Error(msg);
      (err as any).code = code;
      (err as any).neteasePath = path;
      throw err;
    }
  }
}

// 统一入口：业务代码只传 path + params，通道由 resolveModule 决定
async function neteaseRequest(path: string, params: Record<string, any> = {}): Promise<any> {
  const mod = resolveModule(path, params);
  const body = mod.crypto === 'eapi' ? await eapiRequest(mod.uri, mod.data) : await post(mod.uri, mod.data);
  assertNeteaseOk(body, path);
  return body;
}

// eapi 业务请求（不复用 eapiPost，因为它带登录专属 header 写法；这里与 eapiPost 同构）
async function eapiRequest(uri: string, data: Record<string, any>): Promise<any> {
  await ensureGuest();
  const did = getOrCreateDeviceId();
  const header = buildEapiHeader(did);
  const { params: encParams } = await eapi(uri, data, header);
  const url = `${EAPI_BASE}/eapi${uri.replace(/^\/api/, '')}`;
  const cookie = [loginCookie, buildDeviceCookieJar(did)].filter(Boolean).join('; ') || buildDeviceCookieJar(did);
  // 对齐 MusicStorm 登录态 eapi：referer/origin 置 null（非 music.163.com），避免触发风控；
  // MUSIC_U/__csrf 已在 header 签名体内，不再于顶层 headers 重复塞 __csrf。
  const raw: string = await hostApi.invoke<string>('netease_http_post', {
    method: 'POST',
    url,
    body: `params=${encodeURIComponent(encParams)}`,
    cookie,
    referer: null,
    origin: null,
    real_ip: REAL_IP,
    user_agent: UA_EAPI,
    headers: { ...header, 'Request-Id': header.requestId },
  });
  const parsed = JSON.parse(raw || '{}');
  if (parsed.status && parsed.status !== 200) {
    console.warn('[netease] eapi', uri, 'status', parsed.status, 'body', String(parsed.body || '').slice(0, 200));
  }
  if (parsed.cookies && parsed.cookies.length) {
    absorbCookies(parsed.cookies);
    absorbBodyCookie(parsed.body);
  }
  if (typeof parsed.body === 'string') {
    try { return JSON.parse(parsed.body); } catch { return { raw: parsed.body }; }
  }
  return parsed.body || {};
}

// ============ 二维码登录（对齐 MusicStorm native/request.ts，走 eapi 通道） ============
export interface QrSession {
  key: string;
  qrimg: string; // base64 图片（可能带 data:image/png;base64, 前缀）
  qrurl: string;
}

// 1) 取二维码 key。MusicStorm 映射：/login/qr/key -> /api/login/qrcode/unikey，data { type: 3 }
export async function neteaseQrKey(): Promise<string> {
  const r = await eapiPost('/api/login/qrcode/unikey', { type: 3 });
  const key = r?.unikey;
  if (!key) throw new Error('无法获取登录二维码 key');
  return key;
}

// 2) 用 key 本地合成二维码图片。MusicStorm 中 /login/qr/create 是本地合成，不上传服务端。
// qrurl = https://music.163.com/login?codekey=${key}；qrimg 由前端用该 url 生成 data URL。
export async function neteaseQrCreate(key: string): Promise<QrSession> {
  const qrurl = `https://music.163.com/login?codekey=${encodeURIComponent(key)}`;
  const qrimg = await QRCode.toDataURL(qrurl, { width: 200, margin: 2, type: 'image/png' });
  if (!qrimg) throw new Error('无法生成登录二维码');
  return { key, qrimg, qrurl };
}

// 3) 轮询登录状态：800 过期 / 801 待扫 / 802 已扫待确认 / 803 成功
// MusicStorm 映射：/login/qr/check -> /api/login/qrcode/client/login，data { key, type: 3 }
// 803 时 cookie 字段含 MUSIC_U，自动写入 loginCookie 并持久化
export async function neteaseQrCheck(key: string): Promise<{ code: number; cookieSaved: boolean }> {
  const { code, raw } = await eapiPostWithCookies('/api/login/qrcode/client/login', { key, type: 3 });
  let cookieSaved = isLoggedIn();
  // 网易云 eapi 登录态：MUSIC_U 写入 HTTP Set-Cookie，eapiPostWithCookies 已自动保存到 loginCookie。
  // 不依赖 body.code 的精确值（eapi 803 body.code 可能非 803），只要本地已落地 MUSIC_U 即视为登录成功。
  if (cookieSaved) {
    console.log('[netease] 二维码登录态已建立（MUSIC_U 已持久化），code:', code, 'body 键:', Object.keys(raw?.body || {}));
    // 二维码登录通常只给 MUSIC_U、不给 __csrf；而 weapi 写操作（红心）要求 csrf 与 MUSIC_U 同源，
    // 否则静默空 body 假成功。这里主动触发一次 weapi 请求回吐配对 __csrf，建立 csrf 闭环。
    await refreshLoginCsrf();
  } else {
    // 未落地 MUSIC_U 时，仅当 body.code === 803 也提示，便于排查（不作为触发条件）。
    if (code === 803) {
      console.warn('[netease] 803 后端已返回但本地未持久化到 MUSIC_U。body 键:', Object.keys(raw?.body || {}), 'raw 键:', Object.keys(raw || {}));
    }
  }
  return { code, cookieSaved };
}

// 歌词接口（eapi /api/song/lyric，需登录态）：返回 LRC 文本或 null
export async function neteaseGetLyric(songId: number): Promise<string | null> {
  try {
    const r = await eapiPost('/api/song/lyric', { id: songId, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, _nmclfl: 1 });
    const lrc = r?.lrc?.lyric as string | undefined;
    return lrc || null;
  } catch (e) {
    console.warn('[netease] 歌词获取失败', songId, e);
    return null;
  }
}

async function post(endpoint: string, data: Record<string, any>): Promise<any> {
  await ensureGuest();
  // 登录态优先用登录 cookie 里的 __csrf（与 MUSIC_U 配对），否则回落游客态 __csrf，形成 weapi csrf 闭环。
  // 自愈：若登录态 cookie 缺 __csrf（旧 localStorage 缓存或扫码后未回吐），先发一次 weapi 请求触发配对回吐，
  // 再读 loginCookie。否则 csrf_token 会与 MUSIC_U 不同源，服务端静默空 body（红心假成功根因）。
  if (loginCookie && loginCookie.includes('MUSIC_U=') && !loginCookie.includes('__csrf=')) {
    await refreshLoginCsrf();
  }
  const loginCsrf = loginCookie ? (loginCookie.match(/__csrf=([^;]+)/) || [])[1] : '';
  const csrf = loginCsrf || guestCsrf || '';
  if (loginCookie && loginCookie.includes('MUSIC_U=') && !csrf) {
    console.warn('[netease] 登录态但 csrf 仍为空（配对回吐失败），红心可能空 body 假成功');
  }
  const { params, encSecKey } = await weapi(data, csrf);
  // 对齐 MusicStorm ensureDeviceCookies + cookieHeader：weapi cookie 需同时带
  // 登录态 MUSIC_U / __csrf、设备态 MUSIC_A，以及 deviceId/os/appver/osver/resolution/channel 等设备字段。
  // 缺设备字段会触发风控（-460），之前只拼 loginCookie+guestCookie 不够。
  const deviceJar = buildDeviceCookieJar(getOrCreateDeviceId());
  const cookie = [loginCookie, guestCookie, deviceJar].filter(Boolean).join('; ') || '';
  // 对齐 MusicStorm：weapi 请求 URL 为 /weapi/<uri 去掉 /api 前缀>
  const weapiPath = `/weapi/${endpoint.replace(/^\/api\//, '')}`;
  const payload = {
    method: 'POST',
    url: `https://music.163.com${weapiPath}`,
    body: `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`,
    cookie,
    referer: REFERER,
    origin: ORIGIN,
    real_ip: REAL_IP,
    user_agent: UA_WEAPI,
  };
  const raw: string = await hostApi.invoke<string>('netease_http_post', payload);
  const parsed = JSON.parse(raw || '{}');
  console.log('[netease] weapi', weapiPath, 'csrf?', !!csrf, 'MUSIC_U?', !!loginCookie, 'status', parsed.status, 'body', String(parsed.body || '').slice(0, 300));
  if (parsed.status && parsed.status !== 200) {
    console.warn('[netease] post', endpoint, 'status', parsed.status, 'body', String(parsed.body || '').slice(0, 300));
  }
  // 回写响应里的 cookie（MUSIC_A / __csrf 等），形成 csrf 闭环
  if (parsed.cookies && parsed.cookies.length) {
    absorbCookies(parsed.cookies);
    absorbBodyCookie(parsed.body);
    const musicU = parsed.cookies.find((c: string) => c.startsWith('MUSIC_U='));
    const csrf = parsed.cookies.find((c: string) => c.startsWith('__csrf='));
    if (musicU) {
      setLoginCookieFromApi([musicU, csrf].filter(Boolean).join('; '));
    } else if (csrf && loginCookie && loginCookie.includes('MUSIC_U=')) {
      // 登录态 weapi 请求只回 __csrf（无 MUSIC_U）：合并配对 csrf 进 loginCookie，修复红心空 body 假成功。
      setLoginCookieFromApi(csrf);
    }
  }
  if (typeof parsed.body === 'string') {
    try { return JSON.parse(parsed.body); } catch { return { raw: parsed.body }; }
  }
  return parsed.body || {};
}

export interface NeteaseTrack {
  id: number;
  name: string;
  artist: string;
  album: string;
  duration: number;
  cover?: string;
  url?: string;
  fee?: number;       // 0 免费 / 1 VIP / 4 专辑付费 / 8 试听
  maxbr?: number;     // 最高可用码率 bps（privilege.maxbr），用于判断无损/Hi-Res
  mvId?: number;      // MV id（>0 表示有官方 MV），用于「点击播放 MV」入口
  artistId?: number;  // 主歌手 id（详情页入口）
  albumId?: number;   // 专辑 id（详情页入口）
}

function mapTrack(s: any, priv?: any): NeteaseTrack {
  const artists = s.artists || s.ar || [];
  const album = s.album || s.al || {};
  const p = priv || s.privilege || {};
  // 搜索/歌单返回的 mv 字段：0 表示无 MV，>0 为 MV id。部分接口藏在 privilege 或 mvid。
  const mv = s.mv ?? s.mvid ?? p.mv ?? 0;
  return {
    id: s.id,
    name: s.name,
    artist: artists.map((a: any) => a.name).join('/') || '未知歌手',
    album: album.name || '',
    duration: s.duration || s.dt || 0,
    cover: album.picUrl || album.cover || '',
    fee: s.fee ?? p.fee ?? 0,
    maxbr: p.maxbr || 0,
    mvId: mv > 0 ? mv : undefined,
    artistId: (artists[0] && artists[0].id) || s.artistId || undefined,
    albumId: album.id ?? s.albumId ?? undefined,
  };
}

// ============ MV 播放信息（对齐 MusicStorm native/modules.ts） ============
// MV detail：weapi /api/v1/mv/detail，参数 id（或 mvid）。
// MV url：weapi /api/song/enhance/play/mv/url，参数 id + 可选分辨率 r。
export interface NeteaseMv {
  id: number;
  name: string;
  artist: string;
  cover: string;
  durationMs: number;
  url: string;        // 最终选中的播放地址（从高到低分辨率回退）
  br: number;         // 实际分辨率 bps
}
const MV_RESOLUTIONS = [1080, 720, 480, 240]; // 从高到低回退

export async function getMvDetail(mvId: number): Promise<{ name: string; artist: string; cover: string; durationMs: number } | null> {
  try {
    const r: any = await post('/api/v1/mv/detail', { id: mvId, mvId });
    const data = r?.data ?? r ?? {};
    const artists = data.artistName || (data.artists || []).map((a: any) => a.name).join('/') || '';
    return {
      name: data.name || '',
      artist: artists || data.artistName || '',
      cover: data.cover || data.picUrl || data.coverUrl || '',
      durationMs: data.duration || 0,
    };
  } catch (e) {
    console.warn('[netease] getMvDetail 失败', mvId, e);
    return null;
  }
}

export async function getMvPlayable(mvId: number): Promise<NeteaseMv | null> {
  const detail = await getMvDetail(mvId);
  let url = '';
  let br = 0;
  for (const r of MV_RESOLUTIONS) {
    try {
      const res: any = await post('/api/song/enhance/play/mv/url', { id: mvId, r });
      const d = res?.data ?? res ?? {};
      const u = d.url || '';
      if (u) { url = u; br = d.r || r * 1000; break; }
    } catch { /* 该分辨率失败，尝试更低 */ }
  }
  if (!url) return null;
  return {
    id: mvId,
    name: detail?.name || '',
    artist: detail?.artist || '',
    cover: detail?.cover || '',
    durationMs: detail?.durationMs || 0,
    url,
    br,
  };
}

// 列表静态标签：VIP（收费）/ 无损(SQ) / Hi-Res(HR)，由 fee + 最高码率推断，无需额外请求。
export interface TrackBadge { label: string; kind: 'vip' | 'lossless' | 'hires'; }
export function neteaseTrackBadges(t: NeteaseTrack): TrackBadge[] {
  const out: TrackBadge[] = [];
  const fee = t.fee ?? 0;
  if (fee === 1) out.push({ label: 'VIP', kind: 'vip' });
  else if (fee === 4) out.push({ label: '专辑', kind: 'vip' });
  const maxbr = t.maxbr ?? 0;
  if (maxbr >= 2000000) out.push({ label: 'Hi-Res', kind: 'hires' });
  else if (maxbr >= 999000) out.push({ label: 'SQ', kind: 'lossless' });
  return out;
}

// 由播放地址接口返回的实际码率推断标签（实际播放音质）。
export function qualityLabelFromBr(br: number): string {
  if (br >= 2000000) return 'Hi-Res';
  if (br >= 999000) return '无损';
  if (br >= 320000) return '高品质';
  if (br > 0) return '标准';
  return '';
}

// 搜索歌曲（type=1 单曲）。对齐 MusicStorm：eapi /api/cloudsearch/pc
// 支持 offset 分页以实现无限下拉；返回结构含总数 total，便于判断是否到底。
export interface SearchSongsResult {
  tracks: NeteaseTrack[];
  total: number;
}
export async function searchSongs(
  keyword: string,
  limit = 30,
  offset = 0,
): Promise<SearchSongsResult> {
  const r = await neteaseRequest(PATHS.search, { keywords: keyword, type: 1, limit, offset });
  const list = r?.result?.songs || [];
  const total = typeof r?.result?.songCount === 'number' ? r.result.songCount : 0;
  return { tracks: list.map(mapTrack), total };
}

// 「现在就听」：优先每日推荐（weapi，需登录态），失败回落到飙升榜
export async function getListenNow(limit = 20): Promise<NeteaseTrack[]> {
  if (isLoggedIn()) {
    try {
      const r = await neteaseRequest(PATHS.recommendSongs, { limit });
      const list = r?.data?.dailySongs || [];
      if (list.length) return list.map(mapTrack);
    } catch (e) {
      console.warn('[netease] 每日推荐失败，回落榜单', e);
    }
  }
  return (await getTopList(19723756, limit)).tracks; // 飙升榜回落
}

// 「私人 FM / 漫游」：返回一组根据用户口味推荐的歌曲（每次 3-5 首），可重复拉取刷新。
// 需登录态；未登录时返回 []，由业务层 fallback 到 getListenNow。
export async function getPersonalFm(limit = 5, offset = 0): Promise<NeteaseTrack[]> {
  if (!isLoggedIn()) return [];
  try {
    const r: any = await neteaseRequest(PATHS.personalFm, { limit, offset });
    const list = r?.data || r?.songs || [];
    if (!Array.isArray(list) || !list.length) return [];
    return list.map(mapTrack);
  } catch (e) {
    console.warn('[netease] 私人 FM 失败', e);
    return [];
  }
}

// 歌单/榜单详情：eapi /api/v6/playlist/detail，一次性返回完整 tracks（不支持 offset 切片）。
// 返回结构含总数 total，便于前端判断是否到底（已全量则无需分页）。
export interface TopListResult {
  tracks: NeteaseTrack[];
  total: number;
  coverUrl?: string;
  description?: string;
  playCount?: number;
}
export async function getTopList(
  id: number,
  limit = 100000,
  offset = 0,
): Promise<TopListResult> {
  const r = await neteaseRequest(PATHS.toplist, { id, limit, offset });
  const list = r?.playlist?.tracks || [];
  const total = typeof r?.playlist?.trackCount === 'number' ? r.playlist.trackCount : list.length;
  // privileges 数组与 tracks 按 index 对应，含 fee / maxbr 等音质与版权信息
  const privs = r?.playlist?.privileges || [];
  return {
    tracks: list.map((s: any, i: number) => mapTrack(s, privs[i])),
    total,
    coverUrl: r?.playlist?.coverImgUrl || '',
    description: r?.playlist?.description || '',
    playCount: r?.playlist?.playCount || 0,
  };
}

// 为你推荐歌单：weapi /api/personalized/playlist（登录态个性化，游客态返回热门歌单）。
// 对齐 MusicStorm fetchRecommendPlaylists，用于「现在就听」的个性化歌单流。
export interface NeteasePlaylistCard {
  id: number;
  name: string;
  coverUrl: string;
  trackCount?: number;
  copywriter?: string;
}
export async function getPersonalizedPlaylists(limit = 24): Promise<NeteasePlaylistCard[]> {
  const r = await neteaseRequest(PATHS.personalized, { limit });
  console.log('[netease] personalized/playlist raw=', JSON.stringify(r).slice(0, 500));
  // 兼容多种返回结构：result / recommend / 嵌套 data.result
  const arr: any[] =
    (Array.isArray(r?.result) ? r.result : null) ||
    (Array.isArray(r?.recommend) ? r.recommend : null) ||
    (Array.isArray(r?.data?.result) ? r.data.result : null) ||
    (Array.isArray(r?.data?.recommend) ? r.data.recommend : null) ||
    [];
  return arr.map((it: any) => ({
    id: Number(it.id),
    name: it.name,
    coverUrl: it.picUrl || it.coverImgUrl || it.coverUrl || it.imageUrl || '',
    trackCount: typeof it.trackCount === 'number' ? it.trackCount : undefined,
    copywriter: it.copywriter || undefined,
  }));
}

// 获取播放地址：eapi /api/song/enhance/player/url
// 返回实际播放 url 及码率（用于播放器展示真实音质标签）。
export interface SongUrlResult { url: string | null; br: number; type: string; }
export async function getSongUrl(id: number): Promise<SongUrlResult> {
  try {
    const r = await neteaseRequest(PATHS.songUrl, { ids: [id], br: 999000 });
    const item = (r?.data || [])[0] || {};
    return { url: item.url || null, br: item.br || 0, type: item.type || '' };
  } catch {
    return { url: null, br: 0, type: '' };
  }
}

// 歌曲百科（手机版网易云「歌曲百科」）：eapi /api/song/wiki/summary
// 服务端返回 modules 数组，每项含 style、title、content（富文本/链接/文本段落）。
// 我们挑选对漫游页有价值、且官方稳定提供的几个维度：发行时间、语种、BPM、乐器、曲风。
export interface SongWiki {
  publishTime?: string; // 发行时间（已格式化）
  language?: string;    // 语种
  bpm?: number;         // BPM
  instruments?: string[]; // 乐器
  genres?: string[];    // 曲风
  hasSheet?: boolean;   // 是否有官方乐谱（吉他谱/简谱等）
  sheetUrl?: string;    // 乐谱链接（若有）
}
// 网易云 wiki modules 的 style 标识（见官方返回），用于定点抽取
const WIKI_STYLE_PUBLISH = '出版时间';
const WIKI_STYLE_LANGUAGE = '语言';
const WIKI_STYLE_BPM = '节拍';
const WIKI_STYLE_INSTRUMENT = '乐器';
const WIKI_STYLE_GENRE = '曲风';
const WIKI_STYLE_SHEET = '曲谱';

// 从富文本 content 中抠出纯文本（content 可能是 [{ txt, t }] 片段数组或字符串）
function wikiText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content.replace(/<[^>]+>/g, '').trim();
  if (Array.isArray(content)) {
    return content
      .map((seg: any) => (typeof seg === 'string' ? seg : seg?.txt || ''))
      .join('')
      .replace(/<[^>]+>/g, '')
      .trim();
  }
  if (typeof content === 'object') {
    return String(content.txt || content.text || '').replace(/<[^>]+>/g, '').trim();
  }
  return '';
}

export async function getSongWiki(id: number): Promise<SongWiki | null> {
  try {
    const r: any = await neteaseRequest(PATHS.songWiki, { id });
    const modules: any[] = r?.data?.modules || r?.modules || [];
    if (!Array.isArray(modules) || !modules.length) return null;
    const wiki: SongWiki = {};
    for (const m of modules) {
      const style: string = m?.style || '';
      const content = m?.content ?? m?.data?.content;
      if (style.includes(WIKI_STYLE_PUBLISH)) {
        const t = wikiText(content);
        if (t) wiki.publishTime = t;
      } else if (style.includes(WIKI_STYLE_LANGUAGE)) {
        const t = wikiText(content);
        if (t) wiki.language = t;
      } else if (style.includes(WIKI_STYLE_BPM)) {
        const t = wikiText(content).replace(/[^0-9.]/g, '');
        if (t) wiki.bpm = Number(t);
      } else if (style.includes(WIKI_STYLE_INSTRUMENT)) {
        const t = wikiText(content);
        if (t) wiki.instruments = t.split(/[、,，/\s]+/).filter(Boolean);
      } else if (style.includes(WIKI_STYLE_GENRE)) {
        const t = wikiText(content);
        if (t) wiki.genres = t.split(/[、,，/\s]+/).filter(Boolean);
      } else if (style.includes(WIKI_STYLE_SHEET)) {
        const link = m?.content?.[0]?.url || m?.data?.jumpUrl || m?.jumpUrl || '';
        if (link) { wiki.hasSheet = true; wiki.sheetUrl = link; }
        else if (wikiText(content)) wiki.hasSheet = true;
      }
    }
    // 无有效字段视为无百科
    if (!wiki.publishTime && !wiki.language && !wiki.bpm && !wiki.instruments?.length && !wiki.genres?.length && !wiki.hasSheet) {
      return null;
    }
    return wiki;
  } catch (e) {
    console.warn('[netease] getSongWiki 失败', id, e);
    return null;
  }
}

// 个人页：用户资料（weapi /api/nuser/account/get）
export interface NeteaseProfile {
  userId: number;
  nickname: string;
  avatarUrl: string;
  signature?: string;
  vipType?: number;
}
export async function getUserAccount(): Promise<NeteaseProfile | null> {
  const r = await neteaseRequest(PATHS.userAccount, {});
  console.log('[netease] userAccount raw keys:', Object.keys(r || {}), 'account?', !!r?.account, 'profile?', !!r?.profile, 'code:', r?.code, 'msg:', r?.msg || r?.message || '');
  const acc = r?.account || r?.profile;
  if (!acc) return null;
  const p = r?.profile || r?.account;
  return {
    userId: acc.id ?? p?.userId ?? 0,
    nickname: p?.nickname ?? acc.nickname ?? '网易云用户',
    avatarUrl: p?.avatarUrl ?? '',
    signature: p?.signature,
    vipType: acc.vipType ?? p?.vipType ?? 0,
  };
}

// 我的歌单：weapi /api/user/playlist
export interface NeteasePlaylistItem {
  id: number;
  name: string;
  coverImgUrl: string;
  trackCount: number;
  playCount: number;
  creator?: string;
  /** 网易云 specialType：5 表示「我喜欢的音乐」(liked) */
  specialType?: number;
  /** 是否为他人歌单（true=收藏的，false=自己创建的） */
  subscribed?: boolean;
}
/** 判断某歌单是否为「我喜欢的音乐」 */
export function isLikedPlaylist(p: NeteasePlaylistItem): boolean {
  if (p.specialType === 5) return true;
  if (p.subscribed === false && p.specialType === 5) return true;
  return false;
}
export async function getUserPlaylists(uid: number, limit = 30): Promise<NeteasePlaylistItem[]> {
  const r = await neteaseRequest(PATHS.userPlaylist, { uid, limit });
  const list = r?.playlist || [];
  return list.map((p: any) => ({
    id: p.id,
    name: p.name || '未命名歌单',
    coverImgUrl: p.coverImgUrl || '',
    trackCount: p.trackCount || p.trackCount || 0,
    playCount: p.playCount || 0,
    creator: p.creator?.nickname || '',
    specialType: p.specialType,
    subscribed: p.subscribed,
  }));
}

/** 喜欢/取消喜欢一首歌（写入网易云「我喜欢的音乐」） */
export async function likeNeteaseSong(songId: number, like: boolean): Promise<void> {
  console.log('[netease] 调用红心接口', { songId, like });
  const r = await neteaseRequest(PATHS.likeSong, {
    id: songId,
    like,
    timestamp: Date.now(),
  });
  console.log('[netease] 红心接口返回', r);
  // weapi /api/radio/like 成功返回 {code:200}（或偶尔空 body）。若返回空对象或 raw 为空串，
  // 说明服务端未确认写入（静默丢弃），这里显式拦截，避免 PC 显示成功但手机看不到（之前的假成功根因）。
  if (r == null || (typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 0) || (r as any).raw === '') {
    throw new Error('红心接口未返回有效结果（服务端可能未写入，请重试）');
  }
  const code = r?.code;
  if (code !== undefined && code !== 200) {
    throw new Error(`红心接口返回 code ${code}${r?.message ? '：' + r.message : ''}`);
  }
}

/** 收藏/取消收藏网易云歌单 */
export async function subscribeNeteasePlaylist(playlistId: number, subscribe: boolean): Promise<any> {
  const body = await neteaseRequest(PATHS.subscribePlaylist, {
    id: playlistId,
    t: subscribe ? 1 : 2,
  });
  console.log('[netease] subscribePlaylist id=', playlistId, 't=', subscribe ? 1 : 2, 'resp=', JSON.stringify(body).slice(0, 400));
  return body;
}

/** 向网易云歌单添加/删除歌曲 */
export async function manipulateNeteasePlaylistTracks(
  playlistId: number,
  songIds: number[],
  op: 'add' | 'del'
): Promise<void> {
  await neteaseRequest(PATHS.manipulatePlaylistTracks, {
    pid: playlistId,
    tracks: songIds.join(','),
    op,
  });
}

// ============ 歌手 / 专辑详情（顶部抽屉，对齐 MusicStorm artist/album 页） ============

export interface NeteaseArtist {
  id: number;
  name: string;
  cover?: string;          // 艺人封面（artist.img1v1Url）
  avatarLarge?: string;    // 高清头像（artist.picUrl / cover）
  alias?: string[];        // 别名（artist.alias）
  briefDesc?: string;      // 简介（歌手详情页头部）
  musicSize?: number;      // 单曲数
  albumSize?: number;      // 专辑数
  mvSize?: number;         // MV 数
}

export interface NeteaseArtistAlbum {
  id: number;
  name: string;
  cover: string;
  publishTime?: number;    // 时间戳
  size?: number;           // 专辑歌曲数
}

export interface NeteaseMvItem {
  id: number;
  name: string;
  cover: string;
  artistName?: string;
  playCount?: number;
  durationMs?: number;
}

export interface NeteaseSimilarArtist {
  id: number;
  name: string;
  cover: string;
}

// 歌手详情三件套：热门歌 + 基本信息（含简介/统计）
export async function getArtistDetail(artistId: number): Promise<{ artist: NeteaseArtist; hotSongs: NeteaseTrack[] } | null> {
  try {
    const r: any = await neteaseRequest(PATHS.artistDetail, { id: artistId });
    const a = r?.artist || {};
    const artist: NeteaseArtist = {
      id: a.id ?? artistId,
      name: a.name || '未知歌手',
      cover: a.img1v1Url || a.picUrl || '',
      avatarLarge: a.picUrl || a.cover || a.img1v1Url || '',
      alias: a.alias || [],
      briefDesc: a.briefDesc || '',
      musicSize: a.musicSize ?? 0,
      albumSize: a.albumSize ?? 0,
      mvSize: a.mvSize ?? 0,
    };
    const hotSongs: NeteaseTrack[] = (r?.hotSongs || []).map((s: any) => mapTrack(s));
    return { artist, hotSongs };
  } catch (e) {
    console.warn('[netease] getArtistDetail 失败', artistId, e);
    return null;
  }
}

// 歌手全部专辑（含分页）
export interface ArtistAlbumsResult {
  albums: NeteaseArtistAlbum[];
  total: number;
  more: boolean;
}
export async function getArtistAlbums(artistId: number, offset = 0, limit = 30): Promise<ArtistAlbumsResult> {
  const r: any = await neteaseRequest(PATHS.artistAlbums, { id: artistId, offset, limit });
  const albums: NeteaseArtistAlbum[] = (r?.hotAlbums || r?.albums || []).map((al: any) => ({
    id: al.id,
    name: al.name || '未命名专辑',
    cover: al.picUrl || al.cover || '',
    publishTime: al.publishTime || undefined,
    size: al.size || undefined,
  }));
  const more = typeof r?.more === 'boolean' ? r.more : (r?.albumSize ?? 0) > offset + albums.length;
  return { albums, total: r?.albumSize ?? albums.length, more };
}

// 歌手全部 MV
export async function getArtistMvs(artistId: number, offset = 0, limit = 30): Promise<{ mvs: NeteaseMvItem[]; more: boolean; total: number }> {
  try {
    const r: any = await neteaseRequest(PATHS.artistMvs, { id: artistId, offset, limit });
    const mvs: NeteaseMvItem[] = (r?.mvs || []).map((m: any) => ({
      id: m.id,
      name: m.name || '',
      cover: m.imgurl16v9 || m.cover || m.imgurl || '',
      artistName: m.artistName || '',
      playCount: m.playCount || 0,
      durationMs: m.duration || 0,
    }));
    return { mvs, more: !!r?.hasMore, total: r?.total ?? mvs.length };
  } catch (e) {
    console.warn('[netease] getArtistMvs 失败', artistId, e);
    return { mvs: [], more: false, total: 0 };
  }
}

// 歌手简介（长文，含 basic/profile/topic）
export async function getArtistDesc(artistId: number): Promise<string> {
  try {
    const r: any = await neteaseRequest(PATHS.artistDesc, { id: artistId });
    const intro = r?.introduction || [];
    const parts: string[] = [];
    for (const sec of intro) {
      const txt = (sec.txt || []).join('\n');
      if (txt) parts.push(`${sec.ti ? sec.ti + '\n' : ''}${txt}`);
    }
    return parts.join('\n\n');
  } catch (e) {
    console.warn('[netease] getArtistDesc 失败', artistId, e);
    return '';
  }
}

// 相似艺人
export async function getSimilarArtists(artistId: number): Promise<NeteaseSimilarArtist[]> {
  try {
    const r: any = await neteaseRequest(PATHS.simiArtist, { id: artistId });
    return (r?.artists || []).map((a: any) => ({
      id: a.id,
      name: a.name || '',
      cover: a.picUrl || a.img1v1Url || '',
    }));
  } catch (e) {
    console.warn('[netease] getSimilarArtists 失败', artistId, e);
    return [];
  }
}

// 歌手全部歌曲（分页；order='hot' 热门 / 'time' 时间）。返回曲目列表 + 是否还有更多。
export interface ArtistSongsResult {
  tracks: NeteaseTrack[];
  more: boolean;
  total: number;
}
export async function getArtistAllSongs(
  artistId: number,
  offset = 0,
  limit = 100,
  order: 'hot' | 'time' = 'hot',
): Promise<ArtistSongsResult> {
  try {
    const r: any = await neteaseRequest(PATHS.artistAllSongs, { id: artistId, offset, limit, order });
    const songs = r?.songs || [];
    const privs = r?.privileges || [];
    const tracks: NeteaseTrack[] = songs.map((s: any, i: number) => mapTrack(s, privs[i]));
    return {
      tracks,
      more: !!r?.more,
      total: r?.total ?? tracks.length,
    };
  } catch (e) {
    console.warn('[netease] getArtistAllSongs 失败', artistId, e);
    return { tracks: [], more: false, total: 0 };
  }
}

export interface NeteaseAlbum {
  id: number;
  name: string;
  cover: string;
  artistId: number;
  artistName: string;
  publishTime?: string;    // 已格式化的日期
  company?: string;        // 发行公司
  description?: string;    // 专辑简介
  size: number;            // 曲目数
  subed?: boolean;         // 是否已收藏
}

export interface AlbumDetailResult {
  album: NeteaseAlbum;
  tracks: NeteaseTrack[];
}

// 专辑详情：基本信息 + 曲目列表（含 privileges 音质信息）
export async function getAlbumDetail(albumId: number): Promise<AlbumDetailResult | null> {
  try {
    const r: any = await neteaseRequest(PATHS.albumDetail, { id: albumId });
    const al = r?.album || r?.resource || {};
    const album: NeteaseAlbum = {
      id: al.id ?? albumId,
      name: al.name || '未命名专辑',
      cover: al.picUrl || al.cover || '',
      artistId: al.artist?.id ?? (al.artists && al.artists[0] && al.artists[0].id) ?? 0,
      artistName: al.artist?.name || (al.artists && al.artists[0] && al.artists[0].name) || '未知歌手',
      publishTime: al.publishTime ? formatAlbumDate(al.publishTime) : undefined,
      company: al.company || undefined,
      description: al.description || undefined,
      size: al.size ?? (r?.songs?.length || 0),
      subed: !!al.info?.liked,
    };
    const songs = r?.songs || [];
    const privs = r?.privileges || [];
    return { album, tracks: songs.map((s: any, i: number) => mapTrack(s, privs[i])) };
  } catch (e) {
    console.warn('[netease] getAlbumDetail 失败', albumId, e);
    return null;
  }
}

// 收藏/取消收藏专辑（t=1 收藏，t=2 取消）
export async function subscribeAlbum(albumId: number, subscribe: boolean): Promise<void> {
  await neteaseRequest(PATHS.albumSub, { id: albumId, t: subscribe ? 1 : 2 });
}

// 网易云专辑 publishTime 是时间戳（毫秒）。转 yyyy-MM-dd。
function formatAlbumDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
