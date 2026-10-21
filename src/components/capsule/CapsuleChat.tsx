// 黄金棋盘浮岛 · AI 对话子面板。
// 复用主窗口同一套主体 AiChatConversation（capsuleMode 形态），仅透传胶囊专属的封面 / 保持态 / 关闭回调，
// 并沿用胶囊历史持久化 key。群聊不对胶囊开放（不传 onNewGroup）。
import { memo } from 'react';
import { useCapsuleStore } from '@/stores/capsuleStore';
import { useAiChat } from '@/core/ai/useAiChat';
import { AiChatConversation } from '@/components/ai-chat/AiChatConversation';
import { AI_CHAT_CONVERSATIONS_KEY } from '@/core/ai/util';

const CAPSULE_CONV_KEY = AI_CHAT_CONVERSATIONS_KEY;

function CapsuleChat({ coverUrl }: { coverUrl: string | null }) {
  const keepOpen = useCapsuleStore((s) => s.keepOpen);
  const setChatOpen = useCapsuleStore((s) => s.setChatOpen);
  const setKeepOpen = useCapsuleStore((s) => s.setKeepOpen);

  const {
    conversations,
    activeConv,
    busy,
    profileId,
    selectConv,
    newConversation,
    deleteConversation,
    renameConversation,
    send,
    abort,
    webSearch,
    setWebSearch,
    // 重新生成 / 版本分页（2026-10-21）：浮岛对话和 AI 对话页共用同一套会话数据，
    // 这里不传回调的话，浮岛里就看不到那一排操作图标（以前是"只读入口不渲染"）。
    regenerate,
    switchVersion,
    rateMessage,
  } = useAiChat({ persistKey: CAPSULE_CONV_KEY });

  return (
    <AiChatConversation
      capsuleMode
      conversations={conversations}
      activeConv={activeConv}
      busy={busy}
      profileId={profileId}
      send={send}
      onStop={abort}
      webSearch={webSearch}
      onToggleWebSearch={setWebSearch}
      onSelectConv={selectConv}
      onNewConv={newConversation}
      onDeleteConv={deleteConversation}
      onRenameConv={renameConversation}
      onRegenerate={(id) => void regenerate(id)}
      onSwitchVersion={switchVersion}
      onRate={rateMessage}
      coverUrl={coverUrl}
      showKeepButton
      keepPinned={keepOpen}
      onKeepToggle={(pinned) => setKeepOpen(pinned)}
      onClose={() => setChatOpen(false)}
      emptyHint="和 AI 聊聊吧～复用全局模型配置"
    />
  );
}

export default memo(CapsuleChat);
