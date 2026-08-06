// 移动端 AI 流式对话 Hook（T07 + T08 多会话）。
//
// 复用桌面 capsule 的后端契约（同一 ai_chat 命令 + 同一事件流），但状态模型按移动端
// §4.1 重设计：多会话（chatStore 持有）+ 算力来源切换 + 行内降级卡片 + 来源分隔标记。
//
// 会话归属：conversations / activeConvId 存于 chatStore（localStorage 持久化），
// 本 hook 只读写「当前活跃会话」的 timeline：
//   - timeline = activeConv.timeline（派生，不重复持有）
//   - 流式写入 / 重试 / 分隔 都调 chatStore.updateTimeline(convId, ...)
//   - 发送时锁定 streamConvIdRef，避免流式期间切换会话回写错位
//
// 事件契约（与 src-tauri/src/services/ai_service.rs 对齐）：
//   ai-delta            { requestId, delta }
//   ai-reasoning-delta  { requestId, delta }   仅思考模式开启时后端转发
//   ai-done             { requestId, usage }
//   ai-error            { requestId, error }
//
// 监听器在 hook 挂载时一次性注册，按 requestId ref 过滤本次请求，卸载时全部清理。

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';

import type { AiProfile, ChatMsg, ComputeSource, TimelineItem } from '../types/chat';
import { classifyProfile } from '../types/chat';
import type { ComputeKind } from '../components/ComputeChip';
import { useChatStore } from '../stores/chatStore';
import { useCompanionStore, buildCompanionContext, summarizeMemory } from '../stores/companionStore';
import { useAgentStore, buildAgentInstructions, extractToolCall } from '../stores/agentStore';
import { guessReason } from './aiErrorReason';
import { buildSemanticContext, ingestMemory } from '../stores/semanticMemory';

const SYSTEM_PROMPT =
  '你是一个 helpful 的 AI 助手，请用简体中文回答；必要时用 ``` 代码块给出示例并简述要点。';

const DEV = import.meta.env?.DEV ?? false;
function log(...args: unknown[]) { if (DEV) console.log('[useAiStream]', ...args); }

function uid(prefix: string): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export interface UseAiStreamResult {
  /** 当前活跃会话的时间线（消息 + 分隔 + 降级，扁平数组，供虚拟列表渲染） */
  timeline: TimelineItem[];
  /** 当前活跃会话 id */
  activeConvId: string;
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
  /** 发送一条用户消息（到当前活跃会话；可选携带图片 data URL） */
  send: (text: string, images?: string[]) => Promise<void>;
  /** 重试上一条用户消息（用于降级卡片「重试」按钮） */
  retry: () => Promise<void>;
  /** 改用云端（用于降级卡片「改用云端」按钮） */
  switchToCloud: () => Promise<void>;
  /** 新建会话并切换过去（清空时间线到新会话） */
  clear: () => void;
  /** 刷新 profile 列表 */
  refreshProfiles: () => Promise<void>;
  /** 保存（新增/替换）模型档案列表并刷新 */
  saveProfiles: (profiles: AiProfile[]) => Promise<void>;
}

export function useAiStream(): UseAiStreamResult {
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [currentSource, setCurrentSource] = useState<ComputeSource | null>(null);

  // 从 chatStore 派生活跃会话
  const conversations = useChatStore((s) => s.conversations);
  const activeConvId = useChatStore((s) => s.activeConvId);
  const activeConv = conversations.find((c) => c.id === activeConvId);
  const timeline = activeConv?.timeline ?? [];
  const convCount = conversations.length;

  // refs：流式写入需在事件回调中读取最新值，避免闭包陈旧
  const reqRef = useRef<string | null>(null);
  const asstRef = useRef<string | null>(null);
  /** 流式写入锁定的会话 id（发送时锁定，切会话不回写错位） */
  const streamConvRef = useRef<string>(activeConvId);
  const sourceRef = useRef<ComputeSource | null>(null);
  const lastUserTextRef = useRef<string>('');
  const pendingRetryRef = useRef<(() => void) | null>(null);
  const listenersRef = useRef<UnlistenFn[]>([]);

  // 同步 sourceRef 与 currentSource
  const applySource = useCallback((src: ComputeSource | null) => {
    sourceRef.current = src;
    setCurrentSource(src);
  }, []);

  /** 加载 profile 列表，并默认选中第一个（优先 local）。 */
  const refreshProfiles = useCallback(async () => {
    try {
      const raw = await invoke<{ profiles?: AiProfile[] }>('ai_get_profiles');
      const list = raw?.profiles ?? [];
      const valid = (list || []).filter((p) => p && p.id && p.base_url);
      setProfiles(valid);
      if (valid.length > 0 && !sourceRef.current) {
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

  /** 保存模型档案列表（手机端添加/编辑 API 来源用），保存后自动刷新 */
  const saveProfiles = useCallback(
    async (next: AiProfile[]) => {
      await invoke('ai_set_profiles', {
        payload: { profiles: next, active: next[0]?.id ?? null },
      });
      await refreshProfiles();
    },
    [refreshProfiles],
  );

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
        const convId = streamConvRef.current;
        const chunk = e.payload.delta ?? '';
        useChatStore.getState().updateTimeline(convId, (prev) =>
          prev.map((it) => {
            if (it.type !== 'message' || it.msg.id !== id) return it;
            return { ...it, msg: { ...it.msg, content: it.msg.content + chunk } };
          }),
        );
      });

      const u2 = await listen<{ requestId: string; delta: string }>('ai-reasoning-delta', (e) => {
        if (e.payload.requestId !== reqRef.current || !asstRef.current) return;
        const id = asstRef.current;
        const convId = streamConvRef.current;
        useChatStore.getState().updateTimeline(convId, (prev) =>
          prev.map((it) => {
            if (it.type !== 'message' || it.msg.id !== id) return it;
            return { ...it, msg: { ...it.msg, reasoning: (it.msg.reasoning || '') + e.payload.delta } };
          }),
        );
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

  /** 切换会话后重置流式状态（busy/refs 均复位；source 保留全局算力来源） */
  useEffect(() => {
    setBusy(false);
    reqRef.current = null;
    asstRef.current = null;
    streamConvRef.current = activeConvId;
    pendingRetryRef.current = null;
  }, [activeConvId]);

  /** 摘要节流：按会话内消息对数计数，每 3 轮（用户+助手各 1 条 = 2 条消息）触发 */
  const summarizeCounterRef = useRef(0);
  const triggerSummary = useCallback((convId: string) => {
    summarizeCounterRef.current += 1;
    if (summarizeCounterRef.current < 3) return;
    summarizeCounterRef.current = 0;
    const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const msgs = conv.timeline
      .filter((it): it is { type: 'message'; id: string; msg: ChatMsg } =>
        it.type === 'message' && !it.msg.error && it.msg.role !== 'system' && it.msg.content.trim().length > 0)
      .map((it) => ({ role: it.msg.role, content: it.msg.content }));
    if (msgs.length < 2) return;
    void (async () => {
      const res = await summarizeMemory(msgs);
      if (!res) return;
      const companionId = useCompanionStore.getState().companion.id;
      await useCompanionStore.getState().addMemory('summary', res.summary);
      // L3 摄取：把摘要写入 RAG 语义库（失败静默，不影响对话）
      void ingestMemory(companionId, 'summary', res.summary);
      // 情感增量 + 核心档案：EMA 推进关系（后端），里程碑文本回显到对话
      const milestone = await useCompanionStore.getState().applyDeltas(res.deltas, res.coreFacts);
      // L4 关系脉络快照：把更新后的六维状态写入 RAG（带时间戳），AI 可检索"关系过去的状态"
      const r = useCompanionStore.getState().companion.relationship;
      if (r) {
        void ingestMemory(companionId, 'snapshot',
          `关系快照：温暖 ${r.warmth}，信任 ${r.trust}，亲密 ${r.intimacy}，好奇 ${r.intrigue}，耐心 ${r.patience}，张力 ${r.tension}`,
          { snapshot: true },
        );
      }
      if (milestone) {
        useChatStore.getState().updateTimeline(convId, (prev) => [...prev, {
          type: 'message',
          id: `ms_${Date.now()}`,
          msg: { id: `ms_${Date.now()}`, role: 'system', content: `✨ 关系里程碑：${milestone}` },
        }]);
      }
    })();
  }, []);

  /** done / error 共用：复位 busy + 定稿助手消息 */
  const finish = useCallback((err?: string) => {
    setBusy(false);
    const aid = asstRef.current;
    reqRef.current = null;
    const convId = streamConvRef.current;
    let finalContent = '';
    if (aid) {
      useChatStore.getState().updateTimeline(convId, (prev) =>
        prev.map((it) => {
          if (it.type !== 'message' || it.msg.id !== aid) return it;
          if (err) {
            return { ...it, msg: { ...it.msg, error: true, content: (it.msg.content ? it.msg.content + '\n\n' : '') + '⚠ ' + err } };
          }
          finalContent = it.msg.content || '（无内容）';
          return { ...it, msg: { ...it.msg, content: finalContent } };
        }),
      );
    }
    asstRef.current = null;
    // 无错误时：对话结束后自动生成「回忆摘要」并追加到伴侣记忆（每 3 轮触发一次）
    if (!err) {
      void triggerSummary(convId);
      // Agent 能力开启时：解析助手文本里的工具调用 JSON 并执行
      if (useAgentStore.getState().enabled) {
        const call = extractToolCall(finalContent);
        if (call) {
          void useAgentStore.getState().runTool(call).then((res) => {
            // 执行结果追加为一条本地消息（图片生成时带图）
            const id = `sys_${Date.now()}`;
            useChatStore.getState().updateTimeline(convId, (prev) => [...prev, {
              type: 'message',
              id,
              msg: {
                id,
                role: 'system',
                content: res.text,
                ...(res.imageUrl ? { images: [res.imageUrl] } : {}),
              },
            }]);
          });
        }
      }
    }
    if (pendingRetryRef.current) {
      const fn = pendingRetryRef.current;
      pendingRetryRef.current = null;
      fn();
    }
  }, [triggerSummary]);

  /** 真正执行一次 ai_chat 调用（send / retry 共用；images 为用户发的图 data URL） */
  const doSend = useCallback(async (text: string, images?: string[]) => {
    if (busy) return;
    const src = sourceRef.current;
    const convId = useChatStore.getState().activeConvId;
    streamConvRef.current = convId;

    if (!src || !src.profileId) {
      const did = uid('d_');
      useChatStore.getState().updateTimeline(convId, (prev) => [...prev, {
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
    const curTimeline = useChatStore.getState().conversations.find((c) => c.id === convId)?.timeline ?? [];
    const history = curTimeline
      .filter((it): it is { type: 'message'; id: string; msg: ChatMsg } =>
        it.type === 'message' && !it.msg.error && it.msg.role !== 'system')
      .map((it) => ({ role: it.msg.role, content: it.msg.content }));
    // 伴侣记忆注入（人机恋阶段 1）：把人格 + 关系 + 最近记忆拼进 system。
    // 有配置好的人格（name 非默认占位）或存在记忆时才注入，避免打扰普通对话。
    let system = SYSTEM_PROMPT;
    const companion = useCompanionStore.getState().companion;
    const hasCompanion = companion.name.trim() !== '' || companion.memories.length > 0;
    if (hasCompanion) {
      system += '\n\n' + buildCompanionContext(companion);
    }
    // Agent 能力注入（默认关闭，设置里开启才生效）
    if (useAgentStore.getState().enabled) {
      system += '\n\n' + buildAgentInstructions();
    }
    // L3 语义记忆检索（阶段 4）：对本次消息语义检索过去对话，注入 system。
    // 走用户配置的云端嵌入端点；未配置时静默降级不影响发送。
    const semantic = await buildSemanticContext(text);
    if (semantic) {
      system += '\n\n' + semantic;
    }
    // 多模态·用户发图（阶段 5）：调用 ai_vision_ocr 生成图片描述注入 system，
    // 让 AI「看见」用户发的图（图片本身不发给后端，只发描述，兼容不支持视觉的模型）。
    let imageNote = '';
    if (images?.length) {
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const mime = img.startsWith('data:image/') ? img.slice(11, img.indexOf(';')) : 'image/png';
        const b64 = img.includes('base64,') ? img.split('base64,')[1] : img;
        try {
          const desc = await invoke<string>('ai_vision_ocr', {
            imageBase64: b64,
            imageMime: mime,
            prompt: `请用中文描述这张图片的内容（第 ${i + 1} 张，共 ${images.length} 张）。如果包含文字请指出。50 字以内。`,
            profileId: src.profileId,
          });
          imageNote += `\n[用户发来的图${i + 1}] ${desc}`;
        } catch {
          imageNote += `\n[用户发来的图${i + 1}] （图片理解失败）`;
        }
      }
    }
    const payload = [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: text + imageNote },
    ];

    useChatStore.getState().updateTimeline(convId, (prev) => [
      ...prev,
      { type: 'message', id: uId, msg: { id: uId, role: 'user', content: text, images } },
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
        const err = String(e);
        reqRef.current = null;
        setBusy(false);
        useChatStore.getState().updateTimeline(convId, (prev) => {
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
  }, [busy]);

  const send = useCallback(async (text: string, images?: string[]) => {
    const t = text.trim();
    const hasImages = !!images?.length;
    if (!t && !hasImages) return;
    const convId = useChatStore.getState().activeConvId;
    await doSend(t || '（图片）', images);
    // 首条用户消息后刷新标题
    useChatStore.getState().refreshTitle(convId);
  }, [doSend]);

  /** 重试上一条用户消息：移除末尾降级卡片后重发 */
  const retry = useCallback(async () => {
    const text = lastUserTextRef.current;
    if (!text) return;
    const convId = useChatStore.getState().activeConvId;
    if (busy) {
      pendingRetryRef.current = () => { void doSend(text); };
      return;
    }
    useChatStore.getState().updateTimeline(convId, (prev) => {
      const next = [...prev];
      while (next.length && next[next.length - 1].type === 'degrade') next.pop();
      return next;
    });
    await doSend(text);
  }, [busy, doSend]);

  /** 改用云端：找到首个 cloud profile，插入来源分隔（§4.1.2）后重发 */
  const switchToCloud = useCallback(async () => {
    const cloudProfile = profiles.find((p) => classifyProfile(p) === 'cloud');
    const convId = useChatStore.getState().activeConvId;
    if (!cloudProfile) {
      useChatStore.getState().updateTimeline(convId, (prev) => [...prev, {
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
    useChatStore.getState().updateTimeline(convId, (prev) => {
      const next = [...prev];
      while (next.length && next[next.length - 1].type === 'degrade') next.pop();
      return next;
    });
    useChatStore.getState().updateTimeline(convId, (prev) => [...prev, { type: 'divider', id: uid('s_'), source: newSource }]);
    const text = lastUserTextRef.current;
    if (text) await doSend(text);
  }, [profiles, applySource, doSend]);

  /** 手动切换算力来源（ComputeChip 点击 → BottomSheet 选择后调用） */
  const switchSource = useCallback((src: ComputeSource) => {
    const prev = sourceRef.current;
    applySource(src);
    const convId = useChatStore.getState().activeConvId;
    const hasMsg = (useChatStore.getState().conversations.find((c) => c.id === convId)?.timeline ?? [])
      .some((it) => it.type === 'message');
    if (prev && prev.profileId !== src.profileId && hasMsg) {
      useChatStore.getState().updateTimeline(convId, (prevTl) => [...prevTl, { type: 'divider', id: uid('s_'), source: src }]);
    }
  }, [applySource]);

  const clear = useCallback(() => {
    if (busy) return;
    lastUserTextRef.current = '';
    const convId = useChatStore.getState().activeConvId;
    useChatStore.getState().updateTimeline(convId, () => []);
  }, [busy]);

  return {
    timeline,
    activeConvId,
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
    saveProfiles,
  };
}
