// 移动端 AI 流式对话 Hook（T07）。
//
// 复用桌面 capsule 的后端契约（同一 ai_chat 命令 + 同一事件流），但状态模型按移动端
// §4.1 重设计：单活跃会话 + 算力来源切换 + 行内降级卡片 + 来源分隔标记。
//
// 事件契约（与 src-tauri/src/services/ai_service.rs 对齐）：
//   ai-delta            { requestId, delta }
//   ai-reasoning-delta  { requestId, delta }   仅思考模式开启时后端转发
//   ai-done             { requestId, usage }
//   ai-error            { requestId, error }
//
// 监听器在 hook 挂载时一次性注册，按 requestId ref 过滤本次请求，卸载时全部清理
// （项目约束：useAiStream listeners 必须在组件卸载时清理，防止内存泄漏）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';

import type { AiProfile, ChatMsg, ComputeSource, TimelineItem } from '../types/chat';
import { classifyProfile } from '../types/chat';
import type { ComputeKind } from '../components/ComputeChip';

const SYSTEM_PROMPT =
  '你是一个 helpful 的 AI 助手，请用简体中文回答；必要时用 ``` 代码块给出示例并简述要点。';

const DEV = import.meta.env?.DEV ?? false;
function log(...args: unknown[]) { if (DEV) console.log('[useAiStream]', ...args); }

function uid(prefix: string): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export interface UseAiStreamResult {
  /** 时间线（消息 + 分隔 + 降级，扁平数组，供虚拟列表渲染） */
  timeline: TimelineItem[];
  /** 是否正在等待/流式输出 */
  busy: boolean;
  /** 可用 profile 列表 */
  profiles: AiProfile[];
  /** 当前选中的算力来源（null = 未配置） */
  currentSource: ComputeSource | null;
  /** 是否已完成首次 profile 加载 */
  profilesLoaded: boolean;
  /** 切换算力来源（插入来源分隔标记，§4.1.2） */
  switchSource: (source: ComputeSource) => void;
  /** 发送一条用户消息 */
  send: (text: string) => Promise<void>;
  /** 重试上一条用户消息（用于降级卡片「重试」按钮） */
  retry: () => Promise<void>;
  /** 改用云端（用于降级卡片「改用云端」按钮） */
  switchToCloud: () => Promise<void>;
  /** 新建会话（清空时间线） */
  clear: () => void;
  /** 刷新 profile 列表 */
  refreshProfiles: () => Promise<void>;
}

export function useAiStream(): UseAiStreamResult {
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [currentSource, setCurrentSource] = useState<ComputeSource | null>(null);

  // refs：流式写入需在事件回调中读取最新值，避免闭包陈旧
  const reqRef = useRef<string | null>(null);
  const asstRef = useRef<string | null>(null);
  const sourceRef = useRef<ComputeSource | null>(null);
  const lastUserTextRef = useRef<string>('');
  const pendingRetryRef = useRef<(() => void) | null>(null);
  const listenersRef = useRef<UnlistenFn[]>([]);

  // 同步 sourceRef 与 currentSource
  const applySource = useCallback((src: ComputeSource | null) => {
    sourceRef.current = src;
    setCurrentSource(src);
  }, []);

  /** 加载 profile 列表，并默认选中第一个（优先 local） */
  const refreshProfiles = useCallback(async () => {
    try {
      const list = await invoke<AiProfile[]>('ai_get_profiles');
      const valid = (list || []).filter((p) => p && p.id && p.base_url);
      setProfiles(valid);
      if (valid.length > 0 && !sourceRef.current) {
        // 优先选 local（未出网），其次 cloud
        const local = valid.find((p) => classifyProfile(p) === 'local') ?? valid[0];
        applySource({
          kind: classifyProfile(local),
          label: local.name || local.model || '算力来源',
          description: local.model,
          profileId: local.id,
        });
      }
    } catch (e) {
      log('加载 profiles 失败', e);
    } finally {
      setProfilesLoaded(true);
    }
  }, [applySource]);

  // 首次挂载：加载 profiles + 注册事件监听（一次性，按 requestId 过滤）
  useEffect(() => {
    refreshProfiles();
    let cancelled = false;
    const unAll: UnlistenFn[] = [];

    (async () => {
      const u1 = await listen<{ requestId: string; delta?: string }>('ai-delta', (e) => {
        if (e.payload.requestId !== reqRef.current) return;
        const id = asstRef.current;
        if (!id) return;
        const chunk = e.payload.delta ?? '';
        setTimeline((prev) => prev.map((it) => {
          if (it.type !== 'message' || it.msg.id !== id) return it;
          return { ...it, msg: { ...it.msg, content: it.msg.content + chunk } };
        }));
      });

      const u2 = await listen<{ requestId: string; delta: string }>('ai-reasoning-delta', (e) => {
        if (e.payload.requestId !== reqRef.current || !asstRef.current) return;
        const id = asstRef.current;
        setTimeline((prev) => prev.map((it) => {
          if (it.type !== 'message' || it.msg.id !== id) return it;
          return { ...it, msg: { ...it.msg, reasoning: (it.msg.reasoning || '') + e.payload.delta } };
        }));
      });

      const u3 = await listen<{ requestId: string }>('ai-done', (e) => {
        if (e.payload.requestId !== reqRef.current) return;
        finish();
      });

      const u4 = await listen<{ requestId: string; error: string }>('ai-error', (e) => {
        if (e.payload.requestId !== reqRef.current) return;
        finish(e.payload.error);
      });

      if (cancelled) { [u1, u2, u3, u4].forEach((f) => f()); return; }
      unAll.push(u1, u2, u3, u4);
      listenersRef.current = unAll;
    })();

    return () => {
      cancelled = true;
      listenersRef.current.forEach((f) => f());
      listenersRef.current = [];
    };
    // 仅挂载一次；refreshProfiles 通过 ref 安全读取，不在此依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** done / error 共用：复位 busy + 定稿助手消息 */
  const finish = useCallback((err?: string) => {
    setBusy(false);
    const aid = asstRef.current;
    reqRef.current = null;
    if (aid) {
      setTimeline((prev) => prev.map((it) => {
        if (it.type !== 'message' || it.msg.id !== aid) return it;
        if (err) {
          return { ...it, msg: { ...it.msg, error: true, content: (it.msg.content ? it.msg.content + '\n\n' : '') + '⚠ ' + err } };
        }
        return { ...it, msg: { ...it.msg, content: it.msg.content || '（无内容）' } };
      }));
    }
    asstRef.current = null;
    // 释放等待中的重试回调
    if (pendingRetryRef.current) {
      const fn = pendingRetryRef.current;
      pendingRetryRef.current = null;
      fn();
    }
  }, []);

  /** 推断降级原因（依据错误文本给出 §4.1.1 的人因猜测） */
  function guessReason(err: string): string {
    const low = err.toLowerCase();
    if (low.includes('timeout') || low.includes('timed out') || low.includes('超时')) {
      return '算力源响应超时，可能是电脑忙碌或网络波动。';
    }
    if (low.includes('connection refused') || low.includes('econnrefused') || low.includes('连接被拒绝')) {
      return '书房台式机没有响应，可能是电脑睡眠了，或者不在同一个 Wi-Fi。';
    }
    if (low.includes('dns') || low.includes('getaddrinfo') || low.includes('enotfound')) {
      return '无法解析算力源地址，请检查网络连接或电脑是否在线。';
    }
    if (low.includes('api key') || low.includes('unauthorized') || low.includes('401')) {
      return 'API Key 无效或未配置，请在设置中检查算力来源凭据。';
    }
    return '算力源暂时不可达，可以重试或改用云端继续对话。';
  }

  /** 真正执行一次 ai_chat 调用（send / retry 共用） */
  const doSend = useCallback(async (text: string) => {
    if (busy) return;
    const src = sourceRef.current;
    if (!src || !src.profileId) {
      // 未配置算力源：直接在时间线插入降级卡片引导配置
      const did = uid('d_');
      setTimeline((prev) => [...prev, {
        type: 'degrade',
        id: did,
        reason: '尚未配置算力来源，请在设置中添加模型档案后重试。',
        failedMsgId: '',
      }]);
      return;
    }

    const uId = uid('u_');
    const aId = uid('a_');
    lastUserTextRef.current = text;

    // 构建发给后端的 messages（仅 role+content，过滤 UI 层的 divider/degrade）
    const history = timeline
      .filter((it): it is { type: 'message'; id: string; msg: ChatMsg } => it.type === 'message' && !it.msg.error)
      .map((it) => ({ role: it.msg.role, content: it.msg.content }));
    const payload = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: text },
    ];

    setTimeline((prev) => [...prev,
      { type: 'message', id: uId, msg: { id: uId, role: 'user', content: text } },
      { type: 'message', id: aId, msg: { id: aId, role: 'assistant', content: '', source: src } },
    ]);
    setBusy(true);

    const reqId = uid('r_');
    reqRef.current = reqId;
    asstRef.current = aId;

    try {
      log('ai_chat 发送', { reqId, profileId: src.profileId, msgs: payload.length });
      await invoke('ai_chat', { requestId: reqId, messages: payload, profileId: src.profileId });
    } catch (e) {
      if (reqRef.current === reqId) {
        // 同步错误（如 API Key 缺失）→ 插入降级卡片而非红字（§6.3.3 降级是设计不是报错）
        const err = String(e);
        reqRef.current = null;
        setBusy(false);
        // 移除空的助手占位消息，改为降级卡片
        setTimeline((prev) => {
          const withoutEmpty = prev.filter((it) => !(it.type === 'message' && it.msg.id === aId));
          return [...withoutEmpty, {
            type: 'degrade',
            id: uid('d_'),
            reason: guessReason(err),
            failedMsgId: uId,
          }];
        });
        asstRef.current = null;
      }
    }
  }, [busy, timeline]);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return;
    await doSend(t);
  }, [doSend]);

  /** 重试上一条用户消息：移除末尾降级卡片后重发 */
  const retry = useCallback(async () => {
    const text = lastUserTextRef.current;
    if (!text) return;
    if (busy) {
      // 流式中重试：等当前流结束再触发
      pendingRetryRef.current = () => { void doSend(text); };
      return;
    }
    // 移除时间线末尾连续的 degrade 项
    setTimeline((prev) => {
      const next = [...prev];
      while (next.length && next[next.length - 1].type === 'degrade') next.pop();
      return next;
    });
    await doSend(text);
  }, [busy, doSend]);

  /** 改用云端：找到首个 cloud profile，插入来源分隔（§4.1.2）后重发 */
  const switchToCloud = useCallback(async () => {
    const cloudProfile = profiles.find((p) => classifyProfile(p) === 'cloud');
    if (!cloudProfile) {
      // 无云端 profile：提示在降级卡片原因里
      setTimeline((prev) => [...prev, {
        type: 'degrade',
        id: uid('d_'),
        reason: '尚未配置云端算力来源，请先在设置中添加一个公网模型档案。',
        failedMsgId: '',
      }]);
      return;
    }
    const newSource: ComputeSource = {
      kind: 'cloud' as ComputeKind,
      label: cloudProfile.name || cloudProfile.model || '云端',
      description: cloudProfile.model,
      profileId: cloudProfile.id,
    };
    applySource(newSource);
    // 插入来源分隔标记
    setTimeline((prev) => [...prev, { type: 'divider', id: uid('s_'), source: newSource }]);
    // 移除末尾降级卡片
    setTimeline((prev) => {
      const next = [...prev];
      while (next.length && next[next.length - 1].type === 'degrade') next.pop();
      return next;
    });
    const text = lastUserTextRef.current;
    if (text) await doSend(text);
  }, [profiles, applySource, doSend]);

  /** 手动切换算力来源（ComputeChip 点击 → BottomSheet 选择后调用） */
  const switchSource = useCallback((src: ComputeSource) => {
    const prev = sourceRef.current;
    applySource(src);
    // 仅当对话已有内容且来源确实变化时插入分隔标记
    if (prev && prev.profileId !== src.profileId && timeline.some((it) => it.type === 'message')) {
      setTimeline((prevTl) => [...prevTl, { type: 'divider', id: uid('s_'), source: src }]);
    }
  }, [applySource, timeline]);

  const clear = useCallback(() => {
    if (busy) return;
    setTimeline([]);
    lastUserTextRef.current = '';
  }, [busy]);

  return {
    timeline,
    busy,
    profiles,
    currentSource,
    profilesLoaded,
    switchSource,
    send,
    retry,
    switchToCloud,
    clear,
    refreshProfiles,
  };
}
