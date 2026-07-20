/// <reference path="../../global.d.ts" />
// 插件模板 — 复制整个 _template 目录到 plugins/<your-plugin>/ 后开始开发。
// 完整说明见同目录 README.md。
//
// 要点：
// - React 由宿主注入（window.__HOST_REACT__），不要 import 'react'。
// - 入口最后必须调用 window.__PLUGIN_REGISTRY__.register(...) 注册自己。
// - 沙箱默认禁用 fetch / eval / Function 等；如需 new Function 加载外部依赖，
//   须在 manifest.json 声明 "deps"（详见 README 与 templates/external-dep）。

const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useCallback } = React;

// 共享运行时（根目录选择、黑名单、统一状态 UI 等）。路径相对插件源码目录。
import { useRootPaths, EmptyState } from '../../_shared/pluginRuntime';

const STORAGE_KEY = 'my_plugin_root_paths';

function MainComponent() {
  const { rootPaths, addRoot } = useRootPaths(STORAGE_KEY);
  const [count, setCount] = useState(0);

  if (rootPaths.length === 0) {
    return (
      <EmptyState
        icon={
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--element-bg)]">
            <path d="M12 2 2 7l10 5 10-5-10-5z" />
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

  const openFolder = useCallback(async () => {
    try {
      const dirs = await hostApi.invoke<string[] | null>('pick_directory', {});
      if (dirs && dirs.length) {
        // 这里可调用你的 Rust 命令扫描/处理目录……
        console.log('[my-plugin] 已选择:', dirs[0]);
      }
    } catch (e) {
      console.error('[my-plugin] 选择失败', e);
    }
  }, []);

  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full gap-4">
      <h2 className="text-xl font-semibold text-neutral-700 dark:text-stone-200">我的插件</h2>
      <p className="text-sm text-neutral-400 dark:text-stone-500">
        已选择 {rootPaths.length} 个目录 · 计数 {count}
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => setCount((c) => c + 1)}
          className="px-5 py-2 rounded-xl bg-[var(--element-bg)] text-white font-medium hover:opacity-90"
        >
          计数 +1
        </button>
        <button
          onClick={openFolder}
          className="px-5 py-2 rounded-xl border border-neutral-300 dark:border-stone-600 text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5"
        >
          选择文件夹
        </button>
      </div>
    </div>
  );
}

// ============ 可选：加载「外部依赖」（重库，按需从 external-deps 读取） ============
// 仅当插件需要 CodeMirror / TipTap 之类重库时才用。务必：
//   1) 在 manifest.json 写 "deps": ["<dep>"]             —— 沙箱才会开放 Function
//   2) 在 manifest.json 写 "requiredAssets": ["<rel>/index.js"] —— Rust 缺失时拒绝加载
// 构建与挂载方式见仓库 templates/external-dep/README.md。
/*
async function loadMyDep(): Promise<any> {
  const w = window as any;
  if (w.__EXT_MYDEP__) return w.__EXT_MYDEP__;
  const code = await hostApi.invoke<string>('read_external_dep_file', {
    relativePath: '茑萝/myplugin/mydep/index.js',
  });
  if (!code) throw new Error('外部依赖未找到');
  new Function(code)(); // 在全局作用域执行，挂载到 window.__EXT_MYDEP__
  return w.__EXT_MYDEP__;
}
*/

window.__PLUGIN_REGISTRY__.register({
  id: 'my-plugin', // 必须与 manifest.json 的 id 一致
  name: '我的插件',
  iconName: 'Puzzle', // Lucide 图标名
  kind: 'module', // 'module' | 'service'
  visible: true, // 是否出现在导航栏
  component: MainComponent,
  // 可选字段（详见 README）：
  // sidebar?: 侧边栏组件
  // settings?: 设置面板组件
  // parent?: 'niaoluo'   // 设为某父模块 id 即成为其子插件（不单独出现在导航栏）
  // category?: '示例'
  // desc?: '一句话描述'
  // destroy?: () => { /* 卸载时释放资源（定时器/事件监听等） */ }
});
