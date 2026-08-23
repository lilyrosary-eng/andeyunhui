/// <reference path="../../global.d.ts" />
// ============================================================
// Web 接口模块 · 预设数据模型 + 本地持久化（localStorage）
//
// MVP 只做 `command` 类型：预设即一条「脚本/命令」，点击启动后
// 在终端里运行它，服务进程常驻终端，用户可交互、看日志；
// 服务端口就绪后在模块内 iframe 预览。
// `http-mock` / `proxy` 留作后续分期（本期不在 UI 暴露）。
// ============================================================

export type WebPresetKind = 'command' | 'http-mock' | 'proxy';

export interface WebPreset {
  id: string;
  name: string;            // 展示名，如 "静态文件服务"
  desc?: string;           // 备注
  kind: WebPresetKind;
  /** command 用：命令/脚本，如 `python -m http.server 8000` */
  args: string;
  /** 工作目录（可选） */
  cwd?: string;
  /** 预览地址（起点就绪后 iframe 加载它），如 http://127.0.0.1:8000 */
  url: string;
  createdAt: number;
}

export type WebRunStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export interface WebRun {
  presetId: string;
  ptyId: string;
  status: WebRunStatus;
  error?: string;
  startedAt: number;
}

const STORAGE_KEY = 'web_interface_presets';

/** 读取全部预设（JSON 容错） */
export function loadPresets(): WebPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 持久化全部预设 */
export function savePresets(presets: WebPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    /* 忽略存储异常 */
  }
}

/** 生成唯一 id */
export function newPresetId(): string {
  return 'wp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** 校验预设是否可启动：command 必须给 args */
export function validatePreset(p: Partial<WebPreset>): string | null {
  if (!p.name || !p.name.trim()) return '请填写预设名称';
  if ((p.kind ?? 'command') === 'command' && (!p.args || !p.args.trim())) return '请填写要运行的命令或脚本';
  return null;
}

// ============================================================
// 文件/文件夹 → 预设 自动识别
//
// 「新建/编辑预设」时，允许从本地选一个可执行/脚本文件，或选一个文件夹后
// 检索其下的脚本/可执行文件集。系统按扩展名推断出「运行命令」，自动填入
// name + args + cwd，省去手写命令。
// 说明：这里的推断只是「帮用户填表单」，最终命令仍可手动修改；PTY 里执行
// 脚本时由系统 shell 兜底（如 .bat/.cmd 由 cmd 运行、.py 由 python 运行）。
// ============================================================

/** 支持被自动识别为可运行/脚本的扩展名（小写） */
export const RUNNABLE_EXTS: Record<string, string> = {
  // 直接可执行 / 批处理
  '.exe': '',
  '.bat': '',
  '.cmd': '',
  '.com': '',
  '.msi': '',
  // 脚本系
  '.py': 'python',
  '.pyw': 'pythonw',
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.ts': 'node',
  '.sh': 'bash',
  '.ps1': 'powershell -ExecutionPolicy Bypass -File',
  '.php': 'php',
  '.rb': 'ruby',
  '.pl': 'perl',
  '.lua': 'lua',
  '.jar': 'java -jar',
  '.go': 'go run',
};

/** 判断某扩展名是否可被自动识别 */
export function isRunnableExt(ext: string): boolean {
  return ext in RUNNABLE_EXTS;
}

/** 取路径基名（兼容 Windows 分隔符） */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 取路径所在目录，去掉尾部分隔符；已是根则原样返回 */
export function dirName(p: string): string {
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.join('/') || p;
}

/** 取路径的扩展名（小写，含点），无扩展名返回 '' */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

/** 若路径含空格，用双引号包起来（IDE 里 cmd 直接执行路径时防空格断裂） */
function shellQuote(p: string): string {
  return /[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

/**
 * 依据文件路径推断「运行命令」（args 字段内容）。
 * 返回 null 表示无法识别（交给用户手填）；其余返回可执行命令串。
 */
export function inferRunCommand(filePath: string): string | null {
  const ext = extOf(baseName(filePath));
  const runner = RUNNABLE_EXTS[ext];
  if (runner === undefined) return null;
  const q = shellQuote(filePath);
  return runner ? `${runner} ${q}` : q;
}

/**
 * 依据文件路径推断预设基础信息（不含 id/createdAt，需调用方补全）：
 *  - name: 文件名去扩展名
 *  - args: 推断的运行命令（无法识别则留空，让用户手填）
 *  - cwd:  文件所在目录（去尾部斜杠）
 * 返回 null 表示文件无法被识别为可运行内容。
 */
export function suggestFromFile(filePath: string): Pick<WebPreset, 'name' | 'args' | 'cwd'> | null {
  const ext = extOf(baseName(filePath));
  if (!isRunnableExt(ext)) return null;
  const name = baseName(filePath).replace(new RegExp(ext + '$'), '');
  const args = inferRunCommand(filePath) ?? '';
  return { name, args, cwd: dirName(filePath) };
}

/**
 * 扫描一个文件夹（list_directory 需逐层递归），收集其中可识别为「可运行/脚本」的
 * 文件项。返回 { 可运行文件, 提示信息 } 供前端展示候选。
 * - 限制：最多 MAX_FILES 个文件、MAX_DEPTH 层，避免卡死大目录。
 */
export async function scanRunnableFiles(
  rootDir: string,
  list: (dir: string) => Promise<{ name: string; path: string; is_dir: boolean }[]>,
  opts: { maxFiles?: number; maxDepth?: number } = {}
): Promise<{ files: { name: string; path: string; ext: string }[]; hitDepth?: number }> {
  const { maxFiles = 200, maxDepth = 4 } = opts;
  const files: { name: string; path: string; ext: string }[] = [];
  const seen = new Set<string>();

  const walk = async (dir: string, depth: number) => {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let entries: { name: string; path: string; is_dir: boolean }[];
    try {
      entries = await list(dir);
    } catch {
      return;
    }
    // 目录在前、文件在后（与 Rust list_directory 排序一致），先深入目录再收集文件，
    // 保证可运行文件按目录树顺序稳定出现。
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (e.is_dir) {
        if (depth < maxDepth && !seen.has(e.path)) {
          seen.add(e.path);
          await walk(e.path, depth + 1);
        }
      } else {
        const ext = extOf(e.name);
        if (isRunnableExt(ext)) {
          files.push({ name: e.name, path: e.path, ext });
        }
      }
    }
  };

  await walk(rootDir, 1);
  return { files };
}

/** 一批内置预设模板，供「新建」时快速选择 */
export function builtinTemplates(): WebPreset[] {
  const now = Date.now();
  return [
    {
      id: newPresetId(),
      name: '静态文件服务',
      desc: 'python 自带的 http.server，托管当前目录',
      kind: 'command',
      args: 'python -m http.server 8000',
      url: 'http://127.0.0.1:8000',
      createdAt: now,
    },
    {
      id: newPresetId(),
      name: 'Vite Dev Server',
      desc: '在当前项目里启动前端开发服务（需 cwd 指向项目）',
      kind: 'command',
      args: 'npm run dev',
      url: 'http://localhost:5173',
      createdAt: now,
    },
  ];
}