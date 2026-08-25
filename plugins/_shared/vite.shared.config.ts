import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..', '..', 'src');
const ROOT_DIR = join(__dirname, '..', '..');

/**
 * 预生成 Tailwind CSS（全量工具类）。
 * Vite lib 模式下 Tailwind JIT 扫描不触发，所以我们在配置加载时
 * 用 PostCSS + Tailwind 一次性生成所有工具类 CSS，后续注入到每个插件。
 */
let cachedTailwindCss: string | null = null;
let generating = false;
function getTailwindCss(): string {
  if (cachedTailwindCss !== null) return cachedTailwindCss;
  // 等待其他并发调用完成（多插件并行构建时共享同一份 CSS）
  while (generating) { /* busy wait, <1ms */ }
  if (cachedTailwindCss !== null) return cachedTailwindCss;
  generating = true;

  const outPath = join(ROOT_DIR, '.vite-temp', '_tailwind-plugins.css');
  mkdirSync(join(ROOT_DIR, '.vite-temp'), { recursive: true });

  // 用 .cjs 临时脚本生成（CJS 格式，require 可用）
  const scriptPath = join(ROOT_DIR, '.vite-temp', '_gen-tw.cjs');
  const configPath = join(ROOT_DIR, 'tailwind.config.js').replace(/\\/g, '\\\\');
  const cssOutPath = outPath.replace(/\\/g, '\\\\');
  writeFileSync(scriptPath, `
    const postcss = require('postcss');
    const tailwindcss = require('tailwindcss');
    const autoprefixer = require('autoprefixer');
    const fs = require('fs');
    const css = '@tailwind base; @tailwind components; @tailwind utilities;';
    postcss([tailwindcss({ config: '${configPath}' }), autoprefixer()])
      .process(css, { from: undefined })
      .then(r => { fs.writeFileSync('${cssOutPath}', r.css); });
  `);

  execSync(`node "${scriptPath}"`, { cwd: ROOT_DIR, stdio: 'pipe' });
  generating = false;
  if (!existsSync(outPath)) throw new Error('Failed to generate Tailwind CSS');
  cachedTailwindCss = readFileSync(outPath, 'utf-8');
  return cachedTailwindCss;
}

/**
 * 生成插件 vite 配置。
 */
export function createPluginConfig(pluginName: string) {
  const tailwindCss = getTailwindCss();
  // 将 CSS 转为 JS 代码：在插件加载时创建 <style> 标签注入到 document.head
  const cssInjectionJs = `(function(){if(typeof document!=='undefined'){var s=document.createElement('style');s.textContent=${JSON.stringify(tailwindCss)};document.head.appendChild(s);}})();`;

  return defineConfig({
    plugins: [
      react(),
      // Vite 插件：在插件入口文件头部注入 Tailwind CSS 注入代码
      {
        name: 'inject-tailwind-css',
        enforce: 'pre',
        transform: {
          order: 'pre',
          handler(code: string, id: string) {
            if (id.endsWith('/src/index.tsx')) {
              return cssInjectionJs + '\n' + code;
            }
          },
        },
      },
    ],
    resolve: {
      alias: { '@': SRC_DIR },
      dedupe: [
        '@codemirror/state', '@codemirror/view', '@codemirror/language',
        '@codemirror/commands', '@codemirror/search', '@codemirror/autocomplete',
        '@codemirror/lint', '@lezer/common', '@lezer/highlight', '@lezer/lr',
        'style-mod', 'w3c-keyname', 'crelt',
      ],
    },
    css: {
      postcss: join(ROOT_DIR, 'postcss.config.js'),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    build: {
      lib: {
        entry: 'src/index.tsx',
        formats: ['iife'],
        name: pluginName,
      },
      rollupOptions: {
        external: ['react', 'react-dom'],
        output: {
          globals: { react: '__HOST_REACT__', 'react-dom': '__HOST_REACT_DOM__' },
          entryFileNames: 'index.js',
          inlineDynamicImports: true,
        },
      },
      outDir: 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 1600,
    },
  });
}
