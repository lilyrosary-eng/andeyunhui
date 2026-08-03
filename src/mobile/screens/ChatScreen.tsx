// ChatScreen — AI 对话 Tab 主屏（T07 · §4.1）。
//
// 结构（§4.1 线框）：
//   ┌─────────────────────┐
//   │ 算力来源条（常驻）  │  ← ComputeChip，点击切换
//   ├─────────────────────┤
//   │ MessageList (滚动)  │  ← 虚拟滚动 + 流式追加
//   ├─────────────────────┤
//   │ ChatInput           │  ← 多行输入 + 上下文芯片
//   └─────────────────────┘
//   + BottomSheet：算力来源选择 / 溢出菜单
//
// AppBar 的 ⊕（新建会话）/ ⋮（溢出）按钮由 MobileApp 经 chatStore 触发本屏方法。
//
// 高度：用 calc 显式占据 AppBar 与 TabBar 之间的可视区，避免 NavStack 的
// overflow-y-auto 外壳与本屏内部滚动冲突（MessageList 自管滚动）。

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Plus, MoreVertical, Trash2, Cpu, Cloud, MonitorSmartphone } from 'lucide-react';

import { useAiStream } from '../hooks/useAiStream';
import { classifyProfile, type ComputeSource } from '../types/chat';
import { ComputeChip, type ComputeKind } from '../components/ComputeChip';
import { BottomSheet } from '../components/BottomSheet';
import { MessageList } from '../components/chat/MessageList';
import { ChatInput } from '../components/chat/ChatInput';
import { useChatStore } from '../stores/chatStore';

const KIND_ICON: Record<ComputeKind, ReactNode> = {
  local: <Cpu size={16} />,
  cloud: <Cloud size={16} />,
  device: <MonitorSmartphone size={16} />,
  down: <Cpu size={16} />,
  unconfigured: <Cpu size={16} />,
};

export function ChatScreen() {
  const ai = useAiStream();
  const [sourceSheetOpen, setSourceSheetOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const cloudAvailable = ai.profiles.some((p) => classifyProfile(p) === 'cloud');

  // 把动作句柄注册进 chatStore，供全局 AppBar 调用；卸载时清空避免悬空调用
  useEffect(() => {
    const cs = useChatStore.getState();
    cs.setNewConversation(() => ai.clear());
    cs.setOpenOverflow(() => setOverflowOpen(true));
    cs.setOpenSourcePicker(() => setSourceSheetOpen(true));
    return () => {
      cs.setNewConversation(null);
      cs.setOpenOverflow(null);
      cs.setOpenSourcePicker(null);
    };
  }, [ai]);

  // 同步当前算力来源标签到 chatStore（AppBar 副标题可选消费）
  useEffect(() => {
    useChatStore.getState().setSourceLabel(ai.currentSource?.label ?? null);
  }, [ai.currentSource]);

  const handleSelectSource = useCallback((src: ComputeSource) => {
    ai.switchSource(src);
    setSourceSheetOpen(false);
  }, [ai]);

  const handleSend = useCallback((text: string) => {
    void ai.send(text);
  }, [ai]);

  // 算力来源选择项：从 profiles 构造，选中态用 label 前缀 ✓ 表达
  const sourceItems = ai.profiles.map((p) => {
    const kind = classifyProfile(p);
    const active = ai.currentSource?.profileId === p.id;
    return {
      label: (active ? '✓ ' : '') + (p.name || p.model || '未命名档案'),
      description: `${p.model} · ${kind === 'local' ? '本地/局域网' : '云端'}`,
      icon: KIND_ICON[kind],
      onClick: () => handleSelectSource({
        kind,
        label: p.name || p.model || '算力来源',
        description: p.model,
        profileId: p.id,
      }),
    };
  });

  const overflowItems = [
    {
      label: '新建会话',
      icon: <Plus size={18} />,
      onClick: () => { ai.clear(); setOverflowOpen(false); },
    },
    {
      label: '清空对话',
      description: '删除当前会话所有消息',
      icon: <Trash2 size={18} />,
      onClick: () => { ai.clear(); setOverflowOpen(false); },
      destructive: true,
    },
  ];

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{
        // 显式占据 AppBar 与 TabBar 之间的可视高度，避免与 NavStack 外壳滚动冲突
        height: 'calc(100dvh - (var(--appbar-h) + var(--safe-top)) - var(--tabbar-total))',
        contain: 'layout paint',
      }}
    >
      {/* 算力来源条（§4.1 常驻，点击切换） */}
      <div className="shrink-0 px-3 pt-2.5 pb-2">
        {ai.currentSource ? (
          <ComputeChip
            kind={ai.currentSource.kind}
            label={ai.currentSource.label}
            description={
              ai.currentSource.description
                ? `${ai.currentSource.description} · ${ai.currentSource.kind === 'local' ? '未出网' : '数据出网'}`
                : undefined
            }
            onClick={() => setSourceSheetOpen(true)}
          />
        ) : (
          <ComputeChip
            kind="unconfigured"
            label={ai.profilesLoaded ? '未配置算力来源' : '加载中…'}
            description={ai.profilesLoaded ? '点此选择模型档案' : '正在读取模型配置'}
            onClick={() => setSourceSheetOpen(true)}
          />
        )}
      </div>

      {/* 消息列表（虚拟滚动，自管滚动） */}
      <MessageList
        timeline={ai.timeline}
        busy={ai.busy}
        cloudAvailable={cloudAvailable}
        onRetry={() => void ai.retry()}
        onSwitchCloud={() => void ai.switchToCloud()}
      />

      {/* 输入区 */}
      <ChatInput busy={ai.busy} onSend={handleSend} />

      {/* 算力来源选择 */}
      <BottomSheet
        open={sourceSheetOpen}
        onClose={() => setSourceSheetOpen(false)}
        title="选择算力来源"
        items={
          ai.profiles.length === 0
            ? [{
                label: '尚未配置模型档案',
                description: '请在桌面端「设置 → 模型」中添加 OpenAI 兼容端点',
                icon: <Cpu size={18} />,
              }]
            : sourceItems
        }
      />

      {/* 溢出菜单 */}
      <BottomSheet
        open={overflowOpen}
        onClose={() => setOverflowOpen(false)}
        title="对话操作"
        items={overflowItems}
      />
    </div>
  );
}
