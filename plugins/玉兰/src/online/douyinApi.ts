/// <reference path="../../../global.d.ts" />
// ⚠️⚠️ 当前未接入（2026-09-13 实测结论）⚠️⚠️
//
// 本文件描述的「分享页 window._ROUTER_DATA 内嵌 videoInfoRes.item_list[].video.play_addr」
// 这条链路**已经失效**。实测证据：
//   1) 分享页 https://www.iesdouyin.com/share/video/<id>/ （移动 UA，HTTP 200）中
//      window._SSR_DATA.data === {}（空对象）；
//      window._ROUTER_DATA.loaderData['video_(id)/page'] 只有静态渲染配置
//      （ua/webId/abParams/serverToken…），**不含任何视频字段**；
//      整份 HTML 中 videoInfoRes / item_list / play_addr / url_list / aweme_id 出现 0 次。
//   2) 各详情接口（iesdouyin iteminfo、aweme/v1/web/aweme/detail、aweme.snssdk）一律返回
//      **空响应（0 字节）**，其中 iesdouyin/aweme/detail 返回 403 "blocked"。
//   3) 预热 Cookie 只能拿到反爬挑战 __ac_nonce。
//   → 抖音已改为客户端调用带 a_bogus 签名的接口，纯 HTTP 无法获取详情。
//
// 因此 videoPlatforms.ts 中抖音的 mode 为 'url'（「网址直连」面板），
// 但面板上的「解析」按钮**仍会调用本文件的 resolveDouyinShare 尝试一次** ——
// 万一风控放开、或用户拿到的是短链而跳转页恰好带数据，就能直接成功；
// 失败则把具体原因（如「分享页未包含视频信息」）显示给用户，而不是静默失败。
//
// 本文件与 src-tauri/src/services/douyin_proxy.rs 一并保留；
// 待接入签名方案（或改用其它合规数据源）后，在 OnlineVideoView.platformBody 里
// 增加一个专门的 DouyinView 分支即可（原实现见 git 历史）。
//
// ---------------------------------------------------------------------------
// 抖音 API（原方案：分享短链 → aweme_id → 分享页内嵌 JSON → 无水印直链）
//
// 为什么能不用网页：
//   抖音没有开放 Web API，但「分享链接 → 视频 id → 分享页内嵌 JSON」这条链路是纯 HTTP 的：
//     1) 分享短链 https://v.douyin.com/xxxx/ 本身就是 302 跳转，跟随即可拿到 /video/{aweme_id}
//     2) 分享页 https://www.iesdouyin.com/share/video/{aweme_id}/ 的 HTML 里带
//        window._ROUTER_DATA，内含 item_list[0].video.play_addr.url_list
//   两步都是普通 GET，无需浏览器、无需 a_bogus 签名，因此可以在纯 API 架构下完成。
//
// 所有请求经 douyin_request 代理（Rust 白名单 + 无 CORS 转发 + 回传 final_url）。
import type { OnlineVideoItem } from './videoPlatforms';

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => '{}' };

/** 桌面 UA 用于短链跳转 */
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
/** 移动 UA 用于分享页（分享页只对移动 UA 输出 _ROUTER_DATA） */
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export const DOUYIN_REFERER = 'https://www.douyin.com';

interface DyResponse {
  status: number;
  body: string;
  cookies: string[];
  finalUrl: string;
}

async function dyRequest(
  method: string,
  url: string,
  opts: { userAgent?: string; referer?: string; cookie?: string } = {},
): Promise<DyResponse> {
  const raw = await hostApi.invoke('douyin_request', {
    method,
    url,
    body: null,
    cookie: opts.cookie || null,
    headers: null,
    referer: opts.referer || null,
    user_agent: opts.userAgent || UA_DESKTOP,
  });
  const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
  if (parsed?.status && parsed.status !== 200 && parsed.status !== 302) {
    throw new Error(`抖音请求失败 HTTP ${parsed.status}`);
  }
  return {
    status: Number(parsed?.status) || 0,
    body: typeof parsed?.body === 'string' ? parsed.body : '',
    cookies: Array.isArray(parsed?.cookies) ? parsed.cookies : [],
    finalUrl: typeof parsed?.final_url === 'string' ? parsed.final_url : url,
  };
}

// ============ 分享文本 → URL ============
/** 从抖音分享文案里抠出链接（分享文案形如「7.32 复制打开抖音… https://v.douyin.com/xxxx/ 复制此链接…」） */
export function extractUrlFromShareText(text: string): string | null {
  const m = (text || '').match(/https?:\/\/[^\s"'<>，。！？、）)】\]]+/);
  return m ? m[0] : null;
}

/** 从各种形态的抖音 URL 里取 aweme_id */
export function extractAwemeId(url: string): string | null {
  const patterns = [
    /\/video\/(\d{6,})/,
    /\/note\/(\d{6,})/,
    /modal_id=(\d{6,})/,
    /item_id=(\d{6,})/,
    /\/share\/video\/(\d{6,})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

// ============ 分享页 _ROUTER_DATA 解析 ============
/**
 * 解析 HTML 里的 window._ROUTER_DATA。
 * 用花括号配平 + 字符串感知扫描，而不是贪婪正则 —— JSON 内部含 `}` 或 `</script>` 时正则易截断。
 */
export function parseRouterData(html: string): any | null {
  const marker = 'window._ROUTER_DATA';
  const mi = html.indexOf(marker);
  if (mi < 0) return null;
  const eq = html.indexOf('=', mi);
  if (eq < 0) return null;
  const start = html.indexOf('{', eq);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let p = start; p < html.length; p++) {
    const ch = html[p];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, p + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 在 loaderData 的各页面数据里找到视频条目 */
function findVideoItem(router: any): any | null {
  const loader = router?.loaderData;
  if (!loader || typeof loader !== 'object') return null;
  for (const key of Object.keys(loader)) {
    const res = loader[key]?.videoInfoRes;
    const list = res?.item_list;
    if (Array.isArray(list) && list.length > 0) return list[0];
  }
  return null;
}

function pickUrl(list: unknown): string | undefined {
  if (!Array.isArray(list)) return undefined;
  const u = list.find((x) => typeof x === 'string' && x.length > 0);
  return typeof u === 'string' ? u : undefined;
}

/** 去水印：playwm 是带水印通道，换成 play 即无水印 */
function stripWatermark(url: string): string {
  return url.replace('/playwm/', '/play/');
}

// ============ 主流程 ============
export interface DouyinVideo extends OnlineVideoItem {
  /** 无水印直链 */
  url: string;
  author?: string;
  cover?: string;
}

/**
 * 解析抖音分享链接 / 视频页链接，拿到可播放的无水印直链。
 * @param shareText 用户粘贴的分享文案或链接
 */
export async function resolveDouyinShare(shareText: string): Promise<DouyinVideo> {
  const url = extractUrlFromShareText(shareText) || shareText.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('未识别到链接，请粘贴抖音分享链接（形如 https://v.douyin.com/xxxx/）');
  }

  let awemeId = extractAwemeId(url);

  // 短链：跟随 302 拿到最终 /video/{id} 地址
  if (!awemeId && /(^|\.)v\.douyin\.com$/i.test(new URL(url).hostname)) {
    const r = await dyRequest('GET', url, { userAgent: UA_DESKTOP, referer: DOUYIN_REFERER });
    awemeId = extractAwemeId(r.finalUrl) || extractAwemeId(r.body);
    if (!awemeId) {
      throw new Error('短链跳转后未解析出视频 id（链接可能已失效）');
    }
  }
  if (!awemeId) {
    throw new Error('未能从链接中解析出视频 id，请确认是抖音视频分享链接');
  }

  // 分享页 HTML
  const sharePage = `https://www.iesdouyin.com/share/video/${awemeId}/`;
  const page = await dyRequest('GET', sharePage, {
    userAgent: UA_MOBILE,
    referer: DOUYIN_REFERER,
  });
  if (!page.body) {
    throw new Error('分享页返回空内容（可能被风控拦截，稍后重试）');
  }

  const router = parseRouterData(page.body);
  if (!router) {
    throw new Error('分享页结构已变化，未找到 window._ROUTER_DATA（抖音可能调整了页面）');
  }
  const item = findVideoItem(router);
  if (!item) {
    throw new Error('分享页未包含视频信息（该作品可能已删除、私密或为直播）');
  }

  const playUrl =
    pickUrl(item.video?.play_addr?.url_list) ||
    pickUrl(item.video?.play_addr_h264?.url_list) ||
    pickUrl(item.video?.download_addr?.url_list);
  if (!playUrl) {
    throw new Error('未取到播放地址（该作品可能受限）');
  }

  const cover =
    pickUrl(item.video?.cover?.url_list) ||
    pickUrl(item.video?.origin_cover?.url_list) ||
    pickUrl(item.video?.dynamic_cover?.url_list);

  return {
    id: awemeId,
    title: (item.desc || '').trim() || `抖音视频 ${awemeId}`,
    author: item.author?.nickname,
    cover,
    url: stripWatermark(playUrl),
    meta: { aweme_id: awemeId, from: 'douyin' },
  };
}
