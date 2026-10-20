import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { buildDocIframeHtml, dirToAssetUrl } from './markdown';

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
  installPendingAssetResolver();

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

// ==========================================================================
// 粘贴内容的相对图片：多目录兜底检索 + 回填（2026-10-20）
// ==========================================================================
//
// ## 场景
// 从别处**复制粘贴**进来的 markdown / HTML，图片是相对路径（`images/a.png`）。
// 剪贴板里没有任何来源目录信息，webview 里也没有基准 —— 这类路径必然 404。
// 既然推断不出来，就做**兜底检索**：后端在候选根目录下有界查找同名/同后缀的文件
// （见 commands/image_resolve.rs，带条目数/深度/时间三重上限 + 结果缓存）。
//
// ## 为什么要占位再回填，而不是渲染时直接解析
// `renderMarkdown` 是同步纯函数，而检索是磁盘 I/O。直接写相对路径会立刻发一个
// 必然 404 的请求（破图图标闪烁 + 控制台报错），所以渲染阶段只输出透明占位 + 标记，
// 由这里的 MutationObserver 收集后**批量**解析（一次 invoke 处理一批，不逐张发请求）。
//
// ## 整篇 HTML 文档
// 文档里的 `images/a.png` 在 iframe 内解析，我们改不了它的 DOM（沙箱不透明源）。
// 所以先拿文档里的第一张相对图片做"探针"：找到真实位置后反推出目录，
// 再以 `<base href="asset://…/">` 渲染 iframe —— 这样文档内所有相对资源都能加载。

/** 相对路径 → 绝对路径（null = 没找到）。会话级缓存，避免同一张图反复查盘。 */
const relPathCache = new Map<string, string | null>();
/** 缓存上限：一次长会话里可能出现大量唯一相对路径，不加界会一直涨。 */
const REL_CACHE_MAX = 500;

function rememberRel(rel: string, abs: string | null): void {
  if (relPathCache.size >= REL_CACHE_MAX && !relPathCache.has(rel)) {
    // 淘汰最早插入的一批（Map 保持插入序）
    let drop = Math.ceil(REL_CACHE_MAX * 0.2);
    for (const k of relPathCache.keys()) {
      relPathCache.delete(k);
      if (--drop <= 0) break;
    }
  }
  relPathCache.set(rel, abs);
}

const pendingImgs = new Map<HTMLImageElement, string>();
const pendingDocs = new Map<HTMLElement, string>();
let pendingTimer: number | undefined;
let resolverInstalled = false;

/** 检索根：项目根（浮岛写进 localStorage 的那个）+ 用户自定义的图片目录。 */
function imageRoots(): string[] {
  const out: string[] = [];
  try {
    const proj = localStorage.getItem('ide:lastProjectRoot');
    if (proj) out.push(proj);
  } catch { /* localStorage 不可用就算了，后端还有桌面/下载/图片/文档兜底 */ }
  try {
    const custom = localStorage.getItem('andeyunhui.imageRoots');
    if (custom) {
      for (const p of custom.split(/[;\n]/)) {
        const t = p.trim();
        if (t) out.push(t);
      }
    }
  } catch { /* 同上 */ }
  return out;
}

/** 从 HTML 文档里取第一张相对图片的 src（用于反推文档所在目录）。 */
function firstRelativeImageSrc(doc: string): string | null {
  const re = /<img[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc))) {
    const src = m[1].trim();
    if (!src) continue;
    if (/^(https?:|data:|blob:|asset:|localimg:|about:|#)/i.test(src)) continue;
    return src;
  }
  return null;
}

/** 由「探针绝对路径 + 探针相对路径」反推文档目录。 */
function deriveBaseDir(abs: string, rel: string): string | null {
  const a = abs.replace(/\\/g, '/');
  const r = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (a.endsWith('/' + r)) return a.slice(0, a.length - r.length - 1);
  const idx = a.lastIndexOf('/');
  return idx > 0 ? a.slice(0, idx) : null;
}

function scheduleResolve(): void {
  if (pendingTimer !== undefined) return;
  pendingTimer = window.setTimeout(() => {
    pendingTimer = undefined;
    void flushPending();
  }, 90);
}

async function flushPending(): Promise<void> {
  const imgs = [...pendingImgs.entries()];
  const docs = [...pendingDocs.entries()];
  pendingImgs.clear();
  pendingDocs.clear();
  if (!imgs.length && !docs.length) return;

  // 文档探针：只为"还不知道目录"的文档取一张相对图片
  const docProbes = docs.map(([el, doc]) => ({ el, doc, probe: firstRelativeImageSrc(doc) }));

  // 先吃缓存，减少一次 invoke 的路径数
  const need: string[] = [];
  const map: Record<string, string | null> = {};
  for (const [, rel] of imgs) {
    if (relPathCache.has(rel)) map[rel] = relPathCache.get(rel) ?? null;
    else if (!need.includes(rel)) need.push(rel);
  }
  for (const d of docProbes) {
    if (!d.probe) continue;
    if (relPathCache.has(d.probe)) map[d.probe] = relPathCache.get(d.probe) ?? null;
    else if (!need.includes(d.probe)) need.push(d.probe);
  }

  if (need.length) {
    try {
      const roots = imageRoots();
      const res = await invoke<Record<string, string | null>>('resolve_local_images', {
        paths: need,
        roots: roots.length ? roots : null,
      });
      for (const rel of need) {
        const abs = res?.[rel] ?? null;
        map[rel] = abs;
        rememberRel(rel, abs);
      }
    } catch (e) {
      // 检索失败不能影响渲染：图片保持占位，其余内容照常
      console.error('[image] 相对图片兜底检索失败:', e);
    }
  }

  // 回填 <img>
  for (const [el, rel] of imgs) {
    const abs = map[rel] ?? null;
    if (abs) {
      try {
        el.setAttribute('src', convertFileSrc(abs.replace(/\\/g, '/')));
        el.setAttribute('title', abs);
        el.classList.remove('md-img-pending');
        el.removeAttribute('data-andy-rel');
      } catch (e) {
        console.warn('[image] 转换本地图片地址失败:', abs, e);
      }
    } else {
      el.classList.add('md-img-missing');
      el.setAttribute('title', `找不到这张图：${rel}`);
      el.removeAttribute('data-andy-rel'); // 别再反复尝试
      console.warn('[image] 未找到相对图片（可在设置里指定图片根目录）:', rel);
    }
  }

  // 回填 HTML 文档占位：反推目录 → 带 <base> 渲染 iframe
  for (const { el, doc, probe } of docProbes) {
    const abs = probe ? map[probe] ?? null : null;
    const baseDir = abs && probe ? deriveBaseDir(abs, probe) : null;
    const dirUrl = baseDir ? dirToAssetUrl(baseDir) : undefined;
    if (!dirUrl && probe) {
      console.warn('[image] 文档内相对图片未找到，iframe 将不带 base（图片可能加载不出来）:', probe);
    }
    el.innerHTML = buildDocIframeHtml(doc, dirUrl);
    el.classList.remove('md-html-pending');
    el.removeAttribute('data-andy-doc');
  }
}

function installPendingAssetResolver(): void {
  if (resolverInstalled || typeof document === 'undefined') return;
  resolverInstalled = true;

  const pick = (el: Element) => {
    if (el.tagName === 'IMG' && el.hasAttribute('data-andy-rel')) {
      const img = el as HTMLImageElement;
      if (!pendingImgs.has(img)) pendingImgs.set(img, img.getAttribute('data-andy-rel') || '');
    } else if (el.hasAttribute('data-andy-doc')) {
      const div = el as HTMLElement;
      if (!pendingDocs.has(div)) pendingDocs.set(div, div.getAttribute('data-andy-doc') || '');
    }
  };

  // 限定命中面：只找带标记的元素，不对整棵子树做 `img` 全量查询
  const scanFragment = (node: Node) => {
    if (node.nodeType !== 1) return;
    const el = node as Element;
    pick(el);
    el.querySelectorAll?.('img[data-andy-rel], [data-andy-doc]').forEach(pick);
  };

  const observer = new MutationObserver((mutations) => {
    let touched = false;
    for (const m of mutations) {
      if (m.type === 'childList') {
        m.addedNodes.forEach((n) => {
          const before = pendingImgs.size + pendingDocs.size;
          scanFragment(n);
          if (pendingImgs.size + pendingDocs.size > before) touched = true;
        });
      }
    }
    if (touched) scheduleResolve();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // 首屏已有内容（安装晚于首次渲染时）补一遍
  document.querySelectorAll('img[data-andy-rel], [data-andy-doc]').forEach(pick);
  if (pendingImgs.size || pendingDocs.size) scheduleResolve();
}
