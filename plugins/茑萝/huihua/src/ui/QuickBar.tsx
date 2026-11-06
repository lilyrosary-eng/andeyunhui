import { useEditorState } from '../hooks';
import { editor } from '../store';
import { cx } from '../host';
import type { Tool } from '../types';
import { IconFit, IconRedo, IconUndo, IconZoomIn, IconZoomOut } from './icons';

const chip =
  'btn-press inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[11px] tabular-nums ' +
  'text-neutral-600 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-35 dark:text-stone-300 dark:hover:bg-white/10';
const activeChip = 'bg-[var(--element-bg)] text-white hover:bg-[var(--element-bg)]';
const divider = <span className="mx-1 h-5 w-px shrink-0 bg-black/10 dark:bg-white/10" />;

/**
 * 第一行：全部 11 个工具。
 * 此前 QuickBar 只放画笔/橡皮，其余 9 个（矩形/椭圆/直线/箭头/填充/吸色/选区/套索/移动）
 * **只有键盘快捷键、UI 上完全点不到** —— 不画画的人根本不知道它们存在。
 * 用中文短标签而不是图标：图标对陌生工具没有解释力，文字自解释，补充说明放 title。
 */
const TOOLS: Array<{ tool: Tool; label: string; key: string; note?: string; breakBefore?: boolean }> = [
  { tool: 'pen', label: '画笔', key: 'B' },
  { tool: 'eraser', label: '橡皮', key: 'E' },
  { tool: 'rect', label: '矩形', key: 'R', note: '画布上的实心/空心形状随笔宽', breakBefore: true },
  { tool: 'ellipse', label: '椭圆', key: 'O' },
  { tool: 'line', label: '直线', key: 'L' },
  { tool: 'arrow', label: '箭头', key: 'Shift+A' },
  { tool: 'fill', label: '填充', key: 'G', note: '点击区域填当前前景色', breakBefore: true },
  { tool: 'pick', label: '吸色', key: 'I', note: '点击把该处颜色取为前景色' },
  { tool: 'selectRect', label: '选区', key: 'M', note: '框选后只在选区内绘制；羽化=边缘过渡宽度', breakBefore: true },
  { tool: 'selectLasso', label: '套索', key: 'Q' },
  { tool: 'move', label: '移动', key: 'V', note: '拖动当前图层内容' },
];

/** 这些工具用「粗细」当笔宽/线宽（形状走 drawShapeRaw(..., width)，同样吃 size） */
const SIZE_TOOLS: Tool[] = ['pen', 'eraser', 'rect', 'ellipse', 'line', 'arrow'];

export function QuickBar() {
  const s = useEditorState();
  const showSize = SIZE_TOOLS.includes(s.tool);
  return (
    <div className="absolute left-3 top-3 z-20 flex flex-col gap-1 rounded-xl border border-black/10 bg-white/85 px-1.5 py-1 shadow-lg backdrop-blur dark:border-white/10 dark:bg-stone-900/80">
      {/* 第一行：工具 */}
      <div className="flex items-center gap-0.5">
        {TOOLS.map((t) => (
          <div key={t.tool} className="flex items-center gap-0.5">
            {t.breakBefore && divider}
            <button
              className={cx(chip, s.tool === t.tool && activeChip)}
              onClick={() => editor.setTool(t.tool)}
              title={`${t.label} (${t.key})${t.note ? ` — ${t.note}` : ''}`}
            >
              {t.label}
            </button>
          </div>
        ))}
      </div>

      {/* 第二行：随工具出现的选项 + 历史 + 视图 */}
      <div className="flex items-center gap-0.5">
        {s.tool === 'eraser' && (
          <>
            {/* 橡皮两档：SAI 式「涂背景色」为默认；要多图层抠像素时切「擦成透明」 */}
            <button
              className={chip}
              onClick={() => editor.setEraserMode(s.eraserMode === 'bg' ? 'alpha' : 'bg')}
              title={s.eraserMode === 'bg'
                ? '橡皮＝涂背景色（SAI 式，像素其实还在）。点击切到「擦成透明」'
                : '橡皮＝擦成透明（会透出下层图层）。点击切到「涂背景色」'}
            >
              <span
                className="mr-1 inline-block h-2.5 w-2.5 rounded-sm border border-black/20 align-middle dark:border-white/25"
                style={s.eraserMode === 'bg'
                  ? { backgroundColor: s.bgColor }
                  : { backgroundImage: 'repeating-conic-gradient(#9ca3af 0% 25%, #fff 0% 50%)', backgroundSize: '6px 6px' }}
              />
              {s.eraserMode === 'bg' ? '涂背景色' : '擦成透明'}
            </button>
            {divider}
          </>
        )}
        {showSize && (
          <>
            {/* 粗细拖条：往左缩小、往右放大。原先只有 − / ＋，改 40px 要按 40 下；[ / ] 保留 1px 微调 */}
            <input
              type="range"
              min={1}
              max={60}
              step={1}
              value={s.size}
              onChange={(e) => editor.setSize(parseInt(e.target.value, 10))}
              className="w-24 accent-[var(--element-bg)]"
              title="粗细（拖动调节；[ / ] 微调 1px）"
              aria-label="笔刷粗细"
            />
            <span className="w-9 shrink-0 text-center text-[11px] tabular-nums text-neutral-600 dark:text-stone-300">
              {s.size}px
            </span>
            {divider}
            {/* 不透明度原先只是一个只读数字，现在同样可拖 */}
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={Math.round(s.opacity * 100)}
              onChange={(e) => editor.setOpacity(parseInt(e.target.value, 10) / 100)}
              className="w-20 accent-[var(--element-bg)]"
              title="不透明度（拖动调节）"
              aria-label="不透明度"
            />
            <span className="w-8 shrink-0 text-center text-[10px] tabular-nums text-neutral-400 dark:text-stone-500">
              {Math.round(s.opacity * 100)}%
            </span>
            {divider}
          </>
        )}
        <button className={chip} onClick={() => editor.undo()} disabled={!s.canUndo} title="撤销 (Ctrl+Z)">
          <IconUndo size={14} />
        </button>
        <button className={chip} onClick={() => editor.redo()} disabled={!s.canRedo} title="重做 (Ctrl+Shift+Z)">
          <IconRedo size={14} />
        </button>
        {divider}
        <button className={chip} onClick={() => editor.zoomBy(1 / 1.15)} title="缩小 (Ctrl+-)">
          <IconZoomOut size={14} />
        </button>
        <button className={cx(chip, 'w-12')} onClick={() => editor.zoomTo(1)} title="100% (Ctrl+1)">
          {Math.round(s.zoom * 100)}%
        </button>
        <button className={chip} onClick={() => editor.zoomBy(1.15)} title="放大 (Ctrl+=)">
          <IconZoomIn size={14} />
        </button>
        <button className={chip} onClick={() => editor.fitView()} title="适应窗口 (Ctrl+0)">
          <IconFit size={14} />
        </button>
      </div>
    </div>
  );
}
