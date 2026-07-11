// 构建 external-deps 下的外部依赖为独立 IIFE 包（按需加载，不进插件本体）。
// 目前：CodeMirror 6 → external-deps/codemirror/index.js
//       TipTap 2     → external-deps/tiptap/index.js（茑萝「文档编辑器」插件内核，与宿主共享 React）
// 用法：node scripts/build-external-deps.mjs
import { build } from 'esbuild';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const buildDir = join(rootDir, 'external-deps', '_build');

// react / react-dom 外部化到宿主（与插件沙箱共享同一 React 实例，确保 @tiptap/react 的 hooks 正常）
const hostExternals = {
  react: '__HOST_REACT__',
  'react-dom': '__HOST_REACT_DOM__',
};
const hostExternalsPlugin = {
  name: 'host-externals',
  setup(b) {
    // 仅精确匹配 react / react-dom（不含 react/jsx-runtime，后者随包体打包并回退宿主 react）
    b.onResolve({ filter: /^react$|^react-dom$/ }, (args) => ({
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

// 各外部依赖：name 输出目录，entry 为 _build 下入口，global 为 IIFE 内部全局名（仅打包用）
const TARGETS = [
  { name: 'codemirror', entry: 'codemirror-entry.js', global: '__CM_BUNDLE__' },
  { name: 'tiptap', entry: 'tiptap-entry.js', global: '__TIPTAP_BUNDLE__' },
];

for (const t of TARGETS) {
  const entry = join(buildDir, t.entry);
  if (!existsSync(entry)) {
    console.warn(`[Build] 跳过 ${t.name}：入口缺失 → ${entry}`);
    continue;
  }
  const outDir = join(rootDir, 'external-deps', t.name);
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    globalName: t.global,
    outfile: join(outDir, 'index.js'),
    minify: true,
    legalComments: 'none',
    plugins: [hostExternalsPlugin],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info',
  });
  console.log(`[Build] external-deps/${t.name}/index.js 已生成`);
}

console.log('[Build] external-deps 构建完成');
