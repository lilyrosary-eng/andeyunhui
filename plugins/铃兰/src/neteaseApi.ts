/// <reference path="../global.d.ts" />

import CryptoJS from 'crypto-js';
import QRCode from 'qrcode';
import { weapi, eapi } from './neteaseCrypto';

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => ({}) };

// 参考 MusicStorm：伪造国内出口 IP 绕过非 CN 出口拦截
const REAL_IP = '113.66.253.18';
const REFERER = 'https://music.163.com';
const ORIGIN = 'https://music.163.com';
// weapi / eapi 分别使用贴合官方的 UA（参考 MusicStorm，避免中性 UA 触发风控）
const UA_WEAPI =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36';
const UA_EAPI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CloudMusic/8.7.50';

let guestCookie: string | null = null;
let guestCsrf = '';
// 登录态 cookie（MUSIC_U; __csrf; ...），优先于游客态；持久化到 localStorage 实现免登录
let loginCookie: string | null = null;
const LOGIN_COOKIE_KEY = 'netease-login-cookie';

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
  if (!cookieStr || !cookieStr.includes('MUSIC_U=')) return;
  // 兼容网易云有时返回 "MUSIC_U=xxx; __csrf=yyy;"，有时只有 "MUSIC_U=xxx"（无分号）
  const parts = cookieStr.split(';').map((s) => s.trim()).filter(Boolean);
  const wanted = parts.filter((p) => p.startsWith('MUSIC_U=') || p.startsWith('__csrf='));
  if (!wanted.length) return;
  loginCookie = wanted.join('; ');
  saveLoginCookie();
  // 同步刷新 guestCsrf（后续 weapi 加密的 csrf_token 用 __csrf 值）
  const csrf = wanted.find((p) => p.startsWith('__csrf='));
  guestCsrf = csrf ? csrf.replace('__csrf=', '') : '';
  console.log('[netease] 登录 cookie 已保存，长度', loginCookie.length);
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
  return {
    osver: 'Microsoft-Windows-10-Pro-Edition-build-19041-64bit',
    deviceId,
    appver: '3.0.18',
    versioncode: '140',
    mobilename: 'Windows',
    buildver: '19041',
    resolution: '1920x1080',
    os: 'pc',
    channel: 'netease',
    requestId: genRequestId(),
  };
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
    `appver=3.0.18`,
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
  if (loginCookie && loginCookie.includes('MUSIC_U=')) return; // 已登录，跳过游客态
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
  const { params } = await eapi(path, data, header, '');
  const endpoint = path.replace(/^\/api/, '');
  const url = `${EAPI_BASE}/eapi${endpoint}`;
  const cookie = buildDeviceCookieJar(did);
  const raw: string = await hostApi.invoke<string>('netease_http_post', {
    method: 'POST',
    url,
    body: `params=${encodeURIComponent(params)}`,
    cookie: loginCookie || cookie,
    referer: REFERER,
    origin: ORIGIN,
    real_ip: REAL_IP,
    user_agent: UA_EAPI,
    headers: {
      ...header,
      'Request-Id': header.requestId,
      '__csrf': '',
    },
  });
  const parsed = JSON.parse(raw || '{}');
  // 正常响应保持静默，仅在异常状态码时输出，避免下拉翻页时日志刷屏
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
  const { params } = await eapi(path, data, header, '');
  const endpoint = path.replace(/^\/api/, '');
  const url = `${EAPI_BASE}/eapi${endpoint}`;
  const cookie = buildDeviceCookieJar(did);
  const rawResp: string = await hostApi.invoke<string>('netease_http_post', {
    method: 'POST',
    url,
    body: `params=${encodeURIComponent(params)}`,
    cookie: loginCookie || cookie,
    referer: REFERER,
    origin: ORIGIN,
    real_ip: REAL_IP,
    user_agent: UA_EAPI,
    headers: {
      ...header,
      'Request-Id': header.requestId,
      '__csrf': '',
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
  songUrl: '/song/url',
  userAccount: '/user/account',
  userPlaylist: '/user/playlist',
  toplist: '/toplist',
  likeSong: '/song/like',
  subscribePlaylist: '/playlist/subscribe',
  manipulatePlaylistTracks: '/playlist/manipulate/tracks',
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
    case PATHS.songUrl:
      return { uri: '/api/song/enhance/player/url', data: { ids: JSON.stringify(params.ids || []), br: params.br ?? 999000 }, crypto: 'eapi' };
    case PATHS.userAccount:
      // 登录后的个人资料走 eapi，与扫码登录通道保持一致，避免 weapi 缺少 __csrf 返回空体
      return { uri: '/api/nuser/account/get', data: { timestamp: Date.now() }, crypto: 'eapi' };
    case PATHS.userPlaylist:
      // 我的歌单同样走 eapi，避免登录态 cookie 在 weapi 下校验失败
      return { uri: '/api/user/playlist', data: { uid: params.uid, limit: params.limit ?? 30, offset: params.offset ?? 0, includeVideo: true }, crypto: 'eapi' };
    case PATHS.toplist:
      // 分页：offset>0 时按 [offset, offset+limit) 切片取后续曲目；
      // offset=0 时用 n 一次性拉取（兼容歌单首屏/播放全部场景）。
      return params.offset
        ? { uri: '/api/v3/playlist/detail', data: { id: params.id, offset: params.offset, limit: params.limit ?? 30, s: 8 }, crypto: 'eapi' }
        : { uri: '/api/v3/playlist/detail', data: { id: params.id, n: params.limit ?? 20, s: 8 }, crypto: 'eapi' };
    case PATHS.likeSong:
      return { uri: '/api/song/like', data: { id: params.id, like: params.like, alg: params.alg ?? 'itembased', time: params.time ?? '3' }, crypto: 'weapi' };
    case PATHS.subscribePlaylist:
      return { uri: '/api/playlist/subscribe', data: { id: params.id, t: params.t }, crypto: 'weapi' };
    case PATHS.manipulatePlaylistTracks:
      return { uri: '/api/playlist/manipulate/tracks', data: { pid: params.pid, tracks: params.tracks, op: params.op }, crypto: 'weapi' };
    default:
      throw new Error(`未实现的网易云接口: ${path}`);
  }
}

// 统一入口：业务代码只传 path + params，通道由 resolveModule 决定
async function neteaseRequest(path: string, params: Record<string, any> = {}): Promise<any> {
  const mod = resolveModule(path, params);
  if (mod.crypto === 'eapi') {
    return eapiRequest(mod.uri, mod.data);
  }
  return post(mod.uri, mod.data);
}

// eapi 业务请求（不复用 eapiPost，因为它带登录专属 header 写法；这里与 eapiPost 同构）
async function eapiRequest(uri: string, data: Record<string, any>): Promise<any> {
  await ensureGuest();
  const did = getOrCreateDeviceId();
  const header = buildEapiHeader(did);
  const { params: encParams } = await eapi(uri, data, header, '');
  const url = `${EAPI_BASE}/eapi${uri.replace(/^\/api/, '')}`;
  const cookie = [loginCookie, buildDeviceCookieJar(did)].filter(Boolean).join('; ') || buildDeviceCookieJar(did);
  const raw: string = await hostApi.invoke<string>('netease_http_post', {
    method: 'POST',
    url,
    body: `params=${encodeURIComponent(encParams)}`,
    cookie,
    referer: REFERER,
    origin: ORIGIN,
    real_ip: REAL_IP,
    user_agent: UA_EAPI,
    headers: { ...header, 'Request-Id': header.requestId, __csrf: '' },
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
  let cookieSaved = false;
  if (code === 803) {
    // 网易云 803 响应的 MUSIC_U 通常在 HTTP Set-Cookie 头里，body 里的 cookie 字段可能为空。
    // eapiPostWithCookies 已自动把 Set-Cookie 中的 MUSIC_U/__csrf 保存到 loginCookie。
    cookieSaved = isLoggedIn();
    if (!cookieSaved) {
      console.warn('[netease] 803 后端已返回 Set-Cookie，但本地未持久化到 MUSIC_U。body 键:', Object.keys(raw || {}));
    } else {
      console.log('[netease] 803 登录态 cookie 已从 Set-Cookie 保存');
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
  // 登录态优先用登录 cookie 里的 __csrf（与 MUSIC_U 配对），否则回落游客态 __csrf，形成 weapi csrf 闭环
  const loginCsrf = loginCookie ? (loginCookie.match(/__csrf=([^;]+)/) || [])[1] : '';
  const csrf = loginCsrf || guestCsrf || '';
  const { params, encSecKey } = await weapi(data, csrf);
  // 对齐 MusicStorm：weapi cookie 需同时带登录态 MUSIC_U 与设备态 MUSIC_A
  const cookie = [loginCookie, guestCookie].filter(Boolean).join('; ') || '';
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
  if (parsed.status && parsed.status !== 200) {
    console.warn('[netease] post', endpoint, 'status', parsed.status, 'body', String(parsed.body || '').slice(0, 300));
  }
  // 回写响应里的 cookie（MUSIC_A / __csrf 等），形成 csrf 闭环
  if (parsed.cookies && parsed.cookies.length) {
    absorbCookies(parsed.cookies);
    absorbBodyCookie(parsed.body);
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
}

function mapTrack(s: any, priv?: any): NeteaseTrack {
  const artists = s.artists || s.ar || [];
  const album = s.album || s.al || {};
  const p = priv || s.privilege || {};
  return {
    id: s.id,
    name: s.name,
    artist: artists.map((a: any) => a.name).join('/') || '未知歌手',
    album: album.name || '',
    duration: s.duration || s.dt || 0,
    cover: album.picUrl || album.cover || '',
    fee: s.fee ?? p.fee ?? 0,
    maxbr: p.maxbr || 0,
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

// 歌单/榜单详情：eapi /api/v6/playlist/detail（或 /api/v3/playlist/detail）
// 支持 offset 分页以实现无限下拉；返回结构含总数 total，便于判断是否到底。
export interface TopListResult {
  tracks: NeteaseTrack[];
  total: number;
}
export async function getTopList(
  id: number,
  limit = 20,
  offset = 0,
): Promise<TopListResult> {
  const r = await neteaseRequest(PATHS.toplist, { id, limit, offset });
  const list = r?.playlist?.tracks || [];
  const total = typeof r?.playlist?.trackCount === 'number' ? r.playlist.trackCount : list.length;
  // privileges 数组与 tracks 按 index 对应，含 fee / maxbr 等音质与版权信息
  const privs = r?.playlist?.privileges || [];
  return { tracks: list.slice(0, limit).map((s: any, i: number) => mapTrack(s, privs[i])), total };
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
  await neteaseRequest(PATHS.likeSong, {
    id: songId,
    like,
    alg: 'itembased',
    time: '3',
  });
}

/** 收藏/取消收藏网易云歌单 */
export async function subscribeNeteasePlaylist(playlistId: number, subscribe: boolean): Promise<void> {
  await neteaseRequest(PATHS.subscribePlaylist, {
    id: playlistId,
    t: subscribe ? 1 : 2,
  });
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
