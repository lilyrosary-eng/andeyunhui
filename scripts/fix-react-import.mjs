// 将插件源码中的 `const React = window.__HOST_REACT__[ as any];`
// 统一改为 `import React from 'react';`，以修复 TS2503 "Cannot find namespace 'React'"。
// 背景：插件是 IIFE，运行时 React 来自宿主（__HOST_REACT__）。
// createPluginConfig 已将 react 外部化并映射到全局 __HOST_REACT__，
// 因此 `import React from 'react'` 在构建时即等价于 `React = __HOST_REACT__`（运行时不变），
// 同时让 TS 拿到真正的 React 命名空间（原 const 会遮蔽全局 React 命名空间，导致类型报错）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'c:/Users/Rosary/Desktop/andeyunhui/plugins';
const SKIP = new Set(['node_modules', 'dist', 'bundled-plugins', '_template', '.git']);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
})(ROOT);

// 不依赖行尾：匹配整条语句即可
const reConst = /const React = window\.__HOST_REACT__(?: as any)?;/g;
const reHasImport = /import\s+React\s+from\s+['"]react['"]|import\s+\*\s+as\s+React\s+from\s+['"]react['"]/;

const converted = [];
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  if (!reConst.test(s)) continue;
  reConst.lastIndex = 0;
  const hasImport = reHasImport.test(s);
  const out = hasImport ? s.replace(reConst, '') : s.replace(reConst, 'import React from \'react\'');
  if (out !== s) {
    fs.writeFileSync(f, out);
    converted.push(f.replace(ROOT + path.sep, ''));
  }
}
fs.writeFileSync('c:/Users/Rosary/Desktop/andeyunhui/conv_result.txt',
  `converted ${converted.length} of ${files.length}\n` + converted.join('\n') + '\n');
