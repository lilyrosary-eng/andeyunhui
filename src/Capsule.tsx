// 黄金棋盘（原灵动岛，Dynamic Island）—— 屏幕顶部居中常驻的透明小窗。
// 收起态（240×36）：常驻时间 + 天气，紧凑不抢眼；
// 鼠标靠近顶部中央时由 Rust 侧光标监视线程（capsule_start_monitor）自动展开，也可点胶囊切换；
// 展开后向左右 + 向下延展，默认露出专辑大图、播放控制、音量与快捷操作；点「AI」切换为内置对话模式，
// 直接复用全局 AI 能力（ai_chat 命令 + ai-delta/done/error 事件，与 ai 模块同源）。
// 作为 茑萝 的子插件（plugins/茑萝/capsule）承载，窗口内容随主包由 main.tsx 分流渲染。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
// [修复] 用 getCurrentWebviewWindow 取「当前 webview 所属窗」(胶囊窗,label='capsule')。
// 不能用 getCurrentWindow()(Tauri v2 下 metadata.currentWindow 误指向主窗→返回主窗)
// 也不能用 WebviewWindow.getByLabel(它是 async 且胶囊内 JS 注册表未含自身→返回 null)。
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { ensureOverlayWindow, type OverlayProfile } from '@/core/overlayWindow';
import { FileSearchPanel } from '@/components/FileSearchPanel';
import { ThinkingToggle } from '@/core/ai/ThinkingToggle';

// 收起态窗口尺寸（逻辑像素）：高 50%、长 75%（相对上一版 320×72）
export const CAPSULE_W = 240;
export const CAPSULE_H = 36;
// 展开态尺寸：比收起态更宽，向左右延展；高度按模式区分
const EXPANDED_W = 460;
const EXPANDED_H = 340; // 播放器模式
const CHAT_H = 460; // 对话模式（更高，容纳消息列表）
const SEARCH_H = 470;
const TRANSFER_H = 470; // 搜索模式（容纳结果列表）
const TOP_Y = 6;

interface PlayInfo {
  title: string;
  artist: string;
  album: string;
  is_playing: boolean;
  media_type: string;
  cover_path: string | null;
  can_prev: boolean;
  can_next: boolean;
  /** 来源：'system' = 整机媒体监视读取的任意 App；缺省/其他 = 本应用经 smtc_update 推送 */
  source?: string;
  /** 会话稳定标识：系统会话=AUMID，本应用="app"。多个媒体间去重/切换用 */
  key?: string;
}
interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string; // 思考模式下的思维链（reasoning_content），可折叠遮罩展示
  error?: boolean;
}
// 多会话：下拉选择 / 新建对话
interface Conversation {
  id: string;
  title: string;
  messages: ChatMsg[];
  updatedAt: number;
}

// 接收请求载荷（与 Rust transfer.rs 的 transfer-receive-request 事件一致）
interface ReceiveRequest {
  session_id: string;
  sender_alias: string;
  file_count: number;
  file_names: string[];
  auto_accept: boolean;
}

function fmtTime(d = new Date()): string {
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function toPlayInfo(p: Record<string, unknown> | null | undefined): PlayInfo {
  const o = (p ?? {}) as Record<string, unknown>;
  return {
    title: typeof o.title === 'string' ? o.title : '',
    artist: typeof o.artist === 'string' ? o.artist : '',
    album: typeof o.album === 'string' ? o.album : '',
    is_playing: !!o.is_playing,
    media_type: typeof o.media_type === 'string' ? o.media_type : '',
    cover_path: typeof o.cover_path === 'string' && o.cover_path ? o.cover_path : null,
    can_prev: !!o.can_prev,
    can_next: !!o.can_next,
    source: typeof o.source === 'string' ? o.source : undefined,
    key: typeof o.key === 'string' ? o.key : undefined,
  };
}

// —— 内联 SVG 图标（避免额外依赖）——
const svgProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
const GOLD = '#e6c35c';
const IconScreenshot = () => (
  <svg {...svgProps}>
    <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="12.5" r="3.2" />
  </svg>
);
const IconRecord = () => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" />
  </svg>
);
const IconDropzone = () => (
  <svg {...svgProps}>
    <path d="M4 13l3-7h10l3 7" />
    <path d="M4 13h4l1.5 3h5L16 13h4v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
  </svg>
);
const IconClipboard = () => (
  <svg {...svgProps}>
    <rect x="6" y="4" width="12" height="17" rx="2" />
    <path d="M9 4a3 3 0 0 1 6 0" />
    <path d="M9 11h6M9 15h6" />
  </svg>
);
const IconPlay = () => (
  <svg {...svgProps}>
    <path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none" />
  </svg>
);
const IconPause = () => (
  <svg {...svgProps}>
    <rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
  </svg>
);
const IconPrev = () => (
  <svg {...svgProps}>
    <path d="M7 5v14" />
    <path d="M19 5L9 12l10 7z" fill="currentColor" stroke="none" />
  </svg>
);
const IconNext = () => (
  <svg {...svgProps}>
    <path d="M17 5v14" />
    <path d="M5 5l10 7-10 7z" fill="currentColor" stroke="none" />
  </svg>
);
const IconVolume = () => (
  <svg {...svgProps}>
    <path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" stroke="none" />
    <path d="M16 9a4 4 0 0 1 0 6" />
  </svg>
);
const IconVolumeMute = () => (
  <svg {...svgProps}>
    <path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" stroke="none" />
    <path d="M16 9l5 6M21 9l-5 6" />
  </svg>
);
const IconChevron = () => (
  <svg {...svgProps} width={16} height={16}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
const IconClose = () => (
  <svg {...svgProps} width={16} height={16}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const IconSearchGlass = () => (
  <svg {...svgProps} width={18} height={18}>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.5-4.5" />
  </svg>
);
const IconFolder = () => (
  <svg {...svgProps} width={16} height={16}>
    <path d="M3 6h5l2 2h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" />
  </svg>
);
const IconFileDoc = () => (
  <svg {...svgProps} width={16} height={16}>
    <path d="M6 3h8l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v4h4" />
  </svg>
);
const IconNote = () => (
  <svg {...svgProps} width={18} height={18}>
    <path d="M9 18V5l10-2v13" />
    <circle cx="6" cy="18" r="3" fill="currentColor" stroke="none" />
    <circle cx="16" cy="16" r="3" fill="currentColor" stroke="none" />
  </svg>
);
const IconBot = () => (
  <svg {...svgProps}>
    <rect x="4" y="8" width="16" height="11" rx="3" />
    <path d="M12 8V4M9 4h6" />
    <circle cx="9" cy="13" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="15" cy="13" r="1.3" fill="currentColor" stroke="none" />
  </svg>
);
const IconSend = () => (
  <svg {...svgProps} width={18} height={18}>
    <path d="M4 12l16-8-6 16-3-7z" fill="currentColor" stroke="none" />
  </svg>
);
const IconTransfer = () => (
  <svg {...svgProps} width={18} height={18}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M21 4v4h-4M3 20v-4h4" />
  </svg>
);
const IconDevice = () => (
  <svg {...svgProps} width={16} height={16}>
    <rect x="3" y="5" width="18" height="11" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
);
// 天气图标：晴/少云用太阳，其余用云
const IconWeather = ({ code }: { code: number | null }) => {
  const clear = code === 0 || code === 1;
  if (clear) {
    return (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A3.5 3.5 0 0 1 17 18z" />
    </svg>
  );
};

const ACTIONS = [
  { kind: 'ai', label: 'AI', Icon: IconBot },
  { kind: 'search', label: '搜索', Icon: IconSearchGlass },
  { kind: 'screenshot', label: '截图', Icon: IconScreenshot },
  { kind: 'record', label: '录屏', Icon: IconRecord },
  { kind: 'dropzone', label: '中转站', Icon: IconDropzone },
  { kind: 'clipboard', label: '剪贴板', Icon: IconClipboard },
  { kind: 'transfer', label: '传输', Icon: IconTransfer },
] as const;

// 黑白棋盘底纹（深色半透明底叠半透明白格），放大 3 倍、整体倾斜 30°，呼应「黄金棋盘」主题；
// 放大覆盖 (-80%) 确保宽扁的胶囊在 30° 旋转后仍被完整覆盖；整体保持半透明，桌面可透出。
const checkerLayerStyle: React.CSSProperties = {
  position: 'absolute',
  inset: '-80%',
  transform: 'rotate(30deg) translateZ(0)',
  backgroundColor: 'rgba(18,18,20,0.45)',
  backgroundImage: `
    linear-gradient(45deg, rgba(245,245,245,0.16) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(245,245,245,0.16) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(245,245,245,0.16) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(245,245,245,0.16) 75%)
  `,
  backgroundSize: '66px 66px',
  backgroundPosition: '0 0, 0 33px, 33px -33px, -33px 0',
  // 提升为独立合成层，避免父级每次重渲染都重新合成这块大渐变（透明浮窗关键性能点）
  willChange: 'transform',
  backfaceVisibility: 'hidden',
};

// 轻暗叠层（与棋盘底纹同为静态装饰，整段抽到模块级常量，渲染时复用同一元素引用，
// React 直接跳过其协调，进一步降低透明浮窗重渲染开销）
const darkOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'linear-gradient(160deg, rgba(8,8,8,0.16), rgba(8,8,8,0.26))',
  borderRadius: 'inherit',
  pointerEvents: 'none',
};
const DECO_LAYERS = (
  <>
    <div style={checkerLayerStyle} />
    <div style={darkOverlayStyle} />
  </>
);

// 时钟：自带 1s 定时器与自身 state，更新仅限本组件，父级（整棵 Capsule）不再每秒重渲染。
// 这是外部媒体后台播放时浮窗"不丝滑"的核心修复点——此前时钟 setClock 每秒触发整树重渲染。
const Clock = memo(function Clock() {
  const [t, setT] = useState(fmtTime());
  useEffect(() => {
    const id = setInterval(() => setT(fmtTime()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: GOLD }}>
      {t}
    </span>
  );
});

function weatherLabel(code: number | null): string {
  if (code == null) return '—';
  if (code === 0) return '晴';
  if (code <= 3) return '多云';
  if (code <= 48) return '雾';
  if (code <= 67) return '雨';
  if (code <= 77) return '雪';
  if (code <= 82) return '阵雨';
  if (code <= 86) return '阵雪';
  if (code >= 95) return '雷暴';
  return '—';
}

// 带手动超时的 fetch（不依赖 AbortSignal.timeout，兼容老版 WebView2）
async function fetchJson(url: string, ms: number): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const btnBase: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: GOLD,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  borderRadius: 10,
  transition: 'background 140ms ease, transform 140ms ease',
};

// ============ 局域网传输面板（黄金棋盘·传输，LocalSend v2 兼容）============
interface TransferPeer {
  fingerprint: string;
  alias: string;
  device_type?: string | null;
  device_model?: string | null;
  ip: string;
  port: number;
  protocol: string;
}
interface TransferProgressItem {
  direction: 'send' | 'receive';
  session_id: string;
  file_id: string;
  file_name: string;
  received: number;
  total: number;
  done: boolean;
  peer_alias: string;
}

function TransferPanel({
  onClose,
  receiveRequest,
  onAcceptReceive,
  onDeclineReceive,
}: {
  onClose: () => void;
  receiveRequest: ReceiveRequest | null;
  onAcceptReceive: () => void;
  onDeclineReceive: () => void;
}) {
  const [peers, setPeers] = useState<TransferPeer[]>([]);
  const [progress, setProgress] = useState<TransferProgressItem[]>([]);
  const [running, setRunning] = useState(false);
  const [alias, setAlias] = useState('安得云荟');
  const [staged, setStagedState] = useState<string[]>([]);
  const [confirmPeer, setConfirmPeer] = useState<TransferPeer | null>(null);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [stagedOpen, setStagedOpen] = useState(false); // 暂存文件下拉总览
  // 首次使用引导：提示自定义本机名称 + 接收文件保存路径（localStorage 持久引导标记）
  const [onboarded, setOnboarded] = useState<boolean>(() => {
    try { return localStorage.getItem('andeyunhui.transfer.onboarded') === '1'; } catch { return false; }
  });
  const [saveDir, setSaveDir] = useState('');
  const dismissOnboard = useCallback(() => {
    try { localStorage.setItem('andeyunhui.transfer.onboarded', '1'); } catch { /* 忽略 */ }
    setOnboarded(true);
  }, []);
  const pickSaveDir = useCallback(async () => {
    const dir = (await invoke('pick_directory').catch(() => null)) as string | null;
    if (dir) {
      setSaveDir(dir);
      await invoke('transfer_set_save_dir', { dir }).catch(() => {});
    }
  }, []);

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
      setSaveDir((await invoke('transfer_get_save_dir').catch(() => '')) as string);
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
    // 不在此重复监听，避免两端同时弹窗/重复确认。
    // 原生拖放：胶囊窗开启 dragDropEnabled，拖入文件经此事件拿到真实路径
    const unlistenDrag = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'drop') {
        const paths = (payload.paths || []).filter((p) => !!p);
        if (paths.length) setStaged((prev) => Array.from(new Set([...prev, ...paths])));
      }
    });
    unlistenDrag.then((u) => offs.push(u)).catch(() => {});
    return () => offs.forEach((u) => u());
  }, []);

  const applyAlias = async (v: string) => {
    const val = v.trim() || '安得云荟';
    setAlias(val);
    await invoke('transfer_set_alias', { alias: val }).catch(() => {});
  };

  // 发送出错必须在 UI 可见（浮窗用户看不到控制台，.catch 吞掉就是「点了没反应」）
  const doSend = async (fingerprint: string, paths: string[]) => {
    setSendErr(null);
    try {
      await invoke('transfer_send', { fingerprint, paths });
    } catch (e) {
      setSendErr(String(e));
    }
  };

  // 点击对端：有暂存文件 → 先确认；无暂存 → 退回系统文件选择框
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
    setStagedOpen(false);
    await doSend(fp, paths);
  };

  const addFiles = async () => {
    const picked = (await open({ multiple: true, title: '选择要发送的文件' })) as string[] | null;
    if (picked && picked.length) setStaged((prev) => Array.from(new Set([...prev, ...picked])));
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '10px 12px 10px', position: 'relative' }} onClick={(e) => e.stopPropagation()}>

      {/* 接收确认弹窗：浮岛（黄金棋盘）作为主接收方，收到请求时在此询问是否接收 */}
      {receiveRequest && !receiveRequest.auto_accept && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12 }} onClick={(e) => e.stopPropagation()}>
          <div style={{ width: '88%', maxWidth: 300, background: '#232326', borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', padding: 16, boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#f6f6f8', marginBottom: 8 }}>收到文件请求</div>
            <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.8)', marginBottom: 6 }}>来自：{receiveRequest.sender_alias}</div>
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
          <div style={{ fontSize: 13, fontWeight: 700, color: '#f6f6f8' }}>局域网传输</div>
          <div style={{ fontSize: 11, color: 'rgba(244,244,246,0.62)' }}>
            {running ? '已开启 · 可被同网设备发现' : '未开启'} · 兼容 LocalSend
          </div>
        </div>
        <button onClick={onClose} title="返回播放器" style={{ ...btnBase, width: 28, height: 28 }}>
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
            <button onClick={dismissOnboard} title="知道了" style={{ ...btnBase, flex: '0 0 auto', width: 18, height: 18, fontSize: 12, color: 'rgba(244,244,246,0.7)' }}>×</button>
          </div>
        </div>
      )}

      {/* 本机名称（设备名，默认安得云荟，可改） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.55)', flex: '0 0 auto' }}>本机名称</span>
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
        <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.55)', flex: '0 0 auto' }}>保存路径</span>
        <input
          value={saveDir}
          readOnly
          placeholder="默认：程序目录下的 send 文件夹"
          title={saveDir}
          style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '5px 8px', color: 'rgba(244,244,246,0.8)', fontSize: 11, outline: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        />
        <button onClick={pickSaveDir} title="选择保存目录" style={{ ...btnBase, flex: '0 0 auto', padding: '5px 8px', fontSize: 11, borderRadius: 8, background: 'rgba(255,255,255,0.1)', color: '#f6f6f8' }}>
          选择
        </button>
      </div>

      {/* 拖入文件栏：➕ 左边是「总览 + 下拉框」触发区（点它展开全部暂存文件），不影响 ➕ 的导入 */}
      <div style={{ position: 'relative', marginTop: 8 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 38, padding: '4px 8px', borderRadius: 9, background: 'rgba(255,255,255,0.05)', border: '1px dashed rgba(255,255,255,0.18)' }}
          onClick={(e) => { e.stopPropagation(); if (staged.length === 0) addFiles(); }}
        >
          {staged.length === 0 ? (
            <span style={{ flex: 1, fontSize: 11.5, color: 'rgba(244,244,246,0.5)' }}>把文件拖到这里，或点此选择</span>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setStagedOpen((v) => !v); }}
              title={stagedOpen ? '收起文件列表' : '查看全部待发送文件'}
              style={{ ...btnBase, flex: 1, minWidth: 0, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '0 8px', background: 'rgba(255,255,255,0.08)', borderRadius: 7 }}
            >
              <span style={{ fontSize: 11.5, color: 'rgba(244,244,246,0.9)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                已选 {staged.length} 个文件 · {staged[0].split(/[/]/).pop()}{staged.length > 1 ? ' 等' : ''}
              </span>
              <span style={{ fontSize: 10, color: GOLD, flex: '0 0 auto', transform: stagedOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▼</span>
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); addFiles(); }} title="添加文件" style={{ ...btnBase, width: 26, height: 26, flex: '0 0 auto', color: GOLD }}>＋</button>
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
                  <button onClick={() => setStaged((prev) => { const next = prev.filter((x) => x !== p); if (next.length === 0) setStagedOpen(false); return next; })} title="移除" style={{ ...btnBase, width: 18, height: 18, fontSize: 12, lineHeight: '16px', color: 'rgba(244,244,246,0.7)', flex: '0 0 auto' }}>×</button>
                </div>
              );
            })}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4, paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <button onClick={() => { setStaged([]); setStagedOpen(false); }} style={{ ...btnBase, padding: '3px 8px', fontSize: 11, color: 'rgba(244,244,246,0.6)' }}>清空全部</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {peers.length === 0 && (
          <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.55)', textAlign: 'center', marginTop: 12 }}>
            正在发现同网设备…（开启官方 LocalSend 或本应用即可互传）
          </div>
        )}
        {peers.map((p) => (
          <div key={p.fingerprint} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 9, background: 'rgba(255,255,255,0.05)' }}>
            <span style={{ fontSize: 16, color: GOLD, flex: '0 0 18px', textAlign: 'center' }}><IconDevice /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.alias}</div>
              <div style={{ fontSize: 10.5, color: 'rgba(244,244,246,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.ip}:{p.port}</div>
            </div>
            <button onClick={() => sendTo(p)} title="发送文件" style={{ ...btnBase, width: 34, height: 30, color: GOLD }}>
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
              {p.direction === 'send' ? '发→' : '收←'} {p.peer_alias}：{p.file_name}
              {!p.done && p.total > 0 ? ` ${Math.round((p.received / p.total) * 100)}%` : ''}
            </div>
          ))}
        </div>
      )}

      {/* 发送前确认 */}
      {confirmPeer && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20 }} onClick={(e) => { e.stopPropagation(); setConfirmPeer(null); }}>
          <div style={{ background: '#1c1c1e', borderRadius: 12, padding: 16, width: 260, boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#f6f6f8' }}>发送给「{confirmPeer.alias}」？</div>
            <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.6)', marginTop: 6 }}>
              共 {staged.length} 个文件（{staged.map((p) => p.split(/[/]/).pop()).join('、')}）
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button onClick={() => setConfirmPeer(null)} style={{ ...btnBase, padding: '5px 12px', fontSize: 12 }}>取消</button>
              <button onClick={confirmSend} style={{ ...btnBase, padding: '5px 12px', fontSize: 12, color: '#1c1c1e', background: GOLD, fontWeight: 600 }}>确认发送</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Capsule() {
  const [expanded, setExpanded] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // 子面板渲染门控：从收起态展开且子面板打开时，先等 setSize 完成再渲染子面板，
  // 防止 36→470 高度过渡期间面板内容被旧窗高裁剪（标题栏+关闭按钮不可见）。
  const [panelReady, setPanelReady] = useState(true);
  const prevExpandedRef = useRef(false);
  const [play, setPlay] = useState<PlayInfo | null>(null);
  // 双源分离：system=整机媒体监视读取的任意 App；app=本应用经 smtc_update 推送。展示优先级 system > app。
  const appPlayRef = useRef<PlayInfo | null>(null);
  const sysPlayRef = useRef<PlayInfo | null>(null);
  // 多会话切换（堆叠 + 下拉）：sessionList=外部会话快照；appPlay=本应用会话镜像；selectedKey=用户选中（null=跟随实时）
  const [searchOpen, setSearchOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  // 浮岛（黄金棋盘）作为主接收方：收到的待确认接收请求
  const [receiveReq, setReceiveReq] = useState<ReceiveRequest | null>(null);
  // 轻量 toast：接收请求 / 接收中 / 接收完成 等提示（浮岛不弹主窗模态时，用户仍需明确反馈）
  const [toast, setToast] = useState<{ msg: string } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast({ msg });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);
  const [sessionList, setSessionList] = useState<PlayInfo[]>([]);
  const [appPlay, setAppPlay] = useState<PlayInfo | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const sessionListRef = useRef<PlayInfo[]>([]);
  const selectedKeyRef = useRef<string | null>(null);
  const expandedRef = useRef(false); // 收起态下屏蔽与展示无关的 state churn，避免后台播放时重渲染
  const playKeyRef = useRef(''); // 内容比对，避免 applyDisplay 每次都 setPlay

  // —— 接收请求：浮岛（黄金棋盘）作为主接收方 ——
  // 收到 transfer-receive-request 时自动展开浮岛并跳到传输页，弹出「是否接收」询问。
  const acceptReceive = useCallback(async () => {
    if (!receiveReq) return;
    const n = receiveReq.file_count;
    await invoke('transfer_receive_accept', { sessionId: receiveReq.session_id }).catch(() => {});
    setReceiveReq(null);
    showToast(`已开始接收 ${n} 个文件`);
  }, [receiveReq, showToast]);
  const declineReceive = useCallback(async () => {
    if (!receiveReq) return;
    const name = receiveReq.sender_alias;
    await invoke('transfer_receive_decline', { sessionId: receiveReq.session_id }).catch(() => {});
    setReceiveReq(null);
    showToast(`已拒绝 ${name} 的文件`);
  }, [receiveReq, showToast]);
  useEffect(() => {
    const offs: Array<() => void> = [];
    listen('transfer-receive-request', (e: { payload: ReceiveRequest }) => {
      const p = e.payload;
      if (!p?.session_id) return;
      // 自动展开浮岛并跳转到传输页
      setExpanded(true);
      setTransferOpen(true);
      if (!p.auto_accept) setReceiveReq(p);
      // 确保浮岛窗口可见并置于前台（自动弹出）
      const w = getCurrentWebviewWindow();
      try {
        w.show().catch(() => {});
        w.setFocus().catch(() => {});
      } catch { /* 窗口已可见则忽略 */ }
      // 通知主窗：接收由浮岛处理，主窗不再弹确认框
      emit('transfer-receive-capsule-took', { session_id: p.session_id }).catch(() => {});
      // 顶部提示：自动接收时给「正在接收」反馈（否则浮岛静默，用户以为没反应）；
      // 需确认时也给一句引导，与确认框互补。
      showToast(
        p.auto_accept
          ? `正在接收 ${p.file_count} 个文件（来自 ${p.sender_alias}）`
          : `收到 ${p.sender_alias} 的 ${p.file_count} 个文件请求`,
      );
    }).then((u) => offs.push(u));
    // 接收请求在别处被确认/拒绝时，同步清除本地弹窗
    const clearIf = (sid: string) =>
      setReceiveReq((cur) => (cur && cur.session_id === sid ? null : cur));
    listen('transfer-receive-confirmed', (e: { payload: { session_id: string } }) => {
      if (e.payload?.session_id) clearIf(e.payload.session_id);
    }).then((u) => offs.push(u));
    listen('transfer-receive-declined', (e: { payload: { session_id: string } }) => {
      if (e.payload?.session_id) clearIf(e.payload.session_id);
    }).then((u) => offs.push(u));
    // 接收完成（每个文件 mark_done 触发一次）：提示已存入中转站
    listen('transfer-received', (e: { payload: { file_name: string; peer_alias: string } }) => {
      const p = e.payload;
      if (p?.file_name) showToast(`接收完成：${p.file_name} 已存入中转站`);
    }).then((u) => offs.push(u));
    return () => offs.forEach((u) => u());
  }, [showToast]);

  // 计算应展示的媒体卡片：选中具体会话则固定它，否则跟随实时（system > app）
  const computePlay = (): PlayInfo | null => {
    if (selectedKeyRef.current) {
      const all = [...sessionListRef.current];
      if (appPlayRef.current) all.push(appPlayRef.current);
      return (
        all.find((s) => s.key === selectedKeyRef.current) ??
        sysPlayRef.current ??
        appPlayRef.current ??
        null
      );
    }
    return sysPlayRef.current ?? appPlayRef.current ?? null;
  };
  // 仅在内容真正变化时更新，避免后台播放期间冗余 setState 拖累透明浮窗合成
  const applyDisplay = () => {
    const next = computePlay();
    const key = next
      ? `${next.key}|${next.title}|${next.artist}|${next.album}|${next.cover_path}|${next.is_playing}|${next.can_prev}|${next.can_next}`
      : '';
    if (key !== playKeyRef.current) {
      playKeyRef.current = key;
      setPlay(next);
    }
  };
  const refreshList = useCallback(async () => {
    try {
      const list = (await invoke('smtc_list_sessions')) as PlayInfo[];
      sessionListRef.current = list;
      setSessionList(list);
      applyDisplay();
    } catch {
      /* 忽略查询失败 */
    }
  }, []);
  // 搜索状态及 UI 已提取到 FileSearchPanel（与主窗口黄金棋盘面板共享复用）

  // 收起即「回到主页」：关闭所有子面板（搜索/对话/传输），避免再次展开时卡在搜索页。
  const collapse = () => {
    setExpanded(false);
    setSearchOpen(false);
    setChatOpen(false);
    setTransferOpen(false);
  };

  // Esc 兜底逃生：搜索/对话/传输子面板或展开态下按 Esc 一律回到主页，杜绝"卡在搜索页无法返回"。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (searchOpen) setSearchOpen(false);
      else if (chatOpen) setChatOpen(false);
      else if (transferOpen) setTransferOpen(false);
      else if (expanded) collapse();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen, chatOpen, transferOpen, expanded, collapse]);

  // 展开时拉取整机会话快照，并每 2s 刷新（供堆叠 / 下拉切换）
  useEffect(() => {
    if (expanded) {
      void refreshList();
      const id = setInterval(() => void refreshList(), 2000);
      return () => clearInterval(id);
    }
  }, [expanded, refreshList]);
  const [volume, setVolume] = useState(0.7);
  const [weather, setWeather] = useState<{ temp: number | null; code: number | null; city: string | null }>({ temp: null, code: null, city: null });

  // AI 对话状态（多会话：下拉选择 / 新建）
  const CHAT_STORE_KEY = 'andeyunhui.capsule.conversations';
  const CONV_TITLE_MAX = 20;
  const loadConvs = (): Conversation[] => {
    try {
      const raw = localStorage.getItem(CHAT_STORE_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as Conversation[];
        if (Array.isArray(arr) && arr.length) return arr;
      }
    } catch { /* 解析失败忽略 */ }
    return [];
  };
  const initialConvs = useMemo<Conversation[]>(() => {
    const cs = loadConvs();
    return cs.length ? cs : [{ id: 'c' + Date.now().toString(36), title: '新对话', messages: [], updatedAt: Date.now() }];
  }, []);
  const [conversations, setConversations] = useState<Conversation[]>(initialConvs);
  const [activeConvId, setActiveConvId] = useState<string>(() => initialConvs[0].id);
  const activeConvIdRef = useRef<string>(activeConvId);
  useEffect(() => { activeConvIdRef.current = activeConvId; }, [activeConvId]);
  // 持久化会话（localStorage，随胶囊 webview 持久，重启不丢）
  useEffect(() => {
    try { localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(conversations)); } catch { /* 忽略 */ }
  }, [conversations]);
  // 流式写入目标会话（发送时锁定，避免切会话后回写错位）
  const streamConvIdRef = useRef<string>(activeConvId);
  const updateStreamMessages = useCallback((convId: string, updater: (prev: ChatMsg[]) => ChatMsg[]) => {
    setConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, messages: updater(c.messages), updatedAt: Date.now() } : c)));
  }, []);
  // 当前会话消息（派生）
  const activeConv = conversations.find((c) => c.id === activeConvId);
  const chat = activeConv?.messages ?? [];
  const newConversation = useCallback(() => {
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    setConversations((prev) => [{ id, title: '新对话', messages: [], updatedAt: Date.now() }, ...prev]);
    setActiveConvId(id);
    setChatInput('');
    setChatBusy(false);
    activeReqRef.current = null;
    asstIdRef.current = null;
    streamConvIdRef.current = id;
  }, []);
  const selectConversation = useCallback((id: string) => {
    setActiveConvId(id);
    setChatInput('');
    setChatBusy(false);
    activeReqRef.current = null;
    asstIdRef.current = null;
  }, []);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({}); // 思考过程折叠状态
  const [aiProfileId, setAiProfileId] = useState<string | null>(null);
  const [aiHint, setAiHint] = useState<string | null>(null);
  const activeReqRef = useRef<string | null>(null);
  const asstIdRef = useRef<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

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
  // 选中会话切换
  const selectSession = (k: string) => {
    const key = k || null;
    selectedKeyRef.current = key;
    setSelectedKey(key);
    applyDisplay();
  };

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

  // 进入对话模式时加载全局模型档案，取已配置的活动档案 id
  useEffect(() => {
    if (!chatOpen) return;
    setAiHint(null);
    invoke<{ profiles: Array<{ id: string; api_key?: string }>; active: string | null }>('ai_get_profiles')
      .then((d) => {
        const usable = (d.profiles || []).filter((p) => p.api_key && p.api_key.trim());
        const act = d.active && usable.some((p) => p.id === d.active) ? d.active : usable[0]?.id ?? null;
        setAiProfileId(act);
        if (!act) setAiHint('未配置模型：请到「全局设置 → 模型」添加并填写 API Key');
      })
      .catch(() => setAiHint('读取模型配置失败'));
  }, [chatOpen]);

  // 全局流式事件监听（ai-delta / ai-done / ai-error），按 requestId 过滤本次请求
  useEffect(() => {
    let cancelled = false;
    const un: Array<() => void> = [];
    (async () => {
      const u1 = await listen<{ requestId: string; delta: string }>('ai-delta', (e) => {
        if (e.payload.requestId === activeReqRef.current && asstIdRef.current) {
          const id = asstIdRef.current;
          updateStreamMessages(streamConvIdRef.current, (prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + e.payload.delta } : m)));
        }
      });
      const finish = (err?: string) => {
        setChatBusy(false);
        const aid = asstIdRef.current;
        activeReqRef.current = null;
        if (aid) {
          updateStreamMessages(streamConvIdRef.current, (prev) =>
            prev.map((m) => {
              if (m.id !== aid) return m;
              if (err) return { ...m, error: true, content: (m.content ? m.content + '\n\n' : '') + '⚠ ' + err };
              return { ...m, content: m.content || '（无内容）' };
            }),
          );
        }
        asstIdRef.current = null;
      };
      const u2 = await listen<{ requestId: string }>('ai-done', (e) => {
        if (e.payload.requestId === activeReqRef.current) finish();
      });
      const u3 = await listen<{ requestId: string; error: string }>('ai-error', (e) => {
        if (e.payload.requestId === activeReqRef.current) finish(e.payload.error);
      });
      // 思考过程增量（reasoning_content）：流式追加到当前助手消息的 reasoning 字段
      const u4 = await listen<{ requestId: string; delta: string }>('ai-reasoning-delta', (e) => {
        if (e.payload.requestId === activeReqRef.current && asstIdRef.current) {
          const id = asstIdRef.current;
          updateStreamMessages(streamConvIdRef.current, (prev) => prev.map((m) => (m.id === id ? { ...m, reasoning: (m.reasoning || '') + e.payload.delta } : m)));
        }
      });
      if (cancelled) {
        u1();
        u2();
        u3();
        u4();
        return;
      }
      un.push(u1, u2, u3, u4);
    })();
    return () => {
      cancelled = true;
      un.forEach((f) => f());
    };
  }, []);

  // 自动滚动对话到底部
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

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

  // 挂载：透明化、定位顶部居中、显示、启动光标监视、上报物理矩形、订阅事件
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    (async () => {
      // [修复] 用 getCurrentWebviewWindow 取胶囊窗自身（label='capsule'）：
      // getCurrentWindow() 在胶囊里会误返回主窗（Tauri v2 metadata.currentWindow 误指向主窗）；
      // WebviewWindow.getByLabel 是 async 且胶囊内 JS 注册表未含自身，返回 null。
      const win = getCurrentWebviewWindow();
      // eslint-disable-next-line no-console
      console.log('[CAPSULE-PROBE] winLabel=', win?.label);
      if (!win) return;
      try {
        await invoke('set_overlay_transparent');
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
    // 用 expandedRef（expand effect 同步维护）判断是否从收起态展开，避免闭包陈旧值。
    listen<boolean>('capsule:expand', (e) => {
      if (e.payload && !expandedRef.current) {
        setPanelReady(false);
      }
      setExpanded(!!e.payload);
    }).then((f) => unsubs.push(f));
    listen<Record<string, unknown>>('now-playing', (e) => {
      const t0 = performance.now();
      const d = toPlayInfo(e.payload);
      if (d.source === 'system') {
        sysPlayRef.current = d.title ? d : null;
        // 同步进外部会话列表（按 key 去重），供堆叠/下拉切换。收起态下不触发 setSessionList，
        // 避免后台播放时整树重渲染（展开时再由 refreshList 用 ref 重建列表）
        if (d.title && d.key) {
          const next = sessionListRef.current.filter((s) => s.key !== d.key);
          next.unshift(d);
          sessionListRef.current = next;
          if (expandedRef.current) setSessionList(next);
        }
      } else {
        appPlayRef.current = d.title ? d : null;
        if (expandedRef.current) setAppPlay(d.title ? d : null);
      }
      applyDisplay();
      // eslint-disable-next-line no-console
      console.log('[CAPSULE-PROBE] now-playing handler_us=' + Math.round(performance.now() - t0) + ' source=' + (d.source ?? '?'));
    }).then((f) => unsubs.push(f));
    return () => unsubs.forEach((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 按需上屏一次（暂停轮询态下内容变化时使用）
  const presentOverlayNow = useCallback(() => {
    invoke('present_overlay_now').catch(() => {});
  }, []);

  // 展开/收起/对话模式/搜索模式：重新定位（居中）+ 改尺寸 + 上报热区（窗口向左右与向下延展）
  useEffect(() => {
    expandedRef.current = expanded; // 供 now-playing 监听器判断是否需要同步列表 state
    const w = EXPANDED_W;
    const h = !expanded ? CAPSULE_H : chatOpen ? CHAT_H : searchOpen ? SEARCH_H : transferOpen ? TRANSFER_H : EXPANDED_H;
    // [修复] 用 getCurrentWebviewWindow 取胶囊窗自身（见挂载 effect 注释）：
    // getCurrentWindow() 会误返回主窗；WebviewWindow.getByLabel 是 async 且胶囊内注册表无自身。
    const win = getCurrentWebviewWindow();
    if (!win) return;
    const sx = window.screen.availWidth;
    const x = Math.round((sx - w) / 2);
    const t0 = Date.now();
    // 窗口高度同步门控：从收起态展开且子面板打开时，暂不渲染子面板，等 setSize 完成后
    // 再放开渲染。否则 36→470 高度过渡期间，React 已渲染的子面板内容被旧窗高裁剪。
    const expanding = expanded && !prevExpandedRef.current;
    const subPanelOpen = chatOpen || searchOpen || transferOpen;
    prevExpandedRef.current = expanded;
    if (expanding && subPanelOpen) {
      setPanelReady(false);
    }
    // [DEV 探针] 尺寸变化前的真实 bounds
    win
      .outerSize()
      .then((os: { width: number; height: number }) =>
        // eslint-disable-next-line no-console
        console.log('[CAPSULE-PROBE] expand-before', { w: os.width, h: os.height }, { expanded, chatOpen, searchOpen })
      )
      .catch(() => {});
    win.setPosition(new LogicalPosition(x, TOP_Y)).catch(() => {});
    // 穿透/点击切换：收起态 ignore=true（点击穿透桌面），展开态 ignore=false（接收点击）。
    // 原由 Rust 侧 set_ignore_cursor_events 负责，但 Rust 用 get_webview_window 克隆全局窗表里的
    // WebviewWindow 会在窗销毁竞态下克隆已损坏的 Arc 触发 assert_unchecked 中止；改由胶囊对自身窗调用。
    win.setIgnoreCursorEvents(!expanded).catch(() => {});
    win
      .setSize(new LogicalSize(w, h))
      .then(() => {
        reportRect(w, h);
        // 门控复位：expanding && subPanelOpen 时用 setTimeout(0) 跳出 React 18 批处理，
        // 其余情况直接复位——因为 listener 在展开时无条件置 panelReady=false，但子面板可能
        // 尚未打开（首次悬停），需要在此清门控，否则后续点开搜索/AI/传输全显示空白。
        if (expanding && subPanelOpen) {
          setTimeout(() => setPanelReady(true), 0);
        } else {
          setPanelReady(true);
        }
        win
          .outerSize()
          .then((os: { width: number; height: number }) =>
            // eslint-disable-next-line no-console
            console.log('[CAPSULE-PROBE] expand-after', { w: os.width, h: os.height }, 'setSize_cost_ms=' + (Date.now() - t0))
          )
          .catch(() => {});
        // 过渡后立即上屏新尺寸：轻量 3 次 present_overlay_now（替代原来的 8ms×600ms =
        // 125 次/秒 Notify 风暴——该风暴会严重干扰外部媒体播放时的 DWM 呈现，导致卡顿/卡死，
        // 日志里 setSize_cost_ms=2108 即此所致）。稳态重绘频率由上方 request_repaint_rate
        // effect 决定（收起=0 暂停 / 展开=33 连续），此处只负责过渡呈现。
        presentOverlayNow();
        window.setTimeout(presentOverlayNow, 80);
        window.setTimeout(presentOverlayNow, 160);
      })
      .catch(() => {});
  }, [expanded, chatOpen, searchOpen]);

  // 媒体控制：经 Rust 命令转发。target=选中会话的 key（AUMID / "app"），未选中则交给活跃会话/本应用
  const ctrl = useCallback((action: string, value?: number) => {
    const target = selectedKeyRef.current || undefined;
    invoke('smtc_control', { action, value, target }).catch(() => {});
  }, []);

  async function onAction(kind: string) {
    try {
      if (kind === 'ai') {
        // 切换内置 AI 对话模式（复用全局 ai_chat 能力）；与搜索互斥
        setSearchOpen(false);
        setChatOpen((v) => !v);
      } else if (kind === 'search') {
        // 切换内置 Everything 风格搜索模式；与对话互斥
        setChatOpen(false);
        setSearchOpen((v) => !v);
      } else if (kind === 'transfer') {
        // 切换局域网传输模式；与对话/搜索互斥；强制展开（不被收起态折叠）
        setExpanded(true);
        setChatOpen(false);
        setSearchOpen(false);
        setTransferOpen((v) => !v);
      } else if (kind === 'screenshot') {
        await emit('open-screenshot');
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
    // eslint-disable-next-line no-console
    console.log('[CAPSULE-PROBE] request_repaint_rate', ms, { expanded });
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
  }, [expanded]);

  const togglePlay = () => ctrl(isPlaying ? 'pause' : 'play');
  const onVolume = (v: number) => {
    setVolume(v);
    ctrl('volume', v);
  };

  // 发送 AI 消息（复用全局 ai_chat，流式回传经全局事件）
  const sendChat = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    if (!aiProfileId) {
      setAiHint('未配置模型：请到「全局设置 → 模型」添加并填写 API Key');
      return;
    }
    const uid = 'u' + Date.now().toString(36);
    const aid = 'a' + Date.now().toString(36);
    const convId = activeConvId; // 发送时锁定目标会话
    streamConvIdRef.current = convId;
    const history = chat.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    const payload = [
      { role: 'system', content: '你是一个 helpful 的 AI 助手，请用简体中文回答；必要时用 ``` 代码块给出示例并简述要点。' },
      ...history,
      { role: 'user', content: text },
    ];
    // 首条消息用内容自动命名会话（标题为空 / 默认「新对话」时）
    updateStreamMessages(convId, (prev) => [...prev, { id: uid, role: 'user', content: text }, { id: aid, role: 'assistant', content: '' }]);
    setConversations((prev) => prev.map((c) => (c.id === convId && (c.title === '新对话' || !c.title.trim())) ? { ...c, title: text.slice(0, CONV_TITLE_MAX) } : c));
    setChatInput('');
    setChatBusy(true);
    const reqId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    activeReqRef.current = reqId;
    asstIdRef.current = aid;
    try {
      await invoke('ai_chat', { requestId: reqId, messages: payload, profileId: aiProfileId });
    } catch (e) {
      if (activeReqRef.current === reqId) {
        setChatBusy(false);
        activeReqRef.current = null;
        updateStreamMessages(convId, (prev) => prev.map((m) => (m.id === aid ? { ...m, error: true, content: '⚠ ' + String(e) } : m)));
        asstIdRef.current = null;
      }
    }
  }, [chatInput, chatBusy, aiProfileId, chat]);

  const pillH = !expanded ? CAPSULE_H : chatOpen ? CHAT_H : EXPANDED_H;

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
            else setExpanded(true);
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
          {expanded && !chatOpen && !searchOpen && !transferOpen && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '12px 14px 12px', minHeight: 0 }}>
              {/* 媒体源选择：多会话时下拉命中指定卡片 */}
              {allSessions.length > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: 'rgba(244,244,246,0.6)', flex: '0 0 auto' }}>媒体源</span>
                  <select
                    value={selectedKey ?? ''}
                    onChange={(e) => selectSession(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#f4f4f6', background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, padding: '4px 8px', outline: 'none', fontFamily: 'inherit' }}
                  >
                    <option value="">自动（当前播放）</option>
                    {allSessions.map((s) => (
                      <option key={s.key} value={s.key}>
                        {(s.title || (s.key === 'app' ? '本应用' : s.key)) + (s.artist ? ` · ${s.artist}` : '')}
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
                      {play?.title || '未播放'}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'rgba(244,244,246,0.72)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                      {play?.artist || '—'}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'rgba(230,195,92,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                      {play?.album || '未知专辑'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                    <Clock />
                    <button onClick={(e) => { e.stopPropagation(); collapse(); }} title="收起" style={{ ...btnBase, width: 26, height: 26 }}>
                      <IconChevron />
                    </button>
                  </div>
                </div>
              </div>

              {/* 播放控制区（压缩：更紧的间距、更小的按钮；专辑图保持 72px） */}
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
                  <button onClick={(e) => { e.stopPropagation(); ctrl('previous'); }} disabled={!play?.can_prev} title="上一首" style={{ ...btnBase, width: 34, height: 34, opacity: play?.can_prev ? 1 : 0.4 }}>
                    <IconPrev />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} title={isPlaying ? '暂停' : '播放'} style={{ ...btnBase, width: 40, height: 40, background: 'rgba(230,195,92,0.16)' }}>
                    {isPlaying ? <IconPause /> : <IconPlay />}
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); ctrl('next'); }} disabled={!play?.can_next} title="下一首" style={{ ...btnBase, width: 34, height: 34, opacity: play?.can_next ? 1 : 0.4 }}>
                    <IconNext />
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, padding: '0 6px' }}>
                  <button onClick={(e) => { e.stopPropagation(); onVolume(volume > 0 ? 0 : 0.7); }} title={volume > 0 ? '静音' : '取消静音'} style={{ ...btnBase, width: 28, height: 28 }}>
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

              {/* 快捷操作行：截图 / 录屏 / 中转站 / 剪贴板 / AI（可继续扩展） */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-around', marginTop: 'auto', paddingTop: 8 }}>
                {ACTIONS.map(({ kind, label, Icon }) => (
                  <button
                    key={kind}
                    onClick={(e) => { e.stopPropagation(); onAction(kind); }}
                    title={label}
                    style={{
                      ...btnBase,
                      flexDirection: 'column',
                      gap: 3,
                      width: 72,
                      height: 50,
                      fontSize: 11,
                      color: '#f2f2f4',
                      background:
                        (kind === 'ai' && chatOpen) || (kind === 'search' && searchOpen) || (kind === 'transfer' && transferOpen)
                          ? 'rgba(230,195,92,0.18)'
                          : 'rgba(255,255,255,0.06)',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.14)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                  >
                    <Icon />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 展开态 · AI 对话模式（内置对话框，复用全局 AI） */}
          {expanded && chatOpen && panelReady && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '10px 12px 10px' }} onClick={(e) => e.stopPropagation()}>
              {/* 顶部细条：小封面 + 标题 + 播放切换 + 关闭对话 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 9,
                    flex: '0 0 40px',
                    background: 'rgba(255,255,255,0.06)',
                    backgroundImage: coverUrl ? `url(${coverUrl})` : undefined,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: GOLD,
                    overflow: 'hidden',
                  }}
                >
                  {!coverUrl && <IconNote />}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <select
                      value={activeConvId}
                      onChange={(e) => selectConversation(e.target.value)}
                      title="选择对话（下拉切换）"
                      style={{
                        flex: 1, minWidth: 0,
                        fontSize: 12.5, color: '#f6f6f8',
                        background: 'rgba(0,0,0,0.28)',
                        border: '1px solid rgba(255,255,255,0.16)',
                        borderRadius: 8, padding: '5px 6px',
                        outline: 'none',
                      }}
                    >
                      {conversations.map((c) => (
                        <option key={c.id} value={c.id} style={{ background: '#1c1c1e', color: '#f6f6f8' }}>
                          {(c.title || '新对话').slice(0, CONV_TITLE_MAX)}
                        </option>
                      ))}
                    </select>
                    <button onClick={newConversation} title="新建对话" style={{ ...btnBase, width: 30, height: 30, flex: '0 0 auto', color: GOLD, background: 'rgba(230,195,92,0.14)', fontSize: 18, lineHeight: 1 }}>
                      +
                    </button>
                  </div>
                  <div style={{ fontSize: 10.5, color: 'rgba(244,244,246,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {conversations.length} 个对话 · 全局 AI · 复用模型配置
                  </div>
                </div>
                <button onClick={() => setChatOpen(false)} title="返回播放器" style={{ ...btnBase, width: 28, height: 28, flex: '0 0 auto' }}>
                  <IconClose />
                </button>
              </div>

              {/* 消息列表 */}
              <div ref={chatScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 2 }}>
                {aiHint && (
                  <div style={{ fontSize: 12, color: 'rgba(230,195,92,0.9)', background: 'rgba(230,195,92,0.1)', borderRadius: 8, padding: '8px 10px' }}>{aiHint}</div>
                )}
                {!aiHint && chat.length === 0 && (
                  <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.55)', textAlign: 'center', marginTop: 12 }}>向 AI 提问，回车发送（Shift+Enter 换行）</div>
                )}
                {chat.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                      maxWidth: '85%',
                      background: m.role === 'user' ? 'rgba(230,195,92,0.18)' : 'rgba(255,255,255,0.08)',
                      color: m.error ? '#ff9a9a' : '#f2f2f4',
                      borderRadius: 12,
                      padding: '8px 10px',
                      fontSize: 12.5,
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {/* 思考过程：可折叠、遮罩小字（仅助手消息有 reasoning 时显示） */}
                    {m.role === 'assistant' && m.reasoning ? (
                      <div style={{ marginBottom: 6 }}>
                        <button
                          onClick={() => setReasoningOpen((o) => ({ ...o, [m.id]: !o[m.id] }))}
                          style={{
                            ...btnBase, padding: '1px 7px', fontSize: 10.5, borderRadius: 6,
                            background: 'rgba(255,255,255,0.07)', color: 'rgba(244,244,246,0.62)', marginBottom: 4,
                          }}
                        >
                          {reasoningOpen[m.id] ? '▾' : '▸'} 思考过程{reasoningOpen[m.id] ? '' : `（${m.reasoning.length} 字 · 点击展开）`}
                        </button>
                        {reasoningOpen[m.id] && (
                          <div style={{
                            fontSize: 10.5, lineHeight: 1.55, fontStyle: 'italic',
                            color: 'rgba(244,244,246,0.5)', background: 'rgba(0,0,0,0.2)',
                            borderRadius: 8, padding: '6px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            filter: 'blur(0.3px)',
                          }}>
                            {m.reasoning}
                          </div>
                        )}
                      </div>
                    ) : null}
                    {m.content || (m.role === 'assistant' && chatBusy ? '思考中…' : '')}
                  </div>
                ))}
              </div>

              {/* 输入区：统一舒展输入框，思考开关与发送按钮被囊括在同一容器内 */}
              <div style={{ marginTop: 8, borderRadius: 12, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(0,0,0,0.22)', padding: 8 }}>
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void sendChat();
                    }
                  }}
                  rows={1}
                  placeholder={aiProfileId ? '输入消息…' : '未配置模型'}
                  disabled={!aiProfileId}
                  style={{
                    width: '100%',
                    display: 'block',
                    resize: 'none',
                    maxHeight: 90,
                    minHeight: 34,
                    height: 34,
                    border: 'none',
                    background: 'transparent',
                    color: '#f4f4f6',
                    padding: '4px 4px',
                    fontSize: 12.5,
                    lineHeight: 1.4,
                    outline: 'none',
                    fontFamily: 'inherit',
                  }}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                  <ThinkingToggle profileId={aiProfileId} compact disabled={!aiProfileId} />
                  <button
                    onClick={() => void sendChat()}
                    disabled={chatBusy || !aiProfileId || !chatInput.trim()}
                    title="发送"
                    style={{ ...btnBase, width: 34, height: 34, background: 'rgba(230,195,92,0.18)', opacity: chatBusy || !aiProfileId || !chatInput.trim() ? 0.45 : 1 }}
                  >
                    <IconSend />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 展开态 · 文件搜索（复用 FileSearchPanel，与主窗口黄金棋盘共享） */}
          {expanded && searchOpen && panelReady && (
            <FileSearchPanel variant="overlay" onClose={() => setSearchOpen(false)} />
          )}

          {/* 展开态 · 局域网传输（LocalSend v2 兼容） */}
          {expanded && transferOpen && panelReady && (
            <TransferPanel
              onClose={() => setTransferOpen(false)}
              receiveRequest={receiveReq}
              onAcceptReceive={acceptReceive}
              onDeclineReceive={declineReceive}
            />
          )}
        </div>
      </div>
    </div>
  );
}
