/// <reference path="../../global.d.ts" />
// ============================================================
// Web 接口模块（第四个模块 · MVP）
//
// 心智模型（尽量简单）：
//   很多本地 web 服务就是跑一条脚本/命令。这里让用户把「命令」存成预设，
//   点一键启动 → 在一个真实终端里跑它（服务进程常驻终端，可看日志、可交互）；
//   服务端口起来后，模块内 iframe 直接预览它的页面。
//
// 布局：左侧（复用宿主 ModuleSidebarShell 统一侧边栏 + 右键菜单）
//        + 右侧详情（状态卡片 / 编辑表单 / 启动后：预览 + 终端）
// 复用：pty_create/write/resize/kill（白名单已放行）+ xterm.js
//
// 2026-08-23 增强：
//   - 侧边栏复用宿主 ModuleSidebarShell（已有集成于 WebSidebarShell.tsx），
//     不再手搓 <aside>，并获得主色高亮与右键「启动/编辑/删除」。
//   - 预览自动轮询：服务未就绪前每 3.5s 自动重建 iframe，一次性成功后停；
//     显示重连次数，并提供「停止/继续自动刷新」开关，不再需要手动刷新多次。
// 抑制外部浏览器：启动时向子进程注入 BROWSER=空操作，脚本用 Python
//     webbrowser 打开时不再弹 Edge，只在模块内 iframe 预览。
// ============================================================
const React = window.__HOST_REACT__;
const { useState, useEffect, useRef, useCallback, useMemo } = React;
const hostApi = window.__HOST_API__;
import { WebTerminal } from './Terminal';
import { WebSidebarShell, GlobeIcon, type WebSidebarItem } from './WebSidebarShell';
import {
  loadPresets, savePresets, newPresetId, validatePreset,
  suggestFromFile, scanAndRecognize, recognitionToPreset, baseName, dirName, extOf, RUNNABLE_EXTS,
  type WebPreset, type WebRun, type WebRunStatus,
} from './presets';

// ---------- 模块设置（持久化到 localStorage）----------
const SETTINGS_KEY = 'web_interface.settings';
const DEFAULT_SETTINGS: { suppressBrowser: boolean } = { suppressBrowser: true };

function loadSettings(): { suppressBrowser: boolean } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<{ suppressBrowser: boolean }>;
    return { suppressBrowser: parsed.suppressBrowser !== false };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ---------- 抑制外部浏览器 ----------
// gradio/kohya/ComfyUI 启动时若是 webbrowser.open 打开页面，Python 读到 BROWSER 后
// 会执行该「空操作」命令（不带 %s 时会被回退到系统默认，故这里必须带 %s 作为命令模板），
// 从而不弹系统默认浏览器（Edge），只看模块内 iframe 预览。
const SUPPRESS_BROWSER_ENV: Record<string, string> = { BROWSER: 'cmd.exe /c exit %s' };

// ---------- 小组件 ----------
// 简洁开关（宿主未导出 Switch，用最小实现）
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return React.createElement('button', {
    type: 'button', role: 'switch', 'aria-checked': on,
    onClick: () => onChange(!on),
    className: `relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? 'bg-sky-500' : 'bg-neutral-300 dark:bg-stone-600'}`,
    children: React.createElement('span', {
      className: `inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[21px]' : 'translate-x-[3px]'}`,
    }),
  });
}

// ---------- 终止确认弹窗 ----------
// 用户点「终止」时先弹窗提示保存，确认后再激进地、干净利落地释放内存/CPU（后端做进程树强杀）。
function ConfirmStopModal({ name, onConfirm, onCancel }: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return React.createElement('div', {
    className: 'fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm',
    onClick: onCancel, // 点遮罩 = 取消
  },
    React.createElement('div', {
      className: 'w-[min(92vw,380px)] rounded-2xl border border-black/10 dark:border-white/10 bg-white dark:bg-[#1e1e1e] p-5 shadow-2xl',
      onClick: (e: any) => e.stopPropagation(),
    },
      React.createElement('div', { className: 'text-base font-semibold text-neutral-800 dark:text-stone-100 mb-2' }, '终止服务'),
      React.createElement('p', { className: 'text-sm text-neutral-500 dark:text-stone-400 mb-5 leading-relaxed' },
        React.createElement(React.Fragment, null,
          '「', name, '」正在运行。终止会立即强制结束相关进程，请先确认已保存好该服务相关的数据、文档或未完成操作。',
          React.createElement('span', { className: 'mt-1 block font-medium text-red-500' }, '终止后将不可恢复。'),
        ),
      ),
      React.createElement('div', { className: 'flex justify-end gap-2' },
        React.createElement('button', {
          onClick: onCancel,
          className: 'btn-press rounded-lg px-4 py-2 text-sm text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10',
        }, '取消'),
        React.createElement('button', {
          onClick: onConfirm,
          className: 'btn-press rounded-lg px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600',
        }, '确认终止'),
      ),
    ),
  );
}

// ---------- 模块设置内容（复用宿主 ModuleSettingsPanel）----------
function SettingsContent({
  presets, selectedId, runningId, suppressBrowser, onChangeSuppress, onAddPreset, onSelectPreset, onEditPreset, onDeletePreset, onClose,
}: {
  presets: WebPreset[];
  selectedId: string | null;
  runningId: string | null;
  suppressBrowser: boolean;
  onChangeSuppress: (v: boolean) => void;
  onAddPreset: () => void;
  onSelectPreset: (id: string) => void;
  onEditPreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
  onClose: () => void;
}) {
  const ModuleSettingsPanel = (window.__HOST_UI__ as Record<string, unknown>)?.ModuleSettingsPanel as
    | React.FC<{ title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode }>
    | undefined;
  if (!ModuleSettingsPanel) return null;
  return React.createElement(ModuleSettingsPanel, {
    title: 'Web 接口',
    icon: React.createElement(GlobeIcon),
    onClose,
    children: React.createElement('div', { className: 'space-y-4' },
      // 预设管理
      React.createElement('div', { className: 'glass-panel p-4' },
        React.createElement('label', { className: 'block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2' }, '预设'),
        React.createElement('button', {
          onClick: onAddPreset,
          className: 'btn-press w-full flex items-center justify-center gap-1.5 element-muted hover:element-hover rounded-xl py-2 text-sm font-medium transition-colors mb-2',
        },
          React.createElement('svg', { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }, React.createElement('line', { key: 'a', x1: '12', y1: '5', x2: '12', y2: '19' }), React.createElement('line', { key: 'b', x1: '5', y1: '12', x2: '19', y2: '12' })),
          '新建预设',
        ),
        presets.length === 0
          ? React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500' }, '还没有预设，点击「新建预设」创建。')
          : React.createElement('div', { className: 'max-h-48 overflow-y-auto divide-y divide-black/5 dark:divide-white/5' },
              presets.map((p) => {
                const isSel = selectedId === p.id;
                const isRunning = runningId === p.id;
                return React.createElement('div', {
                  key: p.id,
                  className: `flex items-center gap-1 rounded-lg transition-colors ${isSel ? 'text-[var(--element-color-raw)]' : ''}`,
                }, [
                  React.createElement('button', {
                    key: 'name',
                    onClick: () => onSelectPreset(p.id),
                    title: '选择此预设',
                    className: `flex-1 min-w-0 flex items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
                      isSel
                        ? 'bg-[var(--element-muted)] text-[var(--element-color-raw)]'
                        : 'hover:bg-black/5 dark:hover:bg-white/5'
                    }`,
                  }, React.createElement('span', { className: 'text-sm text-neutral-700 dark:text-stone-200 truncate' }, p.name)),
                  React.createElement('button', {
                    key: 'edit',
                    onClick: () => onEditPreset(p.id),
                    title: '编辑此预设',
                    className: 'shrink-0 p-1.5 rounded-md text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] hover:bg-[var(--element-muted)]',
                  }, React.createElement('svg', { width: '13', height: '13', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
                    React.createElement('path', { key: 'e1', d: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' }),
                    React.createElement('path', { key: 'e2', d: 'm15 5 4 4' }),
                  )),
                  React.createElement('button', {
                    key: 'delete',
                    onClick: () => onDeletePreset(p.id),
                    disabled: isRunning,
                    title: isRunning ? '运行中，请先终止后再删除' : '删除此预设',
                    className: `shrink-0 p-1.5 rounded-md transition-colors ${
                      isRunning
                        ? 'text-neutral-300 dark:text-stone-600 cursor-not-allowed'
                        : 'text-neutral-400 dark:text-stone-500 hover:text-red-500 hover:bg-red-500/10'
                    }`,
                  }, React.createElement('svg', { width: '13', height: '13', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
                    React.createElement('path', { key: 'd1', d: 'M3 6h18' }),
                    React.createElement('path', { key: 'd2', d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }),
                    React.createElement('path', { key: 'd3', d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
                  )),
                ]);
              }),
            ),
      ),
      // 运行
      React.createElement('div', { className: 'glass-panel p-4' },
        React.createElement('label', { className: 'block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2' }, '运行'),
        React.createElement('label', { className: 'flex items-center justify-between gap-3 cursor-pointer select-none py-1' },
          React.createElement('span', { className: 'flex-1 text-sm text-neutral-600 dark:text-stone-300' },
            '抑制外部浏览器',
            React.createElement('span', { className: 'block text-xs text-neutral-400 dark:text-stone-500' }, '启动服务时不让脚本弹系统默认浏览器（Edge），只在模块内预览'),
          ),
          React.createElement(Toggle, { on: suppressBrowser, onChange: onChangeSuppress }),
        ),
      ),
      // 说明
      React.createElement('div', { className: 'glass-panel p-4' },
        React.createElement('label', { className: 'block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2' }, '说明'),
        React.createElement('p', { className: 'text-sm text-neutral-600 dark:text-stone-300' }, '新建预设时可选择本地文件/文件夹，自动识别入口脚本、运行命令与预览地址；服务进程常驻终端，端口就绪后会在模块内自动加载预览。'),
      ),
    ),
  });
}

// 启动后的运行区：预览(iframe 自动轮询) + 终端(可折叠)
function RunPane({
  preset, suppressBrowser, openTerminal, refreshSignal, onReady, onStopped,
}: {
  preset: WebPreset;
  suppressBrowser: boolean;
  openTerminal: boolean;
  refreshSignal: number;
  onReady: () => void;
  onStopped: () => void;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [probeReady, setProbeReady] = useState(false);
  const [autoReload, setAutoReload] = useState(true);
  const [reloadCount, setReloadCount] = useState(0);
  const readyFired = useRef(false);
  const loadedOnce = useRef(false);

  const markReady = useCallback(() => {
    if (!readyFired.current) {
      readyFired.current = true;
      onReady();
    }
  }, [onReady]);

  // iframe 成功加载服务页 → 标记就绪、关掉等待态（自动轮询随之停）
  const handleIframeLoad = useCallback(() => {
    loadedOnce.current = true;
    setProbeReady(true);
    markReady();
  }, [markReady]);

  const hasUrl = !!preset.url?.trim();

  // 预览「自动轮询」：服务未就绪时每 3.5s 重建 iframe 触发重新加载；
  // 一旦 iframe onLoad（服务真正就绪）则 loadedOnce 置位，轮询自动停止。
  // 用户可点「停止自动刷新」手动接管（此时可用右侧刷新按钮/重挂 iframe）。
  useEffect(() => {
    if (!hasUrl) return;
    loadedOnce.current = false;
    readyFired.current = false;
    setProbeReady(false);
    setReloadCount(0);
    if (!autoReload) return;
    const timer = window.setInterval(() => {
      // 已成功加载，或用户停止了自动刷新 → 本轮不动作
      if (loadedOnce.current || !autoReload) return;
      setReloadKey((k) => k + 1);
      setReloadCount((n) => n + 1);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [hasUrl, preset.url, autoReload]);

  // 手动刷新（停止自动刷新后仍可用）
  const manualReload = useCallback(() => {
    loadedOnce.current = false;
    setProbeReady(false);
    setReloadKey((k) => k + 1);
  }, []);

  // 侧边栏「刷新」按钮触发：每次信号自增即重挂预览
  useEffect(() => {
    if (refreshSignal <= 0) return; // 初始 0 不触发
    manualReload();
  }, [refreshSignal, manualReload]);

  // 注入抑制外部浏览器环境变量（仅在模块设置开启该选项时）
  const termEnv = useMemo(
    () => (suppressBrowser ? SUPPRESS_BROWSER_ENV : undefined),
    [suppressBrowser]
  );

  // ---------- 终端管理：主终端跑服务，可增开新终端；全部随任务（RunPane 卸载）关闭 ----------
  const termCounterRef = useRef(1);
  const [terminals, setTerminals] = useState<{ id: string; label?: string; command?: string; cwd?: string; env?: Record<string, string> }[]>(() => [
    { id: 'primary', label: '服务', command: preset.args, cwd: preset.cwd, env: termEnv },
  ]);
  const [activeTermId, setActiveTermId] = useState('primary');

  // 新建一个空白 shell 终端（可自由输入命令）
  const addTerminal = useCallback(() => {
    const label = String(termCounterRef.current++);
    const id = 'term_' + label;
    setTerminals((prev) => [...prev, { id, label, cwd: preset.cwd, env: termEnv }]);
    setActiveTermId(id);
  }, [preset.cwd, termEnv]);

  // 关闭某个终端（至少保留一个；关闭由 WebTerminal 卸载触发 pty_kill）
  const closeTerminal = useCallback((id: string) => {
    setTerminals((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) return prev;
      return next;
    });
    setActiveTermId((cur) => (cur === id ? 'primary' : cur));
  }, []);

  return (
      <div className="flex-1 min-h-0 flex flex-col">
        {/* 预览 iframe（服务内容区） */}
        <div className="flex-1 min-h-0 rounded-xl border border-black/10 dark:border-white/10 overflow-hidden bg-white dark:bg-stone-950 relative">
          {hasUrl ? (
            <div className="absolute inset-0">
              {!probeReady && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-white/75 dark:bg-stone-950/75 text-xs text-neutral-400 dark:text-stone-500">
                  <span className="inline-block h-4 w-4 rounded-full border-2 border-neutral-300 border-t-sky-500 animate-spin" />
                  <span>等待服务启动，就绪后自动加载预览（已重试 {reloadCount} 次）…</span>
                </div>
              )}
              <iframe
                key={reloadKey}
                src={preset.url}
                onLoad={handleIframeLoad}
                className="h-full w-full border-0"
                title={preset.name}
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
              />
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-400 dark:text-stone-500">
              该预设未配置预览地址，请看下方终端日志
            </div>
          )}
        </div>

        {/* 终端（服务进程常驻于此；用 CSS 隐藏而非卸载，保证收起/展开是同一终端）
            收起时仅仅 display:none，PTY 不杀、历史保留 */}
        <div className={`mt-2 shrink-0 rounded-xl border border-black/10 dark:border-white/10 overflow-hidden ${openTerminal ? 'block' : 'hidden'}`}>
          {/* 终端管理栏：标签页 + 新建终端 */}
          <div className="flex items-center gap-0.5 border-b border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 px-1 pr-1">
            {terminals.map((t) => {
              const active = t.id === activeTermId;
              return (
                <div
                  key={t.id}
                  onClick={() => setActiveTermId(t.id)}
                  title={t.id === 'primary' ? '服务终端（运行预设命令，不可关闭）' : '终端 ' + t.label}
                  className={`group flex items-center gap-1 rounded-t-lg px-2 py-1.5 text-xs cursor-pointer select-none transition-colors ${
                    active
                      ? 'bg-white dark:bg-[#1e1e1e] text-neutral-800 dark:text-stone-100 border-t border-x border-black/10 dark:border-white/10'
                      : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200'
                  }`}
                >
                  <span>{t.id === 'primary' ? '服务' : '终端 ' + t.label}</span>
                  {t.id !== 'primary' && (
                    <span
                      onClick={(e) => { e.stopPropagation(); closeTerminal(t.id); }}
                      title="关闭此终端"
                      className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-500 rounded px-0.5"
                    >×</span>
                  )}
                </div>
              );
            })}
            <button
              onClick={addTerminal}
              title="新建终端"
              className="px-1.5 py-1 text-neutral-400 hover:text-[var(--element-color-raw)] rounded transition-colors"
            >+</button>
          </div>
          {/* 终端面板：所有终端常驻，仅切换 display */}
          <div className="h-56">
            {terminals.map((t) => (
              <div key={t.id} className={`h-full ${t.id === activeTermId ? 'block' : 'hidden'}`}>
                <WebTerminal
                  command={t.command ?? ''}
                  cwd={t.cwd}
                  env={t.env}
                  hint={t.id === 'primary' ? preset.args : undefined}
                  onExit={t.id === 'primary' ? onStopped : undefined}
                />
              </div>
            ))}
          </div>
        </div>
    </div>
  );
}

// ---------- 编辑表单（新建 / 编辑）----------
function EditorForm({
  initial, onSave, onCancel,
}: {
  initial: WebPreset;
  onSave: (p: WebPreset) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [desc, setDesc] = useState(initial.desc ?? '');
  const [args, setArgs] = useState(initial.args);
  const [cwd, setCwd] = useState(initial.cwd ?? '');
  const [url, setUrl] = useState(initial.url);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanInfo, setScanInfo] = useState<{
    dir: string;
    appName: string;
    url: string;
    files: { name: string; path: string; ext: string; cmd: string }[];
    picked: Set<string>;
  } | null>(null);

  const save = () => {
    const msg = validatePreset({ name, args });
    if (msg) { setErr(msg); return; }
    setErr('');
    onSave({
      ...initial,
      name: name.trim(),
      desc: desc.trim(),
      args: args.trim(),
      cwd: cwd.trim() || undefined,
      url: url.trim(),
    });
  };

  // 打开文件对话框（限定可运行/脚本扩展名），选中后自动识别填入
  const pickFile = useCallback(async () => {
    setBusy(true); setErr('');
    try {
      const files = await hostApi.invoke<string[]>('pick_file', {
        filters: [{ name: '可执行/脚本', extensions: Object.keys(RUNNABLE_EXTS).map((e) => e.slice(1)) }],
      });
      const hit = files && files.length ? suggestFromFile(files[0]) : null;
      if (!hit) { setErr('未能识别该文件类型，请手动填写命令'); return; }
      setName(hit.name); setArgs(hit.args); setCwd(hit.cwd ?? '');
      // 若命令里有常见端口号，顺手填预览地址（取第一个 http://…:port）
      const m = hit.args.match(/:\s*(\d{2,5})/);
      if (m) setUrl('http://127.0.0.1:' + m[1]);
      // 进一步：用「文件所在目录」做一次软件识别，得到更智能的名称与预览地址
      // （比如选了 kohya_ss 下的 gui.bat，名称会识别成 kohya_ss 而不是 gui）
      try {
        const parent = dirName(files[0]);
        const rec = await scanAndRecognize(
          parent,
          (p) => hostApi.invoke<{ name: string; path: string; is_dir: boolean }[]>('list_directory', { path: p }),
          (p) => hostApi.invoke<string>('read_text_file', { path: p })
        );
        if (rec.appName) setName(rec.appName);
        if (rec.url) setUrl(rec.url);
      } catch { /* 识别失败就用上面的兜底结果 */ }
    } catch (e) {
      setErr('选择文件失败：' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  // 选择文件夹 → 智能识别「这是什么软件」+ 找出真实入口脚本，自动填入
  const pickFolder = useCallback(async () => {
    setBusy(true); setErr('');
    try {
      const dir = await hostApi.invoke<string | null>('pick_directory');
      if (!dir) return;
      const rec = await scanAndRecognize(
        dir,
        (p) => hostApi.invoke<{ name: string; path: string; is_dir: boolean }[]>('list_directory', { path: p }),
        (p) => hostApi.invoke<string>('read_text_file', { path: p })
      );
      let presetInfo: { name: string; args: string; cwd: string; url: string };
      if (rec.appName || rec.candidates.length) {
        presetInfo = recognitionToPreset(dir, rec);
      } else {
        presetInfo = { name: baseName(dir.replace(/[\\/]+$/, '')), args: '', cwd: dir, url: '' };
      }
      setName(presetInfo.name); setArgs(presetInfo.args); setCwd(presetInfo.cwd); setUrl(presetInfo.url);
      // 同时展示入口脚本候选，供手动勾选调整（默认勾选识别到的首个入口）
      const defaultPick = new Set(rec.candidates.length ? [rec.candidates[0].path] : []);
      setScanInfo({
        dir,
        appName: rec.appName,
        url: rec.url,
        files: rec.candidates.map((c) => ({ name: c.name, path: c.path, ext: c.ext, cmd: c.cmd })),
        picked: defaultPick,
      });
      setErr(
        rec.appName
          ? `已识别为 ${rec.appName}` + (rec.url ? `，预览 ${rec.url}` : '')
          : rec.candidates.length
            ? '未识别到知名软件，请勾选右侧已找到的入口脚本后点击「填写所选」'
            : '该目录下未发现入口脚本，已填入工作目录'
      );
    } catch (e) {
      setErr('检索文件夹失败：' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  // 应用文件夹中勾选的文件集：每个文件生成一行运行命令，cwd 用文件夹根
  const applyScanPicked = useCallback((info: { dir: string; appName: string; url: string; files: { name: string; path: string; ext: string; cmd: string }[]; picked: Set<string> }) => {
    const chosen = info.files.filter((f) => info.picked.has(f.path));
    if (chosen.length === 0) { setErr('请先勾选至少一个文件'); return; }
    const cmds = chosen.map((f) => f.cmd || f.path);
    if (chosen.length === 1) {
      const file = chosen[0];
      setName(info.appName || baseName(file.path).replace(extOf(file.name), ''));
      setArgs(cmds[0]);
    } else {
      // 多文件：以识别到的软件名（或文件夹名）做预设名，命令逐行列出
      setName(info.appName || baseName(info.dir.replace(/[\\/]+$/, '')));
      setArgs(cmds.join('\n'));
    }
    setCwd(info.dir);
    if (info.url) setUrl(info.url);
    setScanInfo(null);
    setErr('');
  }, []);

  const label = 'text-xs font-medium text-neutral-500 dark:text-stone-400 mb-1 block';
  const input = 'w-full rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-stone-900 px-3 py-2 text-sm outline-none focus:border-sky-500';
  const btnBase = 'btn-press inline-flex items-center gap-1 rounded-lg border border-black/10 dark:border-white/10 px-3 py-1.5 text-xs text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50';

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 rounded-2xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-stone-900 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div className="text-base font-semibold text-neutral-800 dark:text-stone-100">
          {initial.id ? '编辑预设' : '新建预设'}
        </div>
        {err && <div className="text-xs text-red-500">{err}</div>}
      </div>

      {/* 从本地导入：选文件 或 选文件夹检索文件集 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-neutral-400 dark:text-stone-500">从本地导入：</span>
        <button className={btnBase} onClick={pickFile} disabled={busy} title="选择一个 exe / bat / cmd / py 等文件，自动识别命令填入">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <polyline points="13 2 13 9 20 9" />
          </svg>
          选择文件
        </button>
        <button className={btnBase} onClick={pickFolder} disabled={busy} title="选择一个文件夹，检索其中可运行/脚本文件集">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          选择文件夹
        </button>
        {busy && <span className="text-xs text-neutral-400 dark:text-stone-500">读取中…</span>}
      </div>

      {scanInfo && (
        <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-neutral-600 dark:text-stone-300">
              {scanInfo.appName
                ? <>识别为 <code className="text-sky-600 dark:text-sky-400">{scanInfo.appName}</code>，找到 {scanInfo.files.length} 个入口脚本
                  {scanInfo.url ? <>，预览 <code className="text-sky-600 dark:text-sky-400">{scanInfo.url}</code></> : null}</>
                : <>在 <code className="text-sky-600 dark:text-sky-400">{scanInfo.dir}</code> 找到 {scanInfo.files.length} 个可运行/脚本文件，勾选后填写</>}
            </span>
            <button className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-200" onClick={() => setScanInfo(null)}>收起</button>
          </div>
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {scanInfo.files.map((f) => {
              const on = scanInfo.picked.has(f.path);
              return (
                <label key={f.path} className="flex items-center gap-2 rounded-md px-1.5 py-0.5 text-xs cursor-pointer hover:bg-black/5 dark:hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      const next = new Set(scanInfo.picked);
                      if (on) next.delete(f.path); else next.add(f.path);
                      setScanInfo({ ...scanInfo, picked: next });
                    }}
                  />
                  <span className="rounded bg-black/5 dark:bg-white/10 px-1 font-mono text-[10px]">{f.ext.slice(1)}</span>
                  <span className="flex-1 truncate text-neutral-700 dark:text-stone-200">{f.name}</span>
                </label>
              );
            })}
          </div>
          <div className="mt-2">
            <button
              className="btn-press rounded-lg bg-sky-500 px-3 py-1 text-xs font-medium text-white hover:bg-sky-600"
              onClick={() => applyScanPicked(scanInfo)}
            >
              填写所选 ({scanInfo.picked.size})
            </button>
          </div>
        </div>
      )}

      <div>
        <label className={label}>名称 *</label>
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：静态文件服务" />
      </div>
      <div>
        <label className={label}>备注（可选）</label>
        <input className={input} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="这个服务是做什么的" />
      </div>
      <div>
        <label className={label}>命令 / 脚本 *</label>
        <textarea className={input + ' font-mono min-h-[72px] resize-y'} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={'如：python -m http.server 8000'} />
        <div className="mt-1 text-xs text-neutral-400 dark:text-stone-500">服务进程会常驻在打开的终端里，回车后运行。多行 = 依次执行多条命令。</div>
      </div>
      <div>
        <label className={label}>工作目录（可选）</label>
        <input className={input} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="命令执行的目录，如 D:\\projects\\myapp" />
      </div>
      <div>
        <label className={label}>预览地址（起点就绪后 iframe 打开）</label>
        <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="如：http://127.0.0.1:8000" />
      </div>

      <div className="flex items-center gap-2 mt-1">
        <button onClick={save} className="btn-press rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600">
          保存
        </button>
        <button onClick={onCancel} className="btn-press rounded-lg px-4 py-2 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10">
          取消
        </button>
      </div>
    </div>
  );
}

// ---------- 主组件 ----------
declare const window: Window & { __PLUGIN_REGISTRY__?: { register: (p: Record<string, unknown>) => void } };

function WebInterfaceModule() {
  const [presets, setPresets] = useState<WebPreset[]>(loadPresets);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WebPreset | 'new' | null>(null);
  const [run, setRun] = useState<WebRun | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [showTerminal, setShowTerminal] = useState(true);
  const [refreshSignal, setRefreshSignal] = useState(0);
  // 终止确认弹窗：点「终止」先提示保存，确认后才真正停止并强杀进程树
  const [confirmStop, setConfirmStop] = useState(false);

  // 持久化预设
  useEffect(() => { savePresets(presets); }, [presets]);

  // 持久化模块设置
  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }, [settings]);

  const selected = useMemo(() => presets.find((p) => p.id === selectedId) ?? null, [presets, selectedId]);

  // 搜索过滤
  const q = searchQuery.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return presets;
    return presets.filter((p) => (p.name + ' ' + (p.desc ?? '') + ' ' + p.args).toLowerCase().includes(q));
  }, [presets, q]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setEditing(null);
  }, []);

  const addPreset = useCallback(() => {
    setSelectedId(null);
    setEditing('new');
    setShowSettings(false);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setEditing(null);
    setShowSettings((s) => !s);
  }, []);

  // 从设置面板选择一个预设（选中并关闭设置）
  const selectFromSettings = useCallback((id: string) => {
    setSelectedId(id);
    setEditing(null);
    setShowSettings(false);
  }, []);

  // 从设置面板编辑一个预设（进入编辑表单）
  const editFromSettings = useCallback((id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setSelectedId(id);
    setEditing(p);
    setShowSettings(false);
  }, [presets]);

  const startPreset = useCallback((preset: WebPreset) => {
    setSelectedId(preset.id);
    setEditing(null);
    // 同预设重复启动 → 先停掉旧的
    setRun({ presetId: preset.id, ptyId: '', status: 'starting', startedAt: Date.now() });
  }, []);

  // 侧边栏：按 id 启动
  const startById = useCallback((id: string) => {
    const p = presets.find((x) => x.id === id);
    if (p) startPreset(p);
  }, [presets, startPreset]);

  const editById = useCallback((id: string) => {
    const p = presets.find((x) => x.id === id);
    if (p) { setSelectedId(id); setEditing(p); }
  }, [presets]);

  const savePreset = useCallback((p: WebPreset) => {
    setPresets((prev) => {
      const i = prev.findIndex((x) => x.id === p.id);
      if (i >= 0) {
        const next = [...prev];
        next[i] = p;
        return next;
      }
      return [p, ...prev];
    });
    setSelectedId(p.id);
    setEditing(null);
  }, []);

  const deletePreset = useCallback((id: string) => {
    // 强锁：运行中的预设不允许删除（需先终止）
    if (run?.presetId === id) return;
    setPresets((prev) => prev.filter((p) => p.id !== id));
    if (selectedId === id) { setSelectedId(null); setEditing(null); }
  }, [run, selectedId]);

  // 从设置面板删除一个预设（需在 deletePreset 之后声明，避免依赖数组 TDZ）
  const deleteFromSettings = useCallback((id: string) => {
    deletePreset(id);
  }, [deletePreset]);

  const stop = useCallback(() => setRun(null), []);

  const markRunning = useCallback(() => {
    setRun((r) => (r ? { ...r, status: 'running' } : r));
  }, []);

  const markStopped = useCallback(() => {
    // 进程退出 → 回到空闲态，方便一键重建（终端已随 pty 退出）
    setRun(null);
  }, []);

  const isRunningThis = !!run && run.presetId === selected?.id;

  // 服务运行中 → 侧边栏预设列表临时隐藏（预留空间给后续把 web 服务功能映射到侧边栏），
  // 服务终止（run 为空）后自动恢复。列表始终在 presets 状态里，不删除任何数据。
  const serviceRunning = !!run;

  // 侧边栏顶部主按钮：一键启动 / 终止（未选预设时引导去设置新建/选择）
  const runningSelected = !!run && run.presetId === selected?.id;
  // 用户手动点「终止」：先弹确认（提示保存），确认后再真正停止并强杀进程树
  const requestStop = useCallback(() => {
    if (runningSelected) setConfirmStop(true);
  }, [runningSelected]);
  const handleStopConfirmed = useCallback(() => {
    setConfirmStop(false);
    stop(); // 触发 RunPane 卸载 → 终端 pty_kill → 后端进程树强杀，干净利落释放资源
  }, [stop]);
  const primaryAction = {
    label: runningSelected ? '终止' : selected ? '一键启动' : '选择预设',
    onClick: () => {
      if (runningSelected) { requestStop(); return; }
      if (selected) { startPreset(selected); return; }
      handleOpenSettings();
    },
  };

  // 侧边栏数据映射：运行中为空列表（临时隐藏全部预设），停止后恢复
  const sidebarItems: WebSidebarItem[] = useMemo(() => {
    if (serviceRunning) return [];
    return filtered.map((p) => ({
      id: p.id,
      name: p.name,
      desc: p.desc,
      hint: p.args,
      runStatus: run?.presetId === p.id ? run.status : undefined,
    }));
  }, [filtered, run, serviceRunning]);

  return (
    <>
    <div className="flex h-full w-full gap-3 overflow-hidden">
      {/* 左侧：统一侧边栏（复用宿主 ModuleSidebarShell + 右键菜单） */}
      <WebSidebarShell
        icon={<GlobeIcon />}
        title="Web 接口"
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="搜索预设"
        onOpenModuleSettings={handleOpenSettings}
        primaryAction={primaryAction}
        onToggleTerminal={() => setShowTerminal((s) => !s)}
        terminalActive={showTerminal}
        onRefresh={() => setRefreshSignal((s) => s + 1)}
        onStart={startById}
        onEdit={editById}
        onDelete={deletePreset}
        items={sidebarItems}
        selectedId={selectedId}
        onSelect={select}
        emptyText={serviceRunning
          ? '服务运行中，预设列表已暂时隐藏。终止服务后会自动恢复。'
          : (q ? '没有匹配的预设' : '还没有预设。点「新建」，选本地文件/文件夹自动识别后保存。')}
      />

      {/* 右侧：详情 / 编辑 / 运行区 / 设置面板 */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {showSettings ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <SettingsContent
              presets={presets}
              selectedId={selectedId}
              runningId={run?.presetId ?? null}
              suppressBrowser={settings.suppressBrowser}
              onChangeSuppress={(v) => setSettings((s) => ({ ...s, suppressBrowser: v }))}
              onAddPreset={() => { setShowSettings(false); addPreset(); }}
              onSelectPreset={selectFromSettings}
              onEditPreset={editFromSettings}
              onDeletePreset={deleteFromSettings}
              onClose={() => setShowSettings(false)}
            />
          </div>
        ) : editing === 'new' ? (
          <EditorForm
            initial={{ id: '', name: '', desc: '', kind: 'command', args: '', cwd: '', url: '', createdAt: Date.now() }}
            onSave={(p) => savePreset({ ...p, id: newPresetId(), createdAt: Date.now() })}
            onCancel={() => setEditing(null)}
          />
        ) : !selected ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-neutral-400 dark:text-stone-500">
            <GlobeIcon />
            <div className="text-sm">在左侧选择预设，或新建一个本地 Web 服务预设</div>
          </div>
        ) : editing ? (
          <EditorForm initial={selected} onSave={savePreset} onCancel={() => setEditing(null)} />
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* 运行区：preview + 终端 */}
            {isRunningThis && run ? (
              <RunPane preset={selected} suppressBrowser={settings.suppressBrowser}
                openTerminal={showTerminal}
                refreshSignal={refreshSignal}
                onReady={markRunning} onStopped={markStopped} />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-black/10 dark:border-white/10 text-neutral-400 dark:text-stone-500">
                <div className="text-sm">在左侧侧边栏点击「一键启动」，在终端里运行：</div>
                <code className="rounded-lg bg-black/5 dark:bg-white/5 px-3 py-1.5 font-mono text-xs">{selected.args}</code>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
      {confirmStop && selected && (
        <ConfirmStopModal
          name={selected.name}
          onConfirm={handleStopConfirmed}
          onCancel={() => setConfirmStop(false)}
        />
      )}
    </>
  );
}

WebInterfaceModule.displayName = 'WebInterfaceModule';

window.__PLUGIN_REGISTRY__?.register({
  id: 'web-interface',
  name: 'Web 接口',
  kind: 'module',
  visible: true,
  iconName: 'Globe',
  desc: '创建预设，一键启动本地 Web 服务，内嵌预览 + 终端',
  component: WebInterfaceModule,
});

export default WebInterfaceModule;