/// <reference path="../../../global.d.ts" />
// 媒体播放地址代理：把需要防盗链 Referer 的 CDN 地址包成 bimedia 自定义协议 URL，
// 交给 Rust 侧（src-tauri/src/media_relay.rs）带正确 Referer 取流并转发 Range。
//
// 为什么必须走这一层（2026-09-13 实测）：
//   B 站全部 CDN 主机 —— 含 upos-sz-*.bilivideo.com 与 P2P 边缘节点 —— 表现完全一致：
//     · 不带 Referer                        → 403
//     · Referer: tauri://localhost（应用来源） → 403
//     · Referer: http://localhost:1420（dev） → 403
//     · Referer: https://www.bilibili.com    → 206 ✅
//   <video src="https://…"> 的 Referer 由 WebView 决定，前端无法伪造，
//   因此「直连 CDN 播放」必然 403 —— 必须由 Rust 代取。
//
// URL 形态（tauri 2.x 约定，见 Builder::register_uri_scheme_protocol 文档）：
//   Windows / Android : http://bimedia.localhost/<b64u(referer)>/<b64u(url)>
//   macOS / Linux     : bimedia://localhost/<b64u(referer)>/<b64u(url)>

const SCHEME = 'bimedia';

/** base64url（无填充），与 Rust 侧 `URL_SAFE_NO_PAD` 严格对应 */
function b64u(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 协议 URL 前缀：Windows/Android 走 http://<scheme>.localhost，其余走 <scheme>://localhost */
function schemePrefix(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Windows|Android/i.test(ua) ? `http://${SCHEME}.localhost/` : `${SCHEME}://localhost/`;
}

/**
 * 把远端媒体地址转成可被 <video> 加载的地址。
 * - referer 为空：原样返回（不需要防盗链的源没必要多绕一层）
 * - 非 http(s)：原样返回（本地/asset 地址不代理）
 */
export function toPlayableUrl(url: string | undefined, referer: string | undefined): string | undefined {
  if (!url) return undefined;
  if (!referer) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  return `${schemePrefix()}${b64u(referer)}/${b64u(url)}`;
}

/** 批量版本（B 站 durl 多段） */
export function toPlayableUrls(urls: string[] | undefined, referer: string | undefined): string[] | undefined {
  if (!urls || urls.length === 0) return undefined;
  return urls.map((u) => toPlayableUrl(u, referer) ?? u);
}

// ============ 链路自检 ============
// 媒体中继依赖「自定义协议 URL 形态」这一平台约定（Windows 为 http://bimedia.localhost/…），
// 一旦约定不符，表现是「封面全裂 + 播放没反应」，与防盗链失败**外观完全一样**，极难区分。
// 所以这里提供一次主动自检：对同一个地址分别「直连」与「经中继」请求，对比状态码。
//   · 直连 403 + 中继 206  → 中继工作正常
//   · 直连 403 + 中继 403  → 中继跑通了，但 Referer 没生效（或上游拒绝）
//   · 直连 403 + 中继 ERR  → 自定义协议没被路由（URL 形态或注册有问题）
export interface RelayCheckResult {
  sample: string;
  relayUrl: string;
  directStatus: number | 'ERR';
  relayStatus: number | 'ERR';
  verdict: string;
}

async function probeStatus(u: string): Promise<number | 'ERR'> {
  try {
    const r = await fetch(u, { method: 'GET', headers: { Range: 'bytes=0-255' } });
    // 读掉 body 释放连接（忽略内容）
    try {
      await r.arrayBuffer();
    } catch {
      /* ignore */
    }
    return r.status;
  } catch {
    return 'ERR';
  }
}

export async function checkMediaRelay(sampleUrl: string, referer: string): Promise<RelayCheckResult> {
  const relayUrl = toPlayableUrl(sampleUrl, referer) || sampleUrl;
  const directStatus = await probeStatus(sampleUrl);
  const relayStatus = await probeStatus(relayUrl);

  let verdict: string;
  if (relayStatus === 'ERR') {
    verdict = '❌ 中继未被路由：自定义协议 URL 形态可能不对（预期 http://bimedia.localhost/…），或协议未注册';
  } else if (relayStatus >= 200 && relayStatus < 300) {
    verdict = '✅ 中继工作正常（直连 403 而中继 2xx，说明 Referer 已被补上）';
  } else if (relayStatus === 403) {
    verdict = '⚠️ 中继可达但上游仍 403：Referer 未生效或被上游拒绝';
  } else {
    verdict = `⚠️ 中继返回 ${relayStatus}，需排查`;
  }

  return { sample: sampleUrl, relayUrl, directStatus, relayStatus, verdict };
}
