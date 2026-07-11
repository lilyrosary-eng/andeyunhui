// Replaces all broken symlinks/junctions in node_modules/ with real directory copies.
// Workaround for Windows systems where reparse points cannot be followed.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const NM = path.resolve('node_modules');
const SKIP_DIRS = new Set(['.pnpm', '.bin']);
const SKIP_FILES = new Set(['.modules.yaml', '.package-map.json']);

let fixed = 0, failed = 0, working = 0, total = 0;

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
        if (targetStat.isDirectory()) {
          copyDirRecursive(resolved, destPath);
        } else {
          fs.copyFileSync(resolved, destPath);
        }
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

function fixDir(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isSymbolicLink()) {
      total++;
      try {
        fs.statSync(fullPath);
        working++;
        continue;
      } catch (e) {
        try {
          const target = fs.readlinkSync(fullPath);
          const resolved = path.resolve(dirPath, target);
          if (!fs.existsSync(resolved)) {
            console.error(`Target not found: ${fullPath} -> ${resolved}`);
            failed++;
            continue;
          }
          removeLink(fullPath);
          const stat = fs.statSync(resolved);
          if (stat.isDirectory()) {
            copyDirRecursive(resolved, fullPath);
          } else {
            fs.copyFileSync(resolved, fullPath);
          }
          try {
            fs.statSync(fullPath);
            fixed++;
            console.log(`Fixed: ${path.relative(NM, fullPath)}`);
          } catch (e3) {
            failed++;
            console.error(`Verify failed: ${fullPath}`);
          }
        } catch (err) {
          failed++;
          console.error(`Error: ${fullPath}: ${err.message}`);
        }
      }
    } else if (entry.isDirectory()) {
      fixDir(fullPath);
    }
  }
}

console.log('Scanning node_modules for broken symlinks...');
fixDir(NM);
console.log(`\nTotal: ${total}, Working: ${working}, Fixed: ${fixed}, Failed: ${failed}`);
