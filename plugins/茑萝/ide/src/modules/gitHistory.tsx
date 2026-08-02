// 茑萝 · IDE Git 历史面板（阶段三）
// 调用后端 git_log（git_service.rs）展示提交历史。
// 设计：扁平提交列表 + 合并提交标记 + 点击查看详情。
// 暂不实现复杂 lane 合并图算法（terax-ai 的 lane 算法较重），优先稳定美观与轻量，
// 用颜色区分分支首提交/合并提交，后续可迭代为完整 lane 图。
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useEffect, useCallback } = React;
import { ideShared } from './shared';
import { GitCommit, RefreshCw, Loader2, GitBranch, Clock, User, X } from 'lucide-react';

interface GitCommitRow {
  sha: string;
  short_sha: string;
  author: string;
  email: string;
  time: number; // unix 秒
  parents: string[];
  message: string;
}

function formatTime(unixSec: number): string {
  const now = Date.now() / 1000;
  const diff = now - unixSec;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 2592000) return Math.floor(diff / 86400) + ' 天前';
  // 超过 30 天显示日期
  const d = new Date(unixSec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 简单哈希 → HSL 色相，给每个提交一个稳定颜色（用于点圆）
function colorForSha(sha: string): string {
  let h = 0;
  for (let i = 0; i < sha.length && i < 8; i++) h = (h * 31 + sha.charCodeAt(i)) % 360;
  return `hsl(${h}, 65%, 55%)`;
}

export function GitHistory() {
  const [commits, setCommits] = useState<GitCommitRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<GitCommitRow | null>(null);

  const root = ideShared.projectRoot;

  const refresh = useCallback(async () => {
    if (!root) { setCommits([]); setError(null); return; }
    setLoading(true); setError(null);
    try {
      const r = await hostApi.invoke<GitCommitRow[]>('git_log', { repo: root, max: 200 });
      setCommits(r);
    } catch (e: any) {
      setError(String(e?.message || e));
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!root) {
    return <div className="text-xs text-neutral-400 dark:text-stone-500 px-3 py-2">未打开项目，无法显示提交历史。</div>;
  }

  return (
    <div className="flex flex-col h-full text-xs">
      {/* 头部 */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-neutral-200/60 dark:border-stone-700/60 shrink-0">
        <GitCommit size={13} className="text-neutral-500 dark:text-stone-400 shrink-0" />
        <span className="font-medium text-neutral-700 dark:text-stone-200 flex-1">提交历史</span>
        <span className="text-neutral-400">{commits.length}</span>
        <button onClick={refresh} className="btn-press text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200 shrink-0" title="刷新">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="px-2 py-1 bg-red-500/10 text-red-500 text-[11px] shrink-0">
          {error.includes('不是 git 仓库') ? '当前项目不是 git 仓库' : error}
        </div>
      )}

      {/* 提交列表 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && commits.length === 0 && (
          <div className="flex items-center gap-1 px-3 py-3 text-neutral-400"><Loader2 size={13} className="animate-spin" /> 加载历史…</div>
        )}

        {commits.map((c, i) => {
          const isMerge = c.parents.length > 1;
          const isHead = i === 0;
          return (
            <div
              key={c.sha}
              onClick={() => setSelected(c)}
              className={`group flex items-start gap-1.5 px-2 py-1 cursor-pointer border-l-2 ${
                selected?.sha === c.sha ? 'bg-blue-500/10 border-blue-500' : 'border-transparent hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              {/* 提交点 + 连线 */}
              <div className="flex flex-col items-center shrink-0 pt-0.5" style={{ width: 14 }}>
                <span
                  className="rounded-full ring-2 ring-white dark:ring-stone-900"
                  style={{ width: 9, height: 9, backgroundColor: colorForSha(c.sha), boxShadow: isMerge ? '0 0 0 2px hsl(280,65%,55%)' : 'none' }}
                  title={isMerge ? '合并提交' : '提交'}
                />
                {i < commits.length - 1 && <span className="w-px flex-1 bg-neutral-200 dark:bg-stone-700 mt-0.5" style={{ minHeight: 14 }} />}
              </div>

              {/* 提交信息 */}
              <div className="flex-1 min-w-0">
                <div className="text-neutral-700 dark:text-stone-200 truncate" title={c.message}>{c.message}</div>
                <div className="flex items-center gap-2 mt-0.5 text-[10px] text-neutral-400 dark:text-stone-500">
                  <span className="font-mono text-purple-500 dark:text-purple-400">{c.short_sha}</span>
                  <span className="flex items-center gap-0.5 truncate max-w-[80px]"><User size={9} />{c.author}</span>
                  <span className="flex items-center gap-0.5 shrink-0"><Clock size={9} />{formatTime(c.time)}</span>
                  {isHead && <span className="text-emerald-500 font-medium shrink-0">HEAD</span>}
                  {isMerge && <span className="text-amber-500 shrink-0" title={`${c.parents.length} 个父提交`}>⤵ merge</span>}
                </div>
              </div>
            </div>
          );
        })}

        {!loading && commits.length === 0 && !error && (
          <div className="px-3 py-4 text-center text-neutral-400 dark:text-stone-500">暂无提交历史</div>
        )}
      </div>

      {/* 提交详情抽屉 */}
      {selected && (
        <div className="border-t border-neutral-200 dark:border-stone-700 shrink-0 max-h-[45%] overflow-y-auto bg-neutral-50/80 dark:bg-stone-800/50">
          <div className="flex items-center gap-1.5 px-2 py-1.5 sticky top-0 bg-neutral-100/95 dark:bg-stone-800/95 backdrop-blur-sm">
            <GitBranch size={12} className="text-purple-500 shrink-0" />
            <span className="font-mono text-[11px] text-purple-500 dark:text-purple-400 flex-1 truncate">{selected.short_sha}</span>
            <button onClick={() => setSelected(null)} className="text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200">
              <X size={13} />
            </button>
          </div>
          <div className="px-2 py-1.5 space-y-1">
            <div className="text-neutral-700 dark:text-stone-200">{selected.message}</div>
            <div className="text-[10px] text-neutral-400 dark:text-stone-500 space-y-0.5">
              <div className="flex items-center gap-1"><User size={10} />{selected.author} &lt;{selected.email}&gt;</div>
              <div className="flex items-center gap-1"><Clock size={10} />{new Date(selected.time * 1000).toLocaleString('zh-CN')}</div>
              <div className="flex items-center gap-1"><GitCommit size={10} />完整 sha: <span className="font-mono">{selected.sha}</span></div>
              <div>父提交: {selected.parents.length > 0 ? selected.parents.map((p) => p.slice(0, 7)).join(', ') : '（根提交）'}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
