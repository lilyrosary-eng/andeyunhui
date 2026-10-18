// 跨平台「目录 → ZIP」打包助手（.mufurong / .mujin 共用）
//
// 为什么需要它：.mufurong / .mujin 本质是 ZIP 改后缀，由 Rust 端的 zip crate 解压。
// 原实现只在 Windows 用 PowerShell 的 [System.IO.Compression.ZipFile]::CreateFromDirectory()，
// 于是 Linux/macOS 构建这些文件时整条 DLC 打包链直接失败（无法出 deb/appimage）。
//
// 平台策略：
//   - Windows：沿用 PowerShell .NET 实现（与既有产物行为逐字一致，零回归）。
//   - 其它平台：用 Info-ZIP `zip` CLI；以 srcDir 为工作目录打包 '.'，语义等价于
//     CreateFromDirectory（条目位于归档根部，而非嵌套一层目录名）。
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 判断相对路径 relPath 是否命中任一 glob 模式。
 * 匹配基准同时取「 basename 」与「完整相对路径」，这样 `*.dll` 命中任意层级的 DLL，
 * 而 `茑萝/ide/codemirror` 这类带斜杠的模式只按路径精确命中。
 * @param {string} relPath 以 `/` 或 `\` 分隔的相对路径
 * @param {string[]} patterns glob 模式（仅支持 `*` 通配）
 * @returns {boolean}
 */
function matchesAny(relPath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const norm = relPath.replace(/\\/g, '/');
  const base = norm.split('/').pop();
  for (const p of patterns) {
    const re = new RegExp(
      '^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    );
    if (re.test(base) || re.test(norm)) return true;
  }
  return false;
}

/**
 * 把目录 srcDir 打包成 ZIP 文件 destFile。
 * @param {string} srcDir  源目录（其**内容**进入归档根部）
 * @param {string} destFile 目标 .mufurong/.mujin 路径
 * @param {{store?: boolean, exclude?: string[]}} [opts]
 *   store=true 时用「不压缩」存储（对应 NSIS 让压缩、见 prepare-bundled-dlc）
 *   exclude=glob 模式数组，命中的文件不进归档（按 basename 或相对路径匹配）
 */
export function zipDir(srcDir, destFile, { store = false, exclude = [] } = {}) {
  mkdirSync(dirname(destFile), { recursive: true });
  if (existsSync(destFile)) rmSync(destFile);

  if (process.platform === 'win32') {
    if (exclude.length === 0) {
      // 无排除项：走 CreateFromDirectory，产物与历史逐字一致（含空目录条目）。
      const src = srcDir.replace(/'/g, "''");
      const dst = destFile.replace(/'/g, "''");
      const level = store ? 'NoCompression' : 'Optimal';
      const ps =
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `[System.IO.Compression.ZipFile]::CreateFromDirectory('${src}', '${dst}', ` +
        `[System.IO.Compression.CompressionLevel]::${level}, $false)`;
      const encoded = Buffer.from(ps, 'utf16le').toString('base64');
      execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { stdio: 'pipe' });
      return;
    }

    // 有排除项：CreateFromDirectory 不支持过滤（这正是「Windows 安装包打进 76MB
    // Linux ffmpeg」的根因——exclude 参数在 Windows 分支被静默丢弃）。
    // 做法：先物化一份过滤后的临时副本（保留目录结构与空目录），再对副本
    // CreateFromDirectory。代价是一次磁盘拷贝，换来与历史产物逐字一致的打包语义。
    const staging = join(tmpdir(), `andeyunhui-zipstage-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(staging, { recursive: true });
      // cpSync 的 filter 拿到的 path 是绝对路径，转成相对 srcDir 再匹配
      cpSync(srcDir, staging, {
        recursive: true,
        filter: (from) => {
          const rel = relative(srcDir, from);
          if (rel === '' || rel.startsWith('..')) return true; // 根自身
          // 目录一律保留（维持目录结构与空目录条目），只按模式过滤文件
          let isDir = false;
          try {
            isDir = statSync(from).isDirectory();
          } catch {
            return true; // 竞态/幽灵条目：宁可多带一个文件，不要漏掉目录
          }
          if (isDir) return true;
          return !matchesAny(rel, exclude);
        },
      });
      const src = staging.replace(/'/g, "''");
      const dst = destFile.replace(/'/g, "''");
      const level = store ? 'NoCompression' : 'Optimal';
      const ps =
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `[System.IO.Compression.ZipFile]::CreateFromDirectory('${src}', '${dst}', ` +
        `[System.IO.Compression.CompressionLevel]::${level}, $false)`;
      const encoded = Buffer.from(ps, 'utf16le').toString('base64');
      execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { stdio: 'pipe' });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return;
  }

  // 非 Windows：Info-ZIP
  try {
    execSync('zip --version', { stdio: 'ignore' });
  } catch {
    throw new Error('未找到 `zip` 命令；请先安装（Debian/Ubuntu: sudo apt install zip）');
  }
  const levelArg = store ? '-0' : '-6';
  // 平台排除（如 Linux 包不应含 Windows 的 *.exe/*.dll）
  const exArgs = exclude.map((p) => `-x '${p}'`).join(' ');
  // -X 去掉额外属性（uid/gid 等），保证跨机产物稳定
  execSync(`zip -r -q -X ${levelArg} "${destFile}" . ${exArgs}`, { cwd: srcDir, stdio: 'pipe' });
}
