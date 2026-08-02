// 黄金棋盘浮岛 · AI 流式事件监听统一 Hook（P2：消除 chat / aide-chat / aide-agent 三套重复监听）。
// 三套监听结构同构：delta（append 追加 / replace 整段替换）+ done/error（finish 定稿）+ 可选 reasoning-delta。
// 仅事件前缀与 delta 写入方式不同，故抽为单一 Hook 按配置复用。零新依赖，行为与原内联实现一致。
import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { ChatMsg } from './types';

export interface AiStreamConfig {
  /** 事件前缀：'ai'（对话）/ 'capsule-ide-chat'（编程对话）/ 'capsule-ide-agent'（编程代理） */
  prefix: string;
  /** delta 写入方式：append=追加 delta 字段；replace=用 text 字段整体替换（agent 回传整段已清洗文本） */
  deltaMode: 'append' | 'replace';
  /** 是否监听 reasoning-delta（仅对话类模式有思考过程增量） */
  hasReasoning: boolean;
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
  const { prefix, deltaMode, hasReasoning } = config;
  const { reqRef, asstRef, streamConvIdRef, updateMessages, setBusy } = refs;

  useEffect(() => {
    let cancelled = false;
    const un: Array<() => void> = [];
    (async () => {
      // delta：append 追加 delta 字段；replace 用 text 字段整体替换
      const u1 = await listen<{ requestId: string; delta?: string; text?: string }>(`${prefix}-delta`, (e) => {
        if (e.payload.requestId !== reqRef.current) return;
        const id = asstRef.current;
        const cid = streamConvIdRef.current;
        if (!id) return;
        const chunk = deltaMode === 'append' ? (e.payload.delta ?? '') : (e.payload.text ?? '');
        updateMessages(cid, (prev) => prev.map((m) => {
          if (m.id !== id) return m;
          return deltaMode === 'append' ? { ...m, content: m.content + chunk } : { ...m, content: chunk };
        }));
      });

      // finish：done / error 共用，清理请求态并定稿助手消息
      const finish = (err?: string) => {
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
        if (e.payload.requestId === reqRef.current) finish();
      });
      const u3 = await listen<{ requestId: string; error: string }>(`${prefix}-error`, (e) => {
        if (e.payload.requestId === reqRef.current) finish(e.payload.error);
      });

      const unAll: Array<() => void> = [u1, u2, u3];

      // 思考过程增量（仅对话类模式有）
      if (hasReasoning) {
        const u4 = await listen<{ requestId: string; delta: string }>(`${prefix}-reasoning-delta`, (e) => {
          if (e.payload.requestId !== reqRef.current || !asstRef.current) return;
          const id = asstRef.current;
          const cid = streamConvIdRef.current;
          updateMessages(cid, (prev) => prev.map((m) => (m.id === id ? { ...m, reasoning: (m.reasoning || '') + e.payload.delta } : m)));
        });
        unAll.push(u4);
      }

      if (cancelled) { unAll.forEach((f) => f()); return; }
      un.push(...unAll);
    })();
    return () => { cancelled = true; un.forEach((f) => f()); };
  }, [prefix, deltaMode, hasReasoning, updateMessages, setBusy]);
}
