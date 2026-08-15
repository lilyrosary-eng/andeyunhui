// 黄金棋盘浮岛 · AI 对话子面板。
// 复用通用模板 AiChatPanel（src/components/ai-chat/AiChatPanel），
// 仅透传胶囊专属的封面 / 保持态 / 关闭回调，并沿用胶囊历史持久化 key。
import { memo } from 'react';
import { useCapsuleStore } from '@/stores/capsuleStore';
import { AiChatPanel } from '@/components/ai-chat/AiChatPanel';
import { AI_CHAT_CONVERSATIONS_KEY } from '@/components/ai-chat/util';

const CAPSULE_CONV_KEY = AI_CHAT_CONVERSATIONS_KEY;

function CapsuleChat({ coverUrl }: { coverUrl: string | null }) {
  const keepOpen = useCapsuleStore((s) => s.keepOpen);
  const setChatOpen = useCapsuleStore((s) => s.setChatOpen);
  const setKeepOpen = useCapsuleStore((s) => s.setKeepOpen);

  return (
    <AiChatPanel
      persistKey={CAPSULE_CONV_KEY}
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
