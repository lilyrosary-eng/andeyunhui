import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

// markdown 渲染契约（2026-10-20 高亮/交互改造后新增）
// 这些断言钉的是「渲染产物里必须有什么」，不是像素级样式 —— 目的是防止
// 以后有人改 marked 配置时把高亮、代码块按钮或链接安全属性改没了。
describe('renderMarkdown', () => {
  it('代码块：语言标签 + 复制 + HTML 预览三个要素齐全', () => {
    const html = renderMarkdown('```html\n<button>hi</button>\n```');
    expect(html).toContain('md-code-block');
    expect(html).toContain('md-code-head');
    expect(html).toContain('md-lang');
    expect(html).toContain('md-copy-btn');
    // HTML 才给「预览」按钮
    expect(html).toContain('md-run-btn');
  });

  it('非 HTML 代码块不给预览按钮（避免把 CSS/JS 单独当文档跑）', () => {
    const html = renderMarkdown('```css\nbody{color:red}\n```');
    expect(html).toContain('md-copy-btn');
    expect(html).not.toContain('md-run-btn');
  });

  it('已知语言走 highlight.js，产出 hljs-* 着色 span', () => {
    const html = renderMarkdown('```ts\nconst a: number = 1;\n```');
    expect(html).toContain('class="hljs"');
    expect(html).toMatch(/hljs-keyword/);
  });

  it('别名认得出（ts→typescript），未知语言不高亮但也不报错', () => {
    expect(renderMarkdown('```ts\nlet x = 1\n```')).toMatch(/hljs-keyword|hljs-literal/);
    const unknown = renderMarkdown('```brainfuck\n+++\n```');
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
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```');
    // 源码文本里不能出现可执行的 script 标签
    expect(html).not.toMatch(/<script>/);
  });
});
