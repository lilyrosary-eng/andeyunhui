// 翻译的 AI 模型选择器（设置页 / 中转站 / 中转站浮窗 三处共用一个）。
//
// 为什么要有它：翻译走 AI 节点时用的是 `TranslateSettings.profileId`，
// 而这个字段以前**没有任何界面能填** —— 后端 `resolve_target(config, profile_id)`
// 只能退回「AI 设置里当前选中的那个模型」。用户配了七八个模型，翻译却只能跟着对话模型走。
//
// 为什么是树而不是平铺：模型数量多，一条长下拉根本选不动。按预设厂商分组、
// 厂商标题滚动时钉在面板顶部（见 ModelPicker），才是「看完这家再看那家」。
//
// 三处共用而不是各写一份：用户已经反复指出过「多个输入点对应一个功能」的问题。
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ModelPicker } from '@/components/ModelPicker';
import {
  buildModelTree,
  findModelLabel,
  type AiProviderGroup,
  type RawProvider,
} from '@/lib/aiModelTree';

interface Props {
  /** 只有这次会走到 AI 才显示；不显示时也不去白读一次配置 */
  visible: boolean;
  /** 当前选中的模型 id；undefined = 跟随 AI 设置里选中的模型 */
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
      ) : (
        <ModelPicker
          tree={list}
          value={value}
          onChange={onChange}
          summary={summary || undefined}
          note={note}
          labels={{ pick: pickLabel, follow: followLabel, empty: emptyLabel }}
        />
      )}
      {stale && <span className="text-amber-600 dark:text-amber-400">{staleLabel}</span>}
    </div>
  );
}
