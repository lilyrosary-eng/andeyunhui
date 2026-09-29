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

  // 每个进程使用唯一临时文件名，避免 18 个插件并行构建时多进程
  // 同时写/执行同一固定路径引发 Windows 文件锁或读到半截脚本（exit 1）。
  const uid = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const outPath = join(ROOT_DIR, '.vite-temp', `_tailwind-plugins-${uid}.css`);
  mkdirSync(join(ROOT_DIR, '.vite-temp'), { recursive: true });

  // 用 .cjs 临时脚本生成（CJS 格式，require 可用）
  const scriptPath = join(ROOT_DIR, '.vite-temp', `_gen-tw-${uid}.cjs`);
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

  execSync(`node "${scriptPath}"`, { cwd: ROOT_DIR, stdio: 'inherit' });
  generating = false;
  if (!existsSync(outPath)) throw new Error('Failed to generate Tailwind CSS');
  cachedTailwindCss = readFileSync(outPath, 'utf-8');
  return cachedTailwindCss;
}

/**
 * 插件全局滑条样式：与主程序 src/index.css 的 input[type=range] 规则保持一致。
 * 插件注入的 Tailwind 只有 utilities，不含 index.css 的全局规则，若不在此补充，
 * 插件内所有 input[type=range]（播放器进度、音量、绘画笔刷等）会回退浏览器默认灰条外观。
 */
const PLUGIN_RANGE_CSS = `
input[type="range"]{-webkit-appearance:none;appearance:none;border-radius:9999px;background:rgba(127,127,127,.22)}
input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:var(--element-bg,#5a7f5d);cursor:pointer;transition:background .15s;box-shadow:0 0 0 3px rgba(255,255,255,.12)}
input[type="range"]:hover::-webkit-slider-thumb{background:color-mix(in srgb,var(--element-bg,#5a7f5d),black 15%)}
input[type="range"]:active::-webkit-slider-thumb{background:color-mix(in srgb,var(--element-bg,#5a7f5d),black 30%)}
input[type="range"]::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:var(--element-bg,#5a7f5d);border:none;cursor:pointer;transition:background .15s}
input[type="range"]:hover::-moz-range-thumb{background:color-mix(in srgb,var(--element-bg,#5a7f5d),black 15%)}
input[type="range"]:active::-moz-range-thumb{background:color-mix(in srgb,var(--element-bg,#5a7f5d),black 30%)}
`;

/**
 * 生成插件 vite 配置。
 */
export function createPluginConfig(pluginName: string) {
  const tailwindCss = getTailwindCss();
  // CSS 注入：首选「构造样式表」（CSSStyleSheet + adoptedStyleSheets），不可用时回退 <style> 元素。
  // 原因：Tauri 打包时会给 CSP 的 style-src 追加 nonce，按 CSP 规范 nonce/hash 存在时
  // 'unsafe-inline' 被忽略 → 动态插入的 <style> 被整块拦掉，插件自带 CSS（Tailwind 补充量、
  // input[type=range] 滑条外观等）在打包版全部失效（dev 走 Vite 服务无该 CSP，故只在打包后异常）。
  // 构造样式表不经过 style-src 检查，dev / 打包表现一致。
  const cssInjectionJs = `(function(){if(typeof document==='undefined')return;var css=${JSON.stringify(tailwindCss + PLUGIN_RANGE_CSS)};try{if(typeof CSSStyleSheet==='function'&&'adoptedStyleSheets' in document){var sh=new CSSStyleSheet();sh.replaceSync(css);document.adoptedStyleSheets=[].concat(document.adoptedStyleSheets,[sh]);return;}}catch(e){}var s=document.createElement('style');s.textContent=css;document.head.appendChild(s);})();`;

  return defineConfig({
    // 每个插件进程使用独立 cacheDir，避免多插件并发构建时共享 Vite/esbuild
    // 依赖预构建缓存目录引发 Windows 文件锁竞争（偶发 ENOENT）。
    cacheDir: join(ROOT_DIR, '.vite-temp', `vcache-${process.pid}`),
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
      alias: { '@': SRC_DIR, '@shared': __dirname },
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
