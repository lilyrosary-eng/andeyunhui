// 黄金棋盘（原灵动岛，Dynamic Island）—— 屏幕顶部居中常驻的透明小窗。
// 收起态（240×36）：常驻时间 + 天气，紧凑不抢眼；
// 鼠标靠近顶部中央时由 Rust 侧光标监视线程（capsule_start_monitor）自动展开，也可点胶囊切换；
// 展开后向左右 + 向下延展，默认露出专辑大图、播放控制、音量与快捷操作；点「AI」切换为内置对话模式，
// 直接复用全局 AI 能力（ai_chat 命令 + ai-delta/done/error 事件，与 ai 模块同源）。
// 作为 茑萝 的子插件（plugins/茑萝/capsule）承载，窗口内容随主包由 main.tsx 分流渲染。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { ensureOverlayWindow, type OverlayProfile } from '@/core/overlayWindow';

// 收起态窗口尺寸（逻辑像素）：高 50%、长 75%（相对上一版 320×72）
export const CAPSULE_W = 240;
export const CAPSULE_H = 36;
// 展开态尺寸：比收起态更宽，向左右延展；高度按模式区分
const EXPANDED_W = 460;
const EXPANDED_H = 340; // 播放器模式
const CHAT_H = 460; // 对话模式（更高，容纳消息列表）
const SEARCH_H = 470; // 搜索模式（容纳结果列表）
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
  error?: boolean;
}
interface SearchResult {
  path: string;
  name: string;
  size: number;
  modified: number;
  is_dir: boolean;
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
] as const;

// 黑白棋盘底纹（深色半透明底叠半透明白格），放大 3 倍、整体倾斜 30°，呼应「黄金棋盘」主题；
// 放大覆盖 (-80%) 确保宽扁的胶囊在 30° 旋转后仍被完整覆盖；整体保持半透明，桌面可透出。
const checkerLayerStyle: React.CSSProperties = {
  position: 'absolute',
  inset: '-80%',
  transform: 'rotate(30deg)',
  backgroundColor: 'rgba(18,18,20,0.45)',
  backgroundImage: `
    linear-gradient(45deg, rgba(245,245,245,0.16) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(245,245,245,0.16) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(245,245,245,0.16) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(245,245,245,0.16) 75%)
  `,
  backgroundSize: '66px 66px',
  backgroundPosition: '0 0, 0 33px, 33px -33px, -33px 0',
};

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

export default function Capsule() {
  const [expanded, setExpanded] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [play, setPlay] = useState<PlayInfo | null>(null);
  // 双源分离：system=整机媒体监视读取的任意 App；app=本应用经 smtc_update 推送。展示优先级 system > app。
  const appPlayRef = useRef<PlayInfo | null>(null);
  const sysPlayRef = useRef<PlayInfo | null>(null);
  const mergePlay = () => setPlay(sysPlayRef.current ?? appPlayRef.current ?? null);
  // 多会话切换（堆叠 + 下拉）：sessionList=外部会话快照；appPlay=本应用会话镜像；selectedKey=用户选中（null=跟随实时）
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionList, setSessionList] = useState<PlayInfo[]>([]);
  const [appPlay, setAppPlay] = useState<PlayInfo | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const sessionListRef = useRef<PlayInfo[]>([]);
  const selectedKeyRef = useRef<string | null>(null);
  // 根据选中态计算展示的媒体卡片：选中具体会话则固定它，否则跟随实时（system > app）
  const applyDisplay = () => {
    if (selectedKeyRef.current) {
      const all = [...sessionListRef.current];
      if (appPlayRef.current) all.push(appPlayRef.current);
      setPlay(
        all.find((s) => s.key === selectedKeyRef.current) ??
          sysPlayRef.current ??
          appPlayRef.current ??
          null,
      );
    } else {
      setPlay(sysPlayRef.current ?? appPlayRef.current ?? null);
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
  const [clock, setClock] = useState(fmtTime());

  // —— 内置 Everything 风格搜索（复用后端 fs_search 索引）——
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<{ indexing: boolean; count: number; last_indexed: string | null } | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    try {
      const r = (await invoke('fs_search', { query: q, limit: 60 })) as SearchResult[];
      setSearchResults(r);
    } catch {
      setSearchResults([]);
    }
  }, []);
  const onSearchInput = (q: string) => {
    setSearchQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void runSearch(q), 180);
  };
  const refreshIndexStatus = useCallback(async () => {
    try {
      setSearchStatus((await invoke('fs_index_status')) as { indexing: boolean; count: number; last_indexed: string | null });
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (expanded && searchOpen) {
      void refreshIndexStatus();
      const id = setInterval(() => void refreshIndexStatus(), 1500);
      return () => clearInterval(id);
    }
  }, [expanded, searchOpen, refreshIndexStatus]);

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

  // AI 对话状态
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
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

  // 时钟：每秒刷新
  useEffect(() => {
    const t = setInterval(() => setClock(fmtTime()), 1000);
    setClock(fmtTime());
    return () => clearInterval(t);
  }, []);

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
          setChat((prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + e.payload.delta } : m)));
        }
      });
      const finish = (err?: string) => {
        setChatBusy(false);
        const aid = asstIdRef.current;
        activeReqRef.current = null;
        if (aid) {
          setChat((prev) =>
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
      if (cancelled) {
        u1();
        u2();
        u3();
        return;
      }
      un.push(u1, u2, u3);
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
      const win = getCurrentWindow();
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

    listen<boolean>('capsule:expand', (e) => setExpanded(!!e.payload)).then((f) => unsubs.push(f));
    listen<Record<string, unknown>>('now-playing', (e) => {
      const d = toPlayInfo(e.payload);
      if (d.source === 'system') {
        sysPlayRef.current = d.title ? d : null;
        // 同步进外部会话列表（按 key 去重），供堆叠/下拉切换
        if (d.title && d.key) {
          const next = sessionListRef.current.filter((s) => s.key !== d.key);
          next.unshift(d);
          sessionListRef.current = next;
          setSessionList(next);
        }
      } else {
        appPlayRef.current = d.title ? d : null;
        setAppPlay(d.title ? d : null);
      }
      applyDisplay();
    }).then((f) => unsubs.push(f));
    return () => unsubs.forEach((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 展开/收起/对话模式/搜索模式：重新定位（居中）+ 改尺寸 + 上报热区（窗口向左右与向下延展）
  useEffect(() => {
    const w = EXPANDED_W;
    const h = !expanded ? CAPSULE_H : chatOpen ? CHAT_H : searchOpen ? SEARCH_H : EXPANDED_H;
    const win = getCurrentWindow();
    const sx = window.screen.availWidth;
    const x = Math.round((sx - w) / 2);
    win
      .setPosition(new LogicalPosition(x, TOP_Y))
      .catch(() => {});
    win
      .setSize(new LogicalSize(w, h))
      .then(() => reportRect(w, h))
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
    const history = chat.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    const payload = [
      { role: 'system', content: '你是一个 helpful 的 AI 助手，请用简体中文回答；必要时用 ``` 代码块给出示例并简述要点。' },
      ...history,
      { role: 'user', content: text },
    ];
    setChat((prev) => [...prev, { id: uid, role: 'user', content: text }, { id: aid, role: 'assistant', content: '' }]);
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
        setChat((prev) => prev.map((m) => (m.id === aid ? { ...m, error: true, content: '⚠ ' + String(e) } : m)));
        asstIdRef.current = null;
      }
    }
  }, [chatInput, chatBusy, aiProfileId, chat]);

  const pillH = !expanded ? CAPSULE_H : chatOpen ? CHAT_H : EXPANDED_H;

  return (
    <div
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
      <div
        onClick={() => {
          if (!chatOpen) setExpanded((v) => !v);
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
        {/* 棋盘底纹层（放大 3 倍、倾斜 30°，半透明） */}
        <div style={checkerLayerStyle} />
        {/* 轻暗叠层：仅轻微压暗以保证文字可读，整体保持半透明，露出棋盘底纹 */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(160deg, rgba(8,8,8,0.16), rgba(8,8,8,0.26))',
            borderRadius: 'inherit',
            pointerEvents: 'none',
          }}
        />
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
                      animation: 'capsulePulse 1.4s ease-in-out infinite',
                    }}
                  />
                )}
                <span style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: GOLD }}>{clock}</span>
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
          {expanded && !chatOpen && !searchOpen && (
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
                    <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: GOLD }}>{clock}</span>
                    <button onClick={(e) => { e.stopPropagation(); setExpanded(false); }} title="收起" style={{ ...btnBase, width: 26, height: 26 }}>
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
                        (kind === 'ai' && chatOpen) || (kind === 'search' && searchOpen)
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
          {expanded && chatOpen && (
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
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#f6f6f8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {play?.title || 'AI 对话'}
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(244,244,246,0.62)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {play?.artist || '全局 AI · 复用模型配置'}
                  </div>
                </div>
                <button onClick={() => togglePlay()} title={isPlaying ? '暂停' : '播放'} style={{ ...btnBase, width: 32, height: 32, background: 'rgba(230,195,92,0.14)' }}>
                  {isPlaying ? <IconPause /> : <IconPlay />}
                </button>
                <button onClick={() => setChatOpen(false)} title="返回播放器" style={{ ...btnBase, width: 28, height: 28 }}>
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
                    {m.content || (m.role === 'assistant' && chatBusy ? '思考中…' : '')}
                  </div>
                ))}
              </div>

              {/* 输入行 */}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 8 }}>
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
                    flex: 1,
                    resize: 'none',
                    maxHeight: 90,
                    minHeight: 34,
                    height: 34,
                    borderRadius: 10,
                    border: '1px solid rgba(255,255,255,0.16)',
                    background: 'rgba(0,0,0,0.25)',
                    color: '#f4f4f6',
                    padding: '7px 10px',
                    fontSize: 12.5,
                    lineHeight: 1.4,
                    outline: 'none',
                    fontFamily: 'inherit',
                  }}
                />
                <button
                  onClick={() => void sendChat()}
                  disabled={chatBusy || !aiProfileId || !chatInput.trim()}
                  title="发送"
                  style={{ ...btnBase, width: 38, height: 38, background: 'rgba(230,195,92,0.18)', opacity: chatBusy || !aiProfileId || !chatInput.trim() ? 0.45 : 1 }}
                >
                  <IconSend />
                </button>
              </div>
            </div>
          )}

          {/* 展开态 · 内置 Everything 风格搜索 */}
          {expanded && searchOpen && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '10px 12px 10px' }} onClick={(e) => e.stopPropagation()}>
              {/* 顶部：图标 + 标题 + 索引状态 + 返回播放器 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 40, height: 40, borderRadius: 9, flex: '0 0 40px', background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: GOLD }}>
                  <IconSearchGlass />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#f6f6f8' }}>文件搜索</div>
                  <div style={{ fontSize: 11, color: 'rgba(244,244,246,0.62)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {searchStatus?.indexing ? '正在索引文件…' : `已索引 ${searchStatus?.count ?? 0} 项`}
                    {searchStatus?.last_indexed ? ` · ${searchStatus.last_indexed}` : ''}
                  </div>
                </div>
                <button onClick={() => setSearchOpen(false)} title="返回播放器" style={{ ...btnBase, width: 28, height: 28 }}>
                  <IconClose />
                </button>
              </div>

              {/* 搜索框 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => onSearchInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runSearch(searchQuery); } }}
                  placeholder="搜索文件 / 文件夹…"
                  style={{ flex: 1, borderRadius: 10, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(0,0,0,0.25)', color: '#f4f4f6', padding: '8px 10px', fontSize: 12.5, outline: 'none', fontFamily: 'inherit' }}
                />
              </div>

              {/* 结果列表 */}
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {searchResults.length === 0 && (
                  <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.55)', textAlign: 'center', marginTop: 12 }}>
                    {searchQuery.trim() ? '无匹配结果' : searchStatus?.indexing ? '首次索引中，请稍候…' : '输入关键字即时搜索（名称 / 路径）'}
                  </div>
                )}
                {searchResults.map((r) => (
                  <button
                    key={r.path}
                    onClick={() => invoke('fs_open_path', { path: r.path }).catch(() => {})}
                    title={r.path}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', padding: '7px 8px', borderRadius: 9, border: 'none', background: 'rgba(255,255,255,0.05)', cursor: 'pointer', color: '#f2f2f4' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                  >
                    <span style={{ fontSize: 16, color: GOLD, flex: '0 0 18px', textAlign: 'center' }}>{r.is_dir ? <IconFolder /> : <IconFileDoc />}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>{r.name}</span>
                    <span style={{ fontSize: 10.5, color: 'rgba(244,244,246,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150, flex: '0 0 auto' }}>{r.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
