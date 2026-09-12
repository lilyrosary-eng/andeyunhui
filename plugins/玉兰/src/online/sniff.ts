// 网络视频 · 嗅探器（DOM 抽取 + 请求级 hook，对应「通用嗅探 + 请求级嗅探」方案）
//
// 在 webview 内注入脚本：
//  1) hook fetch / XMLHttpRequest / HTMLMediaElement.src，捕获页面动态加载的媒体 URL（请求级嗅探）；
//  2) 立即扫描当前 DOM 的 <video>/<audio>/<source>/<img>/背景图/带媒体后缀的 <a>；
//  3) 等待 1.5s 让 hook 捕获后续请求，合并去重返回。
//
// 返回的资源交给 SnifferPanel 展示，用户多选后按类型落库（直链→download_video，m3u8→download_hls）。

export interface SniffResource {
  url: string;
  type: 'video' | 'audio' | 'image' | 'other';
  /** 来源标签，便于排查：video/audio/img/source/fetch/xhr/background/a */
  tag: string;
  ext: string;
}

// 注入 webview 的请求级 hook：把媒体相关请求收集到 window.__sniffLog（字符串数组，元素是 JSON）。
const SNIFF_HOOK = `
(function(){
  if (window.__sniffHooked) return;
  window.__sniffHooked = true;
  window.__sniffLog = [];
  function push(u, tag){ if(!u) return; try{ var url = new URL(u, location.href).href; var s = JSON.stringify({url:url, tag:tag}); if(window.__sniffLog.indexOf(s) < 0) window.__sniffLog.push(s); }catch(e){} }
  var _fetch = window.fetch;
  window.fetch = function(input, init){ try{ if(typeof input === 'string') push(input,'fetch'); else if(input && input.url) push(input.url,'fetch'); }catch(e){} return _fetch.apply(this, arguments); };
  var _xhr = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function(m, u){ push(u,'xhr'); return _xhr.apply(this, arguments); };
  try {
    var _src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (_src && _src.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        set: function(v){ push(v,'media'); return _src.set.call(this, v); },
        get: function(){ return _src.get.call(this); }
      });
    }
  } catch(e){}
})();
`;

function classify(url: string): SniffResource['type'] {
  const u = url.split('?')[0].toLowerCase();
  if (/\.(m3u8)(\?|$)/.test(u)) return 'video';
  if (/\.(mp4|webm|mkv|mov|flv|ts|m4v|avi|m3u8)(\?|$)/.test(u)) return 'video';
  if (/\.(mp3|wav|ogg|aac|m4a|flac)(\?|$)/.test(u)) return 'audio';
  if (/\.(jpg|jpeg|png|webp|gif|bmp|svg|avif)(\?|$)/.test(u)) return 'image';
  return 'other';
}

function parseList(s: string): Array<{ url: string; tag: string }> {
  try {
    const arr = JSON.parse(s || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * 在 webview 内嗅探媒体资源。
 * @param evalJs webview 执行 JS 的函数（来自 VideoWebview 的 onReady 句柄）
 */
export async function sniffResources(evalJs: (code: string) => Promise<string>): Promise<SniffResource[]> {
  // 1) 注入请求级 hook
  await evalJs(`(() => { ${SNIFF_HOOK} return true; })()`).catch(() => {});

  // 2) 扫描当前 DOM
  const domJson = await evalJs(`(() => {
    var out = [];
    var push = function(u, tag){ if(!u) return; try{ out.push(JSON.stringify({url: new URL(u, location.href).href, tag: tag})); }catch(e){} };
    document.querySelectorAll('video').forEach(function(v){ push(v.src || v.currentSrc, 'video'); (v.querySelectorAll('source') || []).forEach(function(s){ push(s.src, 'source'); }); });
    document.querySelectorAll('audio').forEach(function(a){ push(a.src || a.currentSrc, 'audio'); (a.querySelectorAll('source') || []).forEach(function(s){ push(s.src, 'source'); }); });
    document.querySelectorAll('img').forEach(function(i){ push(i.src || i.dataset.src, 'img'); });
    document.querySelectorAll('source').forEach(function(s){ push(s.src, 'source'); });
    document.querySelectorAll('a[download], a[href$=".mp4"], a[href$=".m3u8"], a[href$=".mp3"]').forEach(function(a){ push(a.href, 'a'); });
    document.querySelectorAll('*').forEach(function(el){
      try { var bg = getComputedStyle(el).backgroundImage || ''; var m = bg.match(/url\\\\("?([^")]+)"?\\\\)/); if(m) push(m[1], 'background'); }catch(e){}
    });
    return '[' + out.join(',') + ']';
  })()`).catch(() => '[]');

  // 3) 等待 hook 捕获动态请求
  await new Promise((r) => setTimeout(r, 1500));

  // 4) 读取 hook 捕获（并清空，便于下次增量）
  const hookJson = await evalJs(`(() => { var l = window.__sniffLog || []; window.__sniffLog = []; return '[' + l.join(',') + ']'; })()`).catch(() => '[]');

  const dom = parseList(domJson);
  const hook = parseList(hookJson);
  const seen = new Set<string>();
  const res: SniffResource[] = [];
  for (const r of [...dom, ...hook]) {
    if (!r.url || r.url.startsWith('blob:') || r.url.startsWith('data:')) continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    const type = classify(r.url);
    const ext = (r.url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1].toLowerCase();
    res.push({ url: r.url, type, tag: r.tag, ext });
  }
  return res;
}
