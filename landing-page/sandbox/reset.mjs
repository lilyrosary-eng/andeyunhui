// 一键重建沙箱靶场数据：删除 DB，下次启动 server.mjs 自动重新播种。
// 用法：node reset.mjs
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const f = join(dirname(fileURLToPath(import.meta.url)), 'data', 'sandbox.db');
rmSync(f, { force: true });
console.log('[sandbox] 已删除 ' + f + '，重启 server.mjs 即重建种子数据');