import { Minus, Square, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { appWindow } from '@/lib/appWindow';
import { LogoButton } from '@/components/LogoButton';
import { useAppStore } from '@/stores/appStore';

export function Titlebar() {
  const { t } = useI18n();
  const toggleImmersive = useAppStore(s => s.toggleImmersive);
  return (
    <div
      data-tauri-drag-region
      className="h-[38px] flex items-center justify-between bg-[#f5f5f0] dark:bg-[#1c1917] border-b border-neutral-200/50 dark:border-stone-700/50 select-none flex-shrink-0"
    >
      {/* 左侧：拖拽区域 + 矢车菊 logo（点击进入沉浸模式）+ 标题 */}
      <div className="flex items-center h-full pl-3 gap-2">
        <LogoButton onClick={toggleImmersive} label={t('titlebar.immersiveEnter')} />
        <span className="text-xs text-neutral-400 dark:text-stone-500 font-medium tracking-wide">{t('common.appName')}</span>
      </div>

      {/* 右侧：窗口控制按钮 */}
      <div className="flex h-full">
        <button
          onClick={() => appWindow?.minimize()}
          className="btn-press w-[46px] h-full flex items-center justify-center text-neutral-400 hover:text-neutral-700 hover:bg-black/5 dark:text-stone-500 dark:hover:text-stone-300 dark:hover:bg-white/5 transition-colors"
          title={t('titlebar.minimize')}
        >
          <Minus size={15} />
        </button>
        <button
          onClick={() => appWindow?.toggleMaximize()}
          className="btn-press w-[46px] h-full flex items-center justify-center text-neutral-400 hover:text-neutral-700 hover:bg-black/5 dark:text-stone-500 dark:hover:text-stone-300 dark:hover:bg-white/5 transition-colors"
          title={t('titlebar.maximize')}
        >
          <Square size={13} />
        </button>
        <button
          onClick={() => appWindow?.close()}
          className="btn-press w-[46px] h-full flex items-center justify-center text-neutral-400 hover:text-white hover:bg-red-500 transition-colors"
          title={t('titlebar.close')}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}