// 黄金棋盘浮岛（Capsule）共享状态：tab 切换 / 接收请求 / AI 模型档案。
// 壳（Capsule.tsx）与 AI 子面板（CapsuleChat / CapsuleAide）通过此 store 订阅共享状态，
// 事件闭包通过 useCapsuleStore.getState() 读最新值，从而消除 expandedRef / keepOpenRef 等 ref 镜像。
// 风格遵循 appStore.ts（zustand v5，项目已装，MIT 协议，零新依赖）。
import { create } from 'zustand';
import { listen, emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { t } from '@/lib/i18n';
import { toPlayInfo } from '@/components/capsule/helpers';
import type { ReceiveRequest, AiProfile, PlayInfo } from '@/components/capsule/types';
import { EVENTS } from '@/core/events/schema';

/**
 * 浮岛共享状态。子面板通过 `useCapsuleStore` 订阅所需切片，
 * 事件监听闭包通过 `useCapsuleStore.getState()` 读最新值。
 */
interface CapsuleState {
  // ---- tab 状态 ----
  expanded: boolean;
  chatOpen: boolean;
  aideOpen: boolean;
  searchOpen: boolean;
  transferOpen: boolean;
  /** 子面板渲染门控：从收起态展开且子面板打开时，先等 setSize 完成再渲染子面板 */
  panelReady: boolean;
  /** 保持态：鼠标离开不自动收起 */
  keepOpen: boolean;

  // ---- 接收请求 ----
  /** 浮岛作为主接收方：待确认的接收请求 */
  receiveReq: ReceiveRequest | null;
  /** 轻量 toast（接收请求 / 接收中 / 接收完成 等反馈） */
  toast: { msg: string } | null;

  // ---- AI 模型档案（chat / aide 共享）----
  aiProfiles: AiProfile[];
  aiProfileId: string | null;
  aideProfileId: string | null;
  aiHint: string | null;

  // ---- actions：tab ----
  setExpanded: (v: boolean) => void;
  setChatOpen: (v: boolean) => void;
  setAideOpen: (v: boolean) => void;
  setSearchOpen: (v: boolean) => void;
  setTransferOpen: (v: boolean) => void;
  setPanelReady: (v: boolean) => void;
  setKeepOpen: (v: boolean) => void;
  /** 收起即「回到主页」：关闭搜索/对话/传输并清除保持态（aide 不在此关闭，行为同改前） */
  collapse: () => void;

  // ---- actions：接收请求 / toast ----
  setReceiveReq: (r: ReceiveRequest | null) => void;
  showToast: (msg: string) => void;
  acceptReceive: () => Promise<void>;
  declineReceive: () => Promise<void>;
  /** 注册 transfer-receive-* 事件监听，返回 cleanup（仿 appStore.initFloatingNoteListeners） */
  initReceiveListeners: () => () => void;

  // ---- actions：AI profiles ----
  setAiProfileId: (id: string | null) => void;
  setAideProfileId: (id: string | null) => void;
  setAiProfiles: (p: AiProfile[]) => void;
  setAiHint: (h: string | null) => void;
  /** 幂等加载 ai_get_profiles 并设默认活动档案（chat/aide 打开时各调一次，频率低可重复加载） */
  ensureProfiles: () => void;

  // ---- 播放器状态（P1：消除 appPlayRef/sysPlayRef/sessionListRef/selectedKeyRef/playKeyRef 双写）----
  /** 当前展示的媒体卡片（驱动收起态指示点 + 展开态播放器） */
  play: PlayInfo | null;
  /** 系统媒体源（整机任意 App，内部累积，壳不以它订阅） */
  sysPlay: PlayInfo | null;
  /** 本应用媒体源（smtc_update 推送；壳仅在展开态订阅以避免后台播放重渲染） */
  appPlay: PlayInfo | null;
  /** 外部会话快照（堆叠 / 下拉切换；壳仅在展开态订阅） */
  sessionList: PlayInfo[];
  /** 用户选中的会话 key（null=跟随实时） */
  selectedKey: string | null;

  // ---- actions：播放器 ----
  /** now-playing 事件处理：更新双源 + 会话列表，并按 playKey 去重上屏 play（收起态不触发额外重渲染） */
  onNowPlaying: (payload: Record<string, unknown>) => void;
  /** 拉取整机会话快照并刷新展示 */
  refreshSessionList: () => Promise<void>;
  /** 选中指定会话（key 空串=跟随实时） */
  selectSession: (k: string) => void;
  /** 媒体控制：经 Rust 命令转发，target=选中会话 key */
  smtcControl: (action: string, value?: number) => void;
  setSelectedKey: (k: string | null) => void;
}

// toast 计时器：store 为单例，模块级变量即可（不触发渲染，不入 store 状态）
let toastTimer: number | null = null;

// play 去重 key：避免后台播放期间冗余 setPlay 拖累透明浮窗合成（不入 store 状态，不触发渲染）
let playKeyAccum = '';

/** 由当前双源 + 会话列表 + 选中 key 计算应展示的媒体卡片 */
function computePlayFrom(
  selectedKey: string | null,
  sessionList: PlayInfo[],
  appPlay: PlayInfo | null,
  sysPlay: PlayInfo | null,
): PlayInfo | null {
  if (selectedKey) {
    const all = [...sessionList];
    if (appPlay) all.push(appPlay);
    return all.find((s) => s.key === selectedKey) ?? sysPlay ?? appPlay ?? null;
  }
  // 跟随实时：优先「正在播放」的源（system > app），都没有在播才回退到任意非空源
  // （暂停态仍可见、可控）。修复「暂停的外部媒体遮蔽正在播放的本应用媒体」→ 显示错源 + 控制错源。
  if (sysPlay?.is_playing) return sysPlay;
  if (appPlay?.is_playing) return appPlay;
  return sysPlay ?? appPlay ?? null;
}

/** 内容指纹：仅在真正变化时才需要更新 play */
function playFingerprint(p: PlayInfo | null): string {
  return p
    ? `${p.key}|${p.title}|${p.artist}|${p.album}|${p.cover_path}|${p.is_playing}|${p.can_prev}|${p.can_next}`
    : '';
}

export const useCapsuleStore = create<CapsuleState>((set, get) => ({
  expanded: false,
  chatOpen: false,
  aideOpen: false,
  searchOpen: false,
  transferOpen: false,
  panelReady: true,
  keepOpen: false,

  receiveReq: null,
  toast: null,

  aiProfiles: [],
  aiProfileId: null,
  aideProfileId: null,
  aiHint: null,

  play: null,
  sysPlay: null,
  appPlay: null,
  sessionList: [],
  selectedKey: null,

  setExpanded: (expanded) => set({ expanded }),
  setChatOpen: (chatOpen) => set({ chatOpen }),
  setAideOpen: (aideOpen) => set({ aideOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setTransferOpen: (transferOpen) => set({ transferOpen }),
  setPanelReady: (panelReady) => set({ panelReady }),
  setKeepOpen: (keepOpen) => set({ keepOpen }),

  collapse: () =>
    set({
      expanded: false,
      searchOpen: false,
      chatOpen: false,
      transferOpen: false,
      keepOpen: false,
    }),

  setReceiveReq: (receiveReq) => set({ receiveReq }),

  showToast: (msg) => {
    set({ toast: { msg } });
    if (toastTimer != null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => set({ toast: null }), 3200);
  },

  acceptReceive: async () => {
    const r = get().receiveReq;
    if (!r) return;
    const n = r.file_count;
    await invoke('transfer_receive_accept', { sessionId: r.session_id }).catch(() => {});
    set({ receiveReq: null });
    get().showToast(`已开始接收 ${n} 个文件`);
  },

  declineReceive: async () => {
    const r = get().receiveReq;
    if (!r) return;
    const name = r.sender_alias;
    await invoke('transfer_receive_decline', { sessionId: r.session_id }).catch(() => {});
    set({ receiveReq: null });
    get().showToast(`已拒绝 ${name} 的文件`);
  },

  initReceiveListeners: () => {
    const offs: Array<() => void> = [];
    // 收到 transfer-receive-request：自动展开浮岛并跳到传输页，弹出「是否接收」询问
    listen(EVENTS.transfer.request, (e: { payload: ReceiveRequest }) => {
      const p = e.payload;
      if (!p?.session_id) return;
      set({ expanded: true, transferOpen: true, receiveReq: p.auto_accept ? get().receiveReq : p });
      // 确保浮岛窗口可见并置于前台（自动弹出）
      const w = getCurrentWebviewWindow();
      try {
        w.show().catch(() => {});
        w.setFocus().catch(() => {});
      } catch { /* 窗口已可见则忽略 */ }
      // 通知主窗：接收由浮岛处理，主窗不再弹确认框
      emit(EVENTS.transfer.capsuleTook, { session_id: p.session_id }).catch(() => {});
      get().showToast(
        p.auto_accept
          ? `正在接收 ${p.file_count} 个文件（来自 ${p.sender_alias}）`
          : `收到 ${p.sender_alias} 的 ${p.file_count} 个文件请求`,
      );
    }).then((u) => offs.push(u));
    // 接收请求在别处被确认/拒绝时，同步清除本地弹窗
    listen(EVENTS.transfer.confirmed, (e: { payload: { session_id: string } }) => {
      const sid = e.payload?.session_id;
      if (sid) {
        const cur = get().receiveReq;
        if (cur && cur.session_id === sid) set({ receiveReq: null });
      }
    }).then((u) => offs.push(u));
    listen(EVENTS.transfer.declined, (e: { payload: { session_id: string } }) => {
      const sid = e.payload?.session_id;
      if (sid) {
        const cur = get().receiveReq;
        if (cur && cur.session_id === sid) set({ receiveReq: null });
      }
    }).then((u) => offs.push(u));
    // 接收完成（每个文件 mark_done 触发一次）：提示已存入中转站
    listen(EVENTS.transfer.received, (e: { payload: { file_name: string; peer_alias: string } }) => {
      const p = e.payload;
      if (p?.file_name) get().showToast(`接收完成：${p.file_name} 已存入中转站`);
    }).then((u) => offs.push(u));

    return () => offs.forEach((u) => u());
  },

  setAiProfileId: (aiProfileId) => set({ aiProfileId }),
  setAideProfileId: (aideProfileId) => set({ aideProfileId }),
  setAiProfiles: (aiProfiles) => set({ aiProfiles }),
  setAiHint: (aiHint) => set({ aiHint }),

  ensureProfiles: () => {
    set({ aiHint: null });
    invoke<{ profiles: AiProfile[]; active: string | null }>('ai_get_profiles')
      .then((d) => {
        const profiles = d.profiles || [];
        const usable = profiles.filter((p) => p.api_key && p.api_key.trim());
        const act = d.active && usable.some((p) => p.id === d.active) ? d.active : usable[0]?.id ?? null;
        const prev = get().aideProfileId;
        set({
          aiProfiles: profiles,
          aiProfileId: act,
          aideProfileId: prev && usable.some((p) => p.id === prev) ? prev : act,
          aiHint: act ? null : t('capsule.noModelHint'),
        });
      })
      .catch(() => set({ aiHint: '读取模型配置失败' }));
  },

  // ---- 播放器动作（P1：消除 appPlayRef/sysPlayRef/sessionListRef/selectedKeyRef/playKeyRef 双写）----
  // 双源 / 会话列表 / 上屏卡片统一在此维护。壳按需订阅：收起态仅订阅 play（指纹去重），
  // 展开态再订阅 sessionList/appPlay——收起态选择器返回稳定空值，后台播放不触发壳重渲染。
  onNowPlaying: (payload) => {
    const d = toPlayInfo(payload);
    const s = get();
    const updates: Partial<CapsuleState> = {};

    if (d.source === 'system') {
      updates.sysPlay = d.title ? d : null;
      // 同步进外部会话列表（按 key 去重），供堆叠/下拉切换
      if (d.title && d.key) {
        const next = s.sessionList.filter((x) => x.key !== d.key);
        next.unshift(d);
        updates.sessionList = next;
      }
    } else {
      updates.appPlay = d.title ? d : null;
    }

    // 派生上屏卡片：仅指纹变化才 set play，避免后台播放期间冗余重渲染（替代原 playKeyRef 比对）
    const nextPlay = computePlayFrom(
      s.selectedKey,
      updates.sessionList ?? s.sessionList,
      updates.appPlay ?? s.appPlay,
      updates.sysPlay ?? s.sysPlay,
    );
    if (playFingerprint(nextPlay) !== playKeyAccum) {
      playKeyAccum = playFingerprint(nextPlay);
      updates.play = nextPlay;
    }
    set(updates);
  },

  refreshSessionList: async () => {
    try {
      const list = (await invoke('smtc_list_sessions')) as PlayInfo[];
      const s = get();
      // 清理失效的 selectedKey：选中的外部会话已不在系统快照中（被关闭/退出）→ 回到跟随实时，
      // 避免用户选了外部源后、源消失时按键无反应（后端会因显式 target 找不到会话而静默丢弃）。
      // 注意 "app" 不在外部快照里，不可清。
      let selectedKey = s.selectedKey;
      if (selectedKey && selectedKey !== 'app' && !list.some((x) => x.key === selectedKey)) {
        selectedKey = null;
      }
      const nextPlay = computePlayFrom(selectedKey, list, s.appPlay, s.sysPlay);
      const updates: Partial<CapsuleState> = { sessionList: list };
      if (selectedKey !== s.selectedKey) updates.selectedKey = selectedKey;
      if (playFingerprint(nextPlay) !== playKeyAccum) {
        playKeyAccum = playFingerprint(nextPlay);
        updates.play = nextPlay;
      }
      set(updates);
    } catch {
      /* 忽略查询失败 */
    }
  },

  selectSession: (k) => {
    const key = k || null;
    const s = get();
    const nextPlay = computePlayFrom(key, s.sessionList, s.appPlay, s.sysPlay);
    const updates: Partial<CapsuleState> = { selectedKey: key };
    if (playFingerprint(nextPlay) !== playKeyAccum) {
      playKeyAccum = playFingerprint(nextPlay);
      updates.play = nextPlay;
    }
    set(updates);
  },

  smtcControl: (action, value) => {
    const target = get().selectedKey || undefined;
    invoke('smtc_control', { action, value, target }).catch(() => {});
  },

  setSelectedKey: (k) => set({ selectedKey: k }),
}));
