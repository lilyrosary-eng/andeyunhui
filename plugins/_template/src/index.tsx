// =============================================
// 插件模板 — 复制此目录开始开发你的插件
// =============================================
//
// 快速开始：
// 1. 复制 _template 目录，重命名为你的插件名
// 2. 修改 manifest.json：id / name / iconName
// 3. 修改下方 register() 调用中的参数
// 4. 在 plugins/ 目录下运行 npm install
// 5. 运行 npm run build 构建插件
// 6. 重启主应用即可看到新插件
//
// 共享运行时（推荐使用）：
//   import { useRootPaths, useBlacklist, EmptyState, LoadingState, NoResultsState }
//     from '../../_shared/pluginRuntime';
//
// 可用图标名（Lucide 图标库）：
//   Puzzle, Music2, Calendar, Video, Image, Code, Globe,
//   Database, Settings, Star, Heart, Bookmark, Clock 等
// =============================================

/// <reference path="../../global.d.ts" />

// 从共享运行时导入基础设施（hooks + 状态 UI）
import { useRootPaths, EmptyState } from '../../_shared/pluginRuntime';

const React = window.__HOST_REACT__;
const { useState } = React;

const STORAGE_KEY_ROOT = 'my_plugin_root_paths';

function MainComponent() {
  const { rootPaths, addRoot } = useRootPaths(STORAGE_KEY_ROOT);
  const [count, setCount] = useState(0);

  if (rootPaths.length === 0) {
    return (
      <EmptyState
        icon={
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--element-bg)]">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        }
        title="我的插件"
        description="选择一个文件夹开始使用"
        buttonText="选择文件夹"
        onSelect={addRoot}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full bg-[#f5f5f0] dark:bg-[#1c1917] gap-4">
      <h2 className="text-xl font-semibold text-neutral-700 dark:text-stone-200">我的插件</h2>
      <p className="text-sm text-neutral-400 dark:text-stone-500">已选择 {rootPaths.length} 个目录</p>
      <button
        onClick={() => setCount(c => c + 1)}
        className="px-6 py-2 rounded-xl element-primary font-medium hover:bg-[var(--element-hover)] transition-colors"
      >
        点击计数: {count}
      </button>
    </div>
  );
}

// 注册到宿主插件系统（必须调用）
window.__PLUGIN_REGISTRY__.register({
  id: 'plugin-id',          // 与 manifest.json 中的 id 一致
  name: '插件名称',           // 显示名称
  iconName: 'Puzzle',       // Lucide 图标名
  kind: 'module',           // 模块类型（module / sidebar / settings）
  visible: true,            // 是否在导航栏显示
  component: MainComponent, // 主组件
  sidebar: undefined,       // 可选：侧边栏组件
  settings: undefined,      // 可选：设置面板组件
});
