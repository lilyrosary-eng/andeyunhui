import { invoke } from '@tauri-apps/api/core';

/**
 * localimg://<percent-encoded-path> → data URL 缓存，避免重复读盘。
 * 笔记中的图片以 localimg:// 占位引用，渲染时再解析为 data URL，
 * 既让图片自包含（不内联进笔记文本），又不撑大笔记体积。
 *
 * 有界 LRU（P1 内存优化）：base64 data URL 平均膨胀 ~1.33 倍，数张
 * 4K 截图即可累积数百 MB 且永不释放。上限 100 条 / 64MB 字符（≈48MB
 * 实际文件），超过时按最久未用 evict；命中刷新顺序，失败标记条目
 * <1KB 不占配额。
 */
const localImageCache = new Map<string, string>();

const MAX_LOCAL_IMAGE_CACHE_ENTRIES = 100;
const MAX_LOCAL_IMAGE_CACHE_CHARS = 64 * 1024 * 1024; // 64M chars ≈ 48MB 文件
let localImageCacheChars = 0;

/** 命中/写入后刷新 LRU 顺序：先删再插，Map 迭代序 = 最近使用序（尾部最新）。 */
function lruTouch(enc: string, url: string): void {
  localImageCache.delete(enc);
  localImageCache.set(enc, url);
}

/** 从最久未用（头部）开始逐出，直到条目数与总字符数双双回落到上限内。 */
function lruEvict(): void {
  while (
    localImageCache.size > MAX_LOCAL_IMAGE_CACHE_ENTRIES ||
    localImageCacheChars > MAX_LOCAL_IMAGE_CACHE_CHARS
  ) {
    const oldest = localImageCache.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    const url = localImageCache.get(oldest)!;
    localImageCacheChars -= url.length;
    localImageCache.delete(oldest);
  }
}

/**
 * 把 localimg:// 占位引用（percent-encoded 路径）解析为 data URL。
 * 解析失败返回空字符串（调用方据此降级，例如隐藏破图）。
 */
export async function resolveLocalImage(enc: string): Promise<string> {
  const hit = localImageCache.get(enc);
  if (hit !== undefined) {
    lruTouch(enc, hit); // 刷新顺序
    return hit;
  }
  try {
    const filePath = decodeURIComponent(enc);
    const dataUrl = await invoke<string>('read_file_base64', { filePath });
    localImageCacheChars += dataUrl.length;
    lruTouch(enc, dataUrl);
    lruEvict();
    return dataUrl;
  } catch (err) {
    console.error('[Notes] 解析本地图片失败:', enc, err);
localImageCache.set(enc, ''); // 标记失败，避免反复重试
    return '';
  }
}

const LOCAL_IMG_RE = /src="localimg:\/\/([^"]+)"/g;

/**
 * 在一段 HTML 字符串中，把所有 src="localimg://..." 替换为解析后的 data URL。
 * 用于 markdown 预览等非 TipTap 渲染路径。
 */
export async function resolveLocalImagesInHtml(html: string): Promise<string> {
  const matches = [...html.matchAll(LOCAL_IMG_RE)];
  if (matches.length === 0) return html;
  const unique = [...new Set(matches.map((m) => m[1]))];
  await Promise.all(unique.map((enc) => resolveLocalImage(enc).then(() => {})));
  return html.replace(LOCAL_IMG_RE, (_full, enc: string) => {
    const url = localImageCache.get(enc) || '';
    return url ? `src="${url}"` : 'src=""';
  });
}

// 1×1 透明像素：改写前先占位，阻断浏览器对 localimg:// 的立即请求（避免 ERR_UNKNOWN_URL_SCHEME）
const TRANSPARENT_PX =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

let sanitizerInstalled = false;

/**
 * 全局兜底：任何把 localimg:// 直接写进 <img>/<source> 的 src/srcset 的渲染路径
 * （编辑器 NodeView、markdown 预览、插件等），若上层未解析，浏览器会尝试加载该未知协议
 * 并抛出 net::ERR_UNKNOWN_URL_SCHEME。用 MutationObserver 在浏览器发起请求前改写为已解析的
 * data URL，从源头消除该报错。仅在主窗口文档生效，重复调用安全。
 */
export function installLocalImageSanitizer(): void {
  if (sanitizerInstalled || typeof document === 'undefined') return;
  sanitizerInstalled = true;

  const resolveAttr = (el: Element, attr: 'src' | 'srcset') => {
    const raw = el.getAttribute(attr) || '';
    if (!raw.includes('localimg://')) return;
    if (attr === 'src') {
      const enc = raw.slice('localimg://'.length);
      el.setAttribute('src', TRANSPARENT_PX); // 先占位，阻断 localimg:// 请求
      void resolveLocalImage(enc).then((url) => {
        if (url) el.setAttribute('src', url);
      });
    } else {
      const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
      Promise.all(
        parts.map(async (p) => {
          const [u, w] = p.split(/\s+/);
          if (u.startsWith('localimg://')) {
            const url = await resolveLocalImage(u.slice('localimg://'.length));
            return url ? `${url}${w ? ' ' + w : ''}` : '';
          }
          return p;
        })
      ).then((resolved) => {
        const next = resolved.filter(Boolean).join(', ');
        if (next) el.setAttribute('srcset', next);
      });
    }
  };

  const handle = (el: Element) => {
    if (el.tagName !== 'IMG' && el.tagName !== 'SOURCE') return;
    if (el.getAttribute('src')?.startsWith('localimg://')) resolveAttr(el, 'src');
    if ((el.getAttribute('srcset') || '').includes('localimg://')) resolveAttr(el, 'srcset');
  };

  // 注意：不再覆写 `HTMLImageElement.prototype.src` setter/getter。
  // 该全局覆写会包裹应用内**每一次** img.src 赋值，且 getter 对 localimg 返回占位值，
  // 与 React 的属性对账相互踩踏，导致渲染抖动（截图后中转站/笔记页图片「很久才出现」的卡顿根因）。
  // 改回纯 MutationObserver 兜底：既捕获属性变更，也捕获新插入节点（用带前缀的选择器限定命中面）。
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && (m.attributeName === 'src' || m.attributeName === 'srcset')) {
        handle(m.target as Element);
      } else if (m.type === 'childList') {
        m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          const el = node as Element;
          handle(el);
          // 仅匹配带 localimg 的 img/source（属性前缀选择器命中面极小，遍历开销可控），
          // 避免对每个新增节点无差别 querySelectorAll('img, source')。
          el.querySelectorAll?.(
            'img[src^="localimg://"], source[srcset*="localimg://"]'
          ).forEach(handle);
        });
      }
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ['src', 'srcset'],
  });

  // 兜底：安装前已存在于文档中的节点
  document
    .querySelectorAll('img[src^="localimg://"], source[srcset*="localimg://"]')
    .forEach(handle);
}
