// 茑萝 · IDE 源码管理面板（阶段三）
// 调用后端 git_* 命令（git_service.rs，系统 git CLI 封装）实现：
// 变更列表（暂存/未暂存分组）+ 差异预览 + 暂存/取消暂存 + 提交 + 当前分支。
// 对齐 terax-ai-main source-control 模块的数据契约与交互（分组 + 内联 diff）。
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useEffect, useCallback } = React;
import { ideShared } from './shared';
import { GitBranch, RefreshCw, Plus, Minus, Check, FileEdit, Trash2, Loader2, ChevronDown, ChevronRight } from 'lucide-react';

// ===== 与 git_service.rs serde 输出对齐的类型 =====
type GitStatusKind =
  | 'unchanged' | 'modified' | 'added' | 'deleted' | 'renamed'
  | 'copied' | 'updated' | 'untracked' | 'ignored' | 'missing';

interface GitFileStatus {
  path: string;
  old_path: string | null;
  staged: GitStatusKind;
  unstaged: GitStatusKind;
}
interface GitStatusResult {
  branch: string;
  upstream: string | null;
  files: GitFileStatus[];
}

// 暂存区有变更的状态集合（X ∈ M/A/D/R/C/U）
const STAGED_SET = new Set<GitStatusKind>(['modified', 'added', 'deleted', 'renamed', 'copied', 'updated', 'missing']);
// 工作区有变更的状态集合（Y ∈ M/D/R/C/U/?，含未跟踪）
const UNSTAGED_SET = new Set<GitStatusKind>(['modified', 'deleted', 'renamed', 'copied', 'updated', 'missing', 'untracked']);

// 状态 → 颜色 + 单字母徽标
const KIND_BADGE: Record<GitStatusKind, { letter: string; cls: string }> = {
  unchanged: { letter: ' ', cls: '' },
  modified: { letter: 'M', cls: 'text-amber-500' },
  added: { letter: 'A', cls: 'text-emerald-500' },
  deleted: { letter: 'D', cls: 'text-red-500' },
  renamed: { letter: 'R', cls: 'text-blue-500' },
  copied: { letter: 'C', cls: 'text-blue-500' },
  updated: { letter: 'U', cls: 'text-purple-500' },
  untracked: { letter: 'U', cls: 'text-neutral-400' },
  ignored: { letter: '!', cls: 'text-neutral-400' },
  missing: { letter: '!', cls: 'text-red-500' },
};

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p;
}

// ===== 差异文本渲染：+ 绿 / - 红 / hunk 头蓝 =====
function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <div className="text-neutral-400 text-xs px-2 py-1">（无差异）</div>;
  const lines = text.split('\n');
  return (
    <pre className="text-[11px] font-mono leading-relaxed overflow-x-auto px-1 py-1 max-h-64 overflow-y-auto">
      {lines.map((ln, i) => {
        let cls = 'text-neutral-600 dark:text-stone-300';
        let bg = '';
        if (ln.startsWith('+') && !ln.startsWith('+++')) { cls = 'text-emerald-600 dark:text-emerald-400'; bg = 'bg-emerald-500/5'; }
        else if (ln.startsWith('-') && !ln.startsWith('---')) { cls = 'text-red-600 dark:text-red-400'; bg = 'bg-red-500/5'; }
        else if (ln.startsWith('@@')) { cls = 'text-blue-500'; }
        else if (ln.startsWith('diff ') || ln.startsWith('index ')) { cls = 'text-purple-500 font-medium'; }
        return <div key={i} className={`${cls} ${bg} px-1`}>{ln || ' '}</div>;
      })}
    </pre>
  );
}

// ===== 文件行 =====
interface FileRowProps {
  file: GitFileStatus;
  stagedView: boolean; // true=暂存区组（显示「取消暂存」按钮），false=工作区组（显示「暂存」按钮）
  active: boolean;
  onClick: () => void;
  onAction: () => void;
}
function FileRow({ file, stagedView, active, onClick, onAction }: FileRowProps) {
  const badge = stagedView ? KIND_BADGE[file.staged] : KIND_BADGE[file.unstaged];
  return (
    <div
      onClick={onClick}
      className={`group flex items-center gap-1 px-1.5 py-0.5 cursor-pointer text-xs ${active ? 'bg-blue-500/10' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}
    >
      <span className={`font-mono font-bold w-3 text-center ${badge.cls}`}>{badge.letter}</span>
      <span className="flex-1 truncate text-neutral-700 dark:text-stone-200" title={file.path}>
        {file.old_path ? `${shortPath(file.old_path)} → ${shortPath(file.path)}` : shortPath(file.path)}
      </span>
      <button
        onClick={(e: any) => { e.stopPropagation(); onAction(); }}
        className="shrink-0 opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200"
        title={stagedView ? '取消暂存' : '暂存'}
      >
        {stagedView ? <Minus size={13} /> : <Plus size={13} />}
      </button>
    </div>
  );
}

export function SourceControl() {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [diffPath, setDiffPath] = useState<{ path: string; staged: boolean } | null>(null);
  const [diffText, setDiffText] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<{ staged: boolean; changes: boolean }>({ staged: false, changes: false });

  const root = ideShared.projectRoot;

  const refresh = useCallback(async () => {
    if (!root) { setStatus(null); setError(null); return; }
    setLoading(true); setError(null);
    try {
      const r = await hostApi.invoke<GitStatusResult>('git_status', { repo: root });
      setStatus(r);
    } catch (e: any) {
      setError(String(e?.message || e));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [root]);

  // 挂载 + 项目切换时刷新；窗口重新聚焦时刷新（用户可能在外部编辑器改了文件）
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const stage = async (path: string) => {
    if (!root) return;
    try { await hostApi.invoke('git_stage', { repo: root, path }); await refresh(); } catch (e: any) { setError(String(e?.message || e)); }
  };
  const unstage = async (path: string) => {
    if (!root) return;
    try { await hostApi.invoke('git_unstage', { repo: root, path }); await refresh(); } catch (e: any) { setError(String(e?.message || e)); }
  };
  const commit = async () => {
    if (!root || !commitMsg.trim() || committing) return;
    setCommitting(true); setError(null);
    try {
      await hostApi.invoke('git_commit', { repo: root, message: commitMsg });
      setCommitMsg('');
      await refresh();
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setCommitting(false); }
  };

  const showDiff = useCallback(async (path: string, staged: boolean) => {
    if (!root) return;
    setDiffPath({ path, staged }); setDiffLoading(true); setDiffText('');
    try {
      const d = await hostApi.invoke<string>('git_diff', { repo: root, staged, path });
      setDiffText(d || '');
    } catch (e: any) { setDiffText('获取差异失败：' + String(e?.message || e)); }
    finally { setDiffLoading(false); }
  }, [root]);

  if (!root) {
    return <div className="text-xs text-neutral-400 dark:text-stone-500 px-3 py-2">未打开项目，无法显示源码管理。</div>;
  }

  const stagedFiles = (status?.files || []).filter((f) => STAGED_SET.has(f.staged));
  const unstagedFiles = (status?.files || []).filter((f) => UNSTAGED_SET.has(f.unstaged));
  const hasStaged = stagedFiles.length > 0;

  return (
    <div className="flex flex-col h-full text-xs">
      {/* 头部：分支 + 刷新 */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-neutral-200/60 dark:border-stone-700/60 shrink-0">
        <GitBranch size={13} className="text-neutral-500 dark:text-stone-400 shrink-0" />
        <span className="font-medium text-neutral-700 dark:text-stone-200 truncate flex-1" title={status?.branch}>
          {status?.branch || '—'}
        </span>
        {status?.upstream && (
          <span className="text-[10px] text-neutral-400 dark:text-stone-500 truncate max-w-[80px]" title={status.upstream}>
            ↑{status.upstream}
          </span>
        )}
        <button onClick={refresh} className="btn-press text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200 shrink-0" title="刷新">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="px-2 py-1 bg-red-500/10 text-red-500 text-[11px] shrink-0">
          {error.includes('不是 git 仓库') ? '当前项目不是 git 仓库' : error}
        </div>
      )}

      {/* 提交信息输入框 */}
      <div className="p-1.5 border-b border-neutral-200/60 dark:border-stone-700/60 shrink-0">
        <textarea
          value={commitMsg}
          onChange={(e: any) => setCommitMsg(e.target.value)}
          onKeyDown={(e: any) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && hasStaged) commit();
          }}
          placeholder={hasStaged ? '提交信息（Ctrl+Enter 提交已暂存的改动）' : '先暂存改动再提交'}
          disabled={!hasStaged || committing}
          rows={2}
          className="w-full text-xs px-1.5 py-1 rounded border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-neutral-700 dark:text-stone-200 resize-none focus:outline-none focus:border-blue-400 disabled:opacity-50"
        />
        <button
          onClick={commit}
          disabled={!hasStaged || !commitMsg.trim() || committing}
          className="btn-press w-full mt-1 py-1 rounded text-center text-xs font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1"
        >
          {committing ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          提交
        </button>
      </div>

      {/* 变更列表 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* 暂存的改动 */}
        <div>
          <div
            className="flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 sticky top-0 bg-neutral-50/95 dark:bg-stone-900/95 backdrop-blur-sm z-10"
            onClick={() => setCollapsed((c) => ({ ...c, staged: !c.staged }))}
          >
            {collapsed.staged ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <span className="font-medium text-neutral-600 dark:text-stone-300">暂存的改动</span>
            <span className="text-neutral-400">{stagedFiles.length}</span>
            {stagedFiles.length > 0 && (
              <button
                onClick={(e: any) => { e.stopPropagation(); unstage('.'); }}
                className="ml-auto text-[10px] text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200"
                title="取消全部暂存"
              >全部取消</button>
            )}
          </div>
          {!collapsed.staged && stagedFiles.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              stagedView={true}
              active={diffPath?.path === f.path && diffPath.staged}
              onClick={() => showDiff(f.path, true)}
              onAction={() => unstage(f.path)}
            />
          ))}
        </div>

        {/* 工作区改动 */}
        <div>
          <div
            className="flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 sticky top-0 bg-neutral-50/95 dark:bg-stone-900/95 backdrop-blur-sm z-10"
            onClick={() => setCollapsed((c) => ({ ...c, changes: !c.changes }))}
          >
            {collapsed.changes ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <span className="font-medium text-neutral-600 dark:text-stone-300">改动</span>
            <span className="text-neutral-400">{unstagedFiles.length}</span>
            {unstagedFiles.length > 0 && (
              <button
                onClick={(e: any) => { e.stopPropagation(); stage('.'); }}
                className="ml-auto text-[10px] text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200"
                title="暂存全部"
              >全部暂存</button>
            )}
          </div>
          {!collapsed.changes && unstagedFiles.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              stagedView={false}
              active={diffPath?.path === f.path && !diffPath.staged}
              onClick={() => showDiff(f.path, f.unstaged !== 'untracked')}
              onAction={() => stage(f.path)}
            />
          ))}
        </div>

        {status && status.files.length === 0 && !error && (
          <div className="px-3 py-4 text-center text-neutral-400 dark:text-stone-500">
            <Check size={20} className="mx-auto mb-1 text-emerald-500" />
            工作区干净，无待提交改动
          </div>
        )}
      </div>

      {/* 差异预览（底部固定区） */}
      {diffPath && (
        <div className="border-t border-neutral-200 dark:border-stone-700 shrink-0 max-h-[40%] flex flex-col">
          <div className="flex items-center gap-1.5 px-2 py-1 bg-neutral-100/80 dark:bg-stone-800/80">
            <FileEdit size={12} className="text-neutral-400 shrink-0" />
            <span className="text-[11px] truncate flex-1 text-neutral-600 dark:text-stone-300" title={diffPath.path}>
              {shortPath(diffPath.path)}
            </span>
            <span className="text-[10px] text-neutral-400">{diffPath.staged ? '已暂存' : '未暂存'}</span>
            <button onClick={() => { setDiffPath(null); setDiffText(''); }} className="text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200 text-[11px]">✕</button>
          </div>
          {diffLoading ? (
            <div className="flex items-center gap-1 px-2 py-2 text-neutral-400"><Loader2 size={12} className="animate-spin" /> 加载差异…</div>
          ) : (
            <DiffView text={diffText} />
          )}
        </div>
      )}
    </div>
  );
}
