// 强制实体化 node_modules（Windows 下 pnpm 用 junction 软链，Node 的 readlinkSync/realpathSync 均返回 UNKNOWN 失败）
// 方案：普通 fs 读取能「跟随」junction（已验证可读 package.json）。据此：
//   1) 读 node_modules/<pkg>/package.json 拿版本；
//   2) 拼出源路径 node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>；
//   3) 把 junction 替换为该源的真实副本。copyEntry 递归时会把嵌套 junction 一并实体化。
// 链接检测：realpathSync 抛错但路径存在 => 不可跟随的 junction／软链（真实目录 realpathSync 会成功）。
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NM = path.join(ROOT, 'node_modules');

function isUnfollowableLink(p) {
  try { fs.realpathSync(p); return false; } catch { return fs.existsSync(p); }
}

function copyEntry(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    copyEntry(path.resolve(path.dirname(src), fs.readlinkSync(src)), dst);
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      copyEntry(path.join(src, e.name), path.join(dst, e.name));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

// 通过 node_modules/<pkg>/package.json（跟随 junction 可读）取版本，拼出 .pnpm 源路径
function findSource(pkgRelPath) {
  const pkgFile = path.join(NM, pkgRelPath, 'package.json');
  let ver;
  try { ver = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version; } catch { return null; }
  const dirName = pkgRelPath.startsWith('@') ? pkgRelPath.replace('/', '+') : pkgRelPath;
  const cand = path.join(NM, '.pnpm', `${dirName}@${ver}`, 'node_modules', pkgRelPath);
  return fs.existsSync(cand) ? cand : null;
}

function materialize(linkPath, src) {
  if (!src) { console.log('  SKIP (无源):', linkPath); return false; }
  if (!fs.existsSync(src)) { console.log('  SKIP (目标缺失):', linkPath, '->', src); return false; }
  fs.rmSync(linkPath, { recursive: true, force: true });
  copyEntry(src, linkPath);
  return true;
}

let count = 0;
let failed = 0;
const skip = new Set(['.pnpm', '.bin', '.cache', '.vite', '.tmp']);

// 1) 顶层包
for (const name of fs.readdirSync(NM)) {
  if (skip.has(name)) continue;
  const linkPath = path.join(NM, name);
  if (!isUnfollowableLink(linkPath)) continue;
  const src = findSource(name);
  try { if (materialize(linkPath, src)) count++; } catch (e) { failed++; console.log('  FAIL', linkPath, e.message); }
}

// 2) 作用域包 node_modules/@scope/<pkg> 第二层
for (const scope of fs.readdirSync(NM)) {
  if (!scope.startsWith('@')) continue;
  const scopePath = path.join(NM, scope);
  let children;
  try { children = fs.readdirSync(scopePath); } catch { continue; }
  for (const child of children) {
    const pkgRel = `${scope}/${child}`;
    const linkPath = path.join(NM, pkgRel);
    if (!isUnfollowableLink(linkPath)) continue;
    const src = findSource(pkgRel);
    try { if (materialize(linkPath, src)) count++; } catch (e) { failed++; console.log('  FAIL', linkPath, e.message); }
  }
}

console.log('Materialized:', count, 'Failed:', failed);
