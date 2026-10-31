// 插件能力模型自检：
//   1) 每条插件 manifest 声明的命令都必须能命中 Rust 命令→能力规则（否则运行期会被拒）；
//   2) manifest 声明的能力必须是已知能力；
//   3) 插件源码里字面量 invoke('...') 的命令必须已在 manifest 声明（只告警，便于发现漏声明）。
//
// 规则唯一事实源：src-tauri/src/services/plugin_access.rs
// 用法：node scripts/check-plugin-capabilities.mjs [--strict]
//   --strict 时把“源码调用了但未声明”的告警也当作失败（CI 可用）。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const strict = process.argv.includes('--strict');

function block(src, name) {
  const start = src.indexOf(name);
  if (start < 0) throw new Error(`找不到规则块 ${name}`);
  const a = src.indexOf('[', start);
  const b = src.indexOf('];', a);
  return src.slice(a, b);
}

const rust = readFileSync(join(root, 'src-tauri/src/services/plugin_access.rs'), 'utf8');
const exact = [...block(rust, 'EXACT_RULES').matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)].map((m) => [m[1], m[2]]);
const prefix = [...block(rust, 'PREFIX_RULES').matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)].map((m) => [m[1], m[2]]);
const capsBlock = rust.slice(rust.indexOf('pub const CAPABILITIES'), rust.indexOf('];', rust.indexOf('pub const CAPABILITIES')));
const capabilities = new Set([...capsBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]));

function capabilityFor(cmd) {
  const e = exact.find(([c]) => c === cmd);
  if (e) return e[1];
  const p = prefix.find(([x]) => cmd.startsWith(x));
  return p ? p[1] : null;
}

const errors = [];
const warnings = [];

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'dist' || name === 'node_modules') continue;
      walk(p, fn);
    } else {
      fn(p);
    }
  }
}

function findPlugins(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (name === '_shared' || name === '_template') continue;
    if (existsSync(join(p, 'manifest.json'))) {
      out.push(p);
    } else {
      findPlugins(p, out);
    }
  }
}

const pluginDirs = [];
findPlugins(join(root, 'plugins'), pluginDirs);

for (const dir of pluginDirs) {
  const manifestPath = join(dir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    errors.push(`${manifestPath}: JSON 解析失败 (${err.message})`);
    continue;
  }
  const id = manifest.id || dir;
  const declared = new Set(manifest.permissions?.commands ?? []);
  const declaredCaps = manifest.permissions?.capabilities;
  if (Array.isArray(declaredCaps)) {
    for (const cap of declaredCaps) {
      if (!capabilities.has(cap)) errors.push(`${id}: manifest 声明了未知能力 "${cap}"`);
    }
  }
  for (const cmd of declared) {
    if (!capabilityFor(cmd)) errors.push(`${id}: 命令 "${cmd}" 没有能力归类（请在 plugin_access.rs 补规则）`);
  }

  const used = new Set();
  const srcDir = join(dir, 'src');
  if (existsSync(srcDir)) {
    walk(srcDir, (file) => {
      if (!/\.(tsx?|jsx?)$/.test(file)) return;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/invoke(?:<[^>]*>)?\(\s*['"]([a-zA-Z0-9_:|.-]+)['"]/g)) {
        used.add(m[1]);
      }
    });
  }
  for (const cmd of used) {
    if (!declared.has(cmd)) {
      warnings.push(`${id}: 源码调用了 "${cmd}"，但 manifest.permissions.commands 未声明`);
    }
  }
}

// 规则本身的一致性：每条规则指向的能力都必须存在
for (const [cmd, cap] of [...exact, ...prefix]) {
  if (!capabilities.has(cap)) errors.push(`规则 ${cmd} → 未知能力 "${cap}"`);
}

for (const w of warnings) console.warn(`[warn] ${w}`);
for (const e of errors) console.error(`[error] ${e}`);

console.log(
  `\n能力自检：${pluginDirs.length} 个插件，${exact.length} 条精确规则 + ${prefix.length} 条前缀规则，` +
    `${errors.length} 个错误 / ${warnings.length} 个告警`,
);

if (errors.length > 0 || (strict && warnings.length > 0)) {
  process.exit(1);
}
