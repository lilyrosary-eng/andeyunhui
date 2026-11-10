// Agent 工具审批的全局宿主：监听 `ai-agent-approval` 并渲染统一确认条。
//
// 为什么挂在窗口根而不是对话组件里：
// - 审批是「进程/窗口级」的等待，不属于某个会话；
// - AI 对话、AIGC 工作台、浮岛 AI 编程可能同时存在，挂在根节点一处即可全覆盖，
//   不必把 approval 状态穿过每一层 props。
//
// 多窗口：事件是 app 级广播，主窗口与浮岛会各显示一条；任一处处理后会收到
// `ai-agent-approval-resolved` 广播并同步收起，不会两边都挂到超时。
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ApprovalBar } from './ApprovalBar';

interface ToolApprovalPayload {
  approvalId: string;
  tool: string;
  operation: string;
}

/** 与后端 120s 超时对齐；多留 5s 兜底，避免界面永久停在一条已失效的请求上。 */
const TIMEOUT_MS = 125_000;

export function ToolApprovalHost() {
  const [pending, setPending] = useState<ToolApprovalPayload | null>(null);
  const [replying, setReplying] = useState(false);

  useEffect(() => {
    let offRequest: UnlistenFn | null = null;
    let offResolved: UnlistenFn | null = null;
    void listen<ToolApprovalPayload>('ai-agent-approval', (event) => {
      const payload = event.payload;
      if (!payload?.approvalId) return;
      setPending(payload);
      setReplying(false);
    }).then((off) => { offRequest = off; });
    void listen<{ approvalId: string }>('ai-agent-approval-resolved', (event) => {
      const approvalId = event.payload?.approvalId;
      setPending((current) => (current && current.approvalId === approvalId ? null : current));
    }).then((off) => { offResolved = off; });
    return () => {
      offRequest?.();
      offResolved?.();
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setPending(null), TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  if (!pending) return null;

  const reply = async (approved: boolean) => {
    setReplying(true);
    try {
      await invoke('ai_agent_approve', { approvalId: pending.approvalId, approved });
    } catch {
      // 已超时/已被处理：直接清条，错误没有可操作价值。
    } finally {
      setPending(null);
      setReplying(false);
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-xl">
        <ApprovalBar
          title={`需要你确认：${pending.tool}`}
          detail={pending.operation}
          options={[{ id: 'allow', label: '允许', kind: 'primary' }]}
          onSelect={() => void reply(true)}
          onReject={() => void reply(false)}
          disabled={replying}
          className="shadow-lg backdrop-blur"
        />
      </div>
    </div>
  );
}

export default ToolApprovalHost;
