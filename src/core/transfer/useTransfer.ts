// 局域网传输（LocalSend v2 兼容）的统一逻辑层。
// 主窗 GoldChessboardHub.TransferTab 与浮岛 Capsule.TransferPanel 共用本 hook，
// 消除两套 peers/progress/staged/确认逻辑的重复维护；UI 层各自保留风格。
//
// 拖放：不同窗口机制不同（主窗用 window dragover/drop，浮岛用 webview onDragDropEvent），
// 各组件自行处理拖放回调，拿到 paths 后调用 setStaged 合并即可。

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

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

/** 默认文件选择框标题（主窗沿用中文硬编码，浮岛可传 t('capsule.pickFiles') 覆盖）。 */
const DEFAULT_PICK_TITLE = '选择要发送的文件';

/**
 * 传输服务交互的全部状态与方法。组件只需消费返回值并渲染 UI。
 * 接收确认弹窗已统一交由 App 根挂载的全局 TransferReceiveModal + 浮岛 TransferPanel 处理，
 * 本 hook 不监听 transfer-receive-request（避免与上层接收弹窗重复）。
 */
export function useTransfer() {
  const [peers, setPeers] = useState<TransferPeer[]>([]);
  const [progress, setProgress] = useState<TransferProgressItem[]>([]);
  const [running, setRunning] = useState(false);
  const [alias, setAlias] = useState('安得云荟');
  const [staged, setStagedState] = useState<string[]>([]);
  const [confirmPeer, setConfirmPeer] = useState<TransferPeer | null>(null);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [stagedOpen, setStagedOpen] = useState(false); // 暂存文件下拉总览

  // 暂存文件走 Rust 端持久化（<appdata>/transfer/config.json），跨 webview 共用
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
    return () => offs.forEach((u) => u());
  }, []);

  const applyAlias = useCallback(async (v: string) => {
    const val = v.trim() || '安得云荟';
    setAlias(val);
    await invoke('transfer_set_alias', { alias: val }).catch(() => {});
  }, []);

  // 发送出错必须在 UI 可见（浮窗用户看不到控制台，.catch 吞掉就是「点了没反应」）
  const doSend = useCallback(async (fingerprint: string, paths: string[]) => {
    setSendErr(null);
    try {
      await invoke('transfer_send', { fingerprint, paths });
    } catch (e) {
      setSendErr(String(e));
    }
  }, []);

  // 点击对端：有暂存文件 → 先确认；无暂存 → 退回系统文件选择框
  const sendTo = useCallback(async (peer: TransferPeer, pickerTitle: string = DEFAULT_PICK_TITLE) => {
    if (staged.length > 0) {
      setConfirmPeer(peer);
      return;
    }
    const picked = (await open({ multiple: true, title: pickerTitle })) as string[] | null;
    if (!picked || picked.length === 0) return;
    await doSend(peer.fingerprint, picked);
  }, [staged.length, doSend]);

  const confirmSend = useCallback(async () => {
    if (!confirmPeer) return;
    const paths = staged;
    const fp = confirmPeer.fingerprint;
    setConfirmPeer(null);
    setStaged([]);
    setStagedOpen(false);
    await doSend(fp, paths);
  }, [confirmPeer, staged, doSend, setStaged]);

  const addFiles = useCallback(async (pickerTitle: string = DEFAULT_PICK_TITLE) => {
    const picked = (await open({ multiple: true, title: pickerTitle })) as string[] | null;
    if (picked && picked.length) setStaged((prev) => Array.from(new Set([...prev, ...picked])));
  }, [setStaged]);

  return {
    peers,
    progress,
    running,
    alias,
    staged,
    confirmPeer,
    sendErr,
    stagedOpen,
    setAlias,
    setStaged,
    setStagedOpen,
    setConfirmPeer,
    setSendErr,
    applyAlias,
    doSend,
    sendTo,
    confirmSend,
    addFiles,
  };
}
