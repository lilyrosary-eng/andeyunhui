// 主动消息心跳（阶段 3 · 存在感）。
//
// 首发实现（务实，不碰 Android 前台 Service）：app 在前台时跑一个心跳定时器，
// 到点检查是否该主动问候（距上次主动消息超过阈值 且 当前伴侣温暖较高），
// 生成一条主动消息追加到活跃会话 + 发系统通知。
//
// 设置：proactiveEnabled（默认关）+ 间隔（分钟）。
// 持久化 localStorage，与 agent 开关同风格。
//
// 局限：app 关闭时不会触发（真正的后台保活需 Android 前台 Service，暂不做，
// 计划文档阶段 3 已注明）。用户打开 app 就会收到补发的主动消息，达到「存在感」。

import { useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useCompanionStore } from '../stores/companionStore';

const PROACTIVE_KEY = 'andeyunhui.mobile.proactive.enabled';
const INTERVAL_KEY = 'andeyunhui.mobile.proactive.intervalMin';

export function getProactiveEnabled(): boolean {
  try { return localStorage.getItem(PROACTIVE_KEY) === '1'; } catch { return false; }
}
export function setProactiveEnabled(v: boolean) {
  try { localStorage.setItem(PROACTIVE_KEY, v ? '1' : '0'); } catch { /* 忽略 */ }
}
export function getProactiveIntervalMin(): number {
  try { return Math.max(10, Number(localStorage.getItem(INTERVAL_KEY)) || 60); } catch { return 60; }
}
export function setProactiveIntervalMin(min: number) {
  try { localStorage.setItem(INTERVAL_KEY, String(min)); } catch { /* 忽略 */ }
}

/** 距上次主动消息的阈值（毫秒）：间隔 * 1.5，避免频繁打扰 */
function thresholdMs(): number {
  return getProactiveIntervalMin() * 60 * 1000 * 1.5;
}

/** 发系统通知（Web Notification API；Android WebView / Chrome 支持） */
function notify(title: string, body: string) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body, tag: 'companion-proactive' });
    }
  } catch { /* 预览忽略 */ }
}

/** 主动消息心跳：app 活跃期间每 intervalMin 检查一次 */
export function useProactiveMessage() {
  const lastRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!getProactiveEnabled()) return;
    const min = getProactiveIntervalMin();
    const timer = setInterval(async () => {
      const now = Date.now();
      if (now - lastRef.current < thresholdMs()) return;
      const companion = useCompanionStore.getState().companion;
      // 关系太冷（温暖 < 20）不发，避免打扰
      if ((companion.relationship.warmth ?? 0) < 20) return;

      const text = await useCompanionStore.getState().proactiveMessage();
      if (!text) return;
      lastRef.current = now;

      // 追加到活跃会话（作为助手消息），并通知
      const convId = useChatStore.getState().activeConvId;
      const id = `pro_${Date.now()}`;
      useChatStore.getState().updateTimeline(convId, (prev) => [
        ...prev,
        {
          type: 'message',
          id,
          msg: { id, role: 'assistant', content: text },
        },
      ]);
      notify(`${companion.name}`, text);
    }, min * 60 * 1000);

    // 首次进入也检查一次（打开 app 补发）
    const first = setTimeout(async () => {
      const now = Date.now();
      if (now - lastRef.current < thresholdMs()) return;
      const companion = useCompanionStore.getState().companion;
      if ((companion.relationship.warmth ?? 0) < 20) return;
      const text = await useCompanionStore.getState().proactiveMessage();
      if (!text) return;
      lastRef.current = now;
      const convId = useChatStore.getState().activeConvId;
      const id = `pro_${Date.now()}`;
      useChatStore.getState().updateTimeline(convId, (prev) => [
        ...prev,
        { type: 'message', id, msg: { id, role: 'assistant', content: text } },
      ]);
      notify(companion.name, text);
    }, 30_000);

    return () => {
      clearInterval(timer);
      clearTimeout(first);
    };
  }, []);
}
