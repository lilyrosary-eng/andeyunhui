/// <reference path="../../global.d.ts" />
// 「工具箱」统计页（薄荷模块）—— 与音乐 / 阅读 / 图片 / 视频 / AI 对话的统计入口对齐。
//
// 数据来自模块内置的工具清单（CATEGORIES / TOOLS / TOOL_VIEWS），纯前端常量：
// 分类数、工具总数、已实现 / 待实现数量、按分类分布。
const React = window.__HOST_REACT__;
const { useMemo } = React;
import { T, useLang } from '../../_shared/pluginRuntime';

interface MintStatsCategory {
  id: string;
  /** 已翻译的分类名（由 index 传 T() 结果，避免本组件再重复取翻译） */
  label: string;
  count: number;
}

interface MintStatsPageProps {
  categories: MintStatsCategory[];
  total: number;
  implemented: number;
  onClose: () => void;
}

const CARD = 'rounded-2xl border border-black/10 dark:border-white/10 bg-white/70 dark:bg-stone-800/60 p-4';

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return React.createElement('div', { className: CARD },
    React.createElement('p', { className: 'text-xs text-neutral-500 dark:text-stone-400' }, label),
    React.createElement('p', { className: 'mt-1 text-2xl font-bold tabular-nums text-neutral-800 dark:text-stone-100' }, value),
    hint ? React.createElement('p', { className: 'mt-0.5 text-[11px] text-neutral-400 dark:text-stone-500' }, hint) : null,
  );
}

export function MintStatsPage({ categories, total, implemented, onClose }: MintStatsPageProps) {
  useLang();

  const maxCount = useMemo(() => Math.max(1, ...categories.map((c) => c.count)), [categories]);
  const pending = Math.max(0, total - implemented);

  return React.createElement('div', {
    className: 'h-full overflow-y-auto p-6 bg-[#f5f5f0] dark:bg-[#1c1917]',
  },
    React.createElement('div', { className: 'flex items-center gap-3 mb-4' },
      React.createElement('h2', { className: 'text-lg font-semibold text-neutral-800 dark:text-stone-100' }, T('mint.title') + ' · 统计'),
      React.createElement('button', {
        onClick: onClose,
        className: 'btn-press ml-auto rounded-lg px-3 py-1.5 text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors',
      }, '返回'),
    ),

    React.createElement('div', { className: 'grid grid-cols-2 gap-3 max-w-2xl' },
      React.createElement(StatCard, { label: '分类', value: String(categories.length), hint: '左侧导航的分类数' }),
      React.createElement(StatCard, { label: '工具总数', value: String(total), hint: '清单里登记的全部工具' }),
      React.createElement(StatCard, { label: '已实现', value: String(implemented), hint: `还有 ${pending} 个待实现` }),
      React.createElement(StatCard, { label: '平均每类', value: String(categories.length ? Math.round(total / categories.length) : 0), hint: '工具 / 分类' }),
    ),

    React.createElement('h3', {
      className: 'mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-stone-500',
    }, '按分类分布'),

    React.createElement('div', { className: 'max-w-2xl space-y-1.5' },
      categories.map((c) => React.createElement('div', {
        key: c.id,
        className: 'flex items-center gap-3 rounded-xl px-3 py-2 bg-white/60 dark:bg-stone-800/50 border border-black/5 dark:border-white/5',
      },
        React.createElement('span', { className: 'w-32 shrink-0 truncate text-xs text-neutral-700 dark:text-stone-200' }, c.label),
        React.createElement('div', { className: 'flex-1 h-1.5 rounded-full overflow-hidden bg-black/5 dark:bg-white/10' },
          React.createElement('div', {
            className: 'h-full rounded-full',
            style: { width: `${Math.round((c.count / maxCount) * 100)}%`, background: 'var(--element-bg)' },
          }),
        ),
        React.createElement('span', { className: 'w-10 shrink-0 text-right text-xs tabular-nums text-neutral-500 dark:text-stone-400' }, String(c.count)),
      )),
    ),

    React.createElement('p', { className: 'mt-6 max-w-2xl text-[11px] text-neutral-400 dark:text-stone-500' },
      '说明：统计来自模块内置的工具清单，纯本地计算；标为「待实现」的工具体验与已实现的不同。'),
  );
}

export default MintStatsPage;
