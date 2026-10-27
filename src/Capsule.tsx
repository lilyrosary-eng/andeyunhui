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
import { isLinux } from '@/platform/isLinux';
import { FileSearchPanel } from '@/components/FileSearchPanel';
import { KeepButton } from '@/components/KeepButton';
import { useI18n } from '@/lib/i18n';
import { useTransfer } from '@/core/transfer/useTransfer';
import { useCapsuleStore } from '@/stores/capsuleStore';
import { api } from '@/lib/api';
import CapsuleChat from '@/components/capsule/CapsuleChat';
import CapsuleAide from '@/components/capsule/CapsuleAide';
import CapsuleSecAide from '@/components/capsule/CapsuleSecAide';
import CapsuleResource from '@/components/capsule/CapsuleResource';
import {
  CAPSULE_W, CAPSULE_H, EXPANDED_W, EXPANDED_H, CHAT_H, AIDE_W, AIDE_H, SEARCH_H, TRANSFER_H, RESOURCE_H, TOP_Y, GOLD,
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
import { injectCssOnce } from '@/lib/injectCss';

// 收起态呼吸动画 @keyframes capsulePulse。
// 走构造样式表注入：打包版 CSP 给 style-src 追加 nonce 后，JSX 渲染出的 <style> 会被整块拦掉
// （dev 无该 CSP 所以只在打包版失效），回退 <style> 逻辑见 injectCssOnce。
injectCssOnce('capsule-keyframes', '@keyframes capsulePulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.65)}}');

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
            style={{ position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 15, background: '#232326', borderRadius: 9, border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 8px 28px rgba(0,0,0,0.5)', padding: 6, maxHeight: 75, overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            {staged.map((p) => {
              const name = p.split(/[/]/).pop() || p;
              return (
                <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 25, padding: '0 6px', borderRadius: 6 }} title={p}>
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
            <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.6)', marginTop: 6, maxHeight: 75, overflowY: 'auto', wordBreak: 'break-all' as const }}>
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
  const secOpen = useCapsuleStore((s) => s.secOpen);
  // 只有真的在流式输出时才值得 60fps。
  // 用 for...in 而不是 Object.keys().length：后者每次 store 更新都新建一个数组
  // （zustand 对**每一个** selector 在每次 set 后都会重新求值），纯属白给 GC 压力。
  const streaming = useCapsuleStore((s) => {
    for (const k in s.activeStreams) if (s.activeStreams[k]) return true;
    return false;
  });

  // —— 重绘频率的两个附加信号（见下方 set_overlay_repaint_rate effect）——
  // transiting：刚刚发生尺寸/模式切换，260ms 的 width/height 过渡正在跑
  const [transiting, setTransiting] = useState(false);
  // pointerIn：指针在浮岛内（滚动/悬停/输入时最需要跟手）
  const [pointerIn, setPointerIn] = useState(false);
  const searchOpen = useCapsuleStore((s) => s.searchOpen);
  const transferOpen = useCapsuleStore((s) => s.transferOpen);
  const resourceOpen = useCapsuleStore((s) => s.resourceOpen);
  const panelReady = useCapsuleStore((s) => s.panelReady);
  const keepOpen = useCapsuleStore((s) => s.keepOpen);
  const setExpanded = useCapsuleStore((s) => s.setExpanded);
  const setSearchOpen = useCapsuleStore((s) => s.setSearchOpen);
  const setTransferOpen = useCapsuleStore((s) => s.setTransferOpen);
  const setKeepOpen = useCapsuleStore((s) => s.setKeepOpen);
  // 浮岛「常用笔记」轮转：记录后端收藏列表 + 局部召唤索引。
  // 浮岛是独立 webview，其 notesStore 收藏队列可能未初始化/为空（与主窗口 localStorage 不同步），
  // 若走后端固定第一个就会“只能召唤一个”，故在此自持索引轮转，多收藏可连续打开不同笔记窗口。
  const favListRef = useRef<string[] | null>(null);
  const favIdxRef = useRef(0);
  // —— 桌面歌词窗口可见性（与音乐模块播放栏共用同一事实源）——
  // 浮岛是独立 webview，主窗前端 store 不共享，故以「后端窗口真实可见性 + 广播事件」收敛状态：
  // 无论从浮岛还是播放栏开关，两端按钮高亮都会同步。
  const [lyricsVisible, setLyricsVisible] = useState(false);
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
  const hoverLockRef = useRef(false);

  // Linux 悬停展开：判定**在合成器侧做**（扩展 Near()）。
  // 为什么不让这里算：Wayland 下 `outerPosition()` 不可靠，按它算出来的矩形会整体偏移
  // ——用户实测触发区跑到屏幕左半边（2026-10-25）。
  // 同时用"是否贴近"驱动整窗穿透：不贴近时穿透，周围那块透明区域就不再挡住底下的点击。
  useEffect(() => {
    if (!isLinux()) return undefined;
    let stopped = false;
    let timer: number | undefined;
    const win = getCurrentWebviewWindow();
    let lastThrough: boolean | null = null;

    const tick = async () => {
      if (stopped) return;
      try {
        // 判定的宽高：
        //   收缩态 → 传收缩尺寸（窗口实际尺寸可能还是展开态，不传就会把触发区放大到整块面板）
        //   展开态 → 传 0（用真实窗口矩形），否则展开面板上的按钮会落在判定区外，
        //            被当成"不贴近"而整窗穿透 ⇒ 按钮点不到（2026-10-26 用户实测）
        const expandedNow = useCapsuleStore.getState().expanded;
        const near = await invoke<boolean>('overlay_near', {
          label: win.label,
          w: expandedNow ? 0 : CAPSULE_W,
          h: expandedNow ? 0 : CAPSULE_H,
        });
        const s = useCapsuleStore.getState();
        if (near) {
          if (!s.expanded && !hoverLockRef.current) {
            s.setPanelReady(false);
            s.setExpanded(true);
          }
        } else {
          hoverLockRef.current = false; // 离开即解锁：否则手动收一次后悬停再也打不开
          if (s.expanded && !s.keepOpen) s.setExpanded(false);
        }
        // 收起态**一律**整窗穿透：浮岛窗口是一块 460×340 的透明矩形（合成器实测
        // x=730 y=38 w=460 h=340），即使只显示一颗胶囊，这块矩形也会吃掉它覆盖的所有
        // hover/click —— 表现为"正下方的模块按钮既不高亮也点不动"（2026-10-27 用户实测
        // 图片模块工具栏中段正好在它下面）。
        // 悬停判定不依赖 DOM 事件（走扩展的 global.get_pointer），所以穿透态照样能感知悬停、
        // 照样能自动展开；展开后必须收回输入，否则面板上的按钮点不了。
        const through = !useCapsuleStore.getState().expanded;
        if (through !== lastThrough) {
          lastThrough = through;
          invoke('overlay_set_click_through', { label: win.label, ignore: through }).catch(() => {});
        }
      } catch {
        // 扩展未加载（拿不到 near）：不能靠穿透，否则胶囊永远点不动 ⇒ 恢复输入
        if (lastThrough !== false) {
          lastThrough = false;
          invoke('overlay_set_click_through', { label: win.label, ignore: false }).catch(() => {});
        }
      }
      if (!stopped) timer = window.setTimeout(tick, 120);
    };

    timer = window.setTimeout(tick, 300);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      invoke('overlay_set_click_through', { label: win.label, ignore: false }).catch(() => {});
    };
  }, []); // 收起后锁定悬停自动展开，需点击胶囊才恢复（不触发渲染，保留为 ref）
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

  // 展开时拉取整机会话快照，并低频对账外部系统会话（供堆叠 / 下拉切换）。
  // 播放卡的实时更新已由 smtc_update 事件(onNowPlaying)驱动，这里只承担「外部会话被
  // 关闭后清 selectedKey」的低频兜底，故降频到 15s，避免每 2s 一次后台 IPC 空转。
  useEffect(() => {
    if (expanded) {
      void refreshSessionList();
      const id = setInterval(() => void refreshSessionList(), 15 * 1000);
      return () => clearInterval(id);
    }
  }, [expanded, refreshSessionList]);

  // 封面 URL：
  //  - http(s) 封面（在线曲目）：直接透传（此前一律 convertFileSrc ⇒ 变成垃圾 asset:// 地址）；
  //  - Linux 本地封面：走 media_http（WebKitGTK 不接 asset://，媒体卡/浮岛都会变空图）；
  //  - 其它平台：convertFileSrc。
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  useEffect(() => {
    const cp = play?.cover_path;
    if (!cp) {
      setCoverUrl(null);
      return undefined;
    }
    if (/^https?:/i.test(cp)) {
      setCoverUrl(cp);
      return undefined;
    }
    if (!isLinux()) {
      setCoverUrl(convertFileSrc(cp));
      return undefined;
    }
    let alive = true;
    invoke<string>('media_http_url', { path: cp })
      .then((u) => {
        if (alive) setCoverUrl(u);
      })
      .catch(() => {
        if (alive) setCoverUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [play]);
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

  // 桌面歌词窗口可见性：初始读一次 + 监听广播事件，与音乐模块播放栏双向同步
  useEffect(() => {
    let alive = true;
    invoke<boolean>('get_lyrics_widget_visible')
      .then((v) => { if (alive) setLyricsVisible(!!v); })
      .catch(() => {});
    const unlisten = listen<{ visible: boolean }>('lyrics-widget-visibility-changed', (e) => {
      if (alive) setLyricsVisible(!!e.payload?.visible);
    });
    return () => {
      alive = false;
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  // 按需上屏一次（暂停轮询态下内容变化时使用）
  const presentOverlayNow = useCallback(() => {
    invoke('present_overlay_now').catch(() => {});
  }, []);

  // 展开/收起/对话模式/搜索模式：重新定位（居中）+ 改尺寸 + 上报热区（窗口向左右与向下延展）
  useEffect(() => {
    // AI 编程 / AI 攻防 独占 2 倍宽 × 2 倍高；其余模式宽度不变（用户 2026-10-19 指定）。
    // 优先级必须与下方 h 的三元链一致：chatOpen 优先，其次 aide，再 sec。
    const aideActive = expanded && aideOpen && !chatOpen;
    const secActive = expanded && secOpen && !chatOpen && !aideOpen;
    const w = (aideActive || secActive) ? AIDE_W : EXPANDED_W;
    const h = !expanded ? CAPSULE_H : chatOpen ? CHAT_H : aideOpen ? AIDE_H : secOpen ? AIDE_H : searchOpen ? SEARCH_H : transferOpen ? TRANSFER_H : resourceOpen ? RESOURCE_H : EXPANDED_H;
    // [修复] 用 getCurrentWebviewWindow 取胶囊窗自身（见挂载 effect 注释）：
    // getCurrentWindow() 会误返回主窗；WebviewWindow.getByLabel 是 async 且胶囊内注册表无自身。
    const win = getCurrentWebviewWindow();
    if (!win) return;
    const sx = window.screen.availWidth;
    const t0 = __DEV ? Date.now() : 0;
    // 窗口高度同步门控：从收起态展开且子面板打开时，暂不渲染子面板，等 setSize 完成后
    // 再放开渲染。否则 36→470 高度过渡期间，React 已渲染的子面板内容被旧窗高裁剪。
    const expanding = expanded && !prevExpandedRef.current;
    const subPanelOpen = chatOpen || searchOpen || transferOpen || resourceOpen;
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
    // 夹取：AI 编程放大到 920×920 后，在 768/900 高度的屏上会超出可用区
    // （窗口超出屏幕部分不可见，且热区按物理矩形算会错位）。这里按可用屏幕尺寸收敛。
    const maxW = Math.max(320, window.screen.availWidth - 16);
    const maxH = Math.max(200, window.screen.availHeight - TOP_Y - 8);
    const wf = Math.min(w, maxW);
    const hf = Math.min(h, maxH);
    // 居中必须用夹取后的宽度算，否则夹取时窗口会偏右
    const x = Math.round((sx - wf) / 2);
    if (__DEV && (wf !== w || hf !== h)) {
      console.log('[CAPSULE-PROBE] 尺寸被屏幕夹取', { want: [w, h], got: [wf, hf] });
    }
    win.setPosition(new LogicalPosition(x, TOP_Y)).catch(() => {});
    // 穿透/点击切换：收起态 ignore=true（点击穿透桌面），展开态 ignore=false（接收点击）。
    // 原由 Rust 侧 set_ignore_cursor_events 负责，但 Rust 用 get_webview_window 克隆全局窗表里的
    // WebviewWindow 会在窗销毁竞态下克隆已损坏的 Arc 触发 assert_unchecked 中止；改由胶囊对自身窗调用。
    // 收起态不再设为鼠标穿透：改为可点击，用户点击胶囊即可展开（悬停自动展开仍由 hoverLockRef 阻止）
    win.setIgnoreCursorEvents(false).catch(() => {});
    win
      .setSize(new LogicalSize(wf, hf))
      .then(() => {
        reportRect(wf, hf);
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
  }, [expanded, chatOpen, aideOpen, secOpen, searchOpen, transferOpen, resourceOpen, presentOverlayNow]);

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
        // 浮岛「AI 编程」：直接调后端 ai_chat_agent（独立执行器）；与其它面板互斥
        s.setExpanded(true);
        s.setChatOpen(false);
        s.setSearchOpen(false);
        s.setTransferOpen(false);
        s.setSecOpen(false);
        s.setAideOpen(!s.aideOpen);
      } else if (kind === 'sec') {
        // 浮岛「AI 攻防」：与 AI 编程平级、互斥（2026-10-19 从攻防模块侧栏迁入）
        s.setExpanded(true);
        s.setChatOpen(false);
        s.setSearchOpen(false);
        s.setTransferOpen(false);
        s.setAideOpen(false);
        s.setSecOpen(!s.secOpen);
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
      } else if (kind === 'resource') {
        // 切换资源监视模式；与对话/搜索/传输/AI 编程互斥；强制展开（不被收起态折叠）
        s.setExpanded(true);
        s.setChatOpen(false);
        s.setSearchOpen(false);
        s.setTransferOpen(false);
        s.setAideOpen(false);
        s.setSecOpen(false);
        s.setResourceOpen(!s.resourceOpen);
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
      } else if (kind === 'favorite') {
        // 常用笔记：用「后端收藏列表 + 局部索引」轮转，不依赖独立 webview 的 notesStore。
        // 每次召唤重新拉取最新收藏列表：用户可能刚「收藏/解除收藏」，若用缓存会召唤出
        // 已解除常用笔记标记的旧笔记浮窗（陈旧列表 bug）。点击频率低，一次 IPC 开销可忽略。
        try {
          let noteId: string | null = null;
          try {
            favListRef.current = (await api.getAllFavorites()) ?? [];
            const list = favListRef.current;
            if (list.length > 0) {
              noteId = list[favIdxRef.current % list.length];
              favIdxRef.current += 1;
            }
          } catch { noteId = null; }
          if (noteId) {
            const content = await api.getNoteContent(noteId);
            if (content) {
              await api.createFloatingNoteWindow(noteId, content.title || '未命名', 200, 200);
            }
          } else {
            // 无收藏笔记：给用户明确反馈，避免「点击无效」的困惑
            try { useCapsuleStore.getState().showToast('还没有收藏的笔记'); } catch {}
          }
        } catch (err) {
          console.error('[Capsule] 常用笔记操作失败:', err);
        }
      } else if (kind === 'deskpet') {
        // 桌宠：切换显示/隐藏
        try {
          const label = 'deskpet';
          const existing = await import('@tauri-apps/api/webviewWindow').then(m => m.WebviewWindow.getByLabel(label));
          if (existing) {
            const visible = await existing.isVisible();
            if (visible) {
              await existing.hide();
            } else {
              await existing.show();
              await existing.setFocus();
            }
          } else {
            // 首次打开：走统一浮窗引擎（ensureOverlayWindow → overlay_window_get_or_create）。
            // 这里原来调的是后端并不存在的 show_deskpet 命令（全仓 .rs 零命中），
            // 所以「第一次点桌宠」必然失败并被下面的 catch 吞成一行 console.error（2026-10-21 修）。
            // 注意：注释里不要出现「invoke 紧跟括号」的写法——契约测试按文本扫描，
            // 注释里的示例也会被当成真实调用（我刚踩过：它把下一行的 'deskpet' 认成了命令名）。
            // profile 与「茑萝/deskpet」插件保持同一份，避免两处漂移。
            await ensureOverlayWindow('deskpet', 'deskpet.html', {
              transparent: true,
              decorations: false,
              shadow: false,
              skipTaskbar: true,
              alwaysOnTop: true,
              resizable: false,
            });
          }
        } catch (err) {
          console.error('[Capsule] 桌宠操作失败:', err);
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
        // 走 console.error 而非 log：宿主只把 error 转发进会话日志（file-logger.ts），
        // 否则这条探针只在 DevTools 里可见，真机取证拿不到（2026-10-20）。
        // eslint-disable-next-line no-console
        console.error(
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
      console.error('[CAPSULE-PROBE] visibilitychange -> ' + document.visibilityState);
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
    //
    // 展开态按需分两档（2026-10-19 起，2026-10-20 补两个信号）：
    //   · 16ms（60fps）—— 有东西真的在动：媒体在播 / 面板流式输出 / 正在做尺寸过渡 / 指针在岛内
    //   · 33ms（30fps）—— 纯静态阅读
    // 为什么不是一律 60fps：每帧要做 SetIsVisible + NotifyParentWindowPositionChanged，
    // 让 DWM 重合成整块透明窗；面板放大到 920×920 后单帧面积是原来 4 倍，常驻 60fps
    // 会持续挤占合成器时间。
    //
    // 为什么必须补这两个信号（用户反馈"不够丝滑"的真正原因）：
    //   · 金色 pill 的 width/height 过渡是 260ms，只有重绘到 60fps 才跑得顺；
    //     旧规则在"没在播歌、没在流式"时给 33ms，等于把过渡强行压成 30fps 的台阶感。
    //   · 用户在面板里滚动/拖动/打字时，输入事件的反馈同样受这条重绘节奏约束，
    //     30fps 下滚动会明显发涩 —— 指针在岛内就给 60fps，移开立刻回落，成本只在交互期间。
    // 过渡期（transiting，340ms）**即使已经收起也给 60fps**：收起时 expanded 立刻变 false，
    // 但 pill 的 260ms 缩回过渡才刚开始 —— 按旧规则这时会回到 0（停止 presents），
    // 表现为收起过程卡住再跳一下。只在这 340ms 内牺牲一点节流收益，换取过渡顺滑。
    const ms = transiting ? 16 : !expanded ? 0 : (isPlaying || streaming || pointerIn ? 16 : 33);
    if (__DEV) {
      console.log('[CAPSULE-PROBE] request_repaint_rate', ms, { expanded, isPlaying, streaming, transiting, pointerIn });
    }
    invoke('set_overlay_repaint_rate', { intervalMs: ms }).catch((e: unknown) => {
      console.warn('[Capsule] 设置重绘频率失败（浮岛可能被降频节流）:', ms, e);
    });
  }, [expanded, isPlaying, streaming, transiting, pointerIn]);

  // 尺寸/模式切换后的 340ms 内提到 60fps：pill 的 width/height 过渡是 260ms
  // （见下方 borderRadius/transition），留 80ms 余量给最后一帧收口。
  // 依赖里必须包含所有会改变体积的开关，否则「对话→AI 编程」这种同展开态内的
  // 尺寸变化不会触发脉冲。
  useEffect(() => {
    setTransiting(true);
    const timer = window.setTimeout(() => setTransiting(false), 340);
    return () => window.clearTimeout(timer);
  }, [expanded, chatOpen, aideOpen, secOpen, searchOpen, transferOpen, resourceOpen]);

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

  const pillH = !expanded ? CAPSULE_H : chatOpen ? CHAT_H : aideOpen ? AIDE_H : secOpen ? AIDE_H : searchOpen ? SEARCH_H : transferOpen ? TRANSFER_H : resourceOpen ? RESOURCE_H : EXPANDED_H;

  // 可见区（金色 pill）必须与窗口同尺寸，否则窗口多出来的部分就是「透明区域」：
  // 窗口 920、内容仍 460 时，用户看到的是「变宽了但什么都没变」。
  // 这里用与窗口侧（setSize 的 wf/hf）完全一致的夹取规则，保证内外一致。
  const bodyWantW = expanded ? ((aideOpen || secOpen) && !chatOpen ? AIDE_W : EXPANDED_W) : CAPSULE_W;
  const bodyW = Math.min(bodyWantW, Math.max(320, window.screen.availWidth - 16));
  const bodyH = Math.min(pillH, Math.max(200, window.screen.availHeight - TOP_Y - 8));

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
                (a.kind === 'ai' && chatOpen) || (a.kind === 'aide' && aideOpen) || (a.kind === 'sec' && secOpen) || (a.kind === 'search' && searchOpen) || (a.kind === 'transfer' && transferOpen) || (a.kind === 'resource' && resourceOpen)
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
        // 指针在岛内 = 正在交互（滚动/拖动/点按/输入），这段时间给 60fps；
        // 移出即回落 30fps。onPointerEnter/Leave 在 React 里按子树语义触发，
        // 指针在内部子元素间移动不会反复触发（不会抖动切档）。
        onPointerEnter={() => setPointerIn(true)}
        onPointerLeave={() => setPointerIn(false)}
        style={{
          width: bodyW,
          height: bodyH,
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
          {expanded && !chatOpen && !searchOpen && !transferOpen && !aideOpen && !secOpen && !resourceOpen && (
            // 滚动契约：外层胶囊本体是 `overflow: hidden` 的定高窗口（EXPANDED_H = 340），
            // 本容器是它唯一的滚动出口。此前缺 overflowY，内容一旦超出就被直接裁掉、
            // 滚轮完全无效（窗口/显示器缩放变化、系统字体放大、多会话下拉增多时必现）。
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '12px 14px 12px', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
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
{/* 桌面歌词：状态由后端可见性事件驱动（见上方 effect），与音乐模块播放栏同一个事实源 */}
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await invoke(lyricsVisible ? 'hide_lyrics_widget' : 'show_lyrics_widget');
                      } catch (err) {
                        console.error('[Capsule] 歌词窗口操作失败:', err);
                      }
                    }}
                    style={{
                      ...btnBase,
                      width: 34,
                      height: 34,
                      color: lyricsVisible ? '#e6c35c' : '#f2f2f4',
                      background: lyricsVisible ? 'rgba(230,195,92,0.18)' : 'rgba(255,255,255,0.06)',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.14)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = lyricsVisible ? 'rgba(230,195,92,0.18)' : 'rgba(255,255,255,0.06)')}
                    title={t('capsule.action.lyrics')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 17h4" /><path d="M4 13h7" /><path d="M4 9h10" /><path d="M15 6l3 3-3 3" />
                    </svg>
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

          {/* 展开态 · 浮岛「AI 攻防」—— 与 AI 编程平级、互斥 */}
          {expanded && secOpen && panelReady && <CapsuleSecAide />}

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

          {/* 展开态 · 资源监视（CPU / GPU / 显存 / 内存 四项实时占用） */}
          {expanded && resourceOpen && panelReady && <CapsuleResource />}
        </div>
      </div>
    </div>
  );
}
