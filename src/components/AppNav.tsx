import { useCallback } from 'react';
import { NotebookText, Settings, Puzzle, Inbox } from 'lucide-react';
import { PluginIcon } from '@/components/PluginIcon';
import { logger } from '@/lib/logger';
import { useAppStore } from '@/stores/appStore';
import type { PluginRegistry } from '@/core/pluginRegistry';

const BUILTIN_NAV = [
  { id: 'notes', icon: NotebookText, label: '鸢尾花' },
  { id: 'extensions', icon: Puzzle, label: '茑萝' },
];

const navBtnClass = (active: boolean) =>
  `btn-press group relative w-10 h-10 flex items-center justify-center rounded-xl transition-all duration-200 ${active ? 'element-muted' : 'text-neutral-400 hover:text-neutral-700 hover:bg-black/5 dark:text-stone-500 dark:hover:text-stone-300 dark:hover:bg-white/5'}`;

interface AppNavProps {
  mainPluginIds: string[];
}

/** 极简导航栏 — 始终显示全部模块图标，子目录切换逻辑已移至左侧侧边栏 */
export function AppNav({ mainPluginIds }: AppNavProps) {
  const activeModule = useAppStore(s => s.activeModule);
  const pluginRegistry = useAppStore(s => s.pluginRegistry) as PluginRegistry | null;
  const setActiveModule = useAppStore(s => s.setActiveModule);

  const activeDef = pluginRegistry?.get(activeModule);
  const isNiaoluoChild = !!(activeDef && activeDef.parent === 'niuluo');

  const handleSwitchModule = useCallback((moduleId: string) => {
    logger.app.switchModule(moduleId);
    if (mainPluginIds.includes(moduleId)) {
      logger.app.switchMainPlugin(moduleId, !!pluginRegistry);
      if (pluginRegistry) {
        const def = pluginRegistry.get(moduleId);
        logger.app.mainPluginDef(moduleId, !!def);
      }
    }
    setActiveModule(moduleId);
  }, [mainPluginIds, pluginRegistry, setActiveModule]);

  return (
    <div className="w-[56px] h-full flex flex-col items-center py-4 nav-primary-bg backdrop-blur-md border-r border-white/80 flex-shrink-0 z-50 dark:border-stone-700/50">
      {/* Logo */}
      <div className="w-8 h-8 rounded-full element-primary flex items-center justify-center mb-6 shadow-sm transition-all duration-200">
        {(() => {
          if (activeModule === 'notes') return <NotebookText size={18} />;
          if (activeModule === 'extensions' || isNiaoluoChild) return <Puzzle size={18} />;
          if (activeModule === 'transfer') return <Inbox size={18} />;
          if (activeModule === 'settings') return <Settings size={18} />;
          if (activeDef) {
            return <PluginIcon name={activeDef.iconName} size={18} fallback={<span className="text-sm font-bold">岸</span>} />;
          }
          return (
            <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
              <g transform="translate(30,30)">
                <path d="M0,-3 C-3,-10 -4,-22 0,-28 C4,-22 3,-10 0,-3 Z" transform="rotate(0)"/>
                <path d="M0,-3 C-3,-10 -4,-22 0,-28 C4,-22 3,-10 0,-3 Z" transform="rotate(45)"/>
                <path d="M0,-3 C-3,-10 -4,-22 0,-28 C4,-22 3,-10 0,-3 Z" transform="rotate(90)"/>
                <path d="M0,-3 C-3,-10 -4,-22 0,-28 C4,-22 3,-10 0,-3 Z" transform="rotate(135)"/>
                <path d="M0,-3 C-3,-10 -4,-22 0,-28 C4,-22 3,-10 0,-3 Z" transform="rotate(180)"/>
                <path d="M0,-3 C-3,-10 -4,-22 0,-28 C4,-22 3,-10 0,-3 Z" transform="rotate(225)"/>
                <path d="M0,-3 C-3,-10 -4,-22 0,-28 C4,-22 3,-10 0,-3 Z" transform="rotate(270)"/>
                <path d="M0,-3 C-3,-10 -4,-22 0,-28 C4,-22 3,-10 0,-3 Z" transform="rotate(315)"/>
                <circle cx="0" cy="-2" r="5"/>
                <circle cx="0" cy="-2" r="2.5" fill="currentColor" opacity=".35"/>
              </g>
            </svg>
          );
        })()}
      </div>

      <div className="flex-1 flex flex-col gap-2">
        {/* 茑萝子模块时：茑萝保持高亮（返回按钮已移至侧边栏标题下方） */}
        {/* 内置导航 */}
        {BUILTIN_NAV.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => handleSwitchModule(id)}
            className={navBtnClass(activeModule === id || (id === 'extensions' && isNiaoluoChild))}
            title={label}
          >
            <Icon size={20} />
          </button>
        ))}
        {/* 主模块插件 */}
        {pluginRegistry && mainPluginIds.map((pluginId) => {
          const def = pluginRegistry.get(pluginId);
          if (!def || !def.visible) return null;
          return (
            <button key={pluginId} onClick={() => handleSwitchModule(pluginId)} className={navBtnClass(activeModule === pluginId)} title={def.name}>
              <PluginIcon name={def.iconName} size={20} fallback={<span className="text-xs">{def.name[0]}</span>} />
            </button>
          );
        })}
      </div>

      {/* 中转站 */}
      <button onClick={() => handleSwitchModule('transfer')} className={`mb-1 ${navBtnClass(activeModule === 'transfer')}`} title="中转站">
        <Inbox size={20} />
      </button>
      {/* 全局设置 */}
      <button onClick={() => handleSwitchModule('settings')} className={navBtnClass(activeModule === 'settings')} title="设置">
        <Settings size={20} />
      </button>
    </div>
  );
}
