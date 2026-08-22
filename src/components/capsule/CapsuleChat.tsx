// 黄金棋盘浮岛 · AI 对话子面板。
// 复用主窗口同一套主体 AiChatConversation（capsuleMode 形态），仅透传胶囊专属的封面 / 保持态 / 关闭回调，
// 并沿用胶囊历史持久化 key。群聊不对胶囊开放（不传 onNewGroup）。
import { memo } from 'react';
import { useCapsuleStore } from '@/stores/capsuleStore';
import { useAiChat } from '@/components/ai-chat/useAiChat';
import { AiChatConversation } from '@/components/ai-chat/AiChatConversation';
import { AI_CHAT_CONVERSATIONS_KEY } from '@/components/ai-chat/util';

const CAPSULE_CONV_KEY = AI_CHAT_CONVERSATIONS_KEY;

function CapsuleChat({ coverUrl }: { coverUrl: string | null }) {
  const keepOpen = useCapsuleStore((s) => s.keepOpen);
  const setChatOpen = useCapsuleStore((s) => s.setChatOpen);
  const setKeepOpen = useCapsuleStore((s) => s.setKeepOpen);

  const {
    conversations,
    activeId,
    activeConv,
    busy,
    profileId,
    selectConv,
    newConversation,
    deleteConversation,
    renameConversation,
    send,
    agent,
    setAgent,
  } = useAiChat({ persistKey: CAPSULE_CONV_KEY });

  return (
    <AiChatConversation
      capsuleMode
      conversations={conversations}
      activeConv={activeConv}
      busy={busy}
      profileId={profileId}
      send={send}
      agent={agent}
      onToggleAgent={setAgent}
      onSelectConv={selectConv}
      onNewConv={newConversation}
      onDeleteConv={deleteConversation}
      onRenameConv={renameConversation}
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
