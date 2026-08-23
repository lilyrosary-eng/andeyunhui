/// <reference path="../../global.d.ts" />
// ============================================================
// Web 接口模块（第四个模块 · MVP）
//
// 心智模型（尽量简单）：
//   很多本地 web 服务就是跑一条脚本/命令。这里让用户把「命令」存成预设，
//   点一键启动 → 在一个真实终端里跑它（服务进程常驻终端，可看日志、可交互）；
//   服务端口起来后，模块内 iframe 直接预览它的页面。
//
// 布局：左侧预设列表 + 右侧详情（状态卡片 / 编辑表单 / 启动后：预览 + 终端）
// 复用：pty_create/write/resize/kill（白名单已放行）+ xterm.js
// ============================================================
const React = window.__HOST_REACT__;
const { useState, useEffect, useRef, useCallback, useMemo } = React;
import { WebTerminal } from './Terminal';
import {
  loadPresets, savePresets, newPresetId, validatePreset, builtinTemplates,
  type WebPreset, type WebRun, type WebRunStatus,
} from './presets';

// ---------- 小组件 ----------
function StatusChip({ status }: { status: WebRunStatus }) {
  const map: Record<WebRunStatus, { label: string; cls: string; dot: string }> = {
    idle:     { label: '未启动', cls: 'text-neutral-400 dark:text-stone-500 border-black/10 dark:border-white/10', dot: 'bg-neutral-400 dark:bg-stone-500' },
    starting: { label: '启动中', cls: 'text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10', dot: 'bg-amber-500 animate-pulse' },
    running:  { label: '运行中', cls: 'text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10', dot: 'bg-emerald-500' },
    stopped:  { label: '已停止', cls: 'text-neutral-400 dark:text-stone-500 border-black/10 dark:border-white/10', dot: 'bg-neutral-400 dark:bg-stone-500' },
    error:    { label: '异常', cls: 'text-red-600 dark:text-red-400 border-red-500/30 bg-red-500/10', dot: 'bg-red-500' },
  };
  const m = map[status] || map.idle;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${m.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

// 启动后的运行区：预览(iframe) + 终端(可折叠)
function RunPane({
  preset, onReady, onStopped,
}: {
  preset: WebPreset;
  onReady: () => void;
  onStopped: () => void;
}) {
  const [showTerminal, setShowTerminal] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const readyFired = useRef(false);

  const markReady = useCallback(() => {
    if (!readyFired.current) {
      readyFired.current = true;
      onReady();
    }
  }, [onReady]);

  // 兜底：启动若干秒后即使 iframe 没触发 load 也按「运行中」处理
  useEffect(() => {
    const t = setTimeout(markReady, 8000);
    return () => clearTimeout(t);
  }, [markReady]);

  const hasUrl = !!preset.url?.trim();

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      {/* 预览工具栏 */}
      {hasUrl && (
        <div className="flex items-center gap-2 rounded-xl border border-black/10 dark:border-white/10 px-3 py-1.5 bg-white dark:bg-stone-900">
          <span className="text-xs text-neutral-400 dark:text-stone-500">预览</span>
          <code className="flex-1 truncate text-xs text-neutral-600 dark:text-stone-300">{preset.url}</code>
          <button
            className="btn-press flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => setReloadKey((k) => k + 1)}
            title="刷新预览"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
          </button>
          <button
            className="btn-press flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => setShowTerminal((s) => !s)}
            title={showTerminal ? '收起终端' : '展开终端'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span>{showTerminal ? '隐藏终端' : '显示终端'}</span>
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col">
        {/* 预览 iframe（服务内容区） */}
        <div className="flex-1 min-h-0 rounded-xl border border-black/10 dark:border-white/10 overflow-hidden bg-white dark:bg-stone-950 relative">
          {hasUrl ? (
            <iframe
              key={reloadKey}
              src={preset.url}
              onLoad={markReady}
              className="h-full w-full border-0"
              title={preset.name}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-400 dark:text-stone-500">
              该预设未配置预览地址，请看下方终端日志
            </div>
          )}
        </div>

        {/* 终端（服务进程常驻于此） */}
        {showTerminal && (
          <div className="mt-2 h-56 shrink-0 rounded-xl border border-black/10 dark:border-white/10 overflow-hidden">
            <div className="h-full">
              <WebTerminal
                command={preset.args}
                cwd={preset.cwd}
                hint={preset.args}
                onExit={onStopped}
              />
            </div>
          </div>
        )}
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

  const save = () => {
    const msg = validatePreset({ name, args });
    if (msg) { setErr(msg); return; }
    onSave({ ...initial, name: name.trim(), desc: desc.trim(), args: args.trim(), cwd: cwd.trim() || undefined, url: url.trim() });
  };

  const label = 'text-xs font-medium text-neutral-500 dark:text-stone-400 mb-1 block';
  const input = 'w-full rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-stone-900 px-3 py-2 text-sm outline-none focus:border-sky-500';

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 rounded-2xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-stone-900 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div className="text-base font-semibold text-neutral-800 dark:text-stone-100">
          {initial.id ? '编辑预设' : '新建预设'}
        </div>
        {err && <div className="text-xs text-red-500">{err}</div>}
      </div>

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
        <div className="mt-1 text-xs text-neutral-400 dark:text-stone-500">服务进程会常驻在打开的终端里，回车后运行。</div>
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

  // 持久化预设
  useEffect(() => { savePresets(presets); }, [presets]);

  const selected = useMemo(() => presets.find((p) => p.id === selectedId) ?? null, [presets, selectedId]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setEditing(null);
  }, []);

  const addPreset = useCallback(() => {
    setSelectedId(null);
    setEditing('new');
  }, []);

  const addFromTemplate = useCallback((t: WebPreset) => {
    setPresets((prev) => [...prev, t]);
    setSelectedId(t.id);
    setEditing(null);
  }, []);

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
    setPresets((prev) => prev.filter((p) => p.id !== id));
    if (run?.presetId === id) setRun(null);
    if (selectedId === id) { setSelectedId(null); setEditing(null); }
  }, [run, selectedId]);

  const start = useCallback(() => {
    if (!selected) return;
    // 同预设重复启动 → 先停掉旧的
    setRun({ presetId: selected.id, ptyId: '', status: 'starting', startedAt: Date.now() });
  }, [selected]);

  const stop = useCallback(() => setRun(null), []);

  const markRunning = useCallback(() => {
    setRun((r) => (r ? { ...r, status: 'running' } : r));
  }, []);

  const markStopped = useCallback(() => {
    // 进程退出 → 回到空闲态，方便一键重建（终端已随 pty 退出）
    setRun(null);
  }, []);

  const isRunningThis = !!run && run.presetId === selected?.id;

  return (
    <div className="flex h-full w-full gap-3 overflow-hidden">
      {/* 左侧：预设列表 */}
      <aside className="w-60 shrink-0 flex flex-col gap-2 rounded-2xl border border-black/10 dark:border-white/10 p-2 bg-white/60 dark:bg-stone-900/60">
        <div className="flex items-center justify-between px-1 py-1">
          <span className="text-sm font-semibold text-neutral-700 dark:text-stone-200">预设</span>
          <button
            className="btn-press flex items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
            onClick={addPreset}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            新建
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
          {presets.map((p) => (
            <button
              key={p.id}
              className={`w-full text-left rounded-xl px-3 py-2 transition-colors ${
                selectedId === p.id
                  ? 'bg-sky-500/10 ring-1 ring-sky-500/30'
                  : 'hover:bg-black/5 dark:hover:bg-white/5'
              }`}
              onClick={() => select(p.id)}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-800 dark:text-stone-100 truncate">{p.name}</span>
                {run?.presetId === p.id && <StatusChip status={run.status} />}
              </div>
              {p.desc && <div className="mt-0.5 text-xs text-neutral-400 dark:text-stone-500 truncate">{p.desc}</div>}
              <div className="mt-0.5 font-mono text-[11px] text-neutral-400 dark:text-stone-600 truncate">{p.args}</div>
            </button>
          ))}
          {presets.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-neutral-400 dark:text-stone-500">
              还没有预设。点「新建」创建，或从下方模板快速开始。
            </div>
          )}
        </div>

        {presets.length === 0 && (
          <div className="space-y-1 border-t border-black/10 dark:border-white/10 pt-2">
            <div className="px-1 pb-1 text-xs text-neutral-400 dark:text-stone-500">快速开始</div>
            {builtinTemplates().map((t) => (
              <button
                key={t.id}
                className="w-full text-left rounded-xl px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                onClick={() => addFromTemplate(t)}
              >
                <div className="text-sm text-neutral-800 dark:text-stone-200">{t.name}</div>
                <div className="font-mono text-[11px] text-neutral-400 dark:text-stone-600">{t.args}</div>
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* 右侧：详情 / 编辑 / 运行区 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {editing === 'new' ? (
          <EditorForm
            initial={{ id: '', name: '', desc: '', kind: 'command', args: '', cwd: '', url: '', createdAt: Date.now() }}
            onSave={(p) => savePreset({ ...p, id: newPresetId(), createdAt: Date.now() })}
            onCancel={() => setEditing(null)}
          />
        ) : !selected ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-neutral-400 dark:text-stone-500">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <div className="text-sm">在左侧选择预设，或新建一个本地 Web 服务预设</div>
          </div>
        ) : editing ? (
          <EditorForm initial={selected} onSave={savePreset} onCancel={() => setEditing(null)} />
        ) : (
          <div className="flex-1 min-h-0 flex flex-col gap-3">
            {/* 状态卡片 */}
            <div className="shrink-0 rounded-2xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-stone-900">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="text-base font-semibold text-neutral-800 dark:text-stone-100 truncate">{selected.name}</div>
                  <span className="rounded-full border border-black/10 dark:border-white/10 px-2 py-0.5 text-[11px] text-neutral-400 dark:text-stone-500">命令</span>
                  {run?.presetId === selected.id && <StatusChip status={run.status} />}
                </div>
                <div className="flex items-center gap-2">
                  {!isRunningThis ? (
                    <button
                      className="btn-press flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-600"
                      onClick={start}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      一键启动
                    </button>
                  ) : (
                    <button
                      className="btn-press flex items-center gap-1.5 rounded-lg bg-red-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-600"
                      onClick={stop}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                      停止
                    </button>
                  )}
                  <button
                    className="btn-press rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
                    onClick={() => setEditing(selected)}
                  >
                    编辑
                  </button>
                  <button
                    className="btn-press rounded-lg px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10"
                    onClick={() => deletePreset(selected.id)}
                    title="删除预设"
                  >
                    删除
                  </button>
                </div>
              </div>
              {selected.cwd && (
                <div className="mt-2 text-xs text-neutral-400 dark:text-stone-500">目录：<code className="text-neutral-600 dark:text-stone-300">{selected.cwd}</code></div>
              )}
            </div>

            {/* 运行区：preview + 终端 */}
            {isRunningThis && run ? (
              <RunPane preset={selected} onReady={markRunning} onStopped={markStopped} />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-black/10 dark:border-white/10 text-neutral-400 dark:text-stone-500">
                <div className="text-sm">点击「一键启动」在终端里运行：</div>
                <code className="rounded-lg bg-black/5 dark:bg-white/5 px-3 py-1.5 font-mono text-xs">{selected.args}</code>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
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