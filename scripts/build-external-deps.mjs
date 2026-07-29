// 构建 external-deps 下的外部依赖为独立 IIFE 包（按需加载，不进插件本体）。
// 目前：CodeMirror 6 → external-deps/茑萝/ide/codemirror/index.js
//       TipTap 2     → external-deps/茑萝/wps/tiptap/index.js（茑萝「文档编辑器」插件内核，与宿主共享 React）
// 用法：node scripts/build-external-deps.mjs
import { build } from 'esbuild';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const buildDir = join(rootDir, 'external-deps', '_build');
const require = createRequire(import.meta.url);

// ===== redi 路径统一插件 =====
// pnpm hoisted 模式下，@wendellhu/redi 同时存在于：
//   node_modules/@wendellhu/redi（hoisted 符号链接）
//   node_modules/.pnpm/@wendellhu+redi@1.1.1_react@18.0.0/node_modules/@wendellhu/redi（虚拟存储）
// esbuild 将两个路径视为不同模块，导致 redi 重复打包，DI 容器（RediContext）被创建多次，
// 破坏 Univer 依赖注入，运行时报 "Cannot read properties of undefined (reading 'setConfig')"。
// 此插件用 require.resolve 获取实际文件路径（跟随符号链接），确保所有 redi 导入统一到同一文件。
const rediResolvePlugin = {
  name: 'redi-resolve',
  setup(b) {
    // require.resolve 跟随符号链接，返回实际文件路径（如 .../dist/esm/index.js）
    const rediMainPath = require.resolve('@wendellhu/redi');
    const rediReactPath = require.resolve('@wendellhu/redi/react-bindings');
    b.onResolve({ filter: /^@wendellhu\/redi$/ }, () => ({ path: rediMainPath }));
    b.onResolve({ filter: /^@wendellhu\/redi\/react-bindings$/ }, () => ({ path: rediReactPath }));
  },
};

// react / react-dom / react-dom/client 外部化到宿主（与插件沙箱共享同一 React 实例）
// react-dom/client 用于 React 18 的 createRoot（Univer 视图层依赖）
const hostExternals = {
  react: '__HOST_REACT__',
  'react-dom': '__HOST_REACT_DOM__',
  'react-dom/client': '__HOST_REACT_DOM__',
};
const hostExternalsPlugin = {
  name: 'host-externals',
  setup(b) {
    // 匹配 react / react-dom / react-dom/client（不含 react/jsx-runtime，后者随包体打包并回退宿主 react）
    b.onResolve({ filter: /^react$|^react-dom$|^react-dom\/client$/ }, (args) => ({
      path: args.path,
      namespace: 'host-external',
    }));
    b.onLoad({ filter: /.*/, namespace: 'host-external' }, (args) => {
      const g = hostExternals[args.path];
      return {
        contents: `module.exports = window.${g};`,
        loader: 'js',
      };
    });
  },
};

// ===== CodeMirror 依赖收敛插件 =====
// pnpm 用符号链接组织 node_modules：@codemirror/state 既可能经 node_modules/@codemirror/state
// （顶层符号链接）被解析，也可能经 node_modules/.pnpm/@codemirror+state@x/... 被解析。esbuild 把
// 这两条路径当成两个不同模块，导致 @codemirror/state 被打进包体两次。运行时 EditorView 与
// basicSetup 各自持有一份 state 实例，互相 instanceof 失败，报
// "multiple instances of @codemirror/state are loaded"，整个 IDE 编辑器崩溃。
// 本插件用 require.resolve 取得每个包的唯一物理入口，强制所有导入收敛到同一文件（与 rediResolvePlugin 同理）。
const CM_DEDUPE_PACKAGES = [
  'codemirror',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/search',
  '@codemirror/autocomplete',
  '@codemirror/lint',
  '@codemirror/tooltip',
  '@codemirror/theme-one-dark',
  '@codemirror/lang-javascript',
  '@codemirror/lang-python',
  '@codemirror/lang-html',
  '@codemirror/lang-css',
  '@codemirror/lang-json',
  'style-mod',
  'w3c-keyname',
  'crelt',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  '@lezer/javascript',
  '@lezer/python',
  '@lezer/css',
  '@lezer/html',
  '@lezer/json',
];
const cmDedupePlugin = {
  name: 'cm-dedupe',
  setup(b) {
    const resolved = new Map();
    for (const pkg of CM_DEDUPE_PACKAGES) {
      try {
        resolved.set(pkg, require.resolve(pkg));
      } catch {
        // 该包未安装则跳过
      }
    }
    for (const [pkg, realPath] of resolved) {
      const re = new RegExp('^' + pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
      b.onResolve({ filter: re }, () => ({ path: realPath }));
    }
  },
};

// 各外部依赖：outDir 输出目录（分类到对应插件子目录），entry 为 _build 下入口，global 为 IIFE 内部全局名（仅打包用）
// loader: 可选，为该目标指定 esbuild loader（如 Univer 的 CSS 用 text 内联到 JS）
const TARGETS = [
  { outDir: '茑萝/ide/codemirror', entry: 'codemirror-entry.js', global: '__CM_BUNDLE__' },
  { outDir: '茑萝/wps/tiptap', entry: 'tiptap-entry.js', global: '__TIPTAP_BUNDLE__' },
  // 本地 OCR 引擎（PaddleOCR PP-OCRv6，onnxruntime-web wasm 后端；推理在 Web Worker 内执行）
  // WASM 后端（ort.wasm.min.js）作为独立运行时资源，不随 esbuild 打包，避免 tree-shake 丢 registerBackend。
  { outDir: '全局/paddleocr', entry: 'paddleocr-entry.js', global: '__PADDLEOCR_BUNDLE__' },
  // 本地 OCR Web Worker（独立线程跑推理，主线程不卡死）。输出到 public/ocr-worker.js（dev/prod 均经 /ocr-worker.js 加载）
  { outDir: '../public', entry: 'paddleocr-worker-entry.js', global: '__OCR_WORKER__', outFile: 'ocr-worker.js' },
];

for (const t of TARGETS) {
  const entry = join(buildDir, t.entry);
  if (!existsSync(entry)) {
    console.warn(`[Build] 跳过 ${t.outDir}：入口缺失 → ${entry}`);
    continue;
  }
  const outDir = join(rootDir, 'external-deps', t.outDir);
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    globalName: t.global,
    outfile: join(outDir, t.outFile || 'index.js'),
    minify: true,
    legalComments: 'none',
    plugins: [rediResolvePlugin, hostExternalsPlugin, cmDedupePlugin],
    loader: t.loader, // undefined 时 esbuild 使用默认 loader
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info',
  });
  console.log(`[Build] ${t.outFile ? '' : 'external-deps/'}${t.outDir}/${t.outFile || 'index.js'} 已生成`);
}

console.log('[Build] external-deps 构建完成');
