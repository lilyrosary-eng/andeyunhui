/// <reference path="../../global.d.ts" />
// 歌词翻译的 AI 模型选择器（插件侧）。
//
// 表现层与宿主共用全站的 `InlineSelect`（厂商分组 + 粘性标题 + 搜索），
// 但**取数走 hostApi.invoke**：插件里绝不能直接 import `@tauri-apps/api/core` ——
// 那会绕过插件权限闸门，命令能不能用由 manifest + plugin_access 说了算。
import { useEffect, useState } from 'react';
import { InlineSelect } from '@/components/ui/inline-select';
import {
  buildModelTree,
  findModelLabel,
  type AiProviderGroup,
  type RawProvider,
} from '@/lib/aiModelTree';

const hostApi: any =
  (typeof window !== 'undefined' ? (window as any).__HOST_API__ : null) || {
    invoke: async () => ({}) as unknown,
  };

interface Props {
  visible: boolean;
  value?: string;
  onChange: (profileId?: string) => void;
  label: string;
  followLabel: string;
  pickLabel: string;
  emptyLabel: string;
  staleLabel: string;
  loadingLabel: string;
}

export function LyricsModelPicker(props: Props) {
  const {
    visible, value, onChange, label, followLabel, pickLabel, emptyLabel, staleLabel, loadingLabel,
  } = props;
  const [tree, setTree] = useState<AiProviderGroup[] | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!visible || tree) return;
    hostApi
      .invoke('ai_get_config')
      .then((cfg: { providers?: RawProvider[] }) => setTree(buildModelTree(cfg)))
      .catch((e: unknown) => {
        setNote(String((e as Error)?.message ?? e));
        setTree([]);
      });
  }, [visible, tree]);

  if (!visible) return null;

  const list = tree ?? [];
  const summary = findModelLabel(list, value);
  const stale = !!value && !!tree && !summary;

  return (
    <div className="flex items-center gap-2 text-[11px] text-neutral-500 dark:text-stone-400">
      <span className="shrink-0">{label}</span>
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
