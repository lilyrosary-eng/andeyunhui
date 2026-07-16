/// <reference path="../../global.d.ts" />
// 专业模块入口（薄荷）
const React = window.__HOST_REACT__;
const { useState, useMemo, useCallback, useRef, useEffect } = React;
const { ModuleSidebarShell, SecondaryNavShell, Icon: HostIcon } = window.__HOST_UI__ || {};

// ========== 数据 ==========
interface ToolMeta {
  id: string;
  name: string;
  desc: string;
  icon: string;
  category: string;
  needBackend?: boolean;
}

// 子插件 / 工具视图所需的精简工具信息（ToolShell、ComingSoon 共用）
type LiteTool = { name: string; desc: string; icon: string };

interface Category {
  id: string;
  name: string;
  count: number;
  icon: string;
}

const CATEGORIES: Category[] = [
  { id: 'convert', name: '格式转换', count: 4, icon: 'Repeat' },
  { id: 'text', name: '文本处理', count: 5, icon: 'Type' },
  { id: 'data', name: '数据分析', count: 3, icon: 'ChartColumn' },
  { id: 'system', name: '系统工具', count: 4, icon: 'SlidersHorizontal' },
];

const TOOLS: Record<string, ToolMeta[]> = {
  convert: [
    { id: 't1', name: '图片格式转换', desc: 'PNG/JPEG/BMP/GIF/TIFF 互转', icon: 'Images', category: 'convert' },
    { id: 't2', name: '文档格式转换', desc: 'Markdown / HTML 互转', icon: 'FileType', category: 'convert' },
    { id: 't3', name: '视频转码', desc: '调用 ffmpeg 转码视频（内置 ffmpeg）', icon: 'Film', category: 'convert' },
    { id: 't4', name: '音频转码', desc: '调用 ffmpeg 转码音频（内置 ffmpeg）', icon: 'AudioLines', category: 'convert' },
  ],
  text: [
    { id: 't5', name: '正则表达式测试', desc: '实时正则匹配和替换', icon: 'Regex', category: 'text' },
    { id: 't6', name: '文本差异对比', desc: 'Diff 对比工具', icon: 'Diff', category: 'text' },
    { id: 't7', name: 'JSON 格式化', desc: 'JSON 美化与校验', icon: 'Braces', category: 'text' },
    { id: 't8', name: 'Base64 编解码', desc: 'Base64 编码与解码', icon: 'Binary', category: 'text' },
    { id: 't9', name: 'URL 编解码', desc: 'URL 编码与解码', icon: 'Link', category: 'text' },
  ],
  data: [
    { id: 't10', name: 'CSV 查看器', desc: 'CSV 数据浏览与导出', icon: 'Table', category: 'data' },
    { id: 't11', name: '哈希计算', desc: 'MD5/SHA1/SHA256/SHA512', icon: 'Hash', category: 'data' },
    { id: 't12', name: 'UUID 生成器', desc: '批量生成 UUID', icon: 'KeyRound', category: 'data' },
  ],
  system: [
    { id: 't13', name: '端口扫描', desc: '检测本地端口占用', icon: 'Network', category: 'system' },
    { id: 't14', name: '进程管理', desc: '查看系统进程', icon: 'Cpu', category: 'system' },
    { id: 't15', name: '环境变量', desc: '查看和编辑环境变量', icon: 'Variable', category: 'system' },
    { id: 't16', name: '剪贴板历史', desc: '剪贴板读写与历史', icon: 'Clipboard', category: 'system' },
  ],
};

const ALL_TOOLS: ToolMeta[] = Object.values(TOOLS).flat();
function findTool(id: string): ToolMeta | undefined {
  return ALL_TOOLS.find(t => t.id === id);
}

// 用宿主 UI 库（lucide）渲染图标；若图标名缺失或宿主不支持，则回退为仅文字
function ToolGlyph({ name, size = 20, className = '' }: { name?: string; size?: number; className?: string }) {
  if (!HostIcon || !name) return null;
  return <HostIcon name={name} size={size} className={className} />;
}

// ========== 通用基础工具 ==========
function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
  } catch (_e) { /* ignore */ }
  return Promise.resolve();
}

function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    copyText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  return (
    <button
      onClick={onClick}
      className="btn-press px-3 py-1.5 rounded-lg text-xs bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors"
    >
      {copied ? '已复制' : label}
    </button>
  );
}

function ToolShell({ tool, onBack, children }: { tool: LiteTool; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-white/80 dark:border-stone-700/50 flex-shrink-0">
        <button
          onClick={onBack}
          className="btn-press w-8 h-8 flex items-center justify-center rounded-lg text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          title="返回"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
          </svg>
        </button>
        <ToolGlyph name={tool.icon} size={22} className="text-neutral-600 dark:text-stone-300" />
        <div>
          <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">{tool.name}</div>
          <div className="text-xs text-neutral-400 dark:text-stone-500">{tool.desc}</div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6">{children}</div>
    </div>
  );
}

function ComingSoon({ tool }: { tool: LiteTool }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-neutral-400 dark:text-stone-500">
      <ToolGlyph name={tool.icon} size={36} className="text-neutral-400 dark:text-stone-500" />
      <p className="text-sm font-medium text-neutral-600 dark:text-stone-300">{tool.name}</p>
      <p className="text-xs text-center max-w-sm px-6 leading-relaxed">
        该工具需要调用系统后端能力（如文件转码、端口 / 进程 / 环境变量查询、剪贴板监听等），
        当前版本尚未实装。后续接入 Tauri 后端命令后即可使用。
      </p>
    </div>
  );
}

// ========== 后端调用辅助 ==========
function hostInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
  return window.__HOST_API__.invoke(cmd, args);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const res = r.result as string;
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

const IMG_MIME: Record<string, string> = {
  png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg',
  bmp: 'image/bmp', gif: 'image/gif', tiff: 'image/tiff',
};

function downloadBase64(filename: string, base64: string, mime: string) {
  const a = document.createElement('a');
  a.href = `data:${mime};base64,${base64}`;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ========== t1 图片格式转换 ==========
function ImageConverter() {
  const fmtList = ['png', 'jpeg', 'bmp', 'gif', 'tiff'];
  const [base64, setBase64] = useState('');
  const [fromExt, setFromExt] = useState('png');
  const [toExt, setToExt] = useState('jpeg');
  const [quality, setQuality] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ b64: string; ext: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setError(''); setResult(null);
    const ext = (f.name.split('.').pop() || 'png').toLowerCase();
    if (fmtList.includes(ext)) setFromExt(ext);
    try { setBase64(await fileToBase64(f)); }
    catch (err) { setError((err as Error).message); }
  };

  const convert = async () => {
    if (!base64) { setError('请先选择图片'); return; }
    setBusy(true); setError(''); setResult(null);
    try {
      const r: string = await hostInvoke('convert_image', { dataBase64: base64, fromExt, toExt, quality });
      setResult({ b64: r, ext: toExt === 'jpeg' ? 'jpg' : toExt });
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const selCls = 'px-2 py-1.5 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none focus:border-[var(--element-border)]';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => fileRef.current?.click()} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors text-sm">选择图片</button>
        <span className="text-xs text-neutral-400 dark:text-stone-500">{base64 ? '已载入图片' : '未选择'}</span>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
      </div>
      <div className="flex items-center gap-3 flex-wrap text-sm text-neutral-600 dark:text-stone-300">
        <label className="flex items-center gap-1.5">源格式
          <select value={fromExt} onChange={e => setFromExt(e.target.value)} className={selCls}>
            {fmtList.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <span>→</span>
        <label className="flex items-center gap-1.5">目标格式
          <select value={toExt} onChange={e => setToExt(e.target.value)} className={selCls}>
            {fmtList.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        {toExt === 'jpeg' && (
          <label className="flex items-center gap-2">质量 {quality}
            <input type="range" min={1} max={100} value={quality} onChange={e => setQuality(parseInt(e.target.value, 10))} className="accent-[var(--element-bg)]" />
          </label>
        )}
        <button onClick={convert} disabled={busy} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors ml-auto disabled:opacity-50">
          {busy ? '转换中…' : '转换'}
        </button>
      </div>
      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">{error}</div>}
      {result && (
        <div className="flex items-center gap-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 px-3 py-2">
          <span className="text-xs text-neutral-500 dark:text-stone-400">转换完成</span>
          <button onClick={() => downloadBase64(`converted.${result.ext}`, result.b64, IMG_MIME[result.ext] || 'application/octet-stream')} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors text-sm">下载</button>
          <CopyButton text={result.b64} label="复制 Base64" />
        </div>
      )}
    </div>
  );
}

// ========== t2 文档格式转换 ==========
function DocConverter() {
  const [text, setText] = useState('# 标题\n\n这是一段 **Markdown** 示例文本。');
  const [from, setFrom] = useState('md');
  const [to, setTo] = useState('html');
  const [out, setOut] = useState('');
  const [error, setError] = useState('');
  const selCls = 'px-2 py-1.5 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none focus:border-[var(--element-border)]';

  const convert = async () => {
    setError('');
    try { setOut(await hostInvoke('convert_document', { text, from, to })); }
    catch (e) { setError((e as Error).message); setOut(''); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap text-sm text-neutral-600 dark:text-stone-300">
        <label className="flex items-center gap-1.5">从
          <select value={from} onChange={e => setFrom(e.target.value)} className={selCls}>
            <option value="md">Markdown</option><option value="html">HTML</option>
          </select>
        </label>
        <span>→</span>
        <label className="flex items-center gap-1.5">到
          <select value={to} onChange={e => setTo(e.target.value)} className={selCls}>
            <option value="html">HTML</option><option value="md">Markdown</option>
          </select>
        </label>
        <button onClick={convert} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors ml-auto">转换</button>
      </div>
      <textarea value={text} onChange={e => setText(e.target.value)} spellCheck={false}
        placeholder="粘贴待转换文本…"
        className="w-full h-40 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)] resize-y" />
      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">{error}</div>}
      {out && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-400 dark:text-stone-500">结果</span>
            <CopyButton text={out} />
          </div>
          <textarea readOnly value={out} spellCheck={false}
            className="w-full h-40 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none resize-y" />
        </div>
      )}
    </div>
  );
}

// ========== t13 端口扫描 ==========
function PortScanner() {
  const [host, setHost] = useState('127.0.0.1');
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState(1024);
  const [ports, setPorts] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const numCls = 'w-24 px-2 py-1.5 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none focus:border-[var(--element-border)]';

  const run = async () => {
    setBusy(true); setError(''); setPorts([]);
    try { setPorts(await hostInvoke('scan_ports', { host, start, end })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-sm text-neutral-600 dark:text-stone-300">
        <label className="flex items-center gap-1.5">主机
          <input value={host} onChange={e => setHost(e.target.value)} className="w-32 px-2 py-1.5 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none focus:border-[var(--element-border)]" />
        </label>
        <label className="flex items-center gap-1.5">起始
          <input type="number" value={start} onChange={e => setStart(parseInt(e.target.value, 10) || 0)} className={numCls} />
        </label>
        <label className="flex items-center gap-1.5">结束
          <input type="number" value={end} onChange={e => setEnd(parseInt(e.target.value, 10) || 0)} className={numCls} />
        </label>
        <button onClick={run} disabled={busy} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors ml-auto disabled:opacity-50">
          {busy ? '扫描中…' : '开始扫描'}
        </button>
      </div>
      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">{error}</div>}
      <div className="text-xs text-neutral-400 dark:text-stone-500">
        {busy ? '正在探测端口连通性…' : ports.length > 0 ? `发现 ${ports.length} 个开放端口` : '未发现开放端口'}
      </div>
      {ports.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {ports.map(p => (
            <span key={p} className="px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 text-xs font-mono">{p}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ========== t14 进程管理 ==========
function ProcessManager() {
  const [list, setList] = useState<{ pid: number; name: string; cpu: number; mem_kb: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    setBusy(true); setError('');
    try { setList(await hostInvoke('list_processes')); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={refresh} disabled={busy} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors disabled:opacity-50">
          {busy ? '刷新中…' : '刷新'}
        </button>
        <span className="text-xs text-neutral-400 dark:text-stone-500">共 {list.length} 个进程（按内存排序，CPU 为采样值）</span>
      </div>
      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">{error}</div>}
      <div className="rounded-xl bg-white/40 dark:bg-stone-800/40 border border-white/60 dark:border-stone-700/40 overflow-auto max-h-[55vh]">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-white/60 dark:bg-stone-800/60 sticky top-0 text-left">
              <th className="px-3 py-2 font-medium text-neutral-700 dark:text-stone-200">PID</th>
              <th className="px-3 py-2 font-medium text-neutral-700 dark:text-stone-200">名称</th>
              <th className="px-3 py-2 font-medium text-neutral-700 dark:text-stone-200">CPU%</th>
              <th className="px-3 py-2 font-medium text-neutral-700 dark:text-stone-200">内存(MB)</th>
            </tr>
          </thead>
          <tbody>
            {list.map(p => (
              <tr key={p.pid} className="even:bg-white/30 dark:even:bg-stone-800/30">
                <td className="px-3 py-1.5 font-mono text-neutral-500 dark:text-stone-400">{p.pid}</td>
                <td className="px-3 py-1.5 text-neutral-600 dark:text-stone-300 truncate max-w-[200px]">{p.name}</td>
                <td className="px-3 py-1.5 font-mono text-neutral-600 dark:text-stone-300">{p.cpu.toFixed(1)}</td>
                <td className="px-3 py-1.5 font-mono text-neutral-600 dark:text-stone-300">{(p.mem_kb / 1024).toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ========== t15 环境变量 ==========
function EnvVars() {
  const [filter, setFilter] = useState('');
  const [vars, setVars] = useState<[string, string][]>([]);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [setMsg, setSetMsg] = useState('');

  const load = useCallback(async () => {
    setError('');
    try { setVars(await hostInvoke('get_env_vars', { filter: filter || null })); }
    catch (e) { setError((e as Error).message); }
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const setVar = async () => {
    setSetMsg('');
    if (!name) { setSetMsg('请填写变量名'); return; }
    try {
      await hostInvoke('set_env_var', { name, value });
      setSetMsg('已设置（仅当前进程生效，不持久化）');
      load();
    } catch (e) { setSetMsg('失败：' + (e as Error).message); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="过滤变量名…"
          className="flex-1 px-3 py-1.5 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none focus:border-[var(--element-border)]" />
        <span className="text-xs text-neutral-400 dark:text-stone-500">{vars.length} 项</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="变量名"
          className="w-40 px-2 py-1.5 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none focus:border-[var(--element-border)]" />
        <input value={value} onChange={e => setValue(e.target.value)} placeholder="变量值"
          className="flex-1 px-2 py-1.5 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none focus:border-[var(--element-border)]" />
        <button onClick={setVar} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors text-sm">设置（当前进程）</button>
      </div>
      {setMsg && <div className="text-xs text-neutral-500 dark:text-stone-400">{setMsg}</div>}
      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">{error}</div>}
      <div className="rounded-xl bg-white/40 dark:bg-stone-800/40 border border-white/60 dark:border-stone-700/40 overflow-auto max-h-[45vh]">
        <table className="w-full text-sm border-collapse">
          <tbody>
            {vars.map(([k, v]) => (
              <tr key={k} className="even:bg-white/30 dark:even:bg-stone-800/30">
                <td className="px-3 py-1.5 font-mono text-[var(--element-color-raw)] whitespace-nowrap align-top w-1/3">{k}</td>
                <td className="px-3 py-1.5 text-neutral-600 dark:text-stone-300 break-all">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ========== t16 剪贴板历史（极致专业版）==========
interface ClipItem {
  id: string;
  type: 'text' | 'image';
  content: string; // 文本内容 或 图片临时文件路径
  preview: string; // 预览文本（图片为尺寸信息）
  timestamp: number;
  pinned: boolean;
  charCount?: number;
  thumbnail?: string; // 缩略图 data URL（后端生成，减轻大图渲染压力）
}

const CLIP_STORAGE_KEY = 'clipboard_history_v1';
const CLIP_MAX_TEXT = 200;
const CLIP_MAX_IMAGE = 5; // 限制图片数量，避免内存爆炸

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function ClipboardHistory() {
  const [items, setItems] = useState<ClipItem[]>([]);
  const [current, setCurrent] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'text' | 'image' | 'pinned'>('all');
  const [error, setError] = useState('');
  const [polling, setPolling] = useState(true);
  const lastTextRef = useRef('');
  const lastImageRef = useRef('');
  const lastImgHashRef = useRef('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 从 localStorage 加载持久化文本历史
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CLIP_STORAGE_KEY);
      if (saved) {
        const parsed: ClipItem[] = JSON.parse(saved);
        setItems(parsed);
        if (parsed.length > 0 && parsed[0].type === 'text') {
          lastTextRef.current = parsed[0].content;
        }
      }
    } catch { /* ignore */ }
    // 初始读取当前剪贴板
    hostInvoke('clipboard_read').then((t: string) => { setCurrent(t); lastTextRef.current = t; }).catch(() => {});
  }, []);

  // 持久化文本历史到 localStorage（图片不持久化，太占空间）
  useEffect(() => {
    try {
      const textItems = items.filter(i => i.type === 'text').slice(0, CLIP_MAX_TEXT);
      localStorage.setItem(CLIP_STORAGE_KEY, JSON.stringify(textItems));
    } catch { /* localStorage 满了，忽略 */ }
  }, [items]);

  // 轮询剪贴板（1s 间隔，比原来 1.5s 更快）
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(async () => {
      try {
        // 高效图片轮询：传入上次已知的 hash，后端比对后仅变化时返回数据
        const imgInfo: { hash: string; tempPath: string; thumbnail: string } | null =
          await hostInvoke('clipboard_poll_image', { lastHash: lastImgHashRef.current || null });
        if (imgInfo) {
          lastImageRef.current = imgInfo.tempPath;
          lastImgHashRef.current = imgInfo.hash;
          lastTextRef.current = '';
          const newItem: ClipItem = {
            id: Date.now() + '_img',
            type: 'image',
            content: imgInfo.tempPath,  // 仅存路径，不存 base64
            preview: '图片',
            timestamp: Date.now(),
            pinned: false,
            thumbnail: imgInfo.thumbnail, // 后端生成的缩略图
          };
          setItems(prev => {
            const existing = prev.filter(i => i.type !== 'image' || i.content !== imgInfo.tempPath);
            // 限制图片数量，保留固定项
            const imageCount = existing.filter(i => i.type === 'image' && !i.pinned).length;
            const trimmed = imageCount >= CLIP_MAX_IMAGE
              ? existing.filter(i => i.type !== 'image' || i.pinned)
              : existing;
            return [newItem, ...trimmed].slice(0, CLIP_MAX_TEXT + CLIP_MAX_IMAGE);
          });
          return;
        }
        // 无新图片 → 检测文本
        const text: string = await hostInvoke('clipboard_read');
        if (text && text !== lastTextRef.current) {
          lastTextRef.current = text;
          lastImageRef.current = '';
          lastImgHashRef.current = '';
          setCurrent(text);
          const newItem: ClipItem = {
            id: Date.now() + '_txt',
            type: 'text',
            content: text,
            preview: text.slice(0, 200),
            timestamp: Date.now(),
            pinned: false,
            charCount: text.length,
          };
          setItems(prev => [newItem, ...prev.filter(i => !(i.type === 'text' && i.content === text))].slice(0, CLIP_MAX_TEXT + CLIP_MAX_IMAGE));
        }
      } catch { /* 忽略轮询错误 */ }
    }, 1500);
    return () => clearInterval(id);
  }, [polling]);

  // 过滤 + 搜索
  const filtered = useMemo(() => {
    let result = items;
    if (filter === 'text') result = result.filter(i => i.type === 'text');
    else if (filter === 'image') result = result.filter(i => i.type === 'image');
    else if (filter === 'pinned') result = result.filter(i => i.pinned);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(i => i.type === 'text' && i.content.toLowerCase().includes(q));
    }
    return result;
  }, [items, filter, search]);

  // 统计
  const stats = useMemo(() => ({
    total: items.length,
    text: items.filter(i => i.type === 'text').length,
    image: items.filter(i => i.type === 'image').length,
    pinned: items.filter(i => i.pinned).length,
  }), [items]);

  // 操作：写入剪贴板
  const writeToClipboard = async (item: ClipItem) => {
    try {
      if (item.type === 'text') {
        await hostInvoke('clipboard_write', { text: item.content });
        setCurrent(item.content);
        lastTextRef.current = item.content;
        lastImageRef.current = '';
        lastImgHashRef.current = '';
      } else {
        // 图片：从临时文件路径写入剪贴板（Win32 API，可靠）
        await hostInvoke('clipboard_write_image_from_path', { path: item.content });
        lastImageRef.current = item.content;
        lastTextRef.current = '';
        // 重置 hash，让下次轮询重新检测并更新（避免重复添加）
        lastImgHashRef.current = '';
      }
      // 显示复制成功反馈
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (e) { setError((e as Error).message); }
  };

  // 写入编辑后的文本
  const writeCurrent = async () => {
    if (!current) return;
    try {
      await hostInvoke('clipboard_write', { text: current });
      lastTextRef.current = current;
      lastImageRef.current = '';
      lastImgHashRef.current = '';
    } catch (e) { setError((e as Error).message); }
  };

  const refreshNow = async () => {
    try {
      // 手动刷新：传 null 强制获取当前图片（绕过 hash 检查）
      const imgInfo: { hash: string; tempPath: string; thumbnail: string } | null =
        await hostInvoke('clipboard_poll_image', { lastHash: null });
      if (imgInfo) {
        lastImageRef.current = imgInfo.tempPath;
        lastImgHashRef.current = imgInfo.hash;
        setCurrent('');
        return;
      }
      const t: string = await hostInvoke('clipboard_read');
      setCurrent(t); lastTextRef.current = t;
    } catch (e) { setError((e as Error).message); }
  };

  const togglePin = (id: string) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, pinned: !i.pinned } : i));
  };

  const deleteItem = (id: string) => {
    setItems(prev => prev.filter(i => i.id !== id));
  };

  const clearAll = () => {
    setItems(prev => prev.filter(i => i.pinned)); // 保留固定的
  };

  const clearSystemClipboard = async () => {
    try { await hostInvoke('clipboard_clear'); setCurrent(''); lastTextRef.current = ''; lastImageRef.current = ''; lastImgHashRef.current = ''; }
    catch (e) { setError((e as Error).message); }
  };

  const exportHistory = () => {
    const text = items
      .filter(i => i.type === 'text')
      .map(i => `[${new Date(i.timestamp).toLocaleString()}]\n${i.content}`)
      .join('\n\n---\n\n');
    const blob = new Blob([text || '（无历史记录）'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clipboard_history_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 打开浮窗
  const openFloating = async () => {
    try {
      await window.__HOST_API__.createFloatingWindow('floating-clipboard', 'index.html?floating=clipboard', {
        title: '剪贴板浮窗',
        width: 360,
        height: 480,
        minWidth: 280,
        minHeight: 320,
        decorations: false,
        resizable: true,
        transparent: true,
      });
    } catch (e) { setError((e as Error).message); }
  };

  const filterTabs: Array<{ id: 'all' | 'text' | 'image' | 'pinned'; label: string; count: number }> = [
    { id: 'all', label: '全部', count: stats.total },
    { id: 'text', label: '文本', count: stats.text },
    { id: 'image', label: '图片', count: stats.image },
    { id: 'pinned', label: '固定', count: stats.pinned },
  ];

  return (
    <div className="space-y-3">
      {/* 顶部操作栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        <textarea value={current} onChange={e => setCurrent(e.target.value)} spellCheck={false}
          placeholder="当前剪贴板内容（可编辑后写入）…"
          className="w-full h-20 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)] resize-y" />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={writeCurrent} className="btn-press px-3 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors text-sm">写入</button>
        <button onClick={refreshNow} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors text-sm">刷新</button>
        <button onClick={clearSystemClipboard} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors text-sm">清空剪贴板</button>
        <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-stone-300 cursor-pointer select-none">
          <input type="checkbox" checked={polling} onChange={e => setPolling(e.target.checked)} className="accent-[var(--element-bg)]" /> 自动记录
        </label>
        <div className="flex-1" />
        <button onClick={openFloating} className="btn-press px-3 py-1.5 rounded-lg bg-blue-500/90 text-white hover:bg-blue-500 transition-colors text-sm flex items-center gap-1" title="以透明浮窗形式打开">
          {HostIcon ? React.createElement(HostIcon, { name: 'PanelTopOpen', className: 'w-3.5 h-3.5' }) : null}
          浮窗
        </button>
        <button onClick={exportHistory} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors text-sm">导出</button>
        <button onClick={clearAll} className="btn-press px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200/50 dark:border-red-700/30 text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors text-sm">清空</button>
      </div>

      {/* 统计信息 */}
      <div className="flex items-center gap-3 text-xs text-neutral-400 dark:text-stone-500 px-1">
        <span>共 {stats.total} 条</span>
        <span>·</span>
        <span>文本 {stats.text}</span>
        <span>·</span>
        <span>图片 {stats.image}</span>
        {stats.pinned > 0 && <><span>·</span><span>固定 {stats.pinned}</span></>}
      </div>

      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 flex items-center justify-between">
        <span>{error}</span>
        <button onClick={() => setError('')} className="text-xs text-red-400 hover:text-red-600">✕</button>
      </div>}

      {/* 搜索 + 分类 */}
      <div className="flex items-center gap-2 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索文本历史…"
          className="flex-1 min-w-[120px] px-3 py-1.5 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)]" />
        <div className="flex items-center gap-1 rounded-lg bg-white/40 dark:bg-stone-800/40 p-0.5">
          {filterTabs.map(tab => (
            <button key={tab.id} onClick={() => setFilter(tab.id)}
              className={`px-2.5 py-1 rounded-md text-xs transition-colors ${filter === tab.id
                ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 font-medium'
                : 'text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200'}`}>
              {tab.label} <span className="opacity-50">{tab.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 历史列表 */}
      <div className="rounded-xl bg-white/40 dark:bg-stone-800/40 border border-white/60 dark:border-stone-700/40 max-h-[45vh] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-neutral-400 dark:text-stone-500">
            {search ? '未找到匹配的记录' : '暂无历史，复制内容后将自动记录'}
          </div>
        ) : filtered.map((item) => (
          <div key={item.id} className="px-3 py-2 border-b border-white/40 dark:border-stone-700/30 last:border-0 flex items-start gap-2 group hover:bg-white/30 dark:hover:bg-stone-700/20 transition-colors">
            {/* 内容区 */}
            <div className="flex-1 min-w-0">
              {item.type === 'image' ? (
                // 使用缩略图渲染，减轻大图内存压力
                <div className="flex items-center gap-2">
                  {item.thumbnail ? (
                    <img 
                      src={item.thumbnail} 
                      alt="缩略图" 
                      loading="lazy"
                      decoding="async"
                      className="w-20 h-14 object-cover rounded-lg border border-white/40 dark:border-stone-700/40 flex-shrink-0" 
                    />
                  ) : (
                    <div className="w-20 h-14 rounded-lg bg-neutral-100 dark:bg-stone-700 flex items-center justify-center flex-shrink-0">
                      <span className="text-xs text-neutral-400">图片</span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-neutral-400 dark:text-stone-500">
                      {formatTime(item.timestamp)} · 图片
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-0.5">
                  <div className="text-sm text-neutral-700 dark:text-stone-200 break-all whitespace-pre-wrap line-clamp-3">{item.preview}</div>
                  <div className="text-xs text-neutral-400 dark:text-stone-500 flex items-center gap-2">
                    <span>{formatTime(item.timestamp)}</span>
                    {item.charCount && <span>{item.charCount} 字符</span>}
                  </div>
                </div>
              )}
            </div>
            {/* 操作按钮 */}
            <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={() => writeToClipboard(item)}
                className={`btn-press text-xs px-2 py-1 rounded transition-colors ${copiedId === item.id ? 'text-green-500' : 'text-neutral-500 dark:text-stone-400 hover:text-[var(--element-color-raw)]'}`}
                title="复制到剪贴板">
                {copiedId === item.id ? '✓' : '复制'}
              </button>
              <button onClick={() => togglePin(item.id)}
                className={`btn-press text-xs px-2 py-1 rounded transition-colors ${item.pinned ? 'text-amber-500' : 'text-neutral-500 dark:text-stone-400 hover:text-amber-500'}`}
                title={item.pinned ? '取消固定' : '固定'}>
                {item.pinned ? '★' : '☆'}
              </button>
              <button onClick={() => deleteItem(item.id)}
                className="btn-press text-xs px-2 py-1 rounded text-neutral-500 dark:text-stone-400 hover:text-red-500 transition-colors"
                title="删除">✕</button>
            </div>
            {item.pinned && <span className="text-amber-500 text-xs flex-shrink-0">★</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ========== t3 / t4 音视频转码（ffmpeg） ==========
function MediaTranscoder({ kind }: { kind: 'video' | 'audio' }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [input, setInput] = useState('');
  const [fmt, setFmt] = useState(kind === 'video' ? 'mp4' : 'mp3');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');

  useEffect(() => {
    hostInvoke('check_ffmpeg').then((b: boolean) => setAvailable(b)).catch(() => setAvailable(false));
  }, []);

  const pick = async () => {
    setError('');
    try {
      const filters = kind === 'video'
        ? [{ name: '视频', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v'] }]
        : [{ name: '音频', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'] }];
      const res: string[] = await hostInvoke('pick_file', { filters });
      if (res && res.length) { setInput(res[0]); setOutput(''); }
      else setInput('');
    } catch (e) { setError((e as Error).message); }
  };

  const run = async () => {
    if (!input) { setError('请先选择文件'); return; }
    setBusy(true); setError(''); setOutput('');
    try { setOutput(await hostInvoke('transcode_media', { inputPath: input, outputFormat: fmt })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const fmts = kind === 'video' ? ['mp4', 'mkv', 'webm', 'mov', 'avi'] : ['mp3', 'flac', 'wav', 'ogg'];
  const selCls = 'px-2 py-1.5 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none focus:border-[var(--element-border)]';

  return (
    <div className="space-y-3">
      {available === false && (
        <div className="text-sm text-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3">
          未检测到 ffmpeg。请确保 external-deps/全局/ffmpeg/ffmpeg.exe 存在。
        </div>
      )}
      {available === null && <div className="text-xs text-neutral-400 dark:text-stone-500">正在检测 ffmpeg…</div>}
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={pick} disabled={available === false} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors text-sm disabled:opacity-50">选择文件</button>
        <span className="text-xs text-neutral-400 dark:text-stone-500 truncate max-w-[280px]">{input || '未选择'}</span>
      </div>
      <div className="flex items-center gap-3 flex-wrap text-sm text-neutral-600 dark:text-stone-300">
        <label className="flex items-center gap-1.5">输出格式
          <select value={fmt} onChange={e => setFmt(e.target.value)} className={selCls}>
            {fmts.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <button onClick={run} disabled={busy || available === false || !input} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors ml-auto disabled:opacity-50">
          {busy ? '转码中…' : '开始转码'}
        </button>
      </div>
      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">{error}</div>}
      {output && (
        <div className="flex items-center gap-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 px-3 py-2">
          <span className="text-xs text-neutral-500 dark:text-stone-400">输出</span>
          <code className="flex-1 text-sm font-mono text-neutral-700 dark:text-stone-200 break-all">{output}</code>
          <CopyButton text={output} label="复制路径" />
        </div>
      )}
    </div>
  );
}

// ========== 图标 ==========
function BriefcaseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </svg>
  );
}

// ========== t5 正则表达式测试 ==========
function RegexTester() {
  const [text, setText] = useState('Hello world\nfoo_bar 2026\nthe quick Brown fox\nemail: a.b@example.com');
  const [pattern, setPattern] = useState('\\b\\w+\\b');
  const [flags, setFlags] = useState({ g: true, i: false, m: true, s: false });

  const flagStr = useMemo(() => {
    let f = '';
    if (flags.g) f += 'g';
    if (flags.i) f += 'i';
    if (flags.m) f += 'm';
    if (flags.s) f += 's';
    return f;
  }, [flags]);

  const result = useMemo(() => {
    if (!pattern) return { error: null as string | null, matches: [] as { match: string; index: number; groups: string[] }[] };
    let iterRe: RegExp;
    try {
      // 迭代必须用全局模式
      iterRe = new RegExp(pattern, flagStr.includes('g') ? flagStr : flagStr + 'g');
    } catch (e) {
      return { error: (e as Error).message, matches: [] };
    }
    const matches: { match: string; index: number; groups: string[] }[] = [];
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = iterRe.exec(text)) !== null) {
      matches.push({ match: m[0], index: m.index, groups: m.slice(1) });
      if (m.index === iterRe.lastIndex) iterRe.lastIndex++;
      if (++guard > 50000) break;
    }
    return { error: null, matches };
  }, [text, pattern, flagStr]);

  const segments = useMemo(() => {
    if (result.error || result.matches.length === 0) return null;
    const segs: { t: string; hit: boolean }[] = [];
    let last = 0;
    for (const mm of result.matches) {
      if (mm.index > last) segs.push({ t: text.slice(last, mm.index), hit: false });
      segs.push({ t: text.slice(mm.index, mm.index + mm.match.length), hit: true });
      last = mm.index + mm.match.length;
    }
    if (last < text.length) segs.push({ t: text.slice(last), hit: false });
    return segs;
  }, [text, result]);

  const flagBox = (key: keyof typeof flags, label: string) => (
    <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-stone-300 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={flags[key]}
        onChange={e => setFlags(prev => ({ ...prev, [key]: e.target.checked }))}
        className="accent-[var(--element-bg)]"
      />
      {label}
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row gap-3">
        <input
          value={pattern}
          onChange={e => setPattern(e.target.value)}
          placeholder="正则表达式，例如 \\d+"
          className="flex-1 px-3 py-2 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)]"
          spellCheck={false}
        />
        <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/40 dark:bg-stone-800/40 border border-white/60 dark:border-stone-700/40">
          {flagBox('g', 'g')}{flagBox('i', 'i')}{flagBox('m', 'm')}{flagBox('s', 's')}
        </div>
      </div>

      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="在此输入待匹配的文本…"
        spellCheck={false}
        className="w-full h-44 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)] resize-y"
      />

      {result.error ? (
        <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">正则错误：{result.error}</div>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs text-neutral-400 dark:text-stone-500">
            <span>共匹配 {result.matches.length} 处</span>
            <CopyButton text={result.matches.map(m => m.match).join('\n')} label="复制全部匹配" />
          </div>
          {segments ? (
            <pre className="whitespace-pre-wrap break-words p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 leading-relaxed">
              {segments.map((s, i) => s.hit
                ? <mark key={i} className="bg-[var(--element-bg)]/25 text-[var(--element-color-raw)] rounded px-0.5">{s.t}</mark>
                : <span key={i}>{s.t}</span>)}
            </pre>
          ) : (
            <div className="text-sm text-neutral-400 dark:text-stone-500">没有匹配结果。</div>
          )}
          {result.matches.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-neutral-500 dark:text-stone-400">匹配明细</div>
              <div className="max-h-48 overflow-y-auto rounded-xl bg-white/40 dark:bg-stone-800/40 border border-white/60 dark:border-stone-700/40 divide-y divide-white/60 dark:divide-stone-700/40">
                {result.matches.map((m, i) => (
                  <div key={i} className="px-3 py-1.5 text-xs font-mono flex gap-2">
                    <span className="text-neutral-400 dark:text-stone-500 flex-shrink-0 w-10">{i + 1}.</span>
                    <span className="text-[var(--element-color-raw)] truncate">{m.match}</span>
                    {m.groups.length > 0 && (
                      <span className="text-neutral-400 dark:text-stone-500 truncate">（{m.groups.join(', ')}）</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ========== t6 文本差异对比 ==========
function diffLines(a: string, b: string): { type: 'eq' | 'del' | 'add'; a?: string; b?: string }[] {
  const al = a.split('\n');
  const bl = b.split('\n');
  const n = al.length;
  const m = bl.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: { type: 'eq' | 'del' | 'add'; a?: string; b?: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) { out.push({ type: 'eq', a: al[i], b: bl[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', a: al[i] }); i++; }
    else { out.push({ type: 'add', b: bl[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'del', a: al[i] }); i++; }
  while (j < m) { out.push({ type: 'add', b: bl[j] }); j++; }
  return out;
}

function TextDiff() {
  const [left, setLeft] = useState('苹果\n香蕉\n橙子\n葡萄');
  const [right, setRight] = useState('苹果\n香蕉\n西瓜\n葡萄\n芒果');
  const diff = useMemo(() => diffLines(left, right), [left, right]);
  const stats = useMemo(() => {
    let add = 0; let del = 0;
    for (const d of diff) { if (d.type === 'add') add++; else if (d.type === 'del') del++; }
    return { add, del };
  }, [diff]);

  const swap = () => { const t = left; setLeft(right); setRight(t); };

  const cell = (d: { type: 'eq' | 'del' | 'add'; a?: string; b?: string }) => {
    if (d.type === 'eq') return <div className="px-3 py-0.5 text-neutral-600 dark:text-stone-300">{d.a}</div>;
    if (d.type === 'del') return <div className="px-3 py-0.5 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400">- {d.a}</div>;
    return <div className="px-3 py-0.5 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400">+ {d.b}</div>;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-xl bg-[var(--element-muted)]/60 border border-white/70 dark:border-stone-700/40 px-3 py-2 text-xs text-neutral-600 dark:text-stone-300">
        <span>💡</span>
        <span>更多专业功能（端口扫描、进程管理、环境变量、剪贴板、图片 / 文档 / 音视频转码）请前往「茑萝」模块查看。</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-neutral-400 dark:text-stone-500">
        <span>新增 {stats.add} 行</span><span>删除 {stats.del} 行</span>
        <button onClick={swap} className="btn-press ml-auto px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors">交换左右</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <textarea value={left} onChange={e => setLeft(e.target.value)} spellCheck={false}
          className="w-full h-40 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)] resize-y" />
        <textarea value={right} onChange={e => setRight(e.target.value)} spellCheck={false}
          className="w-full h-40 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)] resize-y" />
      </div>
      <div className="rounded-xl bg-white/40 dark:bg-stone-800/40 border border-white/60 dark:border-stone-700/40 overflow-hidden font-mono text-sm">
        {diff.map((d, i) => <div key={i}>{cell(d)}</div>)}
      </div>
    </div>
  );
}

// ========== t7 JSON 格式化 ==========
function JsonFormatter() {
  const [text, setText] = useState('{"name":"薄荷","tools":["正则","JSON"],"year":2026}');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');

  const format = (indent: number | undefined) => {
    try {
      const obj = JSON.parse(text);
      setOutput(JSON.stringify(obj, null, indent));
      setError('');
    } catch (e) { setError((e as Error).message); setOutput(''); }
  };
  const minify = () => {
    try { const obj = JSON.parse(text); setOutput(JSON.stringify(obj)); setError(''); }
    catch (e) { setError((e as Error).message); setOutput(''); }
  };

  return (
    <div className="space-y-3">
      <textarea value={text} onChange={e => setText(e.target.value)} spellCheck={false}
        placeholder="粘贴 JSON…"
        className="w-full h-44 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)] resize-y" />
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => format(2)} className="btn-press px-3 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors">格式化 (2 空格)</button>
        <button onClick={() => format(4)} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors">格式化 (4 空格)</button>
        <button onClick={minify} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors">压缩</button>
        <button onClick={() => { setText(''); setOutput(''); setError(''); }} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors">清空</button>
        {output && <CopyButton text={output} />}
      </div>
      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">JSON 错误：{error}</div>}
      {output && (
        <textarea readOnly value={output} spellCheck={false}
          className="w-full h-44 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none resize-y" />
      )}
    </div>
  );
}

// ========== t8 Base64 编解码 ==========
function Base64Tool() {
  const [mode, setMode] = useState<'encode' | 'decode'>('encode');
  const [input, setInput] = useState('薄荷 professional 工具箱 🔧');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');

  const run = () => {
    try {
      if (mode === 'encode') {
        const bytes = new TextEncoder().encode(input);
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        setOutput(btoa(bin));
        setError('');
      } else {
        const bin = atob(input.trim());
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        setOutput(new TextDecoder().decode(bytes));
        setError('');
      }
    } catch (e) { setError((e as Error).message); setOutput(''); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex rounded-xl overflow-hidden border border-white/80 dark:border-stone-700/50">
          <button onClick={() => setMode('encode')} className={`px-4 py-1.5 text-sm ${mode === 'encode' ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100' : 'bg-white/40 dark:bg-stone-800/40 text-neutral-500'}`}>编码</button>
          <button onClick={() => setMode('decode')} className={`px-4 py-1.5 text-sm ${mode === 'decode' ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100' : 'bg-white/40 dark:bg-stone-800/40 text-neutral-500'}`}>解码</button>
        </div>
        <button onClick={run} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors ml-auto">{mode === 'encode' ? '编码' : '解码'}</button>
      </div>
      <textarea value={input} onChange={e => setInput(e.target.value)} spellCheck={false}
        placeholder={mode === 'encode' ? '输入原始文本…' : '输入 Base64…'}
        className="w-full h-40 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)] resize-y" />
      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">错误：{error}</div>}
      {output && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-400 dark:text-stone-500">结果</span>
            <CopyButton text={output} />
          </div>
          <textarea readOnly value={output} spellCheck={false}
            className="w-full h-40 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none resize-y" />
        </div>
      )}
    </div>
  );
}

// ========== t9 URL 编解码 ==========
function UrlTool() {
  const [mode, setMode] = useState<'encode' | 'decode'>('encode');
  const [input, setInput] = useState('https://example.com/搜索?q=薄荷 tool&x=1');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');

  const run = () => {
    try {
      if (mode === 'encode') setOutput(encodeURIComponent(input));
      else setOutput(decodeURIComponent(input.trim()));
      setError('');
    } catch (e) { setError((e as Error).message); setOutput(''); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex rounded-xl overflow-hidden border border-white/80 dark:border-stone-700/50">
          <button onClick={() => setMode('encode')} className={`px-4 py-1.5 text-sm ${mode === 'encode' ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100' : 'bg-white/40 dark:bg-stone-800/40 text-neutral-500'}`}>编码</button>
          <button onClick={() => setMode('decode')} className={`px-4 py-1.5 text-sm ${mode === 'decode' ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100' : 'bg-white/40 dark:bg-stone-800/40 text-neutral-500'}`}>解码</button>
        </div>
        <button onClick={run} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors ml-auto">{mode === 'encode' ? '编码' : '解码'}</button>
      </div>
      <textarea value={input} onChange={e => setInput(e.target.value)} spellCheck={false}
        placeholder={mode === 'encode' ? '输入原始 URL / 文本…' : '输入编码后的文本…'}
        className="w-full h-40 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)] resize-y" />
      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">错误：{error}</div>}
      {output && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-400 dark:text-stone-500">结果</span>
            <CopyButton text={output} />
          </div>
          <textarea readOnly value={output} spellCheck={false}
            className="w-full h-40 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none resize-y" />
        </div>
      )}
    </div>
  );
}

// ========== t10 CSV 查看器 ==========
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      field += c; i++;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function CsvViewer() {
  const [text, setText] = useState('name,age,city\nAlice,30,Beijing\nBob,25,Shanghai\nCharlie,35,Guangzhou');
  const [fileError, setFileError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => (text.trim() ? parseCsv(text) : []), [text]);
  const hasHeader = rows.length > 1;
  const header = hasHeader ? rows[0] : [];
  const body = hasHeader ? rows.slice(1) : rows;

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setFileError('');
    f.text().then((t: string) => setText(t)).catch((err: unknown) => setFileError('读取文件失败：' + (err as Error).message));
  };

  const exportCsv = () => { copyText(text); };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => fileRef.current?.click()} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors text-sm">选择 CSV 文件</button>
        <button onClick={exportCsv} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors text-sm">复制全部</button>
        <span className="text-xs text-neutral-400 dark:text-stone-500 ml-auto">{rows.length} 行 × {rows[0]?.length || 0} 列</span>
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
      </div>
      {fileError && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">{fileError}</div>}
      <textarea value={text} onChange={e => setText(e.target.value)} spellCheck={false}
        placeholder="粘贴 CSV 文本，或选择文件…"
        className="w-full h-28 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)] resize-y" />
      <div className="rounded-xl bg-white/40 dark:bg-stone-800/40 border border-white/60 dark:border-stone-700/40 overflow-auto max-h-[50vh]">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-neutral-400 dark:text-stone-500">暂无数据</div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-white/60 dark:bg-stone-800/60 sticky top-0">
                {header.map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 font-medium text-neutral-700 dark:text-stone-200 border-b border-white/80 dark:border-stone-700/50 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri} className="even:bg-white/30 dark:even:bg-stone-800/30">
                  {r.map((c, ci) => (
                    <td key={ci} className="px-3 py-1.5 text-neutral-600 dark:text-stone-300 border-b border-white/50 dark:border-stone-700/30 whitespace-nowrap">{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ========== t11 哈希计算 ==========
// 纯 JS MD5（与 blueimp 实现一致），用于无 Web Crypto 场景兜底
function md5(rawStr: string): string {
  function safeAdd(x: number, y: number) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function bitRotateLeft(num: number, cnt: number) { return (num << cnt) | (num >>> (32 - cnt)); }
  function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
    return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  }
  function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
  function cycle(x: number[], k: number[]) {
    let [a, b, c, d] = k;
    a = ff(a, b, c, d, x[0], 7, -680876936); d = ff(d, a, b, c, x[1], 12, -389564586); c = ff(c, d, a, b, x[2], 17, 606105819); b = ff(b, c, d, a, x[3], 22, -1044525330);
    a = ff(a, b, c, d, x[4], 7, -176418897); d = ff(d, a, b, c, x[5], 12, 1200080426); c = ff(c, d, a, b, x[6], 17, -1473231341); b = ff(b, c, d, a, x[7], 22, -45705983);
    a = ff(a, b, c, d, x[8], 7, 1770035416); d = ff(d, a, b, c, x[9], 12, -1958414417); c = ff(c, d, a, b, x[10], 17, -42063); b = ff(b, c, d, a, x[11], 22, -1990404162);
    a = ff(a, b, c, d, x[12], 7, 1804603682); d = ff(d, a, b, c, x[13], 12, -40341101); c = ff(c, d, a, b, x[14], 17, -1502002290); b = ff(b, c, d, a, x[15], 22, 1236535329);
    a = gg(a, b, c, d, x[1], 5, -165796510); d = gg(d, a, b, c, x[6], 9, -1069501632); c = gg(c, d, a, b, x[11], 14, 643717713); b = gg(b, c, d, a, x[0], 20, -373897302);
    a = gg(a, b, c, d, x[5], 5, -701558691); d = gg(d, a, b, c, x[10], 9, 38016083); c = gg(c, d, a, b, x[15], 14, -660478335); b = gg(b, c, d, a, x[4], 20, -405537848);
    a = gg(a, b, c, d, x[9], 5, 568446438); d = gg(d, a, b, c, x[14], 9, -1019803690); c = gg(c, d, a, b, x[3], 14, -187363961); b = gg(b, c, d, a, x[8], 20, 1163531501);
    a = gg(a, b, c, d, x[13], 5, -1444681467); d = gg(d, a, b, c, x[2], 9, -51403784); c = gg(c, d, a, b, x[7], 14, 1735328473); b = gg(b, c, d, a, x[12], 20, -1926607734);
    a = hh(a, b, c, d, x[5], 4, -378558); d = hh(d, a, b, c, x[8], 11, -2022574463); c = hh(c, d, a, b, x[11], 16, 1839030562); b = hh(b, c, d, a, x[14], 23, -35309556);
    a = hh(a, b, c, d, x[1], 4, -1530992060); d = hh(d, a, b, c, x[4], 11, 1272893353); c = hh(c, d, a, b, x[7], 16, -155497632); b = hh(b, c, d, a, x[10], 23, -1094730640);
    a = hh(a, b, c, d, x[13], 4, 681279174); d = hh(d, a, b, c, x[0], 11, -358537222); c = hh(c, d, a, b, x[3], 16, -722521979); b = hh(b, c, d, a, x[6], 23, 76029189);
    a = hh(a, b, c, d, x[9], 4, -640364487); d = hh(d, a, b, c, x[12], 11, -421815835); c = hh(c, d, a, b, x[15], 16, 530742520); b = hh(b, c, d, a, x[2], 23, -995338651);
    a = ii(a, b, c, d, x[0], 6, -198630844); d = ii(d, a, b, c, x[7], 10, 1126891415); c = ii(c, d, a, b, x[14], 15, -1416354905); b = ii(b, c, d, a, x[5], 21, -57434055);
    a = ii(a, b, c, d, x[12], 6, 1700485571); d = ii(d, a, b, c, x[3], 10, -1894986606); c = ii(c, d, a, b, x[10], 15, -1051523); b = ii(b, c, d, a, x[1], 21, -2054922799);
    a = ii(a, b, c, d, x[8], 6, 1873313359); d = ii(d, a, b, c, x[15], 10, -30611744); c = ii(c, d, a, b, x[6], 15, -1560198380); b = ii(b, c, d, a, x[13], 21, 1309151649);
    a = ii(a, b, c, d, x[4], 6, -145523070); d = ii(d, a, b, c, x[11], 10, -1120210379); c = ii(c, d, a, b, x[2], 15, 718787259); b = ii(b, c, d, a, x[9], 21, -343485551);
    k[0] = safeAdd(a, k[0]); k[1] = safeAdd(b, k[1]); k[2] = safeAdd(c, k[2]); k[3] = safeAdd(d, k[3]);
    return k;
  }
  function blk(s: string): number[] {
    const b: number[] = [];
    for (let i = 0; i < 64; i += 4) b[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    return b;
  }
  function md51(s: string): number[] {
    let n = s.length;
    let state = [1732584193, -271733879, -1732584194, 271733878];
    let i: number;
    for (i = 64; i <= s.length; i += 64) state = cycle(blk(s.substring(i - 64, i)), state);
    s = s.substring(i - 64);
    const tail: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < s.length; i += 1) tail[i >> 2] = tail[i >> 2] | (s.charCodeAt(i) << ((i % 4) << 3));
    tail[i >> 2] = tail[i >> 2] | (0x80 << ((i % 4) << 3));
    if (i > 55) { state = cycle(tail, state); for (i = 0; i < 16; i += 1) tail[i] = 0; }
    tail[14] = n * 8;
    state = cycle(tail, state);
    return state;
  }
  function rhex(num: number): string {
    let str = '';
    const hex = '0123456789abcdef';
    for (let j = 0; j < 4; j += 1) {
      str += hex.charAt((num >>> (j * 8 + 4)) & 0x0f) + hex.charAt((num >>> (j * 8)) & 0x0f);
    }
    return str;
  }
  const state = md51(unescape(encodeURIComponent(rawStr)));
  let out = '';
  for (let i = 0; i < 4; i += 1) out += rhex(state[i]);
  return out;
}

async function shaDigest(alg: string, data: Uint8Array): Promise<string> {
  const subtle = (window.crypto && (window.crypto as Crypto).subtle) || undefined;
  if (!subtle) throw new Error('当前环境不支持 Web Crypto（SHA 系列），仅 MD5 可用');
  const buf = await subtle.digest(alg, data as BufferSource);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function toBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function HashTool() {
  const [text, setText] = useState('薄荷 professional');
  const [enabled, setEnabled] = useState({ md5: true, sha1: true, sha256: true, sha512: false });
  const [results, setResults] = useState<{ alg: string; value: string }[]>([]);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const compute = useCallback(async () => {
    setError('');
    const bytes = toBytes(text);
    const out: { alg: string; value: string }[] = [];
    try {
      if (enabled.md5) out.push({ alg: 'MD5', value: md5(text) });
      if (enabled.sha1) out.push({ alg: 'SHA-1', value: await shaDigest('SHA-1', bytes) });
      if (enabled.sha256) out.push({ alg: 'SHA-256', value: await shaDigest('SHA-256', bytes) });
      if (enabled.sha512) out.push({ alg: 'SHA-512', value: await shaDigest('SHA-512', bytes) });
      setResults(out);
    } catch (e) { setError((e as Error).message); setResults([]); }
  }, [text, enabled]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    f.arrayBuffer().then((buf: ArrayBuffer) => {
      const dec = new TextDecoder().decode(buf);
      setText(dec.length > 5000 ? dec.slice(0, 5000) : dec);
    }).catch((err: unknown) => setError('读取文件失败：' + (err as Error).message));
  };

  const box = (key: keyof typeof enabled, label: string) => (
    <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-stone-300 cursor-pointer select-none">
      <input type="checkbox" checked={enabled[key]} onChange={e => setEnabled(prev => ({ ...prev, [key]: e.target.checked }))} className="accent-[var(--element-bg)]" />
      {label}
    </label>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/40 dark:bg-stone-800/40 border border-white/60 dark:border-stone-700/40">
          {box('md5', 'MD5')}{box('sha1', 'SHA-1')}{box('sha256', 'SHA-256')}{box('sha512', 'SHA-512')}
        </div>
        <button onClick={() => fileRef.current?.click()} className="btn-press px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors text-sm">选择文件</button>
        <button onClick={compute} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors ml-auto">计算</button>
        <input ref={fileRef} type="file" className="hidden" onChange={onFile} />
      </div>
      <textarea value={text} onChange={e => setText(e.target.value)} spellCheck={false}
        placeholder="输入文本，或选择文件计算哈希…"
        className="w-full h-32 p-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)] resize-y" />
      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">{error}</div>}
      {results.length > 0 && (
        <div className="space-y-2">
          {results.map(r => (
            <div key={r.alg} className="flex items-center gap-3 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 px-3 py-2">
              <span className="text-xs font-medium text-neutral-500 dark:text-stone-400 w-16 flex-shrink-0">{r.alg}</span>
              <code className="flex-1 text-sm font-mono text-neutral-700 dark:text-stone-200 break-all">{r.value}</code>
              <CopyButton text={r.value} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ========== t12 UUID 生成器 ==========
function uuidv4(): string {
  const c = window.crypto as Crypto | undefined;
  if (c && c.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function UuidTool() {
  const [count, setCount] = useState(5);
  const [upper, setUpper] = useState(false);
  const [braces, setBraces] = useState(false);
  const [list, setList] = useState<string[]>([]);

  const gen = () => {
    const n = Math.max(1, Math.min(1000, count || 1));
    const arr: string[] = [];
    for (let i = 0; i < n; i++) {
      let u = uuidv4();
      if (upper) u = u.toUpperCase();
      if (braces) u = '{' + u + '}';
      arr.push(u);
    }
    setList(arr);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-stone-300">
          数量
          <input type="number" min={1} max={1000} value={count}
            onChange={e => setCount(parseInt(e.target.value, 10))}
            className="w-20 px-2 py-1 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none focus:border-[var(--element-border)]" />
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-stone-300 cursor-pointer select-none">
          <input type="checkbox" checked={upper} onChange={e => setUpper(e.target.checked)} className="accent-[var(--element-bg)]" /> 大写
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-stone-300 cursor-pointer select-none">
          <input type="checkbox" checked={braces} onChange={e => setBraces(e.target.checked)} className="accent-[var(--element-bg)]" /> 花括号
        </label>
        <button onClick={gen} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors ml-auto">生成</button>
      </div>
      {list.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-400 dark:text-stone-500">已生成 {list.length} 个</span>
            <CopyButton text={list.join('\n')} label="复制全部" />
          </div>
          <div className="rounded-xl bg-white/40 dark:bg-stone-800/40 border border-white/60 dark:border-stone-700/40 divide-y divide-white/60 dark:divide-stone-700/40 max-h-[50vh] overflow-y-auto">
            {list.map((u, i) => (
              <div key={i} className="px-3 py-1.5 text-sm font-mono text-neutral-700 dark:text-stone-200 flex items-center gap-2">
                <span className="text-neutral-400 dark:text-stone-500 w-8 flex-shrink-0">{i + 1}.</span>
                <span className="flex-1 truncate">{u}</span>
                <CopyButton text={u} label="复制" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const TOOL_VIEWS: Record<string, () => JSX.Element> = {
  t1: ImageConverter,
  t2: DocConverter,
  t3: () => <MediaTranscoder kind="video" />,
  t4: () => <MediaTranscoder kind="audio" />,
  t5: RegexTester,
  t6: TextDiff,
  t7: JsonFormatter,
  t8: Base64Tool,
  t9: UrlTool,
  t10: CsvViewer,
  t11: HashTool,
  t12: UuidTool,
  t13: PortScanner,
  t14: ProcessManager,
  t15: EnvVars,
  t16: ClipboardHistory,
};

// ========== 主组件 ==========
function ProfessionalModule() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const handleSelectCategory = useCallback((catId: string) => {
    setSelectedCategory(catId);
    setSelectedToolId(null);
  }, []);

  const handleOpenModuleSettings = useCallback(() => {
    setShowSettings(prev => !prev);
  }, []);

  const selectedCat = CATEGORIES.find(c => c.id === selectedCategory);

  // 过滤后的工具（搜索作用于工具名/描述）
  const filteredTools = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const base = selectedCategory ? (TOOLS[selectedCategory] || []) : ALL_TOOLS;
    if (!q) return base;
    return base.filter(t => t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q));
  }, [selectedCategory, searchQuery]);

  // 二级导航：分类列表
  const categoryList = (
    <div className="space-y-0.5">
      {CATEGORIES.map((cat) => (
        <button
          key={cat.id}
          onClick={() => handleSelectCategory(cat.id)}
          className={`w-full text-left px-3 py-2 rounded-xl transition-colors text-sm ${
            selectedCategory === cat.id
              ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100'
              : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
          }`}
        >
          <div className="font-medium truncate flex items-center gap-2">
            <ToolGlyph name={cat.icon} size={18} className="text-neutral-500 dark:text-stone-400" />
            {cat.name}
          </div>
          <div className="text-xs text-neutral-400 dark:text-stone-500 mt-0.5">{cat.count} 个工具</div>
        </button>
      ))}
    </div>
  );

  // 工具卡片网格
  const toolGrid = filteredTools.length > 0 ? (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100 mb-4">
        {selectedCat?.name || '全部工具'}
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {filteredTools.map((tool) => (
          <button
            key={tool.id}
            onClick={() => setSelectedToolId(tool.id)}
            className="group rounded-xl p-4 bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 hover:border-[var(--element-border)] dark:hover:border-[var(--element-border)] transition-all cursor-pointer text-left"
          >
            <div className="w-10 h-10 rounded-xl bg-[var(--element-muted)] flex items-center justify-center mb-3 text-lg text-neutral-600 dark:text-stone-300">
              <ToolGlyph name={tool.icon} size={20} />
            </div>
            <h3 className="text-sm font-medium text-neutral-700 dark:text-stone-200">{tool.name}</h3>
            <p className="text-xs text-neutral-400 dark:text-stone-500 mt-1 line-clamp-2">{tool.desc}</p>
            {tool.needBackend && (
              <span className="inline-block mt-2 text-[10px] text-amber-500 bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 rounded">待后端</span>
            )}
          </button>
        ))}
      </div>
    </div>
  ) : null;

  const emptyHint = !selectedCategory ? (
    <div className="flex-1 flex flex-col items-center justify-center h-full gap-3 text-neutral-400 dark:text-stone-500">
      <BriefcaseIcon />
      <p className="text-sm">从左侧选择一个分类开始使用工具</p>
      <p className="text-xs text-neutral-400/60 dark:text-stone-600">全部 {ALL_TOOLS.length} 个工具已实装（音视频转码使用内置 ffmpeg）</p>
    </div>
  ) : (
    <div className="flex-1 flex flex-col items-center justify-center h-full gap-2 text-neutral-400 dark:text-stone-500">
      <p className="text-sm">未找到匹配的工具</p>
    </div>
  );

  const selectedTool = selectedToolId ? findTool(selectedToolId) : undefined;
  const ToolView = selectedToolId ? TOOL_VIEWS[selectedToolId] : undefined;

  // 侧边栏
  const sidebar = ModuleSidebarShell ? (
    <ModuleSidebarShell
      moduleId="professional"
      icon={<BriefcaseIcon />}
      title="薄荷"
      onOpenModuleSettings={handleOpenModuleSettings}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder="搜索工具..."
      children={
        SecondaryNavShell
          ? <SecondaryNavShell>{categoryList}</SecondaryNavShell>
          : <div className="flex-1 overflow-y-auto pr-1">{categoryList}</div>
      }
    />
  ) : (
    <div className="w-[260px] h-full flex-shrink-0 bg-white/60 dark:bg-stone-800/60 backdrop-blur-md border-r border-white/80 dark:border-stone-700/50 p-4 overflow-y-auto">
      <div className="flex items-center gap-2 mb-4 px-1">
        <BriefcaseIcon />
        <span className="font-bold text-lg text-neutral-800 dark:text-stone-100">薄荷</span>
      </div>
      {categoryList}
    </div>
  );

  // 模块设置
  const settingsPanel = React.createElement(
    window.__HOST_UI__?.ModuleSettingsPanel || 'div',
    {
      title: '薄荷',
      icon: React.createElement('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', children: [
        React.createElement('rect', { key: '1', x: '2', y: '7', width: '20', height: '14', rx: '2', ry: '2' }),
        React.createElement('path', { key: '2', d: 'M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' }),
      ]}),
      onClose: () => setShowSettings(false),
      children: React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'glass-panel p-4' },
          React.createElement('label', { className: 'block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2' }, '工具统计'),
          React.createElement('div', { className: 'space-y-2' },
            React.createElement('div', { className: 'flex justify-between text-sm' },
              React.createElement('span', { className: 'text-neutral-500 dark:text-stone-400' }, '工具分类'),
              React.createElement('span', { className: 'text-neutral-700 dark:text-stone-200' }, `${CATEGORIES.length} 个`),
            ),
            React.createElement('div', { className: 'flex justify-between text-sm' },
              React.createElement('span', { className: 'text-neutral-500 dark:text-stone-400' }, '工具总数'),
              React.createElement('span', { className: 'text-neutral-700 dark:text-stone-200' }, `${ALL_TOOLS.length} 个`),
            ),
            React.createElement('div', { className: 'flex justify-between text-sm' },
              React.createElement('span', { className: 'text-neutral-500 dark:text-stone-400' }, '已实装'),
              React.createElement('span', { className: 'text-neutral-700 dark:text-stone-200' }, `${Object.keys(TOOL_VIEWS).length} 个（全部）`),
            ),
          ),
        ),
        React.createElement('div', { className: 'glass-panel p-4' },
          React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500' },
            '图片 / 文档 / 端口 / 进程 / 环境变量 / 剪贴板 工具均依赖 Tauri 后端命令，已实装。音视频转码使用内置 ffmpeg（external-deps/全局/ffmpeg）。'
          ),
        ),
      ),
    }
  );

  return (
    <div className="flex-1 flex h-full overflow-hidden">
      {sidebar}
      <div className="flex-1 h-full overflow-hidden bg-[#f5f5f0] dark:bg-[#1c1917]">
        {showSettings ? (
          settingsPanel
        ) : selectedTool ? (
          <ToolShell tool={selectedTool} onBack={() => setSelectedToolId(null)}>
            {ToolView ? <ToolView /> : <ComingSoon tool={selectedTool} />}
          </ToolShell>
        ) : (
          <>
            {toolGrid}
            {emptyHint}
          </>
        )}
      </div>
    </div>
  );
}

window.__PLUGIN_REGISTRY__.register({
  id: 'professional',
  name: '薄荷',
  iconName: 'Toolbox',
  kind: 'module',
  visible: true,
  component: ProfessionalModule,
  sidebar: undefined,
  settings: undefined,
});

// 16 个功能：各自注册为 parent:'professional' 的子插件（功能即子插件）。
// 它们在注册表中归属「薄荷」，并会在茑萝模块下以「薄荷」分组呈现。
const REG = window.__PLUGIN_REGISTRY__;
for (const t of ALL_TOOLS) {
  REG.register({
    id: 'pro.' + t.id,
    name: t.name,
    desc: t.desc,
    iconName: t.icon,
    kind: 'module',
    visible: false,
    parent: 'professional',
    category: (CATEGORIES.find(c => c.id === t.category)?.name) || t.category,
    component: TOOL_VIEWS[t.id],
  });
}
