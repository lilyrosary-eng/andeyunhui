/// <reference path="../../global.d.ts" />
// 哔哩哔哩 Web API（TS 端完成 wbi 签名，Rust 仅做无 CORS 转发）
//
// 数据流：搜索/取流均由 biliRequest 经 bilibili_request 代理打到 B 站官方接口；
// wbi 签名（imgKey/subKey + mixin + MD5）在 TS 端算好，拼进 query。
// 播放地址（DASH/DURL）取回后交给我们的 VideoPlayer（去广告、统一控制条 + SMTC）。
import CryptoJS from 'crypto-js';
import type { OnlineVideoItem } from './videoPlatforms';

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => '{}' };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';

// 会话级 Cookie（登录态可提升清晰度/解锁会员；留空为游客态）
let sessionCookie = '';
export function setBiliCookie(c: string) {
  sessionCookie = c || '';
}
export function getBiliCookie() {
  return sessionCookie;
}

// ============ 代理请求 ============
interface BiliReqOpts {
  cookie?: string;
  headers?: Record<string, string>;
}
async function biliRequest(method: string, url: string, opts: BiliReqOpts = {}): Promise<any> {
  const raw = await hostApi.invoke('bilibili_request', {
    method,
    url,
    body: null,
    cookie: opts.cookie || sessionCookie || null,
    headers: opts.headers || null,
    referer: REFERER,
    user_agent: UA,
  });
  const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
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
    const json = await biliRequest('GET', 'https://api.bilibili.com/x/web-interface/nav');
    if (json.code !== 0 || !json.data?.wbi_img) {
      throw new Error(`获取 wbi 密钥失败：${json.message || json.code}`);
    }
    const img = json.data.wbi_img.img_url.split('/').pop()?.split('.')[0] || '';
    const sub = json.data.wbi_img.sub_url.split('/').pop()?.split('.')[0] || '';
    cachedKeys = { imgKey: img, subKey: sub };
    return cachedKeys;
  })();
  return keyPromise;
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
  return items.map((it) => {
    const dur = Number(it.duration) || 0;
    const mm = Math.floor(dur / 60);
    const ss = String(dur % 60).padStart(2, '0');
    return {
      id: it.bvid,
      title: stripHtml(it.title),
      author: it.author,
      cover: it.pic?.startsWith('//') ? `https:${it.pic}` : it.pic,
      durationSecs: dur,
      durationText: `${mm}:${ss}`,
      play: Number(it.play) || 0,
      meta: { bvid: it.bvid },
    } as BiliSearchResult;
  });
}

// ============ 视频信息 + 播放地址 ============
export interface BiliPlayInfo {
  url: string;
  quality: number;
}

export async function getBiliView(bvid: string): Promise<{ cid: number; title: string; cover: string }> {
  const signed = await encWbi({ bvid });
  const url = buildUrl('https://api.bilibili.com/x/web-interface/view', signed);
  const json = await biliRequest('GET', url);
  if (json.code !== 0) throw new Error(`获取视频信息失败：${json.message || json.code}`);
  return {
    cid: json.data.cid,
    title: json.data.title,
    cover: json.data.pic?.startsWith('//') ? `https:${json.data.pic}` : json.data.pic,
  };
}

export async function getBiliPlayUrl(bvid: string, cid: number, qn = 80): Promise<BiliPlayInfo> {
  const signed = await encWbi({
    bvid,
    cid: String(cid),
    qn: String(qn),
    fnval: '0', // 取混流 DURL（视频+音频已封装），便于直接用我们的播放器播放
    fourk: '1',
    platform: 'pc',
  });
  const url = buildUrl('https://api.bilibili.com/x/player/wbi/playurl', signed);
  const json = await biliRequest('GET', url);
  if (json.code !== 0) throw new Error(`获取播放地址失败：${json.message || json.code}`);
  const durl: any[] = json.data?.durl || [];
  if (durl.length) {
    // 选最高码率混流
    const best = durl.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a), durl[0]);
    return { url: best.url, quality: json.data.quality || qn };
  }
  // 兜底：DASH（仅视频流，无声，标注限制）
  const dash = json.data?.dash;
  if (dash?.video?.length) {
    return { url: dash.video[0].baseUrl, quality: json.data.quality || qn };
  }
  throw new Error('无可用播放地址（可能为会员/地区限制）');
}

// 一站式：搜索结果 → 取流
export async function resolveBili(item: OnlineVideoItem): Promise<BiliPlayInfo> {
  const bvid = (item.meta?.bvid as string) || item.id;
  const view = await getBiliView(bvid);
  const info = await getBiliPlayUrl(bvid, view.cid);
  return info;
}
