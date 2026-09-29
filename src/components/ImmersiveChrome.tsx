import { Minus, Square, X } from 'lucide-react';
import { LogoButton } from '@/components/LogoButton';
import { appWindow } from '@/lib/appWindow';
import { useI18n } from '@/lib/i18n';
import { useAppStore } from '@/stores/appStore';

/**
 * 沉浸模式悬浮 chrome。
 *
 * 上栏与一二级导航隐藏后，这里补回三类必要能力，其余区域全部让给内容：
 *   1. 左上角矢车菊 logo — 再点一次退出沉浸（带悬停多重提示）
 *   2. 顶部透明拖拽条 — 保证窗口仍可拖动；悬停时浮出淡色条提示「这里可拖」
 *   3. 右上角窗口控制键 — 半透明悬浮，保证沉浸态仍能最小化/最大化/关闭
 *
 * 刻意不加整体遮罩：沉浸模式的意义是最大化内容，chrome 用投影（drop-shadow）保证在
 * 任意背景上都可辨识，而不去压暗内容。
 */
const CTRL_CLASS =
  'btn-press w-[46px] h-full flex items-center justify-center text-neutral-500/90 dark:text-stone-400 transition-colors [filter:drop-shadow(0_1px_2px_rgba(0,0,0,.35))]';

export function ImmersiveChrome() {
  const { t } = useI18n();
  const setImmersive = useAppStore(s => s.setImmersive);

  return (
    <div className="group/chrome pointer-events-none fade-in fixed inset-x-0 top-0 z-[60] flex h-[38px] items-center justify-between select-none">
      {/* 拖拽条：铺满上沿，位于 logo 与控制键之下。鼠标移入整条悬浮带时，这里浮出白色衬底，
          与控制键同步出现/淡出（同一个 group hover 触发，无需 JS） */}
      <div
        data-tauri-drag-region
        className="pointer-events-auto absolute inset-x-0 top-0 h-full bg-transparent transition-colors duration-200 group-hover/chrome:bg-white/30 dark:group-hover/chrome:bg-[#1c1917]/30"
      />

      {/* 左：矢车菊 logo = 退出沉浸。它是常态唯一保留的入口，不随悬停隐藏 */}
      <div className="pointer-events-auto relative pl-3">
        <LogoButton onClick={() => setImmersive(false)} label={t('titlebar.immersiveExit')} />
      </div>

      {/* 右：窗口控制键 —— 常态隐藏（让画面彻底干净）。
          出现：毫秒级，与白色衬底同时（hover 态上的 delay-0）。
          消失：延迟 2s 再淡出（基础态上的 delay-[2000ms]）—— CSS 过渡在「移开」时会用基础态的
          transition-delay，所以无需 JS 即能做到「移出后三键多停留两秒」；衬底不设延迟，立即淡出。
          键盘 Tab 到达时同样立即出现。 */}
      <div className="pointer-events-none relative flex h-full items-center gap-0.5 pr-1 opacity-0 transition-opacity duration-200 delay-[2000ms] group-hover/chrome:pointer-events-auto group-hover/chrome:opacity-100 group-hover/chrome:delay-0 group-focus-within/chrome:pointer-events-auto group-focus-within/chrome:opacity-100 group-focus-within/chrome:delay-0">
        <button onClick={() => appWindow?.minimize()} className={`${CTRL_CLASS} rounded-md hover:text-neutral-800 hover:bg-black/10 dark:hover:text-stone-200 dark:hover:bg-white/10`} title={t('titlebar.minimize')}>
          <Minus size={15} />
        </button>
        <button onClick={() => appWindow?.toggleMaximize()} className={`${CTRL_CLASS} rounded-md hover:text-neutral-800 hover:bg-black/10 dark:hover:text-stone-200 dark:hover:bg-white/10`} title={t('titlebar.maximize')}>
          <Square size={13} />
        </button>
        <button onClick={() => appWindow?.close()} className={`${CTRL_CLASS} rounded-md hover:bg-red-500 hover:text-white`} title={t('titlebar.close')}>
          <X size={16} />
        </button>
      </div>
    </div>
  );
}