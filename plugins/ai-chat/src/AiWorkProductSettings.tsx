// AIWork / AIWorkflow 产物「保存位置」设置：选择 主目录 / 收藏目录 / 待决目录。
// 产物产出即导出为 {title}.md 到主目录；右键「收藏」「待决」把文件移到对应目录；
// 三个目录都可留空——主目录留空时产出不落盘（仅保留产物区记录），收藏/待决留空时仅保留记录不移动文件。
import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { FolderOpen, FolderHeart, FolderClock, RotateCcw } from 'lucide-react';
import { Section } from '@/components/bricks/Section';
import { loadProductDirs, setProductDirs, type AiWorkDirs } from '@/core/ai/aiWorkProductFiles';

type DirKey = keyof AiWorkDirs;

const ROWS: { key: DirKey; icon: React.ReactNode; label: string; desc: string }[] = [
  {
    key: 'saveDir',
    icon: <FolderOpen size={15} />,
    label: '产物保存主目录',
    desc: '每次产出自动导出为 .md 到这里；不选则不落盘（产物区仍保留记录）',
  },
  {
    key: 'favDir',
    icon: <FolderHeart size={15} />,
    label: '收藏目录',
    desc: '右键「收藏」把该产物文件移动到这里（记录保留）',
  },
  {
    key: 'pendingDir',
    icon: <FolderClock size={15} />,
    label: '待决目录',
    desc: '右键「待决」把该产物文件移动到这里（记录保留）',
  },
];

export function AiWorkProductSettings() {
  const [dirs, setDirs] = useState<AiWorkDirs>(() => loadProductDirs());

  const pick = async (key: DirKey) => {
    const sel = await openDialog({ directory: true, multiple: false, title: `选择「${ROWS.find((r) => r.key === key)?.label ?? ''}」` });
    if (!sel || typeof sel !== 'string') return;
    const next = { ...dirs, [key]: sel };
    setDirs(next);
    setProductDirs(next);
  };

  const clear = (key: DirKey) => {
    const next = { ...dirs, [key]: '' };
    setDirs(next);
    setProductDirs(next);
  };

  const reset = () => {
    const next: AiWorkDirs = { saveDir: '', favDir: '', pendingDir: '' };
    setDirs(next);
    setProductDirs(next);
  };

  return (
    <Section title="产物保存位置">
      <div className="space-y-3">
        {ROWS.map(({ key, icon, label, desc }) => {
          const value = dirs[key];
          return (
            <div key={key} className="rounded-lg border border-black/5 dark:border-white/5 px-3 py-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-700 dark:text-stone-200">
                <span className="text-neutral-400">{icon}</span> {label}
              </div>
              <div className="mt-0.5 text-[11px] text-neutral-400 dark:text-stone-500">{desc}</div>
              <div className="mt-2 flex items-center gap-2">
                <div className="min-w-0 flex-1 truncate rounded-md border border-black/5 bg-black/[0.03] px-2 py-1 text-xs text-neutral-500 dark:border-white/5 dark:bg-white/5 dark:text-stone-400">
                  {value || '（未选择）'}
                </div>
                <button
                  type="button"
                  onClick={() => void pick(key)}
                  className="btn-press shrink-0 rounded-md bg-[var(--element-color-raw)] px-3 py-1 text-xs text-white"
                >
                  选择
                </button>
                {value && (
                  <button
                    type="button"
                    onClick={() => clear(key)}
                    className="btn-press shrink-0 rounded-md border border-black/10 px-2 py-1 text-xs text-neutral-500 hover:bg-black/5 dark:border-white/10 dark:text-stone-400 dark:hover:bg-white/5"
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-neutral-400 dark:text-stone-500">
          收藏 / 待决目录未选择时，右键操作仅保留产物区记录、不移动文件
        </span>
        <button
          type="button"
          onClick={reset}
          className="btn-press inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-xs text-neutral-500 hover:bg-black/5 dark:border-white/10 dark:text-stone-400 dark:hover:bg-white/5"
        >
          <RotateCcw size={12} /> 全部重置
        </button>
      </div>
    </Section>
  );
}