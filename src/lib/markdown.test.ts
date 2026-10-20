import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

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
});
