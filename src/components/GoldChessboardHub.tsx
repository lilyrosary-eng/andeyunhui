import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { FileSearchPanel } from '@/components/FileSearchPanel';
import { useI18n } from '@/lib/i18n';

interface TransferPeer {
  fingerprint: string;
  alias: string;
  device_type?: string;
  device_model?: string;
  ip: string;
  port: number;
  protocol: string;
}

interface TransferProgressItem {
  direction: string;
  session_id: string;
  file_id: string;
  file_name: string;
  received: number;
  total: number;
  done: boolean;
  peer_alias: string;
}

// ======== 传输面板（主窗口风格，CSS 变量自适应主题）========
function TransferTab() {
  const { t } = useI18n();
  const [peers, setPeers] = useState<TransferPeer[]>([]);
  const [progress, setProgress] = useState<TransferProgressItem[]>([]);
  const [running, setRunning] = useState(false);
  const [alias, setAlias] = useState('安得云荟');
  const [staged, setStagedState] = useState<string[]>([]);
  const [confirmPeer, setConfirmPeer] = useState<TransferPeer | null>(null);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [stagedOpen, setStagedOpen] = useState(false); // 暂存文件下拉总览

  // 暂存文件走 Rust 端持久化（<appdata>/transfer/config.json），跨 webview 共用
  const setStaged = (updater: string[] | ((prev: string[]) => string[])) => {
    setStagedState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      invoke('transfer_set_staged', { paths: next }).catch(() => {});
      return next;
    });
  };

  useEffect(() => {
    const offs: Array<() => void> = [];
    (async () => {
      await invoke('transfer_start').catch(() => {});
      const st = (await invoke('transfer_status').catch(() => ({}))) as { running?: boolean; alias?: string };
      // 服务已在 transfer_start 后运行，立即置为已开启，避免先显示「未开启」再跳正常的 1 秒闪烁
      setRunning(!!st?.running);
      setAlias(st?.alias || '安得云荟');
      await invoke('transfer_announce').catch(() => {});
      const list = (await invoke('transfer_list_peers').catch(() => [])) as TransferPeer[];
      setPeers(list);
      const s = (await invoke('transfer_get_staged').catch(() => [])) as string[];
      setStagedState(s);
    })();
    listen('transfer-peer-found', (e: { payload: TransferPeer }) => {
      const p = e.payload;
      setPeers((prev) => (prev.some((x) => x.fingerprint === p.fingerprint) ? prev : [...prev, p]));
    }).then((u) => offs.push(u));
    listen('transfer-progress', (e: { payload: TransferProgressItem }) => {
      const p = e.payload;
      setProgress((prev) => {
        const next = prev.filter((x) => !(x.session_id === p.session_id && x.file_id === p.file_id));
        return [...next, p];
      });
    }).then((u) => offs.push(u));
    // 接收确认弹窗已统一交由 App 根挂载的全局 TransferReceiveModal 处理，
    // 此处不再重复监听，避免与主窗/浮岛同时弹出重复确认框。
    return () => offs.forEach((u) => u());
  }, []);

  const applyAlias = async (v: string) => {
    const val = v.trim() || '安得云荟';
    setAlias(val);
    await invoke('transfer_set_alias', { alias: val }).catch(() => {});
  };

  // 发送出错必须在 UI 可见（.catch 只打 console 用户看不到，表现为「点了没反应」）
  const doSend = async (fingerprint: string, paths: string[]) => {
    setSendErr(null);
    try {
      await invoke('transfer_send', { fingerprint, paths });
    } catch (e) {
      setSendErr(String(e));
    }
  };

  const sendTo = async (peer: TransferPeer) => {
    if (staged.length > 0) {
      setConfirmPeer(peer);
      return;
    }
    const picked = (await open({ multiple: true, title: '选择要发送的文件' })) as string[] | null;
    if (!picked || picked.length === 0) return;
    await doSend(peer.fingerprint, picked);
  };

  const confirmSend = async () => {
    if (!confirmPeer) return;
    const paths = staged;
    const fp = confirmPeer.fingerprint;
    setConfirmPeer(null);
    setStaged([]);
    await doSend(fp, paths);
  };

  const addFiles = async () => {
    const picked = (await open({ multiple: true, title: '选择要发送的文件' })) as string[] | null;
    if (picked && picked.length) setStaged((prev) => Array.from(new Set([...prev, ...picked])));
  };

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer?.files) {
      const paths: string[] = [];
      for (const f of Array.from(e.dataTransfer.files)) {
        if ((f as unknown as { path?: string }).path) {
          paths.push((f as unknown as { path: string }).path);
        }
      }
      if (paths.length) setStaged((prev) => Array.from(new Set([...prev, ...paths])));
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
  }, []);

  useEffect(() => {
    window.addEventListener('drop', handleDrop);
    window.addEventListener('dragover', handleDragOver);
    return () => {
      window.removeEventListener('drop', handleDrop);
      window.removeEventListener('dragover', handleDragOver);
    };
  }, [handleDrop, handleDragOver]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden main-panel-bg fade-in">
      {/* 标题栏 */}
      <div className="flex items-center gap-3 px-6 pt-5 pb-2 shrink-0">
        <div className="w-10 h-10 rounded-xl bg-[var(--element-bg)]/10 flex items-center justify-center text-[var(--element-color-raw)] text-lg font-bold">
          ⇄
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-neutral-800 dark:text-stone-100">{t('niaoluo.search.title')} · 传输</h2>
          <p className="text-xs text-neutral-400 dark:text-stone-500 mt-0.5 truncate">
            {running ? '已开启 · 可被同网设备发现' : '未开启'} · 兼容 LocalSend
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
        {/* 本机名称 */}
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs text-neutral-400 dark:text-stone-500 shrink-0">本机名称</span>
          <input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            onBlur={(e) => applyAlias(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="flex-1 min-w-0 rounded-lg border border-white/50 dark:border-stone-600/40 bg-white/60 dark:bg-stone-700/40 px-3 py-1.5 text-sm text-neutral-700 dark:text-stone-200 placeholder:text-neutral-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-1 focus:ring-[var(--element-border)] focus:border-transparent transition-all"
          />
        </div>

        {/* 拖入区域 + 暂存文件下拉总览（与浮岛一致：➕ 左边是总览按钮，点开列出全部待发送文件，导入不受影响） */}
        <div className="relative mb-3">
          <div
            className="rounded-xl border border-dashed border-neutral-300/60 dark:border-stone-600/40 bg-white/40 dark:bg-stone-700/20 p-3 min-h-[48px] cursor-pointer hover:border-[var(--element-border)] hover:bg-white/60 dark:hover:bg-stone-700/30 transition-colors flex items-center gap-2"
            onClick={() => { if (staged.length === 0) addFiles(); }}
          >
            {staged.length === 0 ? (
              <p className="flex-1 text-xs text-neutral-400 dark:text-stone-500 text-center">把文件拖到这里，或点此选择</p>
            ) : (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setStagedOpen((v) => !v); }}
                title={stagedOpen ? '收起文件列表' : '查看全部待发送文件'}
                className="flex-1 min-w-0 h-8 flex items-center justify-between gap-2 px-2 rounded-lg bg-[var(--element-bg)]/8 text-xs text-neutral-600 dark:text-stone-300"
              >
                <span className="truncate">已选 {staged.length} 个文件 · {staged[0].split(/[/]/).pop()}{staged.length > 1 ? ' 等' : ''}</span>
                <span className={`text-[var(--element-color-raw)] text-[10px] transition-transform ${stagedOpen ? 'rotate-180' : ''}`}>▼</span>
              </button>
            )}
            <button onClick={(e) => { e.stopPropagation(); addFiles(); }} className="shrink-0 text-xs text-[var(--element-color-raw)] hover:underline">＋</button>
          </div>

          {stagedOpen && staged.length > 0 && (
            <div
              className="absolute left-0 right-0 top-full mt-1 rounded-xl border border-white/20 dark:border-stone-700/50 bg-white dark:bg-stone-800 shadow-xl p-1.5 max-h-44 overflow-y-auto"
              style={{ zIndex: 15 }}
              onClick={(e) => e.stopPropagation()}
            >
              {staged.map((p) => {
                const name = p.split(/[/]/).pop() || p;
                return (
                  <div key={p} className="flex items-center gap-2 px-2 py-1 rounded-lg" title={p}>
                    <span className="flex-1 min-w-0 text-xs text-neutral-600 dark:text-stone-300 truncate">{name}</span>
                    <button onClick={() => setStaged((prev) => { const next = prev.filter((x) => x !== p); if (next.length === 0) setStagedOpen(false); return next; })} className="shrink-0 text-neutral-400 hover:text-red-500 w-4 h-4 flex items-center justify-center">×</button>
                  </div>
                );
              })}
              <div className="flex justify-end mt-1 pt-1 border-t border-white/40 dark:border-stone-700/40">
                <button onClick={() => { setStaged([]); setStagedOpen(false); }} className="text-xs text-neutral-400 hover:text-red-500">清空全部</button>
              </div>
            </div>
          )}
        </div>

        {/* 对等端列表 */}
        {peers.length === 0 && (
          <p className="text-sm text-neutral-400 dark:text-stone-500 text-center py-6">
            正在发现同网设备…（开启官方 LocalSend 或本应用即可互传）
          </p>
        )}
        <div className="flex flex-col gap-2">
          {peers.map((p) => (
            <div key={p.fingerprint} className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-transparent hover:bg-white/60 dark:hover:bg-stone-700/30 hover:border-white/40 dark:hover:border-stone-600/30 transition-colors">
              <span className="w-7 h-7 rounded-lg bg-[var(--element-bg)]/8 flex items-center justify-center text-[var(--element-color-raw)] text-sm font-bold shrink-0">
                {p.alias[0] || '?'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 truncate">{p.alias}</div>
                <div className="text-[11px] text-neutral-400 dark:text-stone-500 truncate">{p.ip}:{p.port}</div>
              </div>
              <button
                onClick={() => sendTo(p)}
                className="px-3 py-1.5 rounded-lg bg-[var(--element-bg)]/10 text-[var(--element-color-raw)] text-xs font-medium hover:bg-[var(--element-bg)]/20 transition-colors shrink-0"
              >
                发送
              </button>
            </div>
          ))}
        </div>

        {/* 发送错误提示 */}
        {sendErr && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
            <span className="flex-1 min-w-0 text-xs text-red-500 dark:text-red-400 truncate" title={sendErr}>发送失败：{sendErr}</span>
            <button onClick={() => setSendErr(null)} className="text-red-400 hover:text-red-500 w-4 h-4 flex items-center justify-center shrink-0">×</button>
          </div>
        )}

        {/* 传输进度 */}
        {progress.length > 0 && (
          <div className="mt-4 flex flex-col gap-1.5 max-h-40 overflow-y-auto">
            {progress.map((p) => (
              <div key={p.session_id + p.file_id} className="text-xs text-neutral-500 dark:text-stone-400">
                {p.done ? '✓' : '↻'} {p.direction === 'send' ? '发→' : '收←'} {p.peer_alias}：{p.file_name}
                {!p.done && p.total > 0 ? ` ${Math.round((p.received / p.total) * 100)}%` : ''}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 发送前确认弹窗 */}
      {confirmPeer && (
        <div className="absolute inset-0 bg-black/20 flex items-center justify-center z-20" onClick={() => setConfirmPeer(null)}>
          <div className="bg-white dark:bg-stone-800 rounded-xl p-5 w-72 shadow-xl border border-white/20 dark:border-stone-700/50" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-neutral-800 dark:text-stone-100">发送给「{confirmPeer.alias}」？</h3>
            <p className="text-xs text-neutral-500 dark:text-stone-400 mt-2">
              共 {staged.length} 个文件（{staged.map((p) => p.split(/[/]/).pop()).join('、')}）
            </p>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setConfirmPeer(null)} className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-stone-600 text-xs text-neutral-500 dark:text-stone-400 hover:bg-neutral-100 dark:hover:bg-stone-700 transition-colors">取消</button>
              <button onClick={confirmSend} className="px-3 py-1.5 rounded-lg bg-[var(--element-bg)] text-white text-xs font-medium hover:opacity-90 transition-opacity">确认发送</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ======== 黄金棋盘主窗口 Hub（侧栏 Tab 由 HostSidebar 控制） ========
export function GoldChessboardHub() {
  const [tab, setTab] = useState<'search' | 'transfer'>(() => {
    try { return localStorage.getItem('niaoluo:capsule-tab') === 'transfer' ? 'transfer' : 'search'; } catch { return 'search'; }
  });

  // 响应 HostSidebar 的 tab 切换事件
  useEffect(() => {
    const onTab = () => {
      try { setTab(localStorage.getItem('niaoluo:capsule-tab') === 'transfer' ? 'transfer' : 'search'); } catch {}
    };
    window.addEventListener('capsule-tab-changed', onTab);
    // 也监听 storage 事件（跨 webview 同步，仅主窗口内有效）
    window.addEventListener('storage', (e) => {
      if (e.key === 'niaoluo:capsule-tab') onTab();
    });
    return () => {
      window.removeEventListener('capsule-tab-changed', onTab);
      window.removeEventListener('storage', onTab as EventListener);
    };
  }, []);

  return (
    <div className="flex-1 flex min-w-0">
      {tab === 'search' ? (
        <FileSearchPanel variant="panel" />
      ) : (
        <TransferTab />
      )}
    </div>
  );
}

export default GoldChessboardHub;
