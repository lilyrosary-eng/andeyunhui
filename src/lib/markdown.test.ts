import { describe, it, expect } from 'vitest';
import { renderMarkdown, buildDocIframeHtml, listDocResources } from './markdown';

// markdown 渲染契约（2026-10-20 高亮/交互改造后新增）
// 这些断言钉的是「渲染产物里必须有什么」，不是像素级样式 —— 目的是防止
// 以后有人改 marked 配置时把高亮、代码块按钮、标题锚点或链接安全属性改没了。
//
// 为什么要用 NL 拼换行：本文件的断言里要出现「源码中的换行」，
// 直接写模板字符串会把换行变成真实字符（可读但容易在工具编辑时被吃掉），
// 用 charCode 更稳。
const NL = String.fromCharCode(10);

describe('renderMarkdown', () => {
  it('代码块：语言标签 + 复制 + HTML 预览三个要素齐全', () => {
    const html = renderMarkdown('```html' + NL + '<button>hi</button>' + NL + '```');
    expect(html).toContain('md-code-block');
    expect(html).toContain('md-code-head');
    expect(html).toContain('md-lang');
    expect(html).toContain('md-copy-btn');
    // HTML 才给「预览」按钮
    expect(html).toContain('md-run-btn');
  });

  it('非 HTML 代码块不给预览按钮（避免把 CSS/JS 单独当文档跑）', () => {
    const html = renderMarkdown('```css' + NL + 'body{color:red}' + NL + '```');
    expect(html).toContain('md-copy-btn');
    expect(html).not.toContain('md-run-btn');
  });

  it('已知语言走 highlight.js，产出 hljs-* 着色 span', () => {
    const html = renderMarkdown('```ts' + NL + 'const a: number = 1;' + NL + '```');
    expect(html).toContain('class="hljs"');
    expect(html).toMatch(/hljs-keyword/);
  });

  it('别名认得出（ts→typescript），未知语言不高亮但也不报错', () => {
    expect(renderMarkdown('```ts' + NL + 'let x = 1' + NL + '```')).toMatch(/hljs-keyword|hljs-literal/);
    const unknown = renderMarkdown('```brainfuck' + NL + '+++' + NL + '```');
    expect(unknown).toContain('md-code-block');
    // 未知语言不猜语法，原文照样可见
    expect(unknown).toContain('+++');
  });

  it('链接带 target/rel，且 javascript: 协议被中和', () => {
    const html = renderMarkdown('[官网](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    const bad = renderMarkdown('[x](javascript:alert(1))');
    expect(bad).not.toContain('href="javascript:');
  });

  it('原始 HTML 不渲染，只作为文本（防注入）', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('代码块里的 HTML 标签被转义，不会逃出 <code>', () => {
    const html = renderMarkdown('```html' + NL + '<script>alert(1)</script>' + NL + '```');
    // 源码文本里不能出现可执行的 script 标签
    expect(html).not.toMatch(/<script>/);
  });

  // ===== 2026-10-20：标题锚点 + 原始 HTML 的放行边界 =====
  it('标题生成 id，且目录锚点能对上（否则点目录会去导航整个窗口）', () => {
    const html = renderMarkdown('## 安装' + NL + NL + '[跳转](#安装)');
    expect(html).toContain('id="安装"');
    expect(html).toContain('href="#安装"');
  });

  it('同名标题去重：第二个起追加 -2，锚点不会都跳到第一个', () => {
    const html = renderMarkdown('## 说明' + NL + NL + '## 说明');
    expect(html).toContain('id="说明"');
    expect(html).toContain('id="说明-2"');
  });

  it('默认（AI 对话）原始 HTML 仍然只当文本', () => {
    const html = renderMarkdown('<div class="x">hi</div>');
    expect(html).not.toContain('<div');
    expect(html).toContain('&lt;div');
  });

  it('allowHtml：渲染结构但剔除可执行部分（脚本/事件属性/危险协议/嵌入对象）', () => {
    const src = [
      '<div class="box">可见</div>',
      '<script>alert(1)</script>',
      '<img src="x" onerror="alert(2)">',
      '<a href="javascript:alert(3)">x</a>',
      '<iframe src="https://evil"></iframe>',
    ].join(NL + NL);
    const html = renderMarkdown(src, { allowHtml: true });
    expect(html).toContain('<div class="box">可见</div>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<iframe/i);
  });

  it('两种模式的缓存互不污染（同源码、不同选项）', () => {
    const src = '<b>粗</b>';
    const escaped = renderMarkdown(src);
    const rendered = renderMarkdown(src, { allowHtml: true });
    expect(escaped).not.toContain('<b>');
    expect(rendered).toContain('<b>');
  });

  // ===== 2026-10-20：图片路径（webview 里 C:\... 与 ./x.png 天然加载不出来） =====
  it('图片：外链 / localimg 原样保留，且带上 md-img 与懒加载属性', () => {
    const remote = renderMarkdown('![](https://x.com/a.png)');
    expect(remote).toContain('src="https://x.com/a.png"');
    expect(remote).toContain('class="md-img"');
    expect(remote).toContain('loading="lazy"');

    // 笔记里的本地图片是 localimg:// 占位，交给 localImage 模块解析，这里不能改写
    const local = renderMarkdown('![](localimg://abc%2Fdef)');
    expect(local).toContain('src="localimg://abc%2Fdef"');
  });

  it('图片：绝对路径走 asset 协议（用 stub 模拟 Tauri 的 convertFileSrc）', () => {
    const g = globalThis as unknown as { window?: unknown };
    const prev = g.window;
    g.window = {
      __TAURI_INTERNALS__: {
        convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
      },
    };
    try {
      // 注意：markdown 的转义规则会把路径里的反斜杠吃掉（C:\shots.png → C:shotsa.png），
      // 所以图片路径必须用正斜杠。这条测试钉的就是"正斜杠形式能正确转成 asset URL"。
      const html = renderMarkdown('![](C:/shots/a.png)');
      expect(html).toContain('asset.localhost');
      expect(html).toContain(encodeURIComponent('C:/shots/a.png'));

    } finally {
      g.window = prev;
    }
  });

  it('图片：相对路径按 imageBaseDir 拼接（不同项目缓存不能串）', () => {
    const g = globalThis as unknown as { window?: unknown };
    const prev = g.window;
    g.window = {
      __TAURI_INTERNALS__: {
        convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
      },
    };
    try {
      const html = renderMarkdown('![](docs/a.png)', { imageBaseDir: 'D:/proj' });
      expect(html).toContain(encodeURIComponent('D:/proj/docs/a.png'));
      // 另一个项目同一个相对路径必须解析出不同结果（缓存键含 base）
      const other = renderMarkdown('![](docs/a.png)', { imageBaseDir: 'D:/other' });
      expect(other).toContain(encodeURIComponent('D:/other/docs/a.png'));
    } finally {
      g.window = prev;
    }
  });

  // ===== 2026-10-20：长文本信封 + 整篇 HTML 文档 =====
  it('剥掉 @long-text / <long_text_quote> 信封，只渲染正文', () => {
    const src = '@long-text:"# 标题预览…" <long_text_quote>## 真标题' + NL + NL + '正文内容</long_text_quote>';
    const html = renderMarkdown(src);
    expect(html).not.toContain('long_text_quote');
    expect(html).not.toContain('@long-text');
    // 正文里的 markdown 要正常解析
    expect(html).toMatch(/<h2[^>]*>真标题<\/h2>/);
    expect(html).toContain('正文内容');
  });

  it('整篇 HTML 文档（无相对资源）：直接出 iframe，不必等占位', () => {
    const doc = '<!DOCTYPE html>' + NL + '<html><head><style>body{color:red}</style></head>'
      + '<body><h1>报告</h1><script>var a=1;</script></body></html>';
    const html = renderMarkdown(doc);
    expect(html).toContain('<iframe');
    expect(html).toContain('&lt;style&gt;');
    expect(html).not.toContain('md-html-pending');
    // 不能把整篇文档当普通文本输出
    expect(html).not.toContain('<p>&lt;!DOCTYPE');
  });

  it('整篇 HTML 文档 + 相对图片、无基准目录：先出占位（异步检索后再生成 iframe）', () => {
    const doc = '<!DOCTYPE html>' + NL + '<html><head><style>body{color:red}</style></head>'
      + '<body><img src="images/a.png"></body></html>';
    const html = renderMarkdown(doc);
    expect(html).toContain('data-andy-doc=');
    expect(html).toContain('md-html-pending');
    expect(html).not.toContain('<iframe');
  });

  it('文档前面还有文字时仍然识别为文档（旧实现会把 style 剔掉、img 变破图）', () => {
    const doc = '<!DOCTYPE html>' + NL + '<html><head><style>body{background:#f2f6fa}</style></head>'
      + '<body><h1>报告</h1></body></html>';
    const html = renderMarkdown('## 我的笔记' + NL + NL + doc);
    // 前导文字照常渲染成 markdown
    expect(html).toMatch(/<h2[^>]*>我的笔记<\/h2>/);
    // 文档走 iframe，样式完整保留（这是用户实测的回归点）
    expect(html).toContain('<iframe');
    expect(html).toContain('&lt;style&gt;');
    expect(html).toContain('background:#f2f6fa');
  });

  it('代码围栏里的 <!DOCTYPE 不算文档（笔记里教人写 HTML 时不渲染成 iframe）', () => {
    const src = '示例：' + NL + NL + '```html' + NL + '<!DOCTYPE html>' + NL
      + '<html><body><h1>x</h1></body></html>' + NL + '```';
    const html = renderMarkdown(src);
    expect(html).not.toContain('<iframe');
    expect(html).toContain('md-code-block');
  });

  it('listDocResources：只列相对资源，去重且包含 srcset / link', () => {
    const doc = '<img src="images/a.png"><img src="https://cdn/x.png">'
      + '<img srcset="i/b.png 1x, i/b@2x.png 2x"><link href="css/a.css">'
      + '<a href="#ch1">x</a><script src="js/app.js"></script>';
    const rels = listDocResources(doc);
    expect(rels).toEqual(['images/a.png', 'js/app.js', 'i/b.png', 'i/b@2x.png', 'css/a.css']);
    expect(rels).not.toContain('https://cdn/x.png');
    expect(rels).not.toContain('#ch1');
  });

  it('逐路径结果表：不同目录的图片各自改写（不再依赖单一基准）', () => {
    const g = globalThis as unknown as { window?: unknown };
    const prev = g.window;
    g.window = {
      __TAURI_INTERNALS__: {
        convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
      },
    };
    try {
      const doc = '<!DOCTYPE html><html><body>'
        + '<img src="images/a.png"><img src="figs/b.png"></body></html>';
      const html = buildDocIframeHtml(doc, undefined, {
        'images/a.png': 'D:/项目A/images/a.png',
        'figs/b.png': 'D:/项目B/figs/b.png',
      });
      expect(html).toContain(encodeURIComponent('D:/项目A/images/a.png'));
      expect(html).toContain(encodeURIComponent('D:/项目B/figs/b.png'));
    } finally {
      g.window = prev;
    }
  });

  it('整篇 HTML 文档 + 基准目录：沙箱 iframe，保留 style/script', () => {
    const g = globalThis as unknown as { window?: unknown };
    const prev = g.window;
    g.window = {
      __TAURI_INTERNALS__: {
        convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
      },
    };
    try {
      const doc = '<!DOCTYPE html>' + NL + '<html><head><style>body{color:red}</style></head>'
        + '<body><h1>报告</h1><script>var a=1;</script></body></html>';
      const html = renderMarkdown(doc, { imageBaseDir: 'D:/proj' });
      expect(html).toContain('<iframe');
      expect(html).toContain('md-html-frame');
      // 沙箱必须有 allow-scripts（否则交互演示跑不了），且绝不能有 allow-same-origin
      expect(html).toContain('allow-scripts');
      expect(html).not.toContain('allow-same-origin');
      expect(html).toContain('srcdoc=');
      expect(html).toContain('&lt;style&gt;');
      // 相对资源被改写成 asset 绝对 URL；不再注入 <base>
      // （<base> 会把 #锚点 变成 http 链接，进而被外链桥送去 Edge）
      expect(html).not.toContain('&lt;base');
    } finally {
      g.window = prev;
    }
  });

  it('相对路径图片：无基准时出透明占位 + data-andy-rel（交给兜底检索回填）', () => {
    const html = renderMarkdown('![](images/a.png)');
    expect(html).toContain('data-andy-rel="images/a.png"');
    expect(html).toContain('md-img-pending');
    // 不能把相对路径直接写进 src（会立刻发一个必然 404 的请求）
    expect(html).not.toContain('src="images/a.png"');
  });

  it('markdown 里夹一段 HTML 不算"整篇文档"，仍走正常渲染', () => {
    const html = renderMarkdown('# 标题' + NL + NL + '<div>x</div>');
    expect(html).not.toContain('<iframe');
    expect(html).toMatch(/<h1[^>]*>标题<\/h1>/);
  });


  it('整篇文档：相对图片改写成 asset URL，锚点保持纯 fragment', () => {
    const g = globalThis as unknown as { window?: unknown };
    const prev = g.window;
    g.window = {
      __TAURI_INTERNALS__: {
        convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
      },
    };
    try {
      const doc = '<!DOCTYPE html><html><body>'
        + '<a href="#ch1">目录</a><a href="https://x.com">外链</a>'
        + '<img src="images/a.png"><img src="https://cdn/x.png">'
        + '<link href="style/a.css">'
        + '</body></html>';
      const html = renderMarkdown(doc, { imageBaseDir: 'D:/proj' });
      // 相对图片 → asset 绝对 URL（srcdoc 里是转义后的实体）
      expect(html).toContain('images/a.png');
      // 相对样式表同样改写
      expect(html).toContain('style/a.css');
      // 绝对外链不动
      expect(html).toContain('https://cdn/x.png');
      // 锚点保持 #ch1（没有被 base 变成 http://asset.localhost/...#ch1）
      expect(html).toContain('href=&quot;#ch1&quot;');
    } finally {
      g.window = prev;
    }
  });

  it('一页里有两份文档 + 中间说明：各自渲染 iframe，文字照常', () => {
    const d1 = '<!DOCTYPE html><html><head><style>body{color:red}</style></head><body><h1>A</h1></body></html>';
    const d2 = '<!DOCTYPE html><html><head><style>body{color:blue}</style></head><body><h1>B</h1></body></html>';
    const html = renderMarkdown('前置说明' + NL + NL + d1 + NL + NL + '中间说明' + NL + NL + d2);
    expect(html.match(/<iframe/g)?.length).toBe(2);
    expect(html).toContain('前置说明');
    expect(html).toContain('中间说明');
    expect(html).toContain('color:red');
    expect(html).toContain('color:blue');
  });

  it('以 <!DOCTYPE 开头但不带 <html>/<body> 的文档也算文档', () => {
    const doc = '<!DOCTYPE html>' + NL + '<style>body{margin:0}</style>'
      + '<div class="wrap">内容</div>' + NL + '<script>console.log(1)</script>';
    const html = renderMarkdown(doc);
    expect(html).toContain('<iframe');
    expect(html).toContain('&lt;style&gt;');
  });
});
