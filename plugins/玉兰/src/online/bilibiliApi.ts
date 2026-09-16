/// <reference path="../../../global.d.ts" />
// 哔哩哔哩 Web API（TS 端完成 wbi 签名，Rust 仅做无 CORS 转发）
//
// 数据流：搜索 / 取流均由 biliRequest 经 bilibili_request 代理打到 B 站官方接口；
// wbi 签名（imgKey/subKey + mixin + MD5）在 TS 端算好，拼进 query。
// 播放地址取回后交给我们的 VideoPlayer（去广告、统一控制条 + SMTC）。
//
// 会话管理（对齐音乐模块的「游客态注册」思路）：
//   1) 首次请求前先取设备指纹 /x/frontend/finger/spi，拼出 buvid3/buvid4 Cookie，
//      显著降低 -412 风控概率（旧实现没有这一步，setBiliCookie 是死代码）。
//   2) 所有响应里的 Set-Cookie 自动并入本地 cookie jar，后续请求自动带上。
//   3) 用户若提供登录 Cookie（setBiliCookie），则走登录态，可解锁更高清晰度。
import CryptoJS from 'crypto-js';
import type { OnlineVideoItem } from './videoPlatforms';

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => '{}' };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';
export { REFERER as BILI_REFERER };

// ============ 会话 Cookie ============
const cookieJar = new Map<string, string>();
/** 用户手动注入的登录 Cookie（优先级高于自动收集） */
let loginCookie = '';

function absorbSetCookie(list: unknown) {
  if (!Array.isArray(list)) return;
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const pair = raw.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) cookieJar.set(k, v);
  }
}

/** 合并登录 Cookie（形如 "SESSDATA=xxx; bili_jct=yyy"）到 jar */
export function setBiliCookie(c: string) {
  loginCookie = c || '';
  if (!loginCookie) return;
  for (const part of loginCookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    cookieJar.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
}

export function getBiliCookie(): string {
  return buildCookieHeader();
}

function buildCookieHeader(): string {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 是否已具备游客态基础 Cookie（buvid3） */
export function hasVisitorCookie(): boolean {
  return cookieJar.has('buvid3');
}

let visitorReady: Promise<void> | null = null;
/**
 * 确保具备游客态 Cookie。
 * /x/frontend/finger/spi 返回 b_3 / b_4，官方前端就是用它们拼 buvid3 / buvid4 的。
 * 幂等：并发调用共享同一个 Promise；失败也不阻塞业务（只是少一层防风控）。
 */
export async function ensureVisitorCookie(): Promise<void> {
  if (hasVisitorCookie()) return;
  if (visitorReady) return visitorReady;
  visitorReady = (async () => {
    try {
      const json = await biliRequest('GET', 'https://api.bilibili.com/x/frontend/finger/spi', {
        skipVisitor: true,
      });
      const b3 = json?.data?.b_3;
      const b4 = json?.data?.b_4;
      if (b3) cookieJar.set('buvid3', String(b3));
      if (b4) cookieJar.set('buvid4', String(b4));
      if (!cookieJar.has('b_nut')) cookieJar.set('b_nut', String(Math.floor(Date.now() / 1000)));
    } catch {
      // 静默：游客态只是增强，拿不到也继续
    }
  })();
  return visitorReady;
}

// ============ 代理请求 ============
interface BiliReqOpts {
  cookie?: string;
  headers?: Record<string, string>;
  /** 跳过游客态前置（取指纹接口自身调用时用，避免递归） */
  skipVisitor?: boolean;
}

async function biliRequest(method: string, url: string, opts: BiliReqOpts = {}): Promise<any> {
  if (!opts.skipVisitor) await ensureVisitorCookie();
  const raw = await hostApi.invoke('bilibili_request', {
    method,
    url,
    body: null,
    cookie: opts.cookie ?? buildCookieHeader() ?? null,
    headers: opts.headers || null,
    referer: REFERER,
    user_agent: UA,
  });
  const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
  // 自动收集 Set-Cookie，保持会话连续性
  absorbSetCookie(parsed?.cookies);
  if (parsed.status && parsed.status !== 200) {
    throw new Error(`B站请求失败 HTTP ${parsed.status}`);
  }
  const body = typeof parsed.body === 'string' ? JSON.parse(parsed.body || '{}') : parsed.body;
  return body;
}

// ============ wbi 签名 ============
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50,
  10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

function getMixinKey(orig: string): string {
  let s = '';
  for (const i of MIXIN_KEY_ENC_TAB) s += orig[i] || '';
  return s.slice(0, 32);
}

interface WbiKeys {
  imgKey: string;
  subKey: string;
}
let cachedKeys: WbiKeys | null = null;
let keyPromise: Promise<WbiKeys> | null = null;

export async function getWbiKeys(): Promise<WbiKeys> {
  if (cachedKeys) return cachedKeys;
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    // ⚠️ 该接口必须在 Rust 代理白名单里（bilibili_proxy.rs: /x/web-interface/nav）。
    // 缺这条会让所有 wbi 签名接口全部失败。
    //
    // ⚠️⚠️ 游客态该接口返回 `code: -101`（账号未登录），但 **data.wbi_img 依然可用**！
    // 判据必须是「wbi_img 是否存在」，不能是 `code === 0` —— 否则游客态永远拿不到密钥，
    // 搜索/取流全部报「获取 wbi 密钥失败」。实测确认（2026-09-13）。
    const json = await biliRequest('GET', 'https://api.bilibili.com/x/web-interface/nav');
    if (!json?.data?.wbi_img) {
      throw new Error(`获取 wbi 密钥失败：${json?.message || json?.code}`);
    }
    const img = json.data.wbi_img.img_url.split('/').pop()?.split('.')[0] || '';
    const sub = json.data.wbi_img.sub_url.split('/').pop()?.split('.')[0] || '';
    cachedKeys = { imgKey: img, subKey: sub };
    return cachedKeys;
  })().catch((e) => {
    // 失败不缓存，允许下次重试
    keyPromise = null;
    throw e;
  });
  return keyPromise;
}

/** 供 UI 展示登录态（未登录时 isLogin 为 false） */
export async function getBiliNav(): Promise<{ isLogin: boolean; uname?: string; face?: string }> {
  try {
    const json = await biliRequest('GET', 'https://api.bilibili.com/x/web-interface/nav');
    return {
      isLogin: !!json?.data?.isLogin,
      uname: json?.data?.uname,
      face: json?.data?.face,
    };
  } catch {
    return { isLogin: false };
  }
}

export async function encWbi(params: Record<string, string>): Promise<Record<string, string>> {
  const { imgKey, subKey } = await getWbiKeys();
  const mixinKey = getMixinKey(imgKey + subKey);
  const sorted = Object.entries(params).sort((a, b) => a[0].localeCompare(b[0]));
  const query = sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const wts = Math.floor(Date.now() / 1000);
  const w_rid = CryptoJS.MD5(`${query}&wts=${wts}${mixinKey}`).toString();
  return { ...params, wts: String(wts), w_rid };
}

function buildUrl(base: string, params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}?${qs}`;
}

function stripHtml(s: string): string {
  return (s || '').replace(/<[^>]+>/g, '');
}

/**
 * 搜索接口的 `duration` 是**字符串**（实测 102/102 条样本均为 string），形如
 * `"2:5"`、`"1251:9"`（MM:SS，秒数不补零），偶尔 `"1:02:03"`（H:MM:SS）。
 * 旧实现直接 `Number(it.duration)` → NaN → 每条结果时长都显示 `0:00`。
 */
export function parseDurationText(s: unknown): number {
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  if (typeof s !== 'string') return 0;
  const parts = s.split(':').map((x) => Number(x));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/** 秒 → `MM:SS`（超 1 小时给 `H:MM:SS`） */
export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fixPic(p: string | undefined): string | undefined {
  if (!p) return undefined;
  return p.startsWith('//') ? `https:${p}` : p;
}

// ============ 清晰度 ============
export const BILI_QUALITIES: { qn: number; label: string; needLogin: boolean }[] = [
  { qn: 16, label: '360P', needLogin: false },
  { qn: 32, label: '480P', needLogin: false },
  { qn: 64, label: '720P', needLogin: true },
  { qn: 80, label: '1080P', needLogin: true },
  { qn: 112, label: '1080P+', needLogin: true },
  { qn: 116, label: '1080P60', needLogin: true },
];
export const DEFAULT_QN = 32;

// ============ 搜索 ============
export interface BiliSearchResult extends OnlineVideoItem {
  play: number;
  durationText: string;
  pubdate?: number;
}

export async function searchBili(keyword: string, page = 1): Promise<BiliSearchResult[]> {
  const baseParams: Record<string, string> = {
    keyword,
    page: String(page),
    web_location: '333.1007',
    order: 'totalrank',
    platform: 'pc',
  };
  const signed = await encWbi(baseParams);
  const url = buildUrl('https://api.bilibili.com/x/web-interface/wbi/search/all/v2', signed);
  const json = await biliRequest('GET', url);
  if (json.code !== 0) throw new Error(`搜索失败：${json.message || json.code}`);
  const groups: any[] = json.data?.result || [];
  const videoGroup = groups.find((g) => g.result_type === 'video');
  const items: any[] = videoGroup?.data || [];
  // ⚠️ 实测部分条目没有 bvid（如直播/特殊卡），此时 id 会是 undefined，
  // 点开必然取流失败。这里直接过滤掉，保证列表里每一项都可播。
  return items.filter((it) => typeof it?.bvid === 'string' && it.bvid.length > 0).map((it) => {
    // duration 是 "MM:SS" 字符串，必须解析（见 parseDurationText 注释）
    const dur = parseDurationText(it.duration);
    return {
      id: it.bvid,
      title: stripHtml(it.title),
      author: it.author,
      cover: fixPic(it.pic),
      durationSecs: dur,
      durationText: formatDuration(dur),
      play: Number(it.play) || 0,
      meta: { bvid: it.bvid },
    } as BiliSearchResult;
  });
}

// ============ 首页：推荐 / 热门 / 分区排行榜 ============
//
// 实测（2026-09-13）确认可用：
//  · 推荐流 /x/web-interface/index/top/feed/rcmd  → data.item[]（**非 wbi 路径即可**，无需签名）
//  · 热门   /x/web-interface/popular             → data.list[]
//  · 分区   /x/web-interface/ranking/v2?rid=<id> → data.list[]
// 三条路径均已在 bilibili_proxy.rs 白名单中，无需改动 Rust 侧。

/** 统一把「卡片型」条目映射成搜索结果结构（推荐流 / 排行榜 / 热门 共用） */
function mapCard(it: any): BiliSearchResult | null {
  if (typeof it?.bvid !== 'string' || it.bvid.length === 0) return null;
  const dur = parseDurationText(it.duration);
  return {
    id: it.bvid,
    title: stripHtml(it.title),
    author: it.owner?.name,
    cover: fixPic(it.pic),
    durationSecs: dur,
    durationText: formatDuration(dur),
    play: Number(it.stat?.view) || 0,
    meta: { bvid: it.bvid },
  };
}

const isCard = (x: BiliSearchResult | null): x is BiliSearchResult => x !== null;

/**
 * 推荐流。
 * ⚠️ 返回的 item 里混有 `goto: 'login_card'`（未登录引导卡）与 `goto: 'ad'`（广告），
 * 实测 12 条里有 1 张引导卡 + 1 条广告。必须只保留 `goto === 'av'`，
 * 否则界面上会出现空白卡片，而且会把广告塞进「去广告播放」的模块里。
 */
export async function getBiliRecommend(ps = 24): Promise<BiliSearchResult[]> {
  const url = `https://api.bilibili.com/x/web-interface/index/top/feed/rcmd?ps=${ps}&fresh_type=3&feed_version=V8`;
  const json = await biliRequest('GET', url);
  if (json.code !== 0) throw new Error(`获取推荐失败：${json.message || json.code}`);
  const items: any[] = json.data?.item || [];
  return items.filter((it) => it?.goto === 'av').map(mapCard).filter(isCard);
}

/** 热门 */
export async function getBiliPopular(ps = 24): Promise<BiliSearchResult[]> {
  const url = `https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=1`;
  const json = await biliRequest('GET', url);
  if (json.code !== 0) throw new Error(`获取热门失败：${json.message || json.code}`);
  const list: any[] = json.data?.list || [];
  return list.map(mapCard).filter(isCard);
}

/**
 * 分区排行榜。
 * @param rid 分区 id；0 = 全站
 */
export async function getBiliRanking(rid = 0, ps = 24): Promise<BiliSearchResult[]> {
  const url = `https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`;
  const json = await biliRequest('GET', url);
  if (json.code !== 0) throw new Error(`获取分区内容失败：${json.message || json.code}`);
  const list: any[] = json.data?.list || [];
  return list.slice(0, ps).map(mapCard).filter(isCard);
}

/**
 * 分区列表。
 * 官方已无「分区树」公开接口（`/x/web-interface/region/list` 返回 404），
 * 故此表为**实测筛选后**的常量：每个 rid 都用 `ranking/v2` 验证过能返回数据。
 * 已剔除实测返回 -400 的番剧(13) 与生活兴趣(249)。
 */
export const BILI_REGIONS: { rid: number; name: string }[] = [
  { rid: 0, name: '全站' },
  { rid: 1, name: '动画' },
  { rid: 3, name: '音乐' },
  { rid: 4, name: '游戏' },
  { rid: 5, name: '娱乐' },
  { rid: 11, name: '电视剧' },
  { rid: 23, name: '电影' },
  { rid: 36, name: '知识' },
  { rid: 119, name: '鬼畜' },
  { rid: 129, name: '舞蹈' },
  { rid: 155, name: '时尚' },
  { rid: 160, name: '生活' },
  { rid: 168, name: '国创相关' },
  { rid: 181, name: '影视' },
  { rid: 188, name: '数码' },
  { rid: 211, name: '美食' },
  { rid: 217, name: '动物圈' },
  { rid: 223, name: '汽车' },
  { rid: 234, name: '运动' },
];

// ============ 视频信息 + 播放地址 ============
export interface BiliPlayInfo {
  /** 按播放顺序排列的分片地址。单段时长度为 1。 */
  urls: string[];
  /** 服务端实际给出的清晰度 qn */
  quality: number;
  /** 分片数（>1 表示长视频多段） */
  segmentCount: number;
}

export async function getBiliView(bvid: string): Promise<{ cid: number; title: string; cover: string }> {
  const signed = await encWbi({ bvid });
  const url = buildUrl('https://api.bilibili.com/x/web-interface/view', signed);
  const json = await biliRequest('GET', url);
  if (json.code !== 0) throw new Error(`获取视频信息失败：${json.message || json.code}`);
  return {
    cid: json.data.cid,
    title: json.data.title,
    cover: fixPic(json.data.pic) || '',
  };
}

/** 请求一次 playurl，返回 durl 分片列表（无 durl 则返回空数组） */
async function requestPlayUrl(
  bvid: string,
  cid: number,
  qn: number,
  fnval: string,
): Promise<{ urls: string[]; quality: number }> {
  const signed = await encWbi({
    bvid,
    cid: String(cid),
    qn: String(qn),
    fnval,
    fourk: '1',
    platform: 'pc',
  });
  const url = buildUrl('https://api.bilibili.com/x/player/wbi/playurl', signed);
  const json = await biliRequest('GET', url);
  if (json.code !== 0) throw new Error(`获取播放地址失败：${json.message || json.code}`);
  const durl: any[] = json.data?.durl || [];
  const urls = durl.map((d) => d?.url).filter((u): u is string => typeof u === 'string' && u.length > 0);
  return { urls, quality: Number(json.data?.quality) || qn };
}

/**
 * 取播放地址。
 * 优先 fnval=1（MP4 混流，单流可直接播放）；失败回落 fnval=0（FLV 混流）。
 * 两种都拿不到 durl 时抛出明确错误，而不是返回只有画面没声音的 DASH 视频流。
 *
 * ⚠️ 多段：B 站长视频/高码率会返回多段 durl，必须整段交给播放器/下载器按序处理，
 * 只取第一段会导致「只能播前几分钟」。
 */
export async function getBiliPlayUrl(bvid: string, cid: number, qn = DEFAULT_QN): Promise<BiliPlayInfo> {
  let info = await requestPlayUrl(bvid, cid, qn, '1');
  if (info.urls.length === 0) {
    info = await requestPlayUrl(bvid, cid, qn, '0');
  }
  if (info.urls.length === 0) {
    throw new Error('无可用播放地址（该视频可能需要登录、为会员专享，或受地区限制）');
  }
  return { urls: info.urls, quality: info.quality, segmentCount: info.urls.length };
}

/** 一站式：搜索结果 → 取流（qn 由调用方决定，避免「清晰度下拉无效」） */
export async function resolveBili(item: OnlineVideoItem, qn = DEFAULT_QN): Promise<BiliPlayInfo> {
  const bvid = (item.meta?.bvid as string) || item.id;
  const view = await getBiliView(bvid);
  return getBiliPlayUrl(bvid, view.cid, qn);
}
