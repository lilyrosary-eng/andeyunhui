import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { useAppStore } from '@/stores/appStore';
import {
  builtinFlags,
  collectProviderItems,
  subscribeContextMenu,
  visibleProviders,
  type ContextMenuItem,
  type ContextMenuTargetInfo,
} from './registry';
import { currentSelectionText, describeContextMenuTarget } from './describe';
import {
  copyImage,
  copyText,
  cutSelection,
  openCommandPalette,
  openHref,
  pasteInto,
  saveImageAs,
  selectAllIn,
} from './actions';

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

const MENU_WIDTH = 224;
const ITEM_HEIGHT = 32;

/** 内置项（判据来自 builtinFlags，纯函数、已单测；这里只负责文案与执行） */
function buildBuiltinItems(
  info: ContextMenuTargetInfo,
  element: Element,
): ContextMenuItem[] {
  const flags = builtinFlags(info);
  const items: ContextMenuItem[] = [];
  if (flags.cut) {
    items.push({ id: 'cut', label: t('contextMenu.cut'), hint: 'Ctrl+X', run: () => cutSelection(element, info.selectionText) });
  }
  if (flags.copy) {
    items.push({ id: 'copy', label: t('contextMenu.copy'), hint: 'Ctrl+C', run: () => copyText(info.selectionText) });
  }
  if (flags.paste) {
    items.push({ id: 'paste', label: t('contextMenu.paste'), hint: 'Ctrl+V', run: () => pasteInto(element) });
  }
  if (flags.selectAll) {
    items.push({ id: 'select-all', label: t('contextMenu.selectAll'), hint: 'Ctrl+A', run: () => selectAllIn(element) });
  }
  if (flags.openLink) {
    items.push({ id: 'open-link', label: t('contextMenu.openLink'), run: () => openHref(info.linkHref || '') });
  }
  if (flags.copyLink) {
    items.push({ id: 'copy-link', label: t('contextMenu.copyLink'), run: () => copyText(info.linkHref || '') });
  }
  if (flags.copyImage) {
    items.push({ id: 'copy-image', label: t('contextMenu.copyImage'), run: () => copyImage(info.imageSrc || '') });
  }
  if (flags.saveImage) {
    items.push({ id: 'save-image', label: t('contextMenu.saveImage'), run: () => saveImageAs(info.imageSrc || '') });
  }
  return items;
}

/** 收尾固定的应用动作：任何位置都可用，省掉记快捷键 */
function appActionItems(): ContextMenuItem[] {
  return [
    { id: 'command-palette', label: t('contextMenu.commandPalette'), hint: 'Ctrl+K', separatorBefore: true, run: openCommandPalette },
    { id: 'reload', label: t('contextMenu.reload'), run: () => window.location.reload() },
  ];
}

/**
 * 全局右键菜单。
 *
 * 为什么不用 Radix 的 ContextMenu：它把「指针位置」存在 Trigger 的内部状态里，
 * 程序化打开（我们只有一个 document 级监听器）拿不到那个点，定位会跑偏。
 * 仓库里已有同类的自绘浮层（阅读模块的选字工具条），这里沿同一套做法与视觉。
 *
 * 与组件自带的右键菜单共存：Radix 的 Trigger 会 preventDefault，本监听挂在冒泡阶段，
 * 看到 defaultPrevented 就让路 —— 导轨那种局部菜单优先，不做二重菜单。
 */
export function GlobalContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const targetRef = useRef<{ info: ContextMenuTargetInfo; element: Element } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(-1);

  const rebuild = useCallback(async () => {
    const held = targetRef.current;
    if (!held) return;
    const providerItems = await collectProviderItems(held.info);
    const items = [
      ...buildBuiltinItems(held.info, held.element),
      ...(providerItems.length
        ? providerItems.map((item, i) => ({ ...item, separatorBefore: i === 0 && item.separatorBefore !== false }))
        : []),
      ...appActionItems(),
    ];
    setMenu((prev) => (prev ? { ...prev, items } : prev));
  }, []);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      // 带修饰键的右键留给系统与其它软件（截图/触控板的自定义手势都走这条）
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as Element | null;
      if (!el || el.nodeType !== 1) return;
      const info = describeContextMenuTarget(el, {
        selectionText: currentSelectionText(),
        moduleId: useAppStore.getState().activeModule || null,
      });
      const hasBuiltin = Object.values(builtinFlags(info)).some(Boolean);
      const providers = visibleProviders(info.moduleId);
      // 一条都凑不出来就不要拦：那样只会让右键变成哑键
      if (!hasBuiltin && providers.length === 0) return;
      e.preventDefault();
      targetRef.current = { info, element: el };
      setMenu({ x: e.clientX, y: e.clientY, items: [] });
      setActive(-1);
      void rebuild();
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, [rebuild]);

  // 菜单开着时 provider 增删（模块挂载/卸载）→ 重算一次，别显示过期的东西
  useEffect(() => {
    if (!menu) return;
    return subscribeContextMenu(() => { void rebuild(); });
  }, [menu, rebuild]);

  const close = useCallback(() => {
    setMenu(null);
    targetRef.current = null;
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      close();
    };
    // 滚动/缩放后原来的指针位置已经没意义了，直接关
    const onScrollOrResize = () => close();
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [menu, close]);

  useEffect(() => {
    if (menu) panelRef.current?.focus();
  }, [menu]);

  const runItem = useCallback((item?: ContextMenuItem) => {
    if (!item || item.disabled) return;
    close();
    try {
      void item.run?.();
    } catch (err) {
      console.warn('[context-menu] 执行条目失败:', item.id, err);
    }
  }, [close]);

  if (!menu) return null;

  const enabledIndexes = menu.items
    .map((item, i) => (item.disabled ? -1 : i))
    .filter((i) => i >= 0);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (enabledIndexes.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const at = enabledIndexes.indexOf(active);
      const next = at < 0
        ? (e.key === 'ArrowDown' ? 0 : enabledIndexes.length - 1)
        : (at + step + enabledIndexes.length) % enabledIndexes.length;
      setActive(enabledIndexes[next]);
      return;
    }
    if (e.key === 'Home' && enabledIndexes.length) { e.preventDefault(); setActive(enabledIndexes[0]); return; }
    if (e.key === 'End' && enabledIndexes.length) { e.preventDefault(); setActive(enabledIndexes[enabledIndexes.length - 1]); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      if (active < 0) return;
      e.preventDefault();
      runItem(menu.items[active]);
    }
  };

  // 贴边时把菜单拉回视口内（右下角右键不再被裁掉）
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rows = menu.items.length || 1;
  const left = Math.max(8, Math.min(menu.x, vw - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(menu.y, vh - rows * ITEM_HEIGHT - 24));

  return (
    <div
      ref={panelRef}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed z-[9999] outline-none bg-white/90 backdrop-blur-md border border-white/80 shadow-lg rounded-xl p-1.5 dark:bg-stone-800/90 dark:border-stone-700/50 animate-in fade-in-0 zoom-in-95"
      style={{ left, top, width: MENU_WIDTH }}
    >
      {menu.items.length === 0 ? (
        <div className="px-3 py-2 text-xs text-neutral-400 dark:text-stone-500">{t('contextMenu.loading')}</div>
      ) : menu.items.map((item, i) => (
        <div key={item.id}>
          {item.separatorBefore && i > 0 && (
            <div className="my-1 h-px bg-neutral-200/70 dark:bg-stone-700/60" role="separator" />
          )}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onMouseEnter={() => !item.disabled && setActive(i)}
            onClick={() => runItem(item)}
            className={[
              'w-full flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
              item.disabled
                ? 'opacity-40 cursor-default'
                : 'cursor-pointer',
              active === i && !item.disabled ? 'bg-[var(--element-muted)] text-[var(--element-color-raw)]' : 'text-neutral-700 dark:text-stone-200',
              item.variant === 'destructive' && !item.disabled ? 'text-red-600 dark:text-red-400' : '',
            ].join(' ')}
          >
            <span className="truncate">{item.label}</span>
            {item.hint && <span className="shrink-0 text-[11px] tabular-nums text-neutral-400 dark:text-stone-500">{item.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}
