// 移动端传输 hook（LocalSend v2 兼容）。
//
// 与桌面 src/core/transfer/useTransfer.ts 同源，差异点：
//  1. 文件选择走 Android SAF 原生桥（window.AndroidTransfer.pickFile），
//     不依赖 @tauri-apps/plugin-dialog（Android 无原生文件对话框）。
//     content:// URI 由 MainActivity 复制到 cacheDir 临时文件后回调路径数组。
//  2. 接收确认由本 hook 内联管理（移动端无全局 TransferReceiveModal 根挂载），
//     暴露 receiveRequests 队列给 TransferScreen 渲染 BottomSheet。
//
// 后端命令与事件契约见 src-tauri/src/transfer.rs。

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isAndroid } from '@/platform/isMobile';

export interface TransferPeer {
  fingerprint: string;
  alias: string;
  device_type?: string | null;
  device_model?: string | null;
  ip: string;
  port: number;
  protocol: string;
}

export interface TransferProgressItem {
  direction: 'send' | 'receive';
  session_id: string;
  file_id: string;
  file_name: string;
  received: number;
  total: number;
  done: boolean;
  peer_alias: string;
}

/** 收到的传输请求载荷（兼容后端两种字段形态）。 */
export interface ReceiveRequest {
  session_id: string;
  alias?: string;
  sender_alias?: string;
  files?: Array<{ file_name?: string; size?: number }>;
  file_names?: string[];
  file_count?: number;
  auto_accept?: boolean;
}

/** SAF 桥全局回调签名：MainActivity 在选择完成时调用 window.__transferFilePicked(reqId, paths|null)。 */
type FilePickedFn = (reqId: string, paths: string[] | null) => void;

declare global {
  interface Window {
    AndroidTransfer?: { pickFile: (reqId: string) => void; isAvailable: () => boolean };
    __transferFilePicked?: FilePickedFn;
  }
}

/** 等待中的 SAF 选择请求：reqId → resolver。 */
const pendingPicks = new Map<string, (paths: string[] | null) => void>();

/** 安装 SAF 全局回调（仅 Android 有 window.AndroidTransfer）。幂等。 */
function installSafCallback() {
  if (window.__transferFilePicked) return;
  window.__transferFilePicked = (reqId, paths) => {
    const resolve = pendingPicks.get(reqId);
    if (resolve) {
      pendingPicks.delete(reqId);
      resolve(paths);
    }
  };
}

/**
 * 选择文件：
 *  - Android：走 SAF 原生桥（window.AndroidTransfer.pickFile）。
 *  - 桌面/兜底：走 @tauri-apps/plugin-dialog（开发期 web 预览可用）。
 */
async function pickFiles(): Promise<string[] | null> {
  if (isAndroid() && window.AndroidTransfer?.isAvailable?.()) {
    installSafCallback();
    const reqId = `pick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<string[] | null>((resolve) => {
      pendingPicks.set(reqId, resolve);
      try {
        window.AndroidTransfer!.pickFile(reqId);
      } catch {
        pendingPicks.delete(reqId);
        resolve(null);
      }
      // 30s 超时兜底（用户不选也不回调会导致 Promise 永挂）
      setTimeout(() => {
        if (pendingPicks.has(reqId)) {
          pendingPicks.delete(reqId);
          resolve(null);
        }
      }, 30000);
    });
  }
  // 桌面/开发兜底
  const open = (await import('@tauri-apps/plugin-dialog')).open;
  const picked = (await open({ multiple: true, title: '选择要发送的文件' })) as string[] | null;
  return picked;
}

export function useTransfer() {
  const [peers, setPeers] = useState<TransferPeer[]>([]);
  const [progress, setProgress] = useState<TransferProgressItem[]>([]);
  const [running, setRunning] = useState(false);
  const [alias, setAlias] = useState('安得云荟');
  const [staged, setStagedState] = useState<string[]>([]);
  const [autoAccept, setAutoAcceptState] = useState(false);
  const [saveDir, setSaveDir] = useState('');
  const [receiveRequests, setReceiveRequests] = useState<ReceiveRequest[]>([]);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [confirmPeer, setConfirmPeer] = useState<TransferPeer | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 暂存文件走 Rust 端持久化（<appdata>/transfer/config.json）
  const setStaged = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    setStagedState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      invoke('transfer_set_staged', { paths: next }).catch(() => {});
      return next;
    });
  }, []);

  useEffect(() => {
    const offs: Array<() => void> = [];
    (async () => {
      await invoke('transfer_start').catch(() => {});
      const st = (await invoke('transfer_status').catch(() => ({}))) as {
        running?: boolean;
        alias?: string;
      };
      if (!mountedRef.current) return;
      setRunning(!!st?.running);
      setAlias(st?.alias || '安得云荟');
      await invoke('transfer_announce').catch(() => {});
      const list = (await invoke('transfer_list_peers').catch(() => [])) as TransferPeer[];
      const s = (await invoke('transfer_get_staged').catch(() => [])) as string[];
      const aa = (await invoke('transfer_get_auto_accept').catch(() => false)) as boolean;
      const sd = (await invoke('transfer_get_save_dir').catch(() => '')) as string;
      if (!mountedRef.current) return;
      setPeers(list);
      setStagedState(s);
      setAutoAcceptState(aa);
      setSaveDir(sd);
    })();

    listen('transfer-peer-found', (e: { payload: TransferPeer }) => {
      const p = e.payload;
      setPeers((prev) =>
        prev.some((x) => x.fingerprint === p.fingerprint) ? prev : [...prev, p],
      );
    }).then((u) => offs.push(u));

    listen('transfer-progress', (e: { payload: TransferProgressItem }) => {
      const p = e.payload;
      setProgress((prev) => {
        const next = prev.filter(
          (x) => !(x.session_id === p.session_id && x.file_id === p.file_id),
        );
        // 完成项保留 3 秒后自动清除，避免列表无限堆积（移动端可视区有限）
        const merged = [...next, p];
        return merged;
      });
      // 完成项延时清理
      if (p.done) {
        setTimeout(() => {
          if (!mountedRef.current) return;
          setProgress((prev) =>
            prev.filter(
              (x) => !(x.session_id === p.session_id && x.file_id === p.file_id),
            ),
          );
        }, 3000);
      }
    }).then((u) => offs.push(u));

    // 接收请求：入队待用户确认（auto_accept=true 时也入队作 UI 提示，后端已自动建会话）
    listen('transfer-receive-request', (e: { payload: ReceiveRequest }) => {
      const p = e.payload;
      if (!p?.session_id) return;
      setReceiveRequests((q) =>
        q.some((x) => x.session_id === p.session_id) ? q : [...q, p],
      );
    }).then((u) => offs.push(u));

    return () => offs.forEach((u) => u());
  }, []);

  const applyAlias = useCallback(async (v: string) => {
    const val = v.trim() || '安得云荟';
    setAlias(val);
    await invoke('transfer_set_alias', { alias: val }).catch(() => {});
  }, []);

  const doSend = useCallback(async (fingerprint: string, paths: string[]) => {
    setSendErr(null);
    if (paths.length === 0) return;
    try {
      await invoke('transfer_send', { fingerprint, paths });
    } catch (e) {
      setSendErr(String(e));
    }
  }, []);

  // 点对端：有暂存 → 确认发送；无暂存 → 系统文件选择器
  const sendTo = useCallback(
    async (peer: TransferPeer) => {
      if (staged.length > 0) {
        setConfirmPeer(peer);
        return;
      }
      const picked = await pickFiles();
      if (!picked || picked.length === 0) return;
      await doSend(peer.fingerprint, picked);
    },
    [staged.length, doSend],
  );

  const confirmSend = useCallback(async () => {
    if (!confirmPeer) return;
    const paths = staged;
    const fp = confirmPeer.fingerprint;
    setConfirmPeer(null);
    setStaged([]);
    await doSend(fp, paths);
  }, [confirmPeer, staged, doSend, setStaged]);

  const addFiles = useCallback(async () => {
    const picked = await pickFiles();
    if (picked && picked.length) {
      setStaged((prev) => Array.from(new Set([...prev, ...picked])));
    }
  }, [setStaged]);

  // 直接选择并发送（不经暂存）
  const pickAndSend = useCallback(
    async (peer: TransferPeer) => {
      const picked = await pickFiles();
      if (!picked || picked.length === 0) return;
      await doSend(peer.fingerprint, picked);
    },
    [doSend],
  );

  const acceptReceive = useCallback(async (sessionId: string) => {
    await invoke('transfer_receive_accept', { sessionId }).catch(() => {});
    setReceiveRequests((q) => q.filter((x) => x.session_id !== sessionId));
  }, []);

  const declineReceive = useCallback(async (sessionId: string) => {
    await invoke('transfer_receive_decline', { sessionId }).catch(() => {});
    setReceiveRequests((q) => q.filter((x) => x.session_id !== sessionId));
  }, []);

  const toggleAutoAccept = useCallback(async (v: boolean) => {
    setAutoAcceptState(v);
    await invoke('transfer_set_auto_accept', { v }).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    await invoke('transfer_announce').catch(() => {});
    const list = (await invoke('transfer_list_peers').catch(() => [])) as TransferPeer[];
    setPeers(list);
  }, []);

  /** 手动添加对端（组播/广播失效时的兜底）：传 IP，后端 HTTP 探测 info 并加入 peers */
  const addPeer = useCallback(
    async (ip: string) => {
      const raw = await invoke('transfer_add_peer', { ip });
      await refresh();
      return raw as TransferPeer;
    },
    [refresh],
  );

  return {
    peers,
    progress,
    running,
    alias,
    staged,
    autoAccept,
    saveDir,
    receiveRequests,
    confirmPeer,
    sendErr,
    setAlias,
    setStaged,
    setConfirmPeer,
    setSendErr,
    applyAlias,
    doSend,
    sendTo,
    confirmSend,
    addFiles,
    pickAndSend,
    acceptReceive,
    declineReceive,
    toggleAutoAccept,
    refresh,
    addPeer,
  };
}
