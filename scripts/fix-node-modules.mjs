// Windows workaround: this host cannot create working symlinks/junctions
// (NTFS reparse points cannot be followed). pnpm therefore produces broken
// symlinks AND missing/empty nested + transitive dependencies. This script
// fully "materializes" node_modules as real directory copies so Node/esbuild
// can resolve every package and its transitive dependencies.
//
// Strategy:
//   1) Fix every broken symlink under node_modules (incl. inside .pnpm),
//      replacing it with a real copy. This makes the .pnpm store self-contained.
//   2) Materialize the top-level node_modules by MERGING, for every package in
//      .pnpm, that package's `node_modules` contents into the top level:
//        - scoped dirs  (e.g. @tiptap)  -> merge children (adds missing
//          sub-packages like @tiptap/extension-blockquote without deleting others)
//        - unscoped dirs (e.g. linkifyjs, prosemirror-*) -> copy only if the
//          top-level entry is currently missing
//      This pulls every transitive dependency (tiptap's prosemirror-*/linkifyjs,
//      esbuild's platform binary, etc.) into a resolvable location.
//   3) Hoist optional platform binaries (scoped) defensively.
//
// Idempotent: existing real directories are left untouched, so re-runs are
// fast after the first full materialization.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();
const NM = path.join(ROOT, 'node_modules');
const PNPM = path.join(NM, '.pnpm');

const counts = { fixed: 0, failed: 0, working: 0, total: 0, materialized: 0 };

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      const resolved = path.resolve(path.dirname(srcPath), target);
      if (fs.existsSync(resolved)) {
        const targetStat = fs.statSync(resolved);
        if (targetStat.isDirectory()) copyDirRecursive(resolved, destPath);
        else fs.copyFileSync(resolved, destPath);
      }
    } else if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeLink(fullPath) {
  try { fs.unlinkSync(fullPath); return; } catch (e) {}
  try { fs.rmdirSync(fullPath); return; } catch (e) {}
  try { execSync(`rmdir "${fullPath}"`, { stdio: 'ignore' }); return; } catch (e) {}
  try { execSync(`del /f /q "${fullPath}"`, { stdio: 'ignore' }); } catch (e) {}
}

function rel(p) { return path.relative(ROOT, p); }

// Follow a (possibly broken) symlink to a real path; fall back to input.
function resolvePath(p) {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) {
      const t = fs.readlinkSync(p);
      const r = path.resolve(path.dirname(p), t);
      if (fs.existsSync(r)) return r;
    }
  } catch (e) {}
  return p;
}

// Recursively merge `src` into `dest`: add missing files/dirs, never delete
// existing ones. If `dest` is missing entirely, copy `src` verbatim.
function mergeDir(srcRaw, dest) {
  const src = resolvePath(srcRaw);
  let srcStat;
  try { srcStat = fs.statSync(src); } catch (e) { return; }
  let destExists = false;
  try { fs.statSync(dest); destExists = true; } catch (e) {}

  if (!destExists) {
    if (srcStat.isDirectory()) copyDirRecursive(src, dest);
    else fs.copyFileSync(src, dest);
    counts.materialized++;
    return;
  }
  if (!srcStat.isDirectory()) return; // both exist as files -> keep dest
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    mergeDir(path.join(src, e.name), path.join(dest, e.name));
  }
}

// 1) Replace every broken symlink (recursively) with a real copy.
function fixSymlinksIn(root, skipSet) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
  for (const entry of entries) {
    if (skipSet && skipSet.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      counts.total++;
      let ok = false;
      try { fs.statSync(full); ok = true; } catch (e) { ok = false; }
      if (ok) { counts.working++; continue; }
      try {
        const target = fs.readlinkSync(full);
        const resolved = path.resolve(path.dirname(full), target);
        if (!fs.existsSync(resolved)) {
          counts.failed++;
          console.error(`Target not found: ${full} -> ${resolved}`);
          continue;
        }
        removeLink(full);
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) copyDirRecursive(resolved, full);
        else fs.copyFileSync(resolved, full);
        try { fs.statSync(full); counts.fixed++; console.log(`Fixed: ${rel(full)}`); }
        catch (e3) { counts.failed++; console.error(`Verify failed: ${full}`); }
      } catch (err) {
        counts.failed++;
        console.error(`Error: ${full}: ${err.message}`);
      }
    } else if (entry.isDirectory()) {
      fixSymlinksIn(full, null);
    }
  }
}

// 2) Merge every .pnpm package's node_modules into the top-level node_modules.
function materializeTopLevel() {
  if (!fs.existsSync(PNPM)) return;
  for (const pkg of fs.readdirSync(PNPM)) {
    const nm = path.join(PNPM, pkg, 'node_modules');
    if (!fs.existsSync(nm)) continue;
    let entries;
    try { entries = fs.readdirSync(nm, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (e.name === '.bin' || e.name === '.pnpm') continue;
      const src = path.join(nm, e.name);
      const dest = path.join(NM, e.name);
      if (e.name.startsWith('@')) {
        // scoped: always merge children so missing sub-packages get added
        mergeDir(src, dest);
      } else if (!fs.existsSync(dest)) {
        // unscoped: copy only if currently missing
        mergeDir(src, dest);
      }
    }
  }
}

// 3) Defensive hoist of optional platform binaries (scoped) to top level.
function hoistScopedPackages() {
  if (!fs.existsSync(PNPM)) return;
  for (const d of fs.readdirSync(PNPM)) {
    const m = /^@([^+]+)\+(.+?)@(.+)$/.exec(d);
    if (!m) continue;
    const scope = m[1];
    const name = m[2];
    const src = path.join(PNPM, d, 'node_modules', '@' + scope, name);
    if (!fs.existsSync(src) || fs.readdirSync(src).length === 0) continue;
    const dest = path.join(NM, '@' + scope, name);
    if (fs.existsSync(dest)) {
      let broken = false;
      try { fs.statSync(dest); } catch (e) { broken = true; }
      if (!broken) continue;
      removeLink(dest);
    }
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (e) {}
    copyDirRecursive(src, dest);
    counts.materialized++;
    console.log(`Hoisted: ${rel(dest)}`);
  }
}

console.log('Materializing node_modules (Windows symlink workaround)...');
fixSymlinksIn(NM, new Set(['.bin']));
materializeTopLevel();
hoistScopedPackages();

console.log(`\nSymlinks checked: ${counts.total} (working/skipped: ${counts.working})`);
console.log(`Broken symlinks fixed: ${counts.fixed}`);
console.log(`Packages/dirs materialized: ${counts.materialized}`);
console.log(`Failed: ${counts.failed}`);
