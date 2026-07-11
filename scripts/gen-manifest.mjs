// 从 bundled-plugins 生成插件清单 manifest.json。
// 供路线 A（分发解耦）使用：安装包不再携带插件，在线下载时依此清单校验。
// 执行时机：deploy-plugins.mjs 将产物复制到 bundled-plugins 之后。

import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const BUNDLED = join(ROOT, "bundled-plugins");

function sha256(filePath) {
  const data = readFileSync(filePath);
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

function scanRecursive(dir, base) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...scanRecursive(full, base));
    } else {
      const rel = full.replace(base + "\\", "").replace(base + "/", "");
      files.push({ path: rel, size: statSync(full).size, hash: sha256(full) });
    }
  }
  return files;
}

// 递归查找所有含 manifest.json 的插件目录（支持嵌套如 niuluo/wps）
function findPlugins(dir, plugins) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (!e.isDirectory()) continue;
    const manifestPath = join(full, "manifest.json");
    try {
      const meta = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const files = scanRecursive(full, full);
      const totalSize = files.reduce((s, f) => s + f.size, 0);
      plugins.push({
        id: meta.id || e.name,
        name: meta.name || e.name,
        version: meta.version || "0.0.0",
        kind: meta.kind || "module",
        parent: meta.parent || null,
        deps: meta.deps || [],
        desc: meta.desc || "",
        iconName: meta.iconName || "",
        hostApiVersion: meta.hostApiVersion || 1,
        size: totalSize,
        files,
      });
    } catch {
      // 不是插件目录 → 递归深入（如 niuluo/）
      findPlugins(full, plugins);
    }
  }
}

function buildManifest() {
  const plugins = [];
  findPlugins(BUNDLED, plugins);

  const manifest = {
    version: 1,
    updated: new Date().toISOString(),
    plugins,
  };

  const outPath = join(BUNDLED, "manifest.json");
  writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`[gen-manifest] 已生成 ${outPath} (${plugins.length} 个插件)`);
}

buildManifest();
