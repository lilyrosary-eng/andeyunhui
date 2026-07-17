// ensure-placeholders.mjs - create the directory scaffold with .gitkeep
// so essential folders are never dropped by git (empty dirs untracked) or
// NSIS (empty dirs skipped). Called by build.bat / build_clean.bat before build.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// module folders mirrored from plugins/ + external-deps/ structure
const MODULES = [
  'image', 'music', 'note', 'professional', 'reading', 'video',
  'niaoluo', 'niaoluo/ide', 'niaoluo/wps', '全局',
];

function ensure(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const entries = readdirSync(dir);
  if (entries.length === 0) {
    writeFileSync(join(dir, '.gitkeep'), '');
    console.log('[Placeholders] + ' + dir);
  }
}

for (const m of MODULES) {
  ensure(join(rootDir, 'bundled-plugins', m));
  ensure(join(rootDir, 'external-deps', m));
}

// bundled-dlc scaffold (what the installer embeds)
ensure(join(rootDir, 'bundled-dlc', 'plugins'));
ensure(join(rootDir, 'bundled-dlc', 'external-deps'));

console.log('[Placeholders] scaffold ready');
