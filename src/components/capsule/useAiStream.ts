// 黄金棋盘浮岛 · AI 流式事件监听统一 Hook（P2：消除 chat / aide-chat / aide-agent 三套重复监听）。
// 三套监听结构同构：delta（append 追加 / replace 整段替换）+ done/error（finish 定稿）+ 可选 reasoning-delta。
// 仅事件前缀与 delta 写入方式不同，故抽为单一 Hook 按配置复用。零新依赖，行为与原内联实现一致。
import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { ChatMsg } from './types';
import { recordGenerateFail } from '@/core/ai/comfyui/skills';

export interface AiStreamConfig {
  /** 事件前缀：'ai'（对话）/ 'capsule-ide-chat'（编程对话）/ 'capsule-ide-agent'（编程代理） */
  prefix: string;
  /** delta 写入方式：append=追加 delta 字段；replace=用 text 字段整体替换（agent 回传整段已清洗文本） */
  deltaMode: 'append' | 'replace';
  /** 是否监听 reasoning-delta（仅对话类模式有思考过程增量） */
  hasReasoning: boolean;
  /** 是否监听 agent-step（agent 模式工具步骤；实时累积到消息的 agentSteps，供执行轨迹面板） */
  hasAgentStep?: boolean;
}

export interface AiStreamRefs {
  /** 当前飞行的 requestId（按此过滤本次请求） */
  reqRef: MutableRefObject<string | null>;
  /** 流式写入的助手消息 id */
  asstRef: MutableRefObject<string | null>;
  /** 流式写入的目标会话 id（发送时锁定，避免切会话后回写错位） */
  streamConvIdRef: MutableRefObject<string>;
  /** 消息更新器（按会话 id 更新其 messages） */
  updateMessages: (convId: string, updater: (prev: ChatMsg[]) => ChatMsg[]) => void;
  /** busy 状态 setter（done/error 时复位） */
  setBusy: (v: boolean) => void;
}

/**
 * 统一 AI 流式事件监听。按 requestId 过滤本次请求；delta 按 mode 追加或替换；
 * done/error 统一 finish（复位 busy、定稿助手消息：error 追加 ⚠，否则确保非空）。
 * 忠实复刻原三套内联实现，仅去重，不改行为。
 */
export function useAiStream(config: AiStreamConfig, refs: AiStreamRefs) {
  const { prefix, deltaMode, hasReasoning, hasAgentStep } = config;
  const { reqRef, asstRef, streamConvIdRef, updateMessages, setBusy } = refs;

  useEffect(() => {
    let cancelled = false;
    const un: Array<() => void> = [];

    // ===== 增量合并（2026-10-20）=====
    // 后端每个 token 发一个 delta 事件，原实现是「一条 delta → 一次 setState → 整棵面板重渲染」。
    // 面板里每条助手消息都要过一次 marked 解析（内容越长越贵，且流式期间**永远缓存不命中**，
    // 因为每次内容都是新字符串）—— 于是单条回复的总解析量是 O(n²)：
    // 20KB 的回复按 1000 个增量算，相当于把 10MB 文本重新解析了一遍，外加 1000 次 DOM 重建。
    // 现在把增量先收进缓冲，每 50ms 合并提交一次：
    //   · React 渲染次数从「每 token 一次」降到 ≤20 次/秒
    //   · markdown 解析与 innerHTML 重建同比减少（对快模型是 5~10 倍）
    //   · 50ms 仍在单帧可感知范围外，观感与逐字输出一致
    // append 模式累加，replace 模式取最后一段（agent 回传的是整段已清洗文本）。
    const DELTA_BATCH_MS = 50;
    let buf = '';
    let bufRid: string | null = null;
    let flushTimer: number | null = null;

    const flushDelta = () => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!buf || !bufRid) return;
      // 请求已经换人（用户点了新的发送 / 取消后重发）：这段残留属于上一条，直接丢弃，
      // 否则会串到新的助手消息开头。
      if (bufRid !== reqRef.current) {
        buf = '';
        bufRid = null;
        return;
      }
      const pending = buf;
      buf = '';
      bufRid = null;
      const id = asstRef.current;
      const cid = streamConvIdRef.current;
      if (!id) {
        console.warn('[ai-stream] 增量缓冲有内容但助手消息 id 已清空，丢弃', pending.length, '字');
        return;
      }
      updateMessages(cid, (prev) => prev.map((m) => {
        if (m.id !== id) return m;
        return deltaMode === 'append' ? { ...m, content: m.content + pending } : { ...m, content: pending };
      }));
    };
    // 防孤儿监听器：每个 listen 注册成功后立即入列（cleanup 可即时清理），
    // 且各 handler 首行做 cancelled 守卫——异步注册期间到达的事件被丢弃。
    // 此前「全部注册完才统一入列」+ effect 渲染期重建，会让旧监听器在
    // cleanup 与新注册完成之间存活多个 token 周期，同一 delta 被重复追加。
    (async () => {
      // delta：append 追加 delta 字段；replace 用 text 字段整体替换
      const u1 = await listen<{ requestId: string; delta?: string; text?: string }>(`${prefix}-delta`, (e) => {
        if (cancelled) return;
        if (e.payload.requestId !== reqRef.current) return;
        // 只做「入缓冲 + 起定时器」，真正的 setState 在 flushDelta 里，见上方说明。
        // 这里不再直接读 asstRef/streamConvIdRef —— 它们在 50ms 后可能已经变了，
        // 交给 flushDelta 在提交那一刻再取才是准确的值。
        const chunk = deltaMode === 'append' ? (e.payload.delta ?? '') : (e.payload.text ?? '');
        if (!chunk) return;
        buf = deltaMode === 'append' ? buf + chunk : chunk;
        bufRid = e.payload.requestId;
        if (flushTimer === null) flushTimer = window.setTimeout(flushDelta, DELTA_BATCH_MS);
      });
      if (cancelled) { u1(); return; }
      un.push(u1);

      // finish：done / error 共用，清理请求态并定稿助手消息
      const finish = (err?: string) => {
        // 先提交缓冲里还没上屏的最后一段（通常只有几个字，丢了会显得回复被截尾）
        flushDelta();
        setBusy(false);
        const aid = asstRef.current;
        const cid = streamConvIdRef.current;
        reqRef.current = null;
        if (aid) {
          updateMessages(cid, (prev) => prev.map((m) => {
            if (m.id !== aid) return m;
            if (err) return { ...m, error: true, content: (m.content ? m.content + '\n\n' : '') + '⚠ ' + err };
            return { ...m, content: m.content || '（无内容）' };
          }));
        }
        asstRef.current = null;
      };

      const u2 = await listen<{ requestId: string }>(`${prefix}-done`, (e) => {
        if (cancelled) return;
        if (e.payload.requestId === reqRef.current) finish();
      });
      if (cancelled) { u2(); return; }
      un.push(u2);

      const u3 = await listen<{ requestId: string; error: string }>(`${prefix}-error`, (e) => {
        if (cancelled) return;
        if (e.payload.requestId === reqRef.current) finish(e.payload.error);
      });
      if (cancelled) { u3(); return; }
      un.push(u3);

      // 思考过程增量（仅对话类模式有）
      if (hasReasoning) {
        const u4 = await listen<{ requestId: string; delta: string }>(`${prefix}-reasoning-delta`, (e) => {
          if (cancelled) return;
          if (e.payload.requestId !== reqRef.current || !asstRef.current) return;
          const id = asstRef.current;
          const cid = streamConvIdRef.current;
          updateMessages(cid, (prev) => prev.map((m) => (m.id === id ? { ...m, reasoning: (m.reasoning || '') + e.payload.delta } : m)));
        });
        if (cancelled) { u4(); return; }
        un.push(u4);
      }

      // agent 工具步骤（运行中实时累积，供执行轨迹面板在落盘前展示）
      if (hasAgentStep) {
        const u5 = await listen<{ requestId: string; stage: string; name: string; ok: boolean; detail: string; meta?: Record<string, unknown> }>(`${prefix}-agent-step`, (e) => {
          if (cancelled) return;
          if (e.payload.requestId !== reqRef.current || !asstRef.current) return;
          const id = asstRef.current;
          const cid = streamConvIdRef.current;
          const step = { stage: e.payload.stage, name: e.payload.name, ok: e.payload.ok, detail: e.payload.detail, meta: e.payload.meta };
          updateMessages(cid, (prev) => prev.map((m) => (m.id === id ? { ...m, agentSteps: [...(m.agentSteps || []), step] } : m)));
          // AI 写回备注：生图失败时，把原因沉淀进该 ComfyUI 工作流的技能包备注，
          // 下次规划（L3 注入）与运行（日志披露）都能看到，同一坑不踩第二次。
          if (e.payload.name === 'generate_image' && e.payload.ok === false) {
            recordGenerateFail(e.payload.detail);
          }
        });
        if (cancelled) { u5(); return; }
        un.push(u5);
      }
    })();
    return () => {
      cancelled = true;
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      // 卸载前把缓冲刷掉：切面板/关浮岛时最后一段不该丢
      flushDelta();
      un.forEach((f) => f());
    };
  }, [prefix, deltaMode, hasReasoning, hasAgentStep, updateMessages, setBusy]);
}
