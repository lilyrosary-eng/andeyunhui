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
  /** 是否抑制外部浏览器（默认开启：启动时注入 BROWSER 禁用，只在本软件内预览） */
  suppressBrowser?: boolean;
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

/** 校验预设是否可启动：command 必须给 args；预览地址若填了须看起来像有效 URL */
export function validatePreset(p: Partial<WebPreset>): string | null {
  if (!p.name || !p.name.trim()) return '请填写预设名称';
  if ((p.kind ?? 'command') === 'command' && (!p.args || !p.args.trim())) return '请填写要运行的命令或脚本';
  const url = (p.url ?? '').trim();
  if (url) {
    // 模糊校验：缺少协议且不像 `host:port` 的字符串，多半是手误，尽早提示
    const looksOk = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) || /^\S+:\d{2,5}$/.test(url);
    if (!looksOk) return '预览地址需带协议（如 http://127.0.0.1:8000）或形如 host:端口';
  }
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

// ============================================================
// 软件识别：选文件夹 → 判定「这是什么软件」+ 找出真实入口脚本
//
// 关键改进（解决"只管选择不管识别"的问题）：
//  1. 不再递归扫描目录里全部可运行文件（那会扫出 python_embeded /
//     venv / Lib 里几百个无用脚本）。改为「按软件指纹识别 + 浅层找入口」。
//  2. 预设名用「软件名」（kohya_ss / ComfyUI…）而非入口脚本名（run/gui）。
//  3. 读取入口脚本内容，提取真实启动命令与端口，尽量省去手填。
// 环境/依赖目录一律跳过，避免把 Python 运行时当入口。
// ============================================================

/** 需跳过的环境/依赖目录名（扫描时不进去递归，也不当作入口候选） */
const SKIP_DIR_RE = /^(python.*|python_embeded|python-?3\d*|venv|\.venv|env|envs?|site-packages|node_modules|[Ll]ib|[Dd]ll.*|\.git|__pycache__|\.cache|build|dist|assets|resources|models?|logs|docs|tests?|\.github)$/;

/** 入口脚本扩展名 → 建议运行方式（bat/sh 留空=直接在终端执行原文件） */
const ENTRY_EXTS: Record<string, string> = {
  '.bat': '',
  '.cmd': '',
  '.exe': '',
  '.ps1': 'powershell -ExecutionPolicy Bypass -File',
  '.sh': 'bash',
  '.py': 'python',
};

/** 启动候选（扫描识别结果） */
export interface LaunchCandidate {
  path: string;      // 入口脚本绝对路径
  name: string;      // 文件名
  ext: string;
  kind: 'bat' | 'cmd' | 'exe' | 'ps1' | 'sh' | 'py';
  cmd: string;       // 建议运行命令
  appHint?: string;  // 识别到的软件名
}

/** 识别结果：预设在用的字段 */
export interface AppRecognition {
  appName: string;   // 预设 name，如 "kohya_ss" / "ComfyUI（秋叶整合包）"
  stdin: string;     // 预设 args（建议命令，多行=依次执行）
  cwd: string;       // 预设 cwd（软件根）
  url: string;       // 推断的预览地址
}

/** 按目录名/根目录关键文件识别「知名软件指纹」；命中返回软件名+建议入口文件名，否则 null */
function matchKnownApp(
  baseNameLower: string,
  files: Set<string>,
  dirs: Set<string>
): { appName: string; entry?: string; suffix?: string } | null {
  const has = (names: string[]) => names.some((n) => files.has(n));
  // kohya_ss：入口 gui.bat / kohya_gui.py，目录往往叫 kohya_ss / kohya-ss
  if (/kohya/.test(baseNameLower) || has(['gui.bat', 'kohya_gui.py', 'gui.ps1'])) {
    return { appName: 'kohya_ss', entry: has(['gui.bat']) ? 'gui.bat' : 'kohya_gui.py' };
  }
  // ComfyUI 桌面版：根目录就是 ComfyUI.exe
  if (has(['ComfyUI.exe', 'ComfyUI.exe.png'])) {
    return { appName: 'ComfyUI', entry: 'ComfyUI.exe' };
  }
  // 秋叶整合包 / ComfyUI 源码：ComfyUI\main.py + python 环境 + run.bat
  if (/comfy/i.test(baseNameLower) || has(['run.bat', 'main.exp']) || dirs.has('ComfyUI')) {
    const hasPython = dirs.has('python') || dirs.has('python_embeded') || dirs.has('venv');
    return {
      appName: hasPython ? 'ComfyUI（整合包）' : 'ComfyUI',
      entry: has(['run.bat']) ? 'run.bat' : 'ComfyUI\\main.py',
    };
  }
  return null;
}

/** 从脚本文本里粗取「端口」（依次匹配 --port/--listen/--server_port/gradio/app 端口约定） */
function extractPort(text: string): string | null {
  const m = text.match(/(?:--port|--listen|--server_port)\s+(\d{2,5})/i);
  if (m) return m[1];
  if (/gradio|server\.launch/i.test(text)) return '7860';
  return null;
}

/**
 * 扫描文件夹并识别软件入口。
 * list: list_directory 封装；readText: read_text_file 封装（返回文本）。
 * 只浅层（根 + 各子目录一层）找入口脚本，跳过环境目录。
 */
export async function scanAndRecognize(
  rootDir: string,
  list: (dir: string) => Promise<{ name: string; path: string; is_dir: boolean }[]>,
  readText: (p: string) => Promise<string>
): Promise<{ candidates: LaunchCandidate[]; appName: string; url: string }> {
  const infer = (s: string): string | null => {
    if (!s) return null;
    if (s.includes('kohya')) return 'kohya_ss';
    if (/comfy/i.test(s)) return 'ComfyUI';
    return null;
  };

  let rootEntries: { name: string; path: string; is_dir: boolean }[] = [];
  try { rootEntries = await list(rootDir); } catch { /* 忽略 */ }

  const files = new Set(rootEntries.filter((e) => !e.is_dir).map((e) => e.name));
  const dirs = new Set(rootEntries.filter((e) => e.is_dir).map((e) => e.name));
  const baseLower = baseName(rootDir).toLowerCase();
  const known = matchKnownApp(baseLower, files, dirs);

  // 收集候选入口：优先根一层，其次各子目录一层；全部跳过环境目录
  const candidates: LaunchCandidate[] = [];
  const candidateSet = new Set<string>();
  const pushEntry = (p: string, name: string, loc: number) => {
    if (candidateSet.has(p)) return;
    const ext = extOf(name);
    const runner = ENTRY_EXTS[ext];
    if (runner === undefined) return;
    // 跳过明显非入口：卸载/ninstall/updater/python.exe 等
    if (/uninstall|安装|卸载|setup-|-install|python(\.exe|w)?$/i.test(name)) return;
    candidateSet.add(p);
    candidates.push({
      path: p, name, ext,
      kind: (ext.slice(1) || 'bat') as LaunchCandidate['kind'],
      cmd: runner ? `${runner} ${shellQuote(p)}` : shellQuote(p),
      appHint: fileAppHint(known, name),
    });
    void loc;
  };

  // 浅层（深度<=2）遍历，避免深入 python 环境
  const collected: { name: string; path: string; is_dir: boolean; depth: number }[] = [];
  collected.push(...rootEntries.map((e) => ({ ...e, depth: 1 })));
  for (const e of rootEntries) {
    if (!e.is_dir) continue;
    if (SKIP_DIR_RE.test(e.name)) continue;
    let sub: { name: string; path: string; is_dir: boolean }[] = [];
    try { sub = await list(e.path); } catch { continue; }
    collected.push(...sub.map((x) => ({ ...x, depth: 2 })));
  }
  collected.sort((a, b) => a.depth - b.depth || (a.is_dir === b.is_dir ? 0 : a.is_dir ? 1 : -1));
  for (const c of collected) {
    if (!c.is_dir) pushEntry(c.path, c.name, c.depth);
  }

  // 已知软件时：把其入口脚提到最前，并读取其内容抽取端口/确认命令
  let appName = known ? known.appName : '';
  let url = '';
  if (known) {
    const entry = known.entry;
    if (entry) {
      // 优先找根目录下的同基础名入口
      const matched = candidates.find((c) => baseName(c.path).toLowerCase() === entry.toLowerCase()) || candidates.find((c) => baseName(c.path).toLowerCase().replace(/\.(bat|cmd|exe|ps1)$/, '') === entry.toLowerCase());
      if (matched) {
        // 只对文本类脚本读内容抽取端口/软件名；exe 是二进制，读它无意义
        const textExt = extOf(matched.name);
        if (textExt === '.bat' || textExt === '.cmd' || textExt === '.ps1' || textExt === '.sh' || textExt === '.py') {
          try {
            const text = await readText(matched.path);
            const hint = infer(text);
            if (hint) appName = hint === 'ComfyUI' ? (known.entry?.includes('main.py') ? 'ComfyUI（源码）' : 'ComfyUI') : hint;
            const port = extractPort(text.slice(0, 4000));
            if (port) url = `http://127.0.0.1:${port}`;
          } catch { /* 读不到就算了 */ }
        }
      }
    }
  }
  // 兜底端口：已知软件默认
  if (!url) {
    if (/comfy/i.test(appName)) url = 'http://127.0.0.1:8188';
    else if (/kohya/i.test(appName)) url = 'http://127.0.0.1:7860';
  }

  // 无任何入口时退化为：把根目录自身作为 cwd，空命令，让用户手填
  return { candidates, appName, url };
}

function fileAppHint(known: { appName: string; entry?: string } | null, name: string): string | undefined {
  if (!known) return undefined;
  // 入口文件在软件内：名用软件名（不带后缀涉及，由上层决定）；此处仅给辅助提示
  return known.appName;
}

/** 识别结果组装成预设字段 */
export function recognitionToPreset(
  rootDir: string,
  r: { candidates: LaunchCandidate[]; appName: string; url: string }
): { name: string; args: string; cwd: string; url: string } {
  if (r.appName) {
    const entry = r.candidates[0];
    const args = entry ? entry.cmd : '';
    return { name: r.appName, args, cwd: rootDir, url: r.url };
  }
  // 未识别软件：仍可立即用第一个候选
  if (r.candidates.length) {
    const e = r.candidates[0];
    return { name: baseName(e.path).replace(extOf(e.name), ''), args: e.cmd, cwd: rootDir, url: r.url };
  }
  return { name: baseName(rootDir.replace(/[\\/]+$/, '')), args: '', cwd: rootDir, url: r.url };
}