// 翻译的 AI 模型选择器（设置页 / 中转站 / 中转站浮窗 三处共用一个）。
//
// 为什么要有它：翻译走 AI 节点时用的是 `TranslateSettings.profileId`，
// 而这个字段以前**没有任何界面能填** —— 后端 `resolve_target(config, profile_id)`
// 只能退回「AI 设置里当前选中的那个模型」。用户配了七八个模型，翻译却只能跟着对话模型走，
// 想换个便宜的/快的都做不了。
//
// 三处共用而不是各写一份：用户已经反复指出过「多个输入点对应一个功能」的问题。
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AiProfile } from '@/mobile/types/chat';

interface Props {
  /** 只有选了 AI 节点才显示；不显示时也不去白读一次档案 */
  visible: boolean;
  /** 当前选中的档案 id；undefined = 跟随 AI 设置里选中的模型 */
  value?: string;
  onChange: (profileId?: string) => void;
  label: string;
  followLabel: string;
  emptyLabel: string;
  staleLabel: string;
  className?: string;
}

export function TranslateModelPicker(props: Props) {
  const { visible, value, onChange, label, followLabel, emptyLabel, staleLabel, className } = props;
  const [profiles, setProfiles] = useState<AiProfile[] | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!visible || profiles) return;
    invoke<{ profiles?: AiProfile[] }>('ai_get_profiles')
      .then((r) => setProfiles(Array.isArray(r?.profiles) ? r.profiles : []))
      .catch((e) => {
        // 读不到档案也要出界面，并把原因留着 —— 否则这颗下拉框"空的"就只能是猜
        setLoadError(String((e as Error)?.message ?? e));
        setProfiles([]);
      });
  }, [visible, profiles]);

  if (!visible) return null;

  const list = profiles ?? [];
  const stale = !!value && !list.some((p) => p.id === value);

  return (
    <div className={className || 'flex items-center gap-2 mt-2 text-xs'}>
      <span className="text-neutral-500 dark:text-stone-400 shrink-0">{label}</span>
      {list.length === 0 ? (
        <span className="text-neutral-400 dark:text-stone-500">
          {loadError ? `${emptyLabel}（${loadError}）` : emptyLabel}
        </span>
      ) : (
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="px-2 py-1 rounded-lg bg-neutral-100 dark:bg-stone-700 text-neutral-700 dark:text-stone-200 border-0"
        >
          <option value="">{followLabel}</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {`${p.name || p.id} · ${p.model}`}
            </option>
          ))}
        </select>
      )}
      {stale && <span className="text-amber-600 dark:text-amber-400">{staleLabel}</span>}
    </div>
  );
}
