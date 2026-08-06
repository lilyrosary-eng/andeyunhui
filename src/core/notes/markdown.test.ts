import { describe, it, expect } from 'vitest';
import { editorHtmlToMd, mdToEditorHtml } from './markdown';

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