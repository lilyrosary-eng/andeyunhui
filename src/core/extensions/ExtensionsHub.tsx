import { Puzzle } from 'lucide-react';
import { PluginRegistry } from '@/core/pluginRegistry';
import { ExtensionManagerPanel } from '@/core/settings/ExtensionManagerPanel';
import { useAppStore } from '@/stores/appStore';

interface ExtensionsHubProps {
  registry: PluginRegistry;
  parentId: string;
  title?: string;
  excludePluginIds?: string[];
}

/** 茑萝主内容区 — 仅负责显示拓展管理面板或空状态提示。拓展列表由宿主侧边栏渲染。 */
export function ExtensionsHub(_props: ExtensionsHubProps) {
  const showExtensionSettings = useAppStore(s => s.showExtensionSettings);

  if (showExtensionSettings) {
    return <ExtensionManagerPanel />;
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full gap-3 text-neutral-400 dark:text-stone-500">
      <Puzzle size={40} className="opacity-40" />
      <p className="text-sm">从左侧选择一个拓展模块</p>
    </div>
  );
}
