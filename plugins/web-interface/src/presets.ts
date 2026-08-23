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