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
import { classifyProfile, type ComputeSource, type AiProfile } from '../types/chat';
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
  // 手机端「添加 API 算力来源」表单
  const [addApiOpen, setAddApiOpen] = useState(false);
  const [apiForm, setApiForm] = useState({ name: '', baseUrl: '', apiKey: '', model: '' });
  const [saving, setSaving] = useState(false);

  /** 保存新增的 API 算力来源（追加到现有 profiles 并刷新列表） */
  const saveApi = useCallback(async () => {
    const baseUrl = apiForm.baseUrl.trim();
    const apiKey = apiForm.apiKey.trim();
    const model = apiForm.model.trim();
    if (!baseUrl || !apiKey || !model) return;
    setSaving(true);
    try {
      const next: AiProfile = {
        id: `p_${Date.now().toString(36)}`,
        name: apiForm.name.trim() || model,
        base_url: baseUrl,
        api_key: apiKey,
        model,
      };
      await ai.saveProfiles([...ai.profiles, next]);
      setAddApiOpen(false);
      setApiForm({ name: '', baseUrl: '', apiKey: '', model: '' });
    } finally {
      setSaving(false);
    }
  }, [ai, apiForm]);

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

      {/* 算力来源选择（含手机端「添加 API 来源」入口） */}
      <BottomSheet
        open={sourceSheetOpen}
        onClose={() => setSourceSheetOpen(false)}
        title="选择算力来源"
        items={
          (ai.profiles.length === 0 ? [] : sourceItems).concat([
            {
              label: ai.profiles.length === 0 ? '添加 API 算力来源' : '添加 API 来源',
              description: '配置 OpenAI 兼容端点（Base URL / Key / 模型）',
              icon: <Plus size={18} />,
              onClick: () => setAddApiOpen(true),
            },
          ])
        }
      />

      {/* 溢出菜单 */}
      <BottomSheet
        open={overflowOpen}
        onClose={() => setOverflowOpen(false)}
        title="对话操作"
        items={overflowItems}
      />

      {/* 添加 API 算力来源表单 */}
      <BottomSheet
        open={addApiOpen}
        onClose={() => !saving && setAddApiOpen(false)}
        title="添加 API 算力来源"
      >
        <div className="px-4 pb-4 flex flex-col gap-3">
          <ApiField
            label="名称（可选）"
            value={apiForm.name}
            onChange={(v) => setApiForm((f) => ({ ...f, name: v }))}
            placeholder="如：DeepSeek"
          />
          <ApiField
            label="Base URL"
            value={apiForm.baseUrl}
            onChange={(v) => setApiForm((f) => ({ ...f, baseUrl: v }))}
            placeholder="https://api.deepseek.com/v1"
          />
          <ApiField
            label="API Key"
            value={apiForm.apiKey}
            onChange={(v) => setApiForm((f) => ({ ...f, apiKey: v }))}
            placeholder="sk-…"
          />
          <ApiField
            label="模型"
            value={apiForm.model}
            onChange={(v) => setApiForm((f) => ({ ...f, model: v }))}
            placeholder="deepseek-chat"
          />
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => setAddApiOpen(false)}
              className="flex-1 rounded-xl py-2.5 font-medium border border-[var(--border)] text-[var(--foreground)] active:scale-[0.98] transition-transform"
              style={{ fontSize: 'var(--m-text-label)' }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={saveApi}
              disabled={saving || !apiForm.baseUrl.trim() || !apiForm.apiKey.trim() || !apiForm.model.trim()}
              className="flex-1 rounded-xl py-2.5 font-medium active:scale-[0.98] transition-transform disabled:opacity-50"
              style={{
                fontSize: 'var(--m-text-label)',
                background: 'var(--element-bg)',
                color: 'var(--element-fg)',
              }}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}

/** 表单字段（单行输入 + 标签） */
function ApiField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span
        className="block text-[var(--muted-foreground)] mb-1.5"
        style={{ fontSize: 'var(--m-text-caption)' }}
      >
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg px-3 py-2 bg-[var(--input)] text-[var(--foreground)] outline-none border border-[var(--border)] focus:border-[var(--ring)]"
        style={{ fontSize: 'var(--m-text-body)' }}
      />
    </label>
  );
}
