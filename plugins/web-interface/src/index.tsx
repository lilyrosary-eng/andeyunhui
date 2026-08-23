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
const hostApi = window.__HOST_API__;
import { WebTerminal } from './Terminal';
import {
  loadPresets, savePresets, newPresetId, validatePreset,
  suggestFromFile, scanAndRecognize, recognitionToPreset, baseName, dirName, extOf, RUNNABLE_EXTS,
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
  const [probeReady, setProbeReady] = useState(true);
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

  // 预览地址「就绪探测」：no-cors fetch 轮询直到服务端口起来，再加载 iframe。
  // 避免大型应用（kohya/ComfyUI）启动慢时误报"拒绝连接"。超时(90s)后也渲染以便手动刷新。
  useEffect(() => {
    if (!hasUrl) return;
    setProbeReady(false);
    let cancelled = false;
    let attempts = 0;
    const tryOnce = async () => {
      if (cancelled) return;
      try {
        await fetch(preset.url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (!cancelled) setProbeReady(true);
      } catch {
        if (cancelled) return;
        attempts += 1;
        if (attempts > 45) { if (!cancelled) setProbeReady(true); return; }
        setTimeout(tryOnce, 2000);
      }
    };
    tryOnce();
    return () => { cancelled = true; };
  }, [hasUrl, preset.url, reloadKey]);

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
          {hasUrl && !probeReady ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-center text-xs text-neutral-400 dark:text-stone-500">
              <span className="inline-block h-5 w-5 rounded-full border-2 border-neutral-300 border-t-sky-500 animate-spin" />
              <div>等待服务启动，就绪后自动加载预览…</div>
              <div className="text-[11px] opacity-70">首次启动大型应用（如 kohya / ComfyUI）可能需数十秒</div>
            </div>
          ) : hasUrl ? (
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
    onSave({ ...initial, name: name.trim(), desc: desc.trim(), args: args.trim(), cwd: cwd.trim() || undefined, url: url.trim() });
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
              还没有预设。点「新建」，选本地文件/文件夹自动识别后保存。
            </div>
          )}
        </div>
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