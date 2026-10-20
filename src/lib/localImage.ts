import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { buildDocIframeHtml, escapeHtml, listDocResources } from './markdown';

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

/** 文档容器 → 原始文档文本。用于"用户指定目录后按新基准重渲染"，避免把 100KB 文本塞回属性里。 */
const docSources = new Map<HTMLElement, string>();

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

/** 由「绝对路径 + 相对路径」反推这份内容所在的目录。 */
function deriveBaseDir(abs: string, rel: string): string | null {
  const a = abs.replace(/\\/g, '/');
  const r = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (a.endsWith('/' + r)) return a.slice(0, a.length - r.length - 1);
  const idx = a.lastIndexOf('/');
  return idx > 0 ? a.slice(0, idx) : null;
}

/**
 * 从已解析出的结果里**学会**这批内容的来源目录，写进 imageRoots。
 *
 * 目的：下一次粘贴同一份文档（或同目录的另一份）时，"根目录直接拼"就能命中 ——
 * 不再需要索引反查，更不需要用户再点一次目录。只在 rel 带目录层级时学
 * （`images/a.png` 的 base 有意义；裸文件名 `a.png` 的 base 全是噪声）。
 */
function learnBases(resolved: Record<string, string>): void {
  for (const [rel, abs] of Object.entries(resolved)) {
    if (!rel.includes('/')) continue;
    const base = deriveBaseDir(abs, rel);
    if (base) addImageRoot(base);
  }
}

/** 文档里有资源没解析出来时的提示条（可点击选目录）。 */
function docMissingHint(missing: string[]): string {
  const first = missing[0] ?? '';
  const label = first.length > 46 ? '…' + first.slice(-44) : first;
  const more = missing.length > 1 ? ` 等 ${missing.length} 个` : '';
  return (
    '<div class="md-doc-hint">这份文档有资源没找到：'
    + `<span class="md-doc-miss">${escapeHtml(label)}</span>${more} —— `
    + '<button type="button" class="md-doc-pick">选择图片目录</button></div>'
  );
}

/** 找不到图片时显示的占位（内联 SVG，不依赖网络；点击可指定目录）。 */
function missingPlaceholder(rel: string): string {
  const label = rel.length > 52 ? '…' + rel.slice(-50) : rel;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="440" height="58">'
    + '<rect x="1" y="1" width="438" height="56" rx="6" fill="#f6f7f9" stroke="#c9ced6" stroke-dasharray="6 4"/>'
    + `<text x="12" y="24" font-family="system-ui,sans-serif" font-size="12" fill="#5b6472">找不到图片：${label}</text>`
    + '<text x="12" y="43" font-family="system-ui,sans-serif" font-size="11" fill="#8b94a3">点击此处选择图片所在目录</text>'
    + '</svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** 把用户手选的目录追加进 imageRoots（去重、最多 8 个）。 */
function addImageRoot(dir: string): void {
  try {
    const raw = localStorage.getItem('andeyunhui.imageRoots') || '';
    const list = raw.split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
    const norm = dir.replace(/\//g, '\\').toLowerCase();
    if (list.some((x) => x.replace(/\//g, '\\').toLowerCase() === norm)) return;
    list.push(dir);
    localStorage.setItem('andeyunhui.imageRoots', list.slice(-8).join(';'));
    console.info('[image] 已加入图片检索目录:', dir);
  } catch (e) {
    console.warn('[image] 保存图片检索目录失败:', e);
  }
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

  // 文档：把**每个**相对资源都拿去解析（旧实现只取第一张反推目录，
  // 文档里图片分处多个子目录时其余全部 404）
  const docProbes = docs.map(([el, doc]) => ({ el, doc, rels: listDocResources(doc) }));

  // 先吃缓存，减少一次 invoke 的路径数
  const need: string[] = [];
  const map: Record<string, string | null> = {};
  for (const [, rel] of imgs) {
    if (relPathCache.has(rel)) map[rel] = relPathCache.get(rel) ?? null;
    else if (!need.includes(rel)) need.push(rel);
  }
  for (const d of docProbes) {
    for (const rel of d.rels) {
      if (relPathCache.has(rel)) map[rel] = relPathCache.get(rel) ?? null;
      else if (!need.includes(rel)) need.push(rel);
    }
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

  // 回填 <img>（顺带把"这批内容所在目录"记住，下次同目录内容直接命中）
  for (const [el, rel] of imgs) {
    const abs = map[rel] ?? null;
    if (abs) {
      try {
        el.setAttribute('src', convertFileSrc(abs.replace(/\\/g, '/')));
        el.setAttribute('title', abs);
        el.classList.remove('md-img-pending');
        el.removeAttribute('data-andy-rel');
        if (rel.includes('/')) {
          const base = deriveBaseDir(abs, rel);
          if (base) addImageRoot(base);
        }
      } catch (e) {
        console.warn('[image] 转换本地图片地址失败:', abs, e);
      }
    } else {
      // 保留 data-andy-rel：用户点选目录后要能重新解析这一批
      el.classList.add('md-img-missing');
      el.setAttribute('src', missingPlaceholder(rel));
      el.setAttribute('title', `找不到这张图：${rel}（点击选择它所在的目录）`);
      console.warn('[image] 未找到相对图片，已显示占位（可点击占位指定目录）:', rel);
    }
  }

  // 回填 HTML 文档占位：逐路径重写文档内相对资源 → 渲染 iframe
  for (const { el, doc, rels } of docProbes) {
    docSources.set(el, doc);
    const resolved: Record<string, string> = {};
    const missing: string[] = [];
    for (const rel of rels) {
      const abs = map[rel] ?? null;
      if (abs) resolved[rel] = abs;
      else missing.push(rel);
    }
    learnBases(resolved);
    if (missing.length) {
      console.warn(
        `[image] 文档内 ${missing.length}/${rels.length} 个资源未找到（可点提示条选目录）:`,
        missing.slice(0, 5),
      );
    }
    const hint = missing.length ? docMissingHint(missing) : '';
    el.innerHTML = hint + buildDocIframeHtml(doc, undefined, resolved);
    el.classList.remove('md-html-pending');
    el.removeAttribute('data-andy-doc');
  }
}

/** 按当前 imageRoots 重新给已渲染的文档解析资源并重渲染。 */
async function rerenderDocs(): Promise<void> {
  const entries = [...docSources.entries()];
  if (!entries.length) return;
  const jobs = entries.map(([el, doc]) => ({ el, doc, rels: listDocResources(doc) }));
  const need = [...new Set(jobs.flatMap((j) => j.rels))];
  if (!need.length) return;
  let map: Record<string, string | null> = {};
  try {
    const roots = imageRoots();
    map = await invoke<Record<string, string | null>>('resolve_local_images', {
      paths: need,
      roots: roots.length ? roots : null,
    });
  } catch (e) {
    console.error('[image] 文档重渲染检索失败:', e);
    return;
  }
  let recovered = 0;
  for (const { el, doc, rels } of jobs) {
    const resolved: Record<string, string> = {};
    const missing: string[] = [];
    for (const rel of rels) {
      const abs = map[rel] ?? null;
      if (abs) {
        resolved[rel] = abs;
        rememberRel(rel, abs);
      } else {
        missing.push(rel);
      }
    }
    recovered += Object.keys(resolved).length;
    if (!Object.keys(resolved).length) {
      console.warn('[image] 仍未定位到文档资源，保持原样:', missing.slice(0, 5));
      continue;
    }
    learnBases(resolved);
    const hint = missing.length ? docMissingHint(missing) : '';
    el.innerHTML = hint + buildDocIframeHtml(doc, undefined, resolved);
    el.classList.remove('md-html-pending');
  }
  // 所有文档都没进展时也要告诉用户"点目录没用"，而不是静默
  if (!recovered) console.warn('[image] 新目录里没有这批文档引用的资源，请确认目录选对了');
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

  // 点占位图 → 选一个目录 → 把它加入检索根 → 重新解析所有还缺图的占位。
  // 为什么不弹"设置面板"：问题现场就在这张图上，让用户就地指路最快。
  document.addEventListener(
    'click',
    (ev) => {
      const t = ev.target as Element | null;

      // 文档提示条上的「选择图片目录」：选完按新基准把这份文档重渲染一次
      const pickBtn = t?.closest?.('.md-doc-pick') as HTMLElement | null;
      if (pickBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        void (async () => {
          try {
            const dir = await invoke<string | null>('pick_directory');
            if (!dir) return;
            addImageRoot(dir);
            relPathCache.clear();
            await rerenderDocs();
          } catch (e) {
            console.error('[image] 文档目录选择失败:', e);
          }
        })();
        return;
      }

      const img = t?.closest?.('img.md-img-missing') as HTMLImageElement | null;
      if (!img) return;
      ev.preventDefault();
      ev.stopPropagation();
      void (async () => {
        try {
          const dir = await invoke<string | null>('pick_directory');
          if (!dir) return;
          addImageRoot(dir);
          // 根变了 ⇒ 之前"没找到"的结论作废
          relPathCache.clear();
          // 把所有缺图占位重置回待解析（保留 data-andy-rel，src 换成透明像素避免再次显示破图）
          document.querySelectorAll<HTMLImageElement>('img.md-img-missing[data-andy-rel]').forEach((el) => {
            el.classList.remove('md-img-missing');
            el.setAttribute('src', TRANSPARENT_PX);
            pendingImgs.set(el, el.getAttribute('data-andy-rel') || '');
          });
          scheduleResolve();
        } catch (e) {
          console.error('[image] 选择图片目录失败:', e);
        }
      })();
    },
    true,
  );

  // 首屏已有内容（安装晚于首次渲染时）补一遍
  document.querySelectorAll('img[data-andy-rel], [data-andy-doc]').forEach(pick);
  if (pendingImgs.size || pendingDocs.size) scheduleResolve();
}
