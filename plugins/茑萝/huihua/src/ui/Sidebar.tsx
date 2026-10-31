import { LayerPanel } from './LayerPanel';
import { NavigatorPanel } from './Navigator';

export function HuihuaSidebar() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-1.5">
      <LayerPanel />
      <div className="border-t border-neutral-200/60 dark:border-stone-700/40" />
      <NavigatorPanel />
    </div>
  );
}
