/// <reference lib="dom" />
// 茑萝 · HTML 预览宿主（2026-10-20）
//
// ## 解决什么
// markdown 里的 ```html / ```svg 代码块有一个「预览」按钮。点了之后把这段 HTML
// 放进**沙箱 iframe** 里真跑起来（脚本、表单、动画、canvas 都能用），而不是只显示源码。
//
// ## 为什么用 srcdoc + sandbox 而不是 dangerouslySetInnerHTML
// 模型输出可能包含任意脚本，直接塞进主窗口 DOM 等于把整个应用交出去（主窗有 Tauri IPC）。
// `sandbox="allow-scripts allow-forms allow-modals allow-popups"` **不带 allow-same-origin**
// ⇒ iframe 拿到不透明源：拿不到父窗口 DOM、读不到 localStorage、调不到 Tauri IPC，
// 但仍然可以跑脚本、发请求、画 canvas —— 这正是「完整交互」和「隔离」的交点。
//
// ## 为什么自我挂载
// markdown 出现在主窗 / 浮岛窗 / 笔记浮窗三个独立 webview 里，逐个入口去挂组件容易漏。
// 这里做成单例：`ensureHtmlPreviewHost()` 只建一次，谁先渲染 markdown 谁把它带起来。
import React from 'react';
import ReactDOM from 'react-dom/client';

interface Payload { code: string; lang: string }

let mounted = false;

/** 幂等：每个 webview 内只会创建一次宿主。 */
export function ensureHtmlPreviewHost(): void {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  try {
    const el = document.createElement('div');
    el.id = 'andy-html-preview-host';
    document.body.appendChild(el);
    ReactDOM.createRoot(el).render(React.createElement(HtmlPreviewHost));
  } catch (e) {
    // 建不起来只影响「预览」按钮，不能让 markdown 渲染整体失败
    mounted = false;
    console.error('[html-preview] 预览宿主挂载失败:', e);
  }
}

/** 给 iframe 注入的最小运行环境：基础排版 + 链接拦截（沙箱里点链接默认是死的）。 */
function buildDoc(code: string): string {
  const base = `
<style>
  html,body{margin:0;padding:14px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1f2328;background:#fff;}
  body{overflow:auto}
  a{color:#0969da}
  img,video,canvas,svg{max-width:100%;height:auto}
</style>
<script>
  // 沙箱内不允许导航父窗口；把外链点击转给父级（父级用系统浏览器打开）。
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    e.preventDefault();
    try { parent.postMessage({ __andy: 'open', href: a.href }, '*'); } catch (err) {}
  }, true);
</script>`;
  // 已经是完整文档就原样塞进去（保留用户写的 doctype/head），否则包一层
  return /<html[\s>]/i.test(code) ? code : base + code;
}

function HtmlPreviewHost() {
  const [payload, setPayload] = React.useState<Payload | null>(null);

  React.useEffect(() => {
    const onPreview = (e: Event) => {
      const d = (e as CustomEvent<Payload>).detail;
      if (!d?.code) return;
      setPayload({ code: d.code, lang: d.lang || 'html' });
    };
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { __andy?: string; href?: string } | null;
      if (!d || d.__andy !== 'open' || !d.href) return;
      const href = d.href;
      if (!/^https?:/i.test(href)) {
        console.warn('[html-preview] 沙箱内非 http(s) 链接不打开:', href);
        return;
      }
      void import('@tauri-apps/plugin-opener')
        .then((m) => m.openUrl(href))
        .catch((err: unknown) => {
          console.warn('[html-preview] 系统浏览器打开失败:', href, err);
          window.open(href, '_blank', 'noopener');
        });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPayload(null);
    };
    window.addEventListener('andy:preview-html', onPreview as EventListener);
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('andy:preview-html', onPreview as EventListener);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch((e: unknown) => {
      console.warn('[html-preview] 复制源码失败:', e);
    });
  };

  if (!payload) return null;

  return React.createElement(
    'div',
    {
      style: {
        position: 'fixed', inset: 0, zIndex: 99990,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
      },
      onClick: () => setPayload(null),
    },
    React.createElement(
      'div',
      {
        style: {
          width: 'min(1080px, 92vw)', height: 'min(760px, 86vh)',
          display: 'flex', flexDirection: 'column',
          background: '#1c1c1e', color: '#f2f2f4',
          borderRadius: 12, overflow: 'hidden',
          border: '1px solid rgba(255,255,255,0.14)',
          boxShadow: '0 18px 60px rgba(0,0,0,0.55)',
        },
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
      },
      React.createElement(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.1)',
            fontSize: 12,
          },
        },
        React.createElement('span', { style: { fontWeight: 600 } }, 'HTML 预览'),
        React.createElement('span', { style: { opacity: 0.55, fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' } }, payload.lang),
        React.createElement('span', { style: { opacity: 0.45, fontSize: 11 } }, '沙箱 iframe · 与主程序隔离'),
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement('button', {
          onClick: () => copy(payload.code),
          style: btnStyle,
          title: '复制这段 HTML 源码',
        }, '复制源码'),
        React.createElement('button', {
          onClick: () => setPayload(null),
          style: btnStyle,
          title: '关闭（Esc）',
        }, '关闭'),
      ),
      // 用 key 强制重挂：连续点两次预览时，旧文档的计时器/动画不会残留
      React.createElement('iframe', {
        key: payload.code.slice(0, 64) + payload.code.length,
        title: 'html-preview',
        // 注意：绝不能加 allow-same-origin —— 一旦同源，iframe 就能拿到父窗口与 Tauri IPC
        sandbox: 'allow-scripts allow-forms allow-modals allow-popups allow-downloads',
        srcDoc: buildDoc(payload.code),
        style: { flex: 1, border: 'none', background: '#fff', width: '100%' },
      }),
    ),
  );
}

const btnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.1)',
  color: '#f2f2f4',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 7,
  padding: '3px 10px',
  fontSize: 11.5,
  cursor: 'pointer',
};
