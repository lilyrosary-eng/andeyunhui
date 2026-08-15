import { memo } from 'react';
import { Heart } from 'lucide-react';
import { useCompanionStore, type Companion } from '@/mobile/stores/companionStore';
import { affinityOf } from '@/lib/affinity';

interface Props {
  onEdit: () => void;
  /** block = 大卡片（顶部下方一行）；
   *  compact = 紧凑横版（头部右侧条）；默认 block */
  variant?: 'block' | 'compact';
}

/** 导出独立头像，宿主头部左圈复用。 */
export function AiChatCompanionAvatar({ companion, size = 32 }: { companion: Companion; size?: number }) {
  const isImg = companion.avatar.startsWith('data:image/');
  return (
    <div
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-black/5 text-lg dark:bg-white/5"
      style={{ height: size, width: size, fontSize: size * 0.55 }}
      title={companion.name}
    >
      {isImg ? (
        <img src={companion.avatar} alt={companion.name} className="h-full w-full object-cover" />
      ) : (
        <span className="leading-none">{companion.avatar || '💡'}</span>
      )}
    </div>
  );
}

function useCurrentStats() {
  const companion = useCompanionStore((s) => s.companion);
  const affinity = affinityOf(companion.relationship);
  const days = companion.relationship.first_met_at
    ? Math.floor((Date.now() / 1000 - companion.relationship.first_met_at) / 86400)
    : 0;
  return { companion, affinity, days };
}

export const AiChatCompanionCard = memo(function AiChatCompanionCard({ onEdit, variant = 'block' }: Props) {
  const { companion, affinity, days } = useCurrentStats();

  if (variant === 'compact') {
    return (
      <button
        type="button"
        onClick={onEdit}
        title="点击编辑伴侣人设与记忆"
        className="group flex items-center gap-2.5 rounded-full border border-black/10 bg-white/60 py-1 pl-1 pr-3 text-left transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-stone-800/60 dark:hover:bg-white/5"
      >
        <AiChatCompanionAvatar companion={companion} size={28} />
        <div className="min-w-0 flex flex-col leading-tight">
          <span className="truncate text-xs font-semibold text-neutral-800 dark:text-stone-100 max-w-[120px]">
            {companion.name}
          </span>
          <span className="flex items-center gap-1 text-[10px] text-neutral-500 dark:text-stone-400">
            <Heart className="h-2.5 w-2.5 text-rose-400" />
            {affinity}%
            <span className="opacity-50">·</span>
            {days} 天
          </span>
        </div>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onEdit}
      className="group flex w-full items-center gap-3 rounded-xl border border-black/10 bg-white/60 px-4 py-3 text-left transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-stone-800/60 dark:hover:bg-white/5"
    >
      <AiChatCompanionAvatar companion={companion} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-bold text-neutral-800 dark:text-stone-100">{companion.name}</span>
          <Heart className="h-3.5 w-3.5 shrink-0 text-rose-400" />
          <span className="ml-auto shrink-0 text-xs text-neutral-500 dark:text-stone-400">
            亲密度 {affinity}% · 认识 {days} 天
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-stone-400">
          {companion.personality.slice(0, 24)}
        </p>
      </div>
    </button>
  );
});
