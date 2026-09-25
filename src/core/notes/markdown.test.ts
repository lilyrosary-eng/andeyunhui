import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  editorHtmlToMd,
  mdToEditorHtml,
  renderMarkdownPreview,
  wrapMarkdownSelection,
  prefixMarkdownLines,
} from './markdown';
import { MarkdownSourceEditor } from './MarkdownSourceEditor';

// 现状固化测试（golden tests）：
// 期望值取迁移前函数的真实输出，已知缺陷一律照当前行为固化、只在缺陷清单中记录，不在此修复。

describe('editorHtmlToMd', () => {
  it('空输入返回空串', () => {
    expect(editorHtmlToMd('')).toBe('');
  });

  it('纯文本原样返回（无标签）', () => {
    expect(editorHtmlToMd('hello world')).toBe('hello world');
  });

  it('粗体', () => {
    expect(editorHtmlToMd('<p>a <strong>b</strong></p>')).toBe('a **b**');
  });

  it('斜体', () => {
    expect(editorHtmlToMd('<p><em>x</em></p>')).toBe('*x*');
  });

  it('粗体+斜体嵌套', () => {
    expect(editorHtmlToMd('<p><strong><em>ab</em></strong></p>')).toBe('***ab***');
  });

  it('内联代码', () => {
    expect(editorHtmlToMd('<p><code>a &lt; b</code></p>')).toBe('`a < b`');
  });

  it('删除线', () => {
    expect(editorHtmlToMd('<p><s>gone</s></p>')).toBe('~~gone~~');
  });

  it('标题 h1-h3', () => {
    expect(editorHtmlToMd('<h1>T1</h1>')).toBe('# T1');
    expect(editorHtmlToMd('<h2>T2</h2>')).toBe('## T2');
    expect(editorHtmlToMd('<h3>T3</h3>')).toBe('### T3');
  });

  it('链接', () => {
    expect(editorHtmlToMd('<p>see <a href="https://x.com">link</a></p>')).toBe('see [link](https://x.com)');
  });

  it('链接内嵌粗体', () => {
    expect(editorHtmlToMd('<p>see <a href="https://x.com"><strong>link</strong></a></p>')).toBe(
      'see [**link**](https://x.com)',
    );
  });

  it('图片', () => {
    expect(editorHtmlToMd('<p><img src="a.png" alt="x"></p>')).toBe('![](a.png)');
  });

  it('localimg 图片', () => {
    expect(editorHtmlToMd('<p><img src="localimg://abc" alt=""></p>')).toBe('![](localimg://abc)');
  });

  it('水平线', () => {
    expect(editorHtmlToMd('<p><hr></p>')).toBe('---');
  });

  it('引用', () => {
    expect(editorHtmlToMd('<blockquote><p>quote</p></blockquote>')).toBe('> quote');
  });

  it('换行 br', () => {
    expect(editorHtmlToMd('a<br>b')).toBe('a\nb');
  });

  it('无序列表', () => {
    expect(editorHtmlToMd('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b');
  });

  it('有序列表：当前缺陷固化（ol 丢失编号，被当作无序处理）', () => {
    expect(editorHtmlToMd('<ol><li>a</li><li>b</li></ol>')).toBe('- a\n- b');
  });

  it('代码块：当前行为固化（变内联反引号，不保留多行与语言）', () => {
    expect(editorHtmlToMd('<pre><code>line1\nline2</code></pre>')).toBe('`line1\nline2`');
  });

  it('HTML 实体解码', () => {
    expect(editorHtmlToMd('<p>&amp; &lt; &gt; &quot; &#39;</p>')).toBe("& < > \" '");
  });

  it('多余空行合并为 \\n\\n', () => {
    expect(editorHtmlToMd('<p>a</p>\n\n\n<p>b</p>')).toBe('a\n\nb');
  });

  it('round-trip 现状：典型笔记 md→html→md', () => {
    const md = '# 标题\n\n**加粗** 和 *斜体*，还有 `代码`。\n\n- 一\n- 二\n\n[链接](https://example.com) 与 ![图](img.png)';
    const html = mdToEditorHtml(md);
    const out = editorHtmlToMd(html);
    // 固化当前 round-trip 结果：内容主体应保留，列表编号等行业缺陷允许丢失（后续轮次修复）
    expect(out).toContain('# 标题');
    expect(out).toContain('**加粗**');
    expect(out).toContain('*斜体*');
    expect(out).toContain('[链接](https://example.com)');
    expect(out).toContain('- 一');
    expect(out).toContain('- 二');
  });
});

describe('mdToEditorHtml', () => {
  it('空输入返回空串', () => {
    expect(mdToEditorHtml('')).toBe('');
  });

  it('纯文本包一层 p', () => {
    expect(mdToEditorHtml('hello')).toBe('<p>hello</p>\n');
  });

  it('标题', () => {
    expect(mdToEditorHtml('# Title')).toBe('<h1>Title</h1>\n');
    expect(mdToEditorHtml('## Sub')).toBe('<h2>Sub</h2>\n');
  });

  it('粗体', () => {
    expect(mdToEditorHtml('**bold**')).toBe('<p><strong>bold</strong></p>\n');
  });

  it('链接', () => {
    expect(mdToEditorHtml('[t](https://x.com)')).toBe('<p><a href="https://x.com">t</a></p>\n');
  });

  it('图片', () => {
    expect(mdToEditorHtml('![alt](a.png)')).toBe('<p><img src="a.png" alt="alt"></p>\n');
  });

  it('内联代码', () => {
    expect(mdToEditorHtml('`code`')).toBe('<p><code>code</code></p>\n');
  });

  it('无序列表', () => {
    expect(mdToEditorHtml('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n');
  });

  it('有序列表', () => {
    expect(mdToEditorHtml('1. a\n2. b')).toBe('<ol>\n<li>a</li>\n<li>b</li>\n</ol>\n');
  });

  it('引用', () => {
    expect(mdToEditorHtml('> quote')).toBe('<blockquote>\n<p>quote</p>\n</blockquote>\n');
  });
});

// 预览渲染回归：旧实现在 parse 前把连续 \n 换成等量 <br>，删掉了真实换行，
// 导致空行之后的行首块级语法（## / 列表 / 引用 / 围栏代码）全部失效。
describe('renderMarkdownPreview（预览块级语法修复）', () => {
  it('空输入返回空串', () => {
    expect(renderMarkdownPreview('')).toBe('');
  });

  it('空行之后的 `## 标题` 必须渲染为 h2', () => {
    const html = renderMarkdownPreview('上一段\n\n## 标题');
    expect(html).toContain('<p>上一段</p>');
    expect(html).toContain('<h2>标题</h2>');
  });

  it('空行之后的其它行首块级语法同样生效：无序列表 / 有序列表 / 引用 / 围栏代码', () => {
    expect(renderMarkdownPreview('正文\n\n- 一\n- 二')).toContain('<ul>');
    expect(renderMarkdownPreview('正文\n\n1. 一')).toContain('<ol>');
    expect(renderMarkdownPreview('正文\n\n> 引用')).toContain('<blockquote>');
    const code = renderMarkdownPreview('正文\n\n```js\nconst a = 1;\n```');
    expect(code).toContain('<pre><code');
    expect(code).toContain('const a = 1;');
  });

  it('段内单个换行由 breaks 选项转 <br>，与编辑区逐行显示一致', () => {
    expect(renderMarkdownPreview('第一行\n第二行')).toContain('<br>');
  });

  it('连续空行只折叠为段落边界，不再产生字面 <br>', () => {
    const html = renderMarkdownPreview('a\n\n\n\nb');
    expect(html).not.toContain('<br>');
    expect(html).toContain('<p>a</p>');
    expect(html).toContain('<p>b</p>');
  });
});

// 代码块复制按钮：由共享 renderer（src/lib/markdown.ts）注入，点击由事件代理处理。
// 这里锁住「按钮存在 + 待复制文本正确 + 属性已转义」，防止后续换 renderer 时静默丢失。
describe('renderMarkdownPreview（代码块复制按钮）', () => {
  it('围栏代码块被包进 .md-code-block 并带上复制按钮', () => {
    const html = renderMarkdownPreview('```\nconst a = 1;\n```');
    expect(html).toContain('md-code-block');
    expect(html).toContain('md-copy-btn');
    expect(html).toContain('data-code=');
  });

  it('data-code 携带代码原文，且双引号被转义以免截断属性', () => {
    const html = renderMarkdownPreview('```\nsay "hi" & bye\n```');
    // 属性值里必须是实体，不能出现裸引号（否则属性会被引号截断）。
    // 不断言闭合引号：围栏代码块的内容自带尾部换行，闭合引号不在同一行。
    expect(html).toContain('data-code="say &quot;hi&quot; &amp; bye');
    expect(html).not.toContain('data-code="say "hi"');
  });

  it('无围栏代码块时不注入复制按钮', () => {
    const html = renderMarkdownPreview('只有普通段落');
    expect(html).not.toContain('md-copy-btn');
  });
});

// 编辑区改为受控 textarea 后必须显示字面 Markdown，这里用 SSR 断言渲染结果
describe('MarkdownSourceEditor（编辑区保持字面 Markdown）', () => {
  it('`## 标题` 与 `**加粗**` 原样出现在 textarea 里，不被渲染成 HTML', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownSourceEditor, {
        content: '## 标题\n\n**加粗**',
        onContentChange: () => {},
      }),
    );
    expect(markup).toContain('<textarea');
    expect(markup).toContain('## 标题');
    expect(markup).toContain('**加粗**');
    expect(markup).not.toContain('<h2');
    expect(markup).not.toContain('<strong>');
  });
});

// 工具栏指令：编辑器里只插入字面 Markdown 标记
describe('编辑区 Markdown 插入指令', () => {
  it('加粗：用 ** 包裹选中文字并保持选中', () => {
    expect(
      wrapMarkdownSelection({ text: 'hello', selectionStart: 0, selectionEnd: 5 }, '**', '**'),
    ).toEqual({ text: '**hello**', selectionStart: 2, selectionEnd: 7 });
  });

  it('加粗：未选中时插入空标记，光标落在标记中间', () => {
    expect(
      wrapMarkdownSelection({ text: 'ab', selectionStart: 1, selectionEnd: 1 }, '**', '**'),
    ).toEqual({ text: 'a****b', selectionStart: 3, selectionEnd: 3 });
  });

  it('链接：未选中文字时用 URL 兜底为 [URL](URL)', () => {
    expect(
      wrapMarkdownSelection({ text: '', selectionStart: 0, selectionEnd: 0 }, '[', '](https://x.com)', 'https://x.com').text,
    ).toBe('[https://x.com](https://x.com)');
  });

  it('无序列表：为选中各行加 "- "，空行跳过', () => {
    const md = '一\n二\n\n三';
    expect(prefixMarkdownLines({ text: md, selectionStart: 0, selectionEnd: md.length }, '- ').text)
      .toBe('- 一\n- 二\n\n- 三');
  });

  it('标题：为光标所在行加 "## "', () => {
    expect(prefixMarkdownLines({ text: '标题', selectionStart: 2, selectionEnd: 2 }, '## ').text)
      .toBe('## 标题');
  });
});