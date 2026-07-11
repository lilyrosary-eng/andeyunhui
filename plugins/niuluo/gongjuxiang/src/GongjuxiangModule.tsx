/// <reference path="../../../global.d.ts" />
const React = window.__HOST_REACT__;
const { useState } = React;

import { GarbledFixer } from './GarbledFixer';
import { TextDiff } from './TextDiff';

type TabKey = 'garbled' | 'diff';

const GarbleIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2-2 2.6-2.6z" />
  </svg>
);

const DiffIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="7" height="16" rx="1" />
    <rect x="14" y="4" width="7" height="16" rx="1" />
  </svg>
);

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
        active
          ? 'bg-[var(--element-muted)] text-[var(--element-bg)]'
          : 'text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200 hover:bg-black/5 dark:hover:bg-white/5'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function GongjuxiangModule() {
  const [tab, setTab] = useState<TabKey>('garbled');

  return (
    <div className="flex-1 flex flex-col h-full bg-[#f5f5f0] dark:bg-[#1c1917]">
      {/* 子工具标签栏 */}
      <div className="flex items-center gap-1 px-5 py-2.5 border-b border-white/80 dark:border-stone-700/50">
        <TabButton active={tab === 'garbled'} onClick={() => setTab('garbled')} icon={GarbleIcon} label="乱码修复" />
        <TabButton active={tab === 'diff'} onClick={() => setTab('diff')} icon={DiffIcon} label="文本对比" />
      </div>

      <div className="flex-1 h-full overflow-hidden">
        {tab === 'garbled' ? <GarbledFixer /> : <TextDiff />}
      </div>
    </div>
  );
}

export { GongjuxiangModule };
