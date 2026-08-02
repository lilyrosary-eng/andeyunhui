// 茑萝 · IDE 侧边栏容器（阶段三）
// 在原 FileExplorer 基础上加活动栏（Activity Bar），切换 资源管理器 / 源码管理 / Git 历史。
// 对齐 VS Code 活动栏 + 侧边栏的交互范式；宿主仍把本组件作为 sidebar 渲染，内部自管视图切换。
const React = window.__HOST_REACT__;
const { useState, useEffect } = React;
import { FileText, GitBranch, History } from 'lucide-react';
import { FileExplorer } from './explorer';
import { SourceControl } from './sourceControl';
import { GitHistory } from './gitHistory';

type SidebarView = 'explorer' | 'sourceControl' | 'gitHistory';

const VIEWS: { id: SidebarView; label: string; Icon: any }[] = [
  { id: 'explorer', label: '资源管理器', Icon: FileText },
  { id: 'sourceControl', label: '源码管理', Icon: GitBranch },
  { id: 'gitHistory', label: 'Git 历史', Icon: History },
];

export function IdeSidebar() {
  const [view, setView] = useState<SidebarView>('explorer');

  // 切到源码管理/历史时自动刷新（组件挂载即触发自身 useEffect，此处无需额外动作，
  // 但监听 ide-project-changed 事件以便项目切换时回到资源管理器）
  useEffect(() => {
    const onProjectChanged = () => {
      // 项目切换：保持当前视图，子组件靠 ideShared.projectRoot 自行重载
    };
    window.addEventListener('ide-project-changed', onProjectChanged);
    return () => window.removeEventListener('ide-project-changed', onProjectChanged);
  }, []);

  return (
    <div className="flex h-full w-full">
      {/* 活动栏（垂直图标条） */}
      <div className="w-10 shrink-0 flex flex-col items-center py-1.5 gap-0.5 border-r border-neutral-200 dark:border-stone-700 bg-neutral-50 dark:bg-stone-900">
        {VIEWS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`btn-press w-8 h-8 flex items-center justify-center rounded relative ${
              view === id
                ? 'text-blue-500 bg-blue-500/10'
                : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 hover:bg-black/5 dark:hover:bg-white/5'
            }`}
            title={label}
          >
            <Icon size={18} />
            {/* 活动指示条（左侧竖线，VS Code 同款） */}
            {view === id && <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-r bg-blue-500" />}
          </button>
        ))}
      </div>

      {/* 当前视图 */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {view === 'explorer' && <FileExplorer />}
        {view === 'sourceControl' && <SourceControl />}
        {view === 'gitHistory' && <GitHistory />}
      </div>
    </div>
  );
}
