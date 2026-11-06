// 翻译的 AI 模型选择器（设置页 / 中转站 / 中转站浮窗 三处共用一个）。
//
// 为什么要有它：翻译走 AI 节点时用的是 `TranslateSettings.profileId`，
// 而这个字段以前**没有任何界面能填** —— 后端 `resolve_target(config, profile_id)`
// 只能退回「AI 设置里当前选中的那个模型」。用户配了七八个模型，翻译却只能跟着对话模型走。
//
// 为什么是「厂商分组 + 粘性标题」：模型数量多（一个中转站上百条），平铺一条长下拉选不动。
// 表现层复用全站已有的 `InlineSelect`（它已经有搜索、fixed 定位、键盘、分组），
// 分组标题在滚动时钉在面板顶部 —— 看完这家才换下一家。这样全站只有一套下拉实现，
// 不再为翻译单独维护一份。
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { InlineSelect } from '@/components/ui/inline-select';
import {
  buildModelTree,
  findModelLabel,
  type AiProviderGroup,
  type RawProvider,
} from '@/lib/aiModelTree';

interface Props {
  /** 只有这次会走到 AI 才显示；不显示时也不去白读一次配置 */
  visible: boolean;
  /** 当前选中的模型 id；空串/undefined = 跟随 AI 设置里选中的模型 */
  value?: string;
  onChange: (profileId?: string) => void;
  label: string;
  followLabel: string;
  pickLabel: string;
  emptyLabel: string;
  staleLabel: string;
  loadingLabel: string;
  className?: string;
}

export function TranslateModelPicker(props: Props) {
  const {
    visible, value, onChange, label, followLabel, pickLabel, emptyLabel, staleLabel, loadingLabel, className,
  } = props;
  const [tree, setTree] = useState<AiProviderGroup[] | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!visible || tree) return;
    invoke<{ providers?: RawProvider[] }>('ai_get_config')
      .then((cfg) => setTree(buildModelTree(cfg)))
      .catch((e) => {
        // 读不到配置也要出界面，并把原因留着 —— 否则这颗选择器"空的"就只能是猜
        setNote(String((e as Error)?.message ?? e));
        setTree([]);
      });
  }, [visible, tree]);

  if (!visible) return null;

  const list = tree ?? [];
  const summary = findModelLabel(list, value);
  // 档案里已经没有这个 id（用户删了模型）：说清楚这次按默认走，而不是悄悄换
  const stale = !!value && !!tree && !summary;

  return (
    <div className={className || 'flex items-center gap-2 mt-2 text-xs'}>
      <span className="text-neutral-500 dark:text-stone-400 shrink-0">{label}</span>
      {!tree ? (
        <span className="text-neutral-400 dark:text-stone-500">{loadingLabel}</span>
      ) : list.length === 0 ? (
        <span className="text-neutral-400 dark:text-stone-500">
          {note ? `${emptyLabel}（${note}）` : emptyLabel}
        </span>
      ) : (
        <InlineSelect
          value={value ?? ''}
          onChange={(v) => onChange(v || undefined)}
          placeholder={pickLabel}
          groups={[
            { label: '', options: [{ value: '', label: followLabel }] },
            ...list.map((g) => ({
              label: g.name,
              options: g.models.map((m) => ({
                value: m.id,
                label: m.label,
                // 触发按钮上要能看出「哪家的哪个模型」
                shortLabel: `${g.name} · ${m.label}`,
              })),
            })),
          ]}
        />
      )}
      {stale && <span className="text-amber-600 dark:text-amber-400">{staleLabel}</span>}
    </div>
  );
}
