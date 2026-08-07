// 黄金棋盘（原灵动岛，Dynamic Island）—— 屏幕顶部居中常驻的透明小窗。壳。
// 收起态（240×36）：常驻时间 + 天气，紧凑不抢眼；
// 鼠标靠近顶部中央时由 Rust 侧光标监视线程（capsule_start_monitor）自动展开，也可点胶囊切换；
// 展开后向左右 + 向下延展，默认露出专辑大图、播放控制、音量与快捷操作；点「AI」切换为内置对话模式，
// 直接复用全局 AI 能力（ai_chat 命令 + ai-delta/done/error 事件，与 ai 模块同源）。
// 作为 茑萝 的子插件（plugins/茑萝/capsule）承载，窗口内容随主包由 main.tsx 分流渲染。
//
// 本文件为壳：窗口生命周期 / 播放器 / 收起态 / Esc / DEV 探针 / TransferPanel / FileSearchPanel。
// AI 对话 → CapsuleChat；AI 编程 → CapsuleAide（各自自持 state + 流式监听）。
// 壳级共享状态（tab / 接收请求 / AI profiles）经 capsuleStore（zustand）订阅，
// 事件闭包用 useCapsuleStore.getState() 读最新值，从而消除 expandedRef / keepOpenRef 等 ref 镜像。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
// [修复] 用 getCurrentWebviewWindow 取「当前 webview 所属窗」(胶囊窗,label='capsule')。
// 不能用 getCurrentWindow()(Tauri v2 下 metadata.currentWindow 误指向主窗→返回主窗)
// 也不能用 WebviewWindow.getByLabel(它是 async 且胶囊内 JS 注册表未含自身→返回 null)。
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { ensureOverlayWindow, type OverlayProfile } from '@/core/overlayWindow';
import { FileSearchPanel } from '@/components/FileSearchPanel';
import { KeepButton } from '@/components/KeepButton';
import { useI18n } from '@/lib/i18n';
import { useTransfer } from '@/core/transfer/useTransfer';
import { useCapsuleStore } from '@/stores/capsuleStore';
import CapsuleChat from '@/components/capsule/CapsuleChat';
import CapsuleAide from '@/components/capsule/CapsuleAide';
import {
  CAPSULE_W, CAPSULE_H, EXPANDED_W, EXPANDED_H, CHAT_H, SEARCH_H, TRANSFER_H, TOP_Y, GOLD,
  btnBase, DECO_LAYERS,
} from '@/components/capsule/constants';
import {
  IconPlay, IconPause, IconPrev, IconNext, IconVolume, IconVolumeMute, IconChevron,
  IconNote, IconWeather, IconTransfer, IconDevice, IconSend, IconClose,
  ACTIONS, ACTION_LAYER1, ACTION_LAYER2, Clock,
} from '@/components/capsule/icons';
import { toPlayInfo, weatherLabel, fetchJson } from '@/components/capsule/helpers';
import type { PlayInfo, ReceiveRequest } from '@/components/capsule/types';
import { EVENTS } from '@/core/events/schema';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';

// 生产构建里所有 [CAPSULE-PROBE] 诊断（fps RAF / longtask / console.log / outerSize 探针）会被
// Vite 静态替换 + tree-shake 掉，透明浮窗不再背运行时诊断开销。DEV 模式下仍可在胶囊 DevTools 查看。
const __DEV = import.meta.env.DEV;

// 收起态选择器返回的稳定空数组：避免后台播放期间 sessionList 变化触发壳重渲染
// （展开瞬间选择器切换为真实值，Zustand 自动重渲染拿到最新会话快照）
const EMPTY_SESSIONS: PlayInfo[] = [];

// ============ 局域网传输面板（黄金棋盘·传输，LocalSend v2 兼容）============
// TransferPeer / TransferProgressItem 类型与传输逻辑统一抽到 @/core/transfer/useTransfer，
// 与主窗 GoldChessboardHub.TransferTab 共用，消除重复维护。
function TransferPanel({
  onClose,
  receiveRequest,
  onAcceptReceive,
  onDeclineReceive,
  keepOpen,
  onKeepToggle,
}: {
  onClose: () => void;
  receiveRequest: ReceiveRequest | null;
  onAcceptReceive: () => void;
  onDeclineReceive: () => void;
  keepOpen?: boolean;
  onKeepToggle?: () => void;
}) {
  const { t } = useI18n();
  const {
    peers, progress, running, alias, staged, confirmPeer, sendErr, stagedOpen,
    setAlias, setStaged, setStagedOpen, setConfirmPeer, setSendErr,
    applyAlias, sendTo, confirmSend, addFiles,
  } = useTransfer();

  // 首次使用引导：提示自定义本机名称 + 接收文件保存路径（localStorage 持久引导标记）
  const [onboarded, setOnboarded] = useState<boolean>(() => {
    return storage.getString(KEYS.transfer.onboarded.key, '0') === '1';
  });
  const [saveDir, setSaveDir] = useState('');
  const dismissOnboard = useCallback(() => {
    storage.setString(KEYS.transfer.onboarded.key, '1');
    setOnboarded(true);
  }, []);
  const pickSaveDir = useCallback(async () => {
    const dir = (await invoke('pick_directory').catch(() => null)) as string | null;
    if (dir) {
      setSaveDir(dir);
      await invoke('transfer_set_save_dir', { dir }).catch(() => {});
    }
  }, []);

  // 浮岛专属：接收文件保存路径获取 + 原生拖放（webview onDragDropEvent）。
  // 传输服务交互（peers/progress/staged/确认）由 useTransfer 负责，此处不重复监听。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      setSaveDir((await invoke('transfer_get_save_dir').catch(() => '')) as string);
      const u = await getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === 'drop') {
          const paths = (payload.paths || []).filter((p) => !!p);
          if (paths.length) setStaged((prev) => Array.from(new Set([...prev, ...paths])));
        }
      });
      if (cancelled) { u(); return; } // effect 已卸载，立即注销避免泄漏
      unlisten = u;
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [setStaged]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '10px 12px 10px', position: 'relative' }} onClick={(e) => e.stopPropagation()}>

      {/* 接收确认弹窗：浮岛（黄金棋盘）作为主接收方，收到请求时在此询问是否接收 */}
      {receiveRequest && !receiveRequest.auto_accept && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12 }} onClick={(e) => e.stopPropagation()}>
          <div style={{ width: '88%', maxWidth: 300, background: '#232326', borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', padding: 16, boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#f6f6f8', marginBottom: 8 }}>{t('capsule.receiveRequest')}</div>
            <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.8)', marginBottom: 6 }}>{t('capsule.from')}：{receiveRequest.sender_alias}</div>
            <div style={{ fontSize: 11.5, color: 'rgba(244,244,246,0.6)', marginBottom: 14, maxHeight: 130, overflowY: 'auto', lineHeight: 1.5 }}>
              共 {receiveRequest.file_count} 个文件：{receiveRequest.file_names.join('、')}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={onDeclineReceive} style={{ ...btnBase, padding: '6px 16px', background: 'rgba(255,255,255,0.1)', color: '#f6f6f8', fontSize: 12 }}>
                拒绝
              </button>
              <button onClick={onAcceptReceive} style={{ ...btnBase, padding: '6px 16px', background: GOLD, color: '#1a1a1a', fontWeight: 600, fontSize: 12 }}>
                接收
              </button>
            </div>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 40, height: 40, borderRadius: 9, flex: '0 0 40px', background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: GOLD }}>
          <IconTransfer />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#f6f6f8' }}>{t('capsule.lanTransfer')}</div>
          <div style={{ fontSize: 11, color: 'rgba(244,244,246,0.62)' }}>
            {running ? t('capsule.lanOn') : t('capsule.lanOff')} · {t('capsule.localsendCompatible')}
          </div>
        </div>
        {onKeepToggle && (
          <KeepButton pinned={!!keepOpen} onToggle={onKeepToggle} size={28} />
        )}
        <button onClick={onClose} title={t('capsule.backToPlayer')} style={{ ...btnBase, width: 28, height: 28 }}>
          <IconClose />
        </button>
      </div>

      {/* 首次使用引导：推荐自定义本机名称 + 接收文件保存路径 */}
      {!onboarded && (
        <div style={{ marginTop: 8, borderRadius: 9, background: 'rgba(230,195,92,0.12)', border: '1px solid rgba(230,195,92,0.3)', padding: '8px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ flex: 1, fontSize: 11.5, color: 'rgba(244,244,246,0.85)', lineHeight: 1.5 }}>
              首次使用传输，建议：① 自定义<b style={{ color: GOLD }}>本机名称</b>（方便对方一眼认出你）；② 设置<b style={{ color: GOLD }}>接收文件保存路径</b>（默认在程序目录下，建议改到常用文件夹）。下方「保存路径」可直接选择。
            </div>
            <button onClick={dismissOnboard} title={t('capsule.gotIt')} style={{ ...btnBase, flex: '0 0 auto', width: 18, height: 18, fontSize: 12, color: 'rgba(244,244,246,0.7)' }}>×</button>
          </div>
        </div>
      )}

      {/* 本机名称（设备名，默认安得云荟，可改） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.55)', flex: '0 0 auto' }}>{t('capsule.deviceName')}</span>
        <input
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onBlur={(e) => applyAlias(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '5px 8px', color: '#f6f6f8', fontSize: 12, outline: 'none' }}
        />
      </div>

      {/* 接收文件保存路径（首用引导项，可直接在此设置；默认值见 CapsuleSettingsPanel） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.55)', flex: '0 0 auto' }}>{t('capsule.savePath')}</span>
        <input
          value={saveDir}
          readOnly
          placeholder={t('capsule.savePathPlaceholder')}
          title={saveDir}
          style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '5px 8px', color: 'rgba(244,244,246,0.8)', fontSize: 11, outline: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        />
        <button onClick={pickSaveDir} title={t('capsule.chooseSaveDir')} style={{ ...btnBase, flex: '0 0 auto', padding: '5px 8px', fontSize: 11, borderRadius: 8, background: 'rgba(255,255,255,0.1)', color: '#f6f6f8' }}>
          选择
        </button>
      </div>

      {/* 拖入文件栏：➕ 左边是「总览 + 下拉框」触发区（点它展开全部暂存文件），不影响 ➕ 的导入 */}
      <div style={{ position: 'relative', marginTop: 8 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 38, padding: '4px 8px', borderRadius: 9, background: 'rgba(255,255,255,0.05)', border: '1px dashed rgba(255,255,255,0.18)' }}
          onClick={(e) => { e.stopPropagation(); if (staged.length === 0) addFiles(t('capsule.pickFiles')); }}
        >
          {staged.length === 0 ? (
            <span style={{ flex: 1, fontSize: 11.5, color: 'rgba(244,244,246,0.5)' }}>{t('capsule.dragHere')}</span>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setStagedOpen((v) => !v); }}
              title={stagedOpen ? t('capsule.collapseFiles') : t('capsule.viewAllFiles')}
              style={{ ...btnBase, flex: 1, minWidth: 0, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '0 8px', background: 'rgba(255,255,255,0.08)', borderRadius: 7 }}
            >
              <span style={{ fontSize: 11.5, color: 'rgba(244,244,246,0.9)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                已选 {staged.length} 个文件 · {staged[0].split(/[/]/).pop()}{staged.length > 1 ? ' 等' : ''}
              </span>
              <span style={{ fontSize: 10, color: GOLD, flex: '0 0 auto', transform: stagedOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▼</span>
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); addFiles(t('capsule.pickFiles')); }} title={t('capsule.addFile')} style={{ ...btnBase, width: 26, height: 26, flex: '0 0 auto', color: GOLD }}>＋</button>
        </div>

        {/* 下拉总览：列出全部待发送文件，可逐个移除或清空 */}
        {stagedOpen && staged.length > 0 && (
          <div
            style={{ position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 15, background: '#232326', borderRadius: 9, border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 8px 28px rgba(0,0,0,0.5)', padding: 6, maxHeight: 180, overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            {staged.map((p) => {
              const name = p.split(/[/]/).pop() || p;
              return (
                <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 6 }} title={p}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'rgba(244,244,246,0.9)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                  <button onClick={() => setStaged((prev) => { const next = prev.filter((x) => x !== p); if (next.length === 0) setStagedOpen(false); return next; })} title={t('capsule.remove')} style={{ ...btnBase, width: 18, height: 18, fontSize: 12, lineHeight: '16px', color: 'rgba(244,244,246,0.7)', flex: '0 0 auto' }}>×</button>
                </div>
              );
            })}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4, paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <button onClick={() => { setStaged([]); setStagedOpen(false); }} style={{ ...btnBase, padding: '3px 8px', fontSize: 11, color: 'rgba(244,244,246,0.6)' }}>{t('capsule.clearAll')}</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {peers.length === 0 && (
          <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.55)', textAlign: 'center', marginTop: 12 }}>
            {t('capsule.discovering')}
          </div>
        )}
        {peers.map((p) => (
          <div key={p.fingerprint} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 9, background: 'rgba(255,255,255,0.05)' }}>
            <span style={{ fontSize: 16, color: GOLD, flex: '0 0 18px', textAlign: 'center' }}><IconDevice /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.alias}</div>
              <div style={{ fontSize: 10.5, color: 'rgba(244,244,246,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.ip}:{p.port}</div>
            </div>
            <button onClick={() => sendTo(p, t('capsule.pickFiles'))} title={t('capsule.sendFile')} style={{ ...btnBase, width: 34, height: 30, color: GOLD }}>
              <IconSend />
            </button>
          </div>
        ))}
      </div>

      {sendErr && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 8, background: 'rgba(220,60,60,0.16)', border: '1px solid rgba(220,60,60,0.35)' }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: '#f1a0a0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sendErr}>发送失败：{sendErr}</span>
          <button onClick={() => setSendErr(null)} style={{ ...btnBase, width: 16, height: 16, fontSize: 11, color: '#f1a0a0', flex: '0 0 auto' }}>×</button>
        </div>
      )}

      {progress.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 120, overflowY: 'auto' }}>
          {progress.map((p) => (
            <div key={p.session_id + p.file_id} style={{ fontSize: 11, color: 'rgba(244,244,246,0.78)' }}>
              {p.done ? '✓ ' : '↻ '}
              {p.direction === 'send' ? t('capsule.dirSend') : t('capsule.dirRecv')} {p.peer_alias}：{p.file_name}
              {!p.done && p.total > 0 ? ` ${Math.round((p.received / p.total) * 100)}%` : ''}
            </div>
          ))}
        </div>
      )}

      {/* 发送前确认 */}
      {confirmPeer && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20 }} onClick={(e) => { e.stopPropagation(); setConfirmPeer(null); }}>
          <div style={{ background: '#1c1c1e', borderRadius: 12, padding: 16, width: 260, boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#f6f6f8' }}>{t('capsule.sendToConfirm', { alias: confirmPeer.alias })}</div>
            <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.6)', marginTop: 6 }}>
              共 {staged.length} 个文件（{staged.map((p) => p.split(/[/]/).pop()).join('、')}）
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button onClick={() => setConfirmPeer(null)} style={{ ...btnBase, padding: '5px 12px', fontSize: 12 }}>{t('capsule.cancel')}</button>
              <button onClick={confirmSend} style={{ ...btnBase, padding: '5px 12px', fontSize: 12, color: '#1c1c1e', background: GOLD, fontWeight: 600 }}>{t('capsule.confirmSend')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Capsule() {
  const { t } = useI18n();
  // —— tab 状态（从 capsuleStore 订阅）——
  const expanded = useCapsuleStore((s) => s.expanded);
  const chatOpen = useCapsuleStore((s) => s.chatOpen);
  const aideOpen = useCapsuleStore((s) => s.aideOpen);
  const searchOpen = useCapsuleStore((s) => s.searchOpen);
  const transferOpen = useCapsuleStore((s) => s.transferOpen);
  const panelReady = useCapsuleStore((s) => s.panelReady);
  const keepOpen = useCapsuleStore((s) => s.keepOpen);
  const setExpanded = useCapsuleStore((s) => s.setExpanded);
  const setChatOpen = useCapsuleStore((s) => s.setChatOpen);
  const setAideOpen = useCapsuleStore((s) => s.setAideOpen);
  const setSearchOpen = useCapsuleStore((s) => s.setSearchOpen);
  const setTransferOpen = useCapsuleStore((s) => s.setTransferOpen);
  const setKeepOpen = useCapsuleStore((s) => s.setKeepOpen);
  // —— 接收请求 / toast（从 capsuleStore 订阅）——
  const receiveReq = useCapsuleStore((s) => s.receiveReq);
  const toast = useCapsuleStore((s) => s.toast);
  const acceptReceive = useCapsuleStore((s) => s.acceptReceive);
  const declineReceive = useCapsuleStore((s) => s.declineReceive);

  // —— 播放器状态（从 capsuleStore 订阅；ref/state 双写已消除）——
  // play 驱动收起态指示点 + 展开态播放器，全时段订阅（store 内指纹去重，仅内容变化才重渲染）。
  const play = useCapsuleStore((s) => s.play);
  const selectedKey = useCapsuleStore((s) => s.selectedKey);
  // sessionList/appPlay 仅展开态订阅：收起态选择器返回稳定空值，后台播放不触发壳重渲染；
  // 展开瞬间切换为真实值，Zustand 自动重渲染拿到最新会话快照。
  const sessionList = useCapsuleStore((s) => (s.expanded ? s.sessionList : EMPTY_SESSIONS));
  const appPlay = useCapsuleStore((s) => (s.expanded ? s.appPlay : null));
  const selectSession = useCapsuleStore((s) => s.selectSession);
  const smtcControl = useCapsuleStore((s) => s.smtcControl);
  const refreshSessionList = useCapsuleStore((s) => s.refreshSessionList);
  const hoverLockRef = useRef(false); // 收起后锁定悬停自动展开，需点击胶囊才恢复（不触发渲染，保留为 ref）
  const prevExpandedRef = useRef(false); // 尺寸 effect：检测「从收起态展开」过渡
  const [volume, setVolume] = useState(0.7);
  const [weather, setWeather] = useState<{ temp: number | null; code: number | null; city: string | null }>({ temp: null, code: null, city: null });

  // 收起即「回到主页」：关闭所有子面板（搜索/对话/传输），避免再次展开时卡在搜索页。
  // hoverLockRef 保留为组件内 ref（不触发渲染，不入 store）；状态重置交由 store.collapse()。
  const collapse = useCallback(() => {
    hoverLockRef.current = true; // 收起后：悬停不再自动展开，需用户点击胶囊恢复（见 body onClick）
    useCapsuleStore.getState().collapse();
  }, []);

  // Esc 兜底逃生：搜索/对话/传输子面板或展开态下按 Esc 一律回到主页，杜绝"卡在搜索页无法返回"。
  // 闭包内用 getState() 读最新值，避免每次 tab 切换都重注册监听。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useCapsuleStore.getState();
      if (s.searchOpen) s.setSearchOpen(false);
      else if (s.chatOpen) s.setChatOpen(false);
      else if (s.transferOpen) s.setTransferOpen(false);
      else if (s.expanded) collapse();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapse]);

  // 展开时拉取整机会话快照，并每 2s 刷新（供堆叠 / 下拉切换）
  // 会话列表与上屏卡片派生统一由 capsuleStore 维护，壳仅触发刷新。
  useEffect(() => {
    if (expanded) {
      void refreshSessionList();
      const id = setInterval(() => void refreshSessionList(), 2000);
      return () => clearInterval(id);
    }
  }, [expanded, refreshSessionList]);

  const coverUrl = useMemo(
    () => (play?.cover_path ? convertFileSrc(play.cover_path) : null),
    [play?.cover_path],
  );
  // 多会话堆叠：合并外部会话与本应用会话；当前展示之外的会话作为背景卡营造层次质感
  const allSessions = useMemo(() => {
    const a = [...sessionList];
    if (appPlay) a.unshift(appPlay);
    return a;
  }, [sessionList, appPlay]);
  const behindCards = useMemo(
    () => allSessions.filter((s) => s.key !== play?.key).slice(0, 2),
    [allSessions, play?.key],
  );
  // 天气：免 key 的 Open-Meteo（实时温度 + 天气代码）+ ipapi.co 自动定位 + BigDataCloud 反向地理编码取城市；
  // 不依赖 AbortSignal.timeout（部分 WebView2 运行时无此方法，会直接抛错导致永远显示「—」），改用手动超时。
  useEffect(() => {
    let alive = true;
    const load = async () => {
      let lat = 31.2304;
      let lon = 121.4737; // 兜底：上海
      // 经后端命令取 IP 地理坐标，规避浮窗 WebView2 直接请求 ipapi.co 被 CORS 拦截。
      const loc = (await invoke('capsule_ip_location').catch(() => null)) as
        | { latitude?: number; longitude?: number }
        | null;
      if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
        lat = loc.latitude;
        lon = loc.longitude;
      }
      // 反向地理编码取城市（免 key，返回中文城市名）
      const geo = (await fetchJson(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`,
        4000,
      )) as { city?: string; locality?: string; principalSubdivision?: string } | null;
      const city = geo ? geo.city || geo.locality || geo.principalSubdivision || null : null;
      const w = (await fetchJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`,
        5000,
      )) as { current?: { temperature_2m?: number; weather_code?: number } } | null;
      if (alive && w?.current) {
        setWeather({
          temp: typeof w.current.temperature_2m === 'number' ? Math.round(w.current.temperature_2m) : null,
          code: typeof w.current.weather_code === 'number' ? w.current.weather_code : null,
          city,
        });
      }
    };
    void load();
    const iv = setInterval(() => void load(), 15 * 60 * 1000); // 每 15 分钟刷新
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  // 上报窗口物理矩形，供 Rust 光标监视线程做热区判定（随展开/收起改变尺寸与居中）
  async function reportRect(w: number, h: number) {
    try {
      const dpr = window.devicePixelRatio || 1;
      const sx = window.screen.availWidth;
      const x = Math.round((sx - w) / 2);
      await invoke('capsule_set_rect', {
        x: Math.round(x * dpr),
        y: Math.round(TOP_Y * dpr),
        w: Math.round(w * dpr),
        h: Math.round(h * dpr),
      });
    } catch {
      /* 忽略 */
    }
  }

  // 挂载：透明化、定位顶部居中、显示、启动光标监视、上报物理矩形、订阅事件、注册接收请求监听
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    (async () => {
      // [修复] 用 getCurrentWebviewWindow 取胶囊窗自身（label='capsule'）：
      // getCurrentWindow() 在胶囊里会误返回主窗（Tauri v2 metadata.currentWindow 误指向主窗）；
      // WebviewWindow.getByLabel 是 async 且胶囊内 JS 注册表未含自身，返回 null。
      const win = getCurrentWebviewWindow();
      if (__DEV) console.log('[CAPSULE-PROBE] winLabel=', win?.label);
      if (!win) return;
      try {
        await invoke('set_overlay_transparent');
        // [DEV 探针] 确认 DComp 是否真正激活（打破静默回落盲调）。
        // true=走 DComp swapchain（外部媒体下不卡）；false=回落 layered 重定向（外部媒体下会卡）。
        if (__DEV) {
          try {
            const active = await invoke<boolean>('dcomp_is_active', { label: win.label });
            // eslint-disable-next-line no-console
            console.log('[CAPSULE-PROBE] dcomp_is_active=' + active + ' label=' + win.label);
          } catch {
            /* 命令未注册（旧版）忽略 */
          }
        }
      } catch {
        /* 非 Windows 或不支持时忽略 */
      }
      try {
        const sx = window.screen.availWidth;
        await win.setPosition(new LogicalPosition(Math.round((sx - CAPSULE_W) / 2), TOP_Y));
      } catch {
        /* 忽略定位失败 */
      }
      try {
        await win.show();
      } catch {
        /* 忽略 */
      }
      try {
        await invoke('capsule_start_monitor');
      } catch {
        /* 忽略 */
      }
      await reportRect(CAPSULE_W, CAPSULE_H);
    })();

    // 展开前置门控：在 setExpanded(true) 之前置 panelReady=false，确保展开后
    // 首帧渲染就不包含子面板——规避 36→470 过渡期旧窗高裁剪标题栏的问题。
    // 闭包内用 getState() 读最新值（替代原 expandedRef/keepOpenRef 双写镜像）。
    listen<boolean>(EVENTS.deskpet.expand, (e) => {
      const s = useCapsuleStore.getState();
      if (e.payload) {
        if (hoverLockRef.current) return; // 收起锁定：悬停不自动展开，直到用户点击胶囊
        if (!s.expanded) s.setPanelReady(false);
      } else {
        if (s.keepOpen) return; // 保持态：鼠标离开不自动收起
      }
      s.setExpanded(!!e.payload);
    }).then((f) => unsubs.push(f));
    listen<Record<string, unknown>>(EVENTS.deskpet.nowPlaying, (e) => {
      const t0 = __DEV ? performance.now() : 0;
      // 双源合并 / 会话列表 / 上屏卡片派生统一由 store 处理；壳仅保留 DEV 探针计时。
      useCapsuleStore.getState().onNowPlaying(e.payload);
      if (__DEV) {
        const d = toPlayInfo(e.payload);
        console.log('[CAPSULE-PROBE] now-playing handler_us=' + Math.round(performance.now() - t0) + ' source=' + (d.source ?? '?'));
      }
    }).then((f) => unsubs.push(f));
    // 接收请求监听（由 capsuleStore 统一管理：自动展开 / 弹确认 / toast / 完成）
    unsubs.push(useCapsuleStore.getState().initReceiveListeners());
    return () => unsubs.forEach((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 按需上屏一次（暂停轮询态下内容变化时使用）
  const presentOverlayNow = useCallback(() => {
    invoke('present_overlay_now').catch(() => {});
  }, []);

  // 展开/收起/对话模式/搜索模式：重新定位（居中）+ 改尺寸 + 上报热区（窗口向左右与向下延展）
  useEffect(() => {
    const w = EXPANDED_W;
    const h = !expanded ? CAPSULE_H : chatOpen ? CHAT_H : aideOpen ? CHAT_H : searchOpen ? SEARCH_H : transferOpen ? TRANSFER_H : EXPANDED_H;
    // [修复] 用 getCurrentWebviewWindow 取胶囊窗自身（见挂载 effect 注释）：
    // getCurrentWindow() 会误返回主窗；WebviewWindow.getByLabel 是 async 且胶囊内注册表无自身。
    const win = getCurrentWebviewWindow();
    if (!win) return;
    const sx = window.screen.availWidth;
    const x = Math.round((sx - w) / 2);
    const t0 = __DEV ? Date.now() : 0;
    // 窗口高度同步门控：从收起态展开且子面板打开时，暂不渲染子面板，等 setSize 完成后
    // 再放开渲染。否则 36→470 高度过渡期间，React 已渲染的子面板内容被旧窗高裁剪。
    const expanding = expanded && !prevExpandedRef.current;
    const subPanelOpen = chatOpen || searchOpen || transferOpen;
    prevExpandedRef.current = expanded;
    if (expanding && subPanelOpen) {
      useCapsuleStore.getState().setPanelReady(false);
    }
    // [DEV 探针] 尺寸变化前的真实 bounds
    if (__DEV) {
      win
        .outerSize()
        .then((os: { width: number; height: number }) =>
          console.log('[CAPSULE-PROBE] expand-before', { w: os.width, h: os.height }, { expanded, chatOpen, searchOpen })
        )
        .catch(() => {});
    }
    win.setPosition(new LogicalPosition(x, TOP_Y)).catch(() => {});
    // 穿透/点击切换：收起态 ignore=true（点击穿透桌面），展开态 ignore=false（接收点击）。
    // 原由 Rust 侧 set_ignore_cursor_events 负责，但 Rust 用 get_webview_window 克隆全局窗表里的
    // WebviewWindow 会在窗销毁竞态下克隆已损坏的 Arc 触发 assert_unchecked 中止；改由胶囊对自身窗调用。
    // 收起态不再设为鼠标穿透：改为可点击，用户点击胶囊即可展开（悬停自动展开仍由 hoverLockRef 阻止）
    win.setIgnoreCursorEvents(false).catch(() => {});
    win
      .setSize(new LogicalSize(w, h))
      .then(() => {
        reportRect(w, h);
        // 门控复位：expanding && subPanelOpen 时用 setTimeout(0) 跳出 React 18 批处理，
        // 其余情况直接复位——因为 listener 在展开时无条件置 panelReady=false，但子面板可能
        // 尚未打开（首次悬停），需要在此清门控，否则后续点开搜索/AI/传输全显示空白。
        if (expanding && subPanelOpen) {
          setTimeout(() => useCapsuleStore.getState().setPanelReady(true), 0);
        } else {
          useCapsuleStore.getState().setPanelReady(true);
        }
        if (__DEV) {
          win
            .outerSize()
            .then((os: { width: number; height: number }) =>
              console.log('[CAPSULE-PROBE] expand-after', { w: os.width, h: os.height }, 'setSize_cost_ms=' + (Date.now() - t0))
            )
            .catch(() => {});
        }
        // 过渡后立即上屏新尺寸：轻量 3 次 present_overlay_now（替代原来的 8ms×600ms =
        // 125 次/秒 Notify 风暴——该风暴会严重干扰外部媒体播放时的 DWM 呈现，导致卡顿/卡死，
        // 日志里 setSize_cost_ms=2108 即此所致）。稳态重绘频率由上方 request_repaint_rate
        // effect 决定（收起=0 暂停 / 展开=33 连续），此处只负责过渡呈现。
        presentOverlayNow();
        window.setTimeout(presentOverlayNow, 80);
        window.setTimeout(presentOverlayNow, 160);
      })
      .catch(() => {});
  }, [expanded, chatOpen, aideOpen, searchOpen, transferOpen, presentOverlayNow]);

  async function onAction(kind: string) {
    // 闭包内读 store 最新值做互斥切换（click 同步执行，无竞态）
    const s = useCapsuleStore.getState();
    try {
      if (kind === 'ai') {
        // 切换内置 AI 对话模式（复用全局 ai_chat 能力）；与搜索/浮岛 AI 编程互斥
        s.setSearchOpen(false);
        s.setAideOpen(false);
        s.setChatOpen(!s.chatOpen);
      } else if (kind === 'aide') {
        // 浮岛「AI 编程」：接管 IDE 对话，由 IDE 模块处理；与内置 AI/搜索/传输互斥
        s.setExpanded(true);
        s.setChatOpen(false);
        s.setSearchOpen(false);
        s.setTransferOpen(false);
        s.setAideOpen(!s.aideOpen);
      } else if (kind === 'search') {
        // 切换内置 Everything 风格搜索模式；与对话互斥
        s.setChatOpen(false);
        s.setSearchOpen(!s.searchOpen);
      } else if (kind === 'transfer') {
        // 切换局域网传输模式；与对话/搜索互斥；强制展开（不被收起态折叠）
        s.setExpanded(true);
        s.setChatOpen(false);
        s.setSearchOpen(false);
        s.setTransferOpen(!s.transferOpen);
      } else if (kind === 'screenshot') {
        await emit(EVENTS.screenshot.open);
      } else if (kind === 'record') {
        await invoke('show_recorder_select');
      } else if (kind === 'dropzone' || kind === 'clipboard') {
        const label = kind === 'dropzone' ? 'floating-dropzone' : 'floating-clipboard';
        const profile: OverlayProfile = {
          width: kind === 'dropzone' ? 360 : 340,
          height: kind === 'dropzone' ? 520 : 460,
          decorations: false,
          transparent: true,
          alwaysOnTop: true,
          resizable: false,
          skipTaskbar: true,
          dragDropEnabled: false,
        };
        const w = await ensureOverlayWindow(label, `index.html?floating=${kind}`, profile);
        if (w) {
          await w.show();
          await w.setFocus();
        }
      }
    } catch {
      /* 忽略交互失败 */
    }
  }

  const isPlaying = !!play?.is_playing;
  // [DEV 探针] 实测胶囊在失焦时的真实 fps 与可见性，定位卡顿根因。
  // 每 1 秒打一行；若 fps 低（≈10）说明续命没让合成器持续产帧，若 visibility=hidden 说明
  // SetIsVisible(TRUE) 没生效。打开胶囊 webview 的 DevTools Console 可见。
  useEffect(() => {
    if (!__DEV) return; // 生产构建不跑 fps / visibility 探针（Vite tree-shake 掉整块）
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const loop = (t: number) => {
      frames++;
      if (t - last >= 1000) {
        const fps = Math.round((frames * 1000) / (t - last));
        // eslint-disable-next-line no-console
        console.log(
          '[CAPSULE-PROBE] fps=' + fps +
          ' visibility=' + document.visibilityState +
          ' hidden=' + document.hidden
        );
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onVis = () =>
      // eslint-disable-next-line no-console
      console.log('[CAPSULE-PROBE] visibilitychange -> ' + document.visibilityState);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  // [DEV 探针] 主线程长任务监控：若外部媒体下出现 >50ms 长任务，说明 JS 主线程被阻塞
  // （典型：now-playing 重渲染 / 图片解码），会直接导致按钮点击卡顿。无长任务却仍卡 → 属分层窗
  // 输入/合成器问题（与 Notify 风暴相关）。看胶囊 DevTools Console。
  useEffect(() => {
    if (!__DEV) return; // 生产构建不跑 longtask 探针
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          // eslint-disable-next-line no-console
          console.log('[CAPSULE-PROBE] longtask ms=' + Math.round(e.duration) + ' at=' + Math.round(e.startTime));
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
      return () => obs.disconnect();
    } catch {
      /* ignore */
    }
  }, []);
  // 有动画（外部媒体脉冲 / 对话 / 搜索）时把透明浮窗重绘频率提到 ~60fps，否则失焦窗口会被
  // Chromium 后台节流压到默认 10fps 而卡顿；静止时回落 100ms 省 CPU。须放在 isPlaying 声明之后
  // （const 的暂时性死区：依赖数组在渲染时求值，放前面会 ReferenceError）。
  useEffect(() => {
    // 收起态（!expanded）已静态化 → 暂停轮询（0）：屏幕停在最后一帧，内容变化由
    // MutationObserver 调 present_overlay_now 按需上屏，从而不与外部媒体抢 DWM 重定向呈现。
    // 展开态需连续上屏 → 16ms（60fps，极致丝滑；screenshot.rs 注释亦推荐此值）。
    // animating 只需 expanded：子面板仅在展开时渲染，收起时 searchOpen 等残留值不应驱动轮询
    // （会与 DWM 合成时序冲突致布局偏移/空白）。DComp 开启时 Notify 被跳过，此处仅影响 layered 兜底。
    const animating = expanded;
    const ms = animating ? 16 : 0;
    if (__DEV) console.log('[CAPSULE-PROBE] request_repaint_rate', ms, { expanded });
    invoke('set_overlay_repaint_rate', { intervalMs: ms }).catch(() => {});
  }, [expanded]);

  // 收起态（暂停轮询）下按需上屏：监听内容实际变化（正在播放的歌名、时钟跳动等）才 present
  // 一帧，不再每 10fps 轮询 Notify，从而不与外部媒体抢 DWM 重定向呈现（根除「仅外部媒体下卡顿」）。
  // 展开/对话/搜索态由上方 request_repaint_rate effect 设 33fps 连续上屏，此处禁用观察器。
  useEffect(() => {
    const animating = expanded;
    if (animating) return;
    const root = document.getElementById('capsule-root');
    if (!root) return;
    let last = 0;
    const obs = new MutationObserver(() => {
      const now = performance.now();
      if (now - last < 120) return; // 节流 ~8fps 上限，避免 mutation 风暴
      last = now;
      presentOverlayNow();
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    return () => obs.disconnect();
  }, [expanded, presentOverlayNow]);

  const togglePlay = () => smtcControl(isPlaying ? 'pause' : 'play');
  const onVolume = (v: number) => {
    setVolume(v);
    smtcControl('volume', v);
  };

  const pillH = !expanded ? CAPSULE_H : chatOpen ? CHAT_H : aideOpen ? CHAT_H : searchOpen ? SEARCH_H : transferOpen ? TRANSFER_H : EXPANDED_H;

  // 浮岛动作按钮分两排渲染（第一排高频，第二排其余），按钮 JSX 仅在内部出现一次
  const renderActionRow = (kinds: readonly string[]) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-around' }}>
      {kinds.map((k) => {
        const a = ACTIONS.find((x) => x.kind === k)!;
        return (
          <button
            key={a.kind}
            onClick={(e) => { e.stopPropagation(); onAction(a.kind); }}
            title={t(a.labelKey)}
            style={{
              ...btnBase,
              flexDirection: 'column',
              gap: 3,
              width: 72,
              height: 50,
              fontSize: 11,
              color: '#f2f2f4',
              background:
                (a.kind === 'ai' && chatOpen) || (a.kind === 'aide' && aideOpen) || (a.kind === 'search' && searchOpen) || (a.kind === 'transfer' && transferOpen)
                  ? 'rgba(230,195,92,0.18)'
                  : 'rgba(255,255,255,0.06)',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.14)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
          >
            <a.Icon />
            <span>{t(a.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      id="capsule-root"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        pointerEvents: 'none',
      }}
    >
      <style>{`@keyframes capsulePulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.65)}}`}</style>
      {/* 轻量 toast：接收相关反馈（请求 / 接收中 / 完成） */}
      {toast && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 60,
            pointerEvents: 'none',
            background: 'rgba(20,20,22,0.92)',
            border: '1px solid rgba(230,195,92,0.5)',
            color: '#f4f4f6',
            fontSize: 12,
            padding: '6px 12px',
            borderRadius: 10,
            maxWidth: EXPANDED_W,
            boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {toast.msg}
        </div>
      )}
      <div
        onClick={() => {
          if (!chatOpen) {
            if (expanded) collapse();
            else { hoverLockRef.current = false; setExpanded(true); }
          }
        }}
        style={{
          width: expanded ? EXPANDED_W : CAPSULE_W,
          height: pillH,
          borderRadius: expanded ? 22 : CAPSULE_H / 2,
          border: '1px solid rgba(230,195,92,0.55)',
          boxShadow: '0 6px 24px rgba(0,0,0,0.4), 0 0 18px rgba(230,195,92,0.18)',
          color: '#f4f4f6',
          overflow: 'hidden',
          transition: 'width 260ms cubic-bezier(0.22,1,0.36,1), height 260ms cubic-bezier(0.22,1,0.36,1), border-radius 260ms ease',
          pointerEvents: 'auto',
          position: 'relative',
        }}
      >
        {/* 棋盘底纹层 + 轻暗叠层：静态装饰，已抽到模块级 DECO_LAYERS 常量，React 跳过其协调 */}
        {DECO_LAYERS}
        {/* 内容层 */}
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* 收起态：时间 + 天气（不显示播放控制） */}
          {!expanded && (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {isPlaying && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: GOLD,
                      boxShadow: '0 0 8px rgba(230,195,92,0.8)',
                      animation: 'none', // 收起态静态化：关掉脉冲，避免持续 Notify 与外部媒体抢 DWM 呈现
                      willChange: 'opacity, transform',
                      transform: 'translateZ(0)',
                    }}
                  />
                )}
                <Clock />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#f4f4f6', minWidth: 0 }}>
                <IconWeather code={weather.code} />
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{weather.temp != null ? `${weather.temp}°` : '—'}</span>
                <span style={{ fontSize: 10.5, color: 'rgba(244,244,246,0.72)', whiteSpace: 'nowrap' }}>{weatherLabel(weather.code)}</span>
                {weather.city && (
                  <span style={{ fontSize: 10, color: 'rgba(244,244,246,0.6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 54 }}>
                    {weather.city}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 展开态 · 播放器模式（多会话可堆叠 / 下拉切换） */}
          {expanded && !chatOpen && !searchOpen && !transferOpen && !aideOpen && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '12px 14px 12px', minHeight: 0 }}>
              {/* 媒体源选择：多会话时下拉命中指定卡片 */}
              {allSessions.length > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.6)', flex: '0 0 auto' }}>{t('capsule.mediaSource')}</span>
                  <select
                    value={selectedKey ?? ''}
                    onChange={(e) => selectSession(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#f4f4f6', background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, padding: '4px 8px', outline: 'none', fontFamily: 'inherit' }}
                  >
                    <option value="">{t('capsule.mediaAuto')}</option>
                    {allSessions.map((s) => (
                      <option key={s.key} value={s.key}>
                        {(s.title || (s.key === 'app' ? t('capsule.mediaApp') : s.key)) + (s.artist ? ` · ${s.artist}` : '')}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* 头部：大封面（保持 72px）+ 标题/艺人/专辑 + 时钟 + 收起 */}
              <div style={{ position: 'relative' }}>
                {/* 堆叠背景卡：其他会话封面，营造层次质感 */}
                {behindCards.map((s, i) => (
                  <div
                    key={s.key}
                    style={{
                      position: 'absolute',
                      top: -8 - i * 5,
                      left: 10 + i * 16,
                      width: 72,
                      height: 72,
                      borderRadius: 12,
                      background: s.cover_path ? '#000' : 'rgba(255,255,255,0.06)',
                      backgroundImage: s.cover_path ? `url(${convertFileSrc(s.cover_path)})` : undefined,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      opacity: 0.45 - i * 0.12,
                      transform: `scale(${0.97 - i * 0.03})`,
                      transformOrigin: 'top left',
                      zIndex: 0,
                      boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                      pointerEvents: 'none',
                    }}
                  />
                ))}
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', position: 'relative', zIndex: 1 }}>
                  <div
                    style={{
                      width: 72,
                      height: 72,
                      borderRadius: 12,
                      flex: '0 0 72px',
                      background: 'rgba(255,255,255,0.06)',
                      backgroundImage: coverUrl ? `url(${coverUrl})` : undefined,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: GOLD,
                      overflow: 'hidden',
                      boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
                    }}
                  >
                    {!coverUrl && <IconNote />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#f6f6f8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {play?.title || t('capsule.mediaNone')}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'rgba(244,244,246,0.72)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                      {play?.artist || '—'}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'rgba(230,195,92,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                      {play?.album || t('capsule.unknownAlbum')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                    <Clock />
                    <KeepButton pinned={keepOpen} onToggle={() => setKeepOpen(!keepOpen)} size={26} />
                    <button onClick={(e) => { e.stopPropagation(); collapse(); }} title={t('capsule.collapse')} style={{ ...btnBase, width: 26, height: 26 }}>
                      <IconChevron />
                    </button>
                  </div>
                </div>
              </div>

              {/* 播放控制区（压缩：更紧的间距、更小的按钮；专辑图保持 72px） */}
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
                  <button onClick={(e) => { e.stopPropagation(); smtcControl('previous'); }} disabled={!play?.can_prev} title={t('capsule.prev')} style={{ ...btnBase, width: 34, height: 34, opacity: play?.can_prev ? 1 : 0.4 }}>
                    <IconPrev />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} title={isPlaying ? t('capsule.pause') : t('capsule.play')} style={{ ...btnBase, width: 40, height: 40, background: 'rgba(230,195,92,0.16)' }}>
                    {isPlaying ? <IconPause /> : <IconPlay />}
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); smtcControl('next'); }} disabled={!play?.can_next} title={t('capsule.next')} style={{ ...btnBase, width: 34, height: 34, opacity: play?.can_next ? 1 : 0.4 }}>
                    <IconNext />
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, padding: '0 6px' }}>
                  <button onClick={(e) => { e.stopPropagation(); onVolume(volume > 0 ? 0 : 0.7); }} title={volume > 0 ? t('capsule.mute') : t('capsule.unmute')} style={{ ...btnBase, width: 28, height: 28 }}>
                    {volume > 0 ? <IconVolume /> : <IconVolumeMute />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={volume}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => { e.stopPropagation(); onVolume(parseFloat(e.target.value)); }}
                    style={{ flex: 1, accentColor: GOLD, cursor: 'pointer', height: 4 }}
                  />
                  <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.7)', width: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {Math.round(volume * 100)}
                  </span>
                </div>
              </div>

              {/* 快捷操作：分两排。第一排=高频(用户指定)，第二排=其余(后续排满再加「更多」二级入口) */}
              <div style={{ display: 'flex', flexDirection: 'column', marginTop: 'auto', paddingTop: 8, gap: 8 }}>
                {renderActionRow(ACTION_LAYER1)}
                <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '0 6px' }} />
                {renderActionRow(ACTION_LAYER2)}
              </div>
            </div>
          )}

          {/* 展开态 · AI 对话模式（内置对话框，复用全局 AI） —— 已拆为 CapsuleChat 子组件 */}
          {expanded && chatOpen && panelReady && <CapsuleChat coverUrl={coverUrl} />}

          {/* 展开态 · 浮岛「AI 编程」多对话 —— 已拆为 CapsuleAide 子组件 */}
          {expanded && aideOpen && panelReady && <CapsuleAide />}

          {/* 展开态 · 文件搜索（复用 FileSearchPanel，与主窗口黄金棋盘共享） */}
          {expanded && searchOpen && panelReady && (
            <FileSearchPanel variant="overlay" onClose={() => setSearchOpen(false)} keepOpen={keepOpen} onKeepToggle={() => setKeepOpen(!keepOpen)} />
          )}

          {/* 展开态 · 局域网传输（LocalSend v2 兼容） */}
          {expanded && transferOpen && panelReady && (
            <TransferPanel
              onClose={() => setTransferOpen(false)}
              receiveRequest={receiveReq}
              onAcceptReceive={acceptReceive}
              onDeclineReceive={declineReceive}
              keepOpen={keepOpen}
              onKeepToggle={() => setKeepOpen(!keepOpen)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
