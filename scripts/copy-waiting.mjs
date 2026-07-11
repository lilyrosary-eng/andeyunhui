// 将 wait-page/ 下的定制加载页同步到 public/。
// 注意：index.html 中的哥特页注入已由 vite.config.ts 的 transformIndexHtml 插件接管，
//       不再依赖本脚本生成的 JS 数据文件（彻底消除了外部脚本加载失败的风险）。
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../wait-page/', import.meta.url));
const outDir = fileURLToPath(new URL('../public/', import.meta.url));

const files = ['waiting-page-light.html', 'waiting-page-dark.html'];

await mkdir(outDir, { recursive: true });
for (const f of files) {
  await copyFile(srcDir + f, outDir + f);
}

console.log('[copy-waiting] 已同步加载页 ->', outDir);
