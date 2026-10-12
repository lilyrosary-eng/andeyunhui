import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';

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
 * CodeMirror 依赖收敛（与 scripts/build-external-deps.mjs 的 cmDedupePlugin 对齐）。
 *
 * 根因：pnpm 下 codemirror 元包 dist/index.js 用 `export * from "@codemirror/autocomplete"`
 * 这类裸导入。插件构建开了 inlineDynamicImports:true（强制把动态 import 的整条依赖图内联），
 * 一旦 gongfang/ide 动态 import('codemirror')，Rollup 就必须解析该嵌套裸导入——而 @codemirror/*
 * 这些包仅作为 codemirror 的「传递依赖」存在于 node_modules/.pnpm 虚拟存储里，并未被提升到
 * 顶层 node_modules，Vite 在此配置下解析不到，报
 * "Rollup failed to resolve import @codemirror/autocomplete"（gongfang / ide 两个插件均中招）。
 *
 * 修复：直接扫描 node_modules/.pnpm 物理存储，把每个 codemirror/@lezer 系裸导入收敛到其唯一
 * 物理 ESM 入口。require.resolve 在此不可用——Vite 把配置打包到临时文件，import.meta.url 指向
 * 临时目录，且这些传递依赖本就不在任何可 require 解析的路径上。
 * 一举两得：1) 修复解析失败；2) 避免 "multiple instances of @codemirror/state" 运行时崩溃
 * （与 external-deps 同理，插件构建原本也缺这层防护，多实例会让 EditorView 与 basicSetup 的
 * state 互不相认）。
 */
const CM_PACKAGES = [
  'codemirror',
  '@codemirror/state', '@codemirror/view', '@codemirror/commands',
  '@codemirror/language', '@codemirror/search', '@codemirror/autocomplete',
  '@codemirror/lint', '@codemirror/tooltip', '@codemirror/theme-one-dark',
  '@codemirror/lang-javascript', '@codemirror/lang-python', '@codemirror/lang-html',
  '@codemirror/lang-css', '@codemirror/lang-json',
  'style-mod', 'w3c-keyname', 'crelt',
  '@lezer/common', '@lezer/highlight', '@lezer/lr',
  '@lezer/javascript', '@lezer/python', '@lezer/css', '@lezer/html', '@lezer/json',
];

/** 读包目录的 ESM 入口（优先 exports['.'].import > module > main），失败返回 null */
function cmEsmEntry(pkgDir: string): string | null {
  const pj = join(pkgDir, 'package.json');
  if (!existsSync(pj)) return null;
  try {
    const j = JSON.parse(readFileSync(pj, 'utf-8'));
    const exp = j.exports && j.exports['.'];
    const esm = (exp && (exp.import || exp.default)) || j.module || j.main;
    if (!esm || typeof esm !== 'string') return null;
    return join(pkgDir, esm);
  } catch {
    return null;
  }
}

/**
 * 在 node_modules/.pnpm 物理存储里定位某个包的唯一物理入口。
 * 优先在 codemirror 元包自身的依赖树（即 codemirror@<版本>/node_modules 下）里找，版本最权威；
 * 找不到再全量扫描 .pnpm（兜底）。readdirSync 顺序不影响正确性——只要每个包收敛到单一路径
 * 即避免多实例问题。
 */
function findPnpmPkg(pkg: string): string | null {
  const pnpmDir = join(ROOT_DIR, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return null;
  const si = pkg.indexOf('/');
  const tryDir = (base: string): string | null => {
    const nm = join(base, 'node_modules');
    if (!existsSync(nm)) return null;
    const cand = si >= 0 ? join(nm, pkg.slice(0, si), pkg.slice(si + 1)) : join(nm, pkg);
    return existsSync(cand) ? cmEsmEntry(cand) : null;
  };
  for (const dir of readdirSync(pnpmDir)) {
    if (dir.startsWith('codemirror@')) {
      const r = tryDir(join(pnpmDir, dir));
      if (r) return r;
    }
  }
  for (const dir of readdirSync(pnpmDir)) {
    const r = tryDir(join(pnpmDir, dir));
    if (r) return r;
  }
  return null;
}

const cmResolved = new Map<string, string>();
for (const pkg of CM_PACKAGES) {
  const p = findPnpmPkg(pkg);
  if (p) cmResolved.set(pkg, p);
}

const cmResolvePlugin = {
  name: 'cm-resolve',
  enforce: 'pre' as const,
  resolveId(source: string) {
    const p = cmResolved.get(source);
    return p ?? null;
  },
};

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
      cmResolvePlugin,
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
