# 侧边栏子母目录模式模板

## 概述

此模板定义了宿主应用中「母目录列表 → 子模块页面 → 返回」的完整对接模式。核心思想：侧边栏壳组件（`ModuleSidebarShell`）保持不变，仅中间的 children 内容根据 `activeModule` 切换；返回按钮由壳组件的 `backAction` prop 驱动，不侵入图标栏（AppNav）。

架构数据流：`PluginRegistry.parent` 标注归属 → `App.tsx` 允许子插件作为合法 activeModule → `HostSidebar` 检测子模块模式并传递 `backAction` → `ModuleSidebarShell` 渲染返回按钮。

---

## 第一步：插件注册声明 parent

在 `PluginDef` 接口中，`parent` 字段将插件标记为某个模块的子模块。设有 parent 的插件不进入顶层导航栏，由父模块的侧边栏列表管理。

```ts
// pluginRegistry.ts
export interface PluginDef {
  id: string;
  name: string;
  kind: 'module' | 'service';
  visible?: boolean;
  component: ComponentType<any>;
  sidebar?: ComponentType<any>;      // 子模块自己的侧边栏内容（如文件树、图层列表）
  parent?: string;                    // ★ 归属的父模块 id
  category?: string;                  // 分组标签，供父模块侧边栏分组渲染
  desc?: string;
  // ...
}
```

插件注册示例：

```ts
// 子插件注册 — 声明 parent: 'niuluo' 即归属茑萝
window.__PLUGIN_REGISTRY__.register({
  id: 'ide',
  name: 'IDE',
  kind: 'module',
  visible: false,         // 子模块通常 visible: false，不在顶层导航栏出现
  parent: 'niuluo',       // ★ 关键字段
  category: '开发',
  component: IdeEditor,
  sidebar: IdeSidebar,
});
```

---

## 第二步：App.tsx 布局与路由

### 2.1 派生子插件 ID 列表

```tsx
// App.tsx
const subPluginIds = useMemo(() => {
  if (!pluginRegistry) return [] as string[];
  return pluginRegistry.getAll()
    .filter((p) => p.kind === 'module' && p.parent)
    .map((p) => p.id);
}, [pluginRegistry]);
```

### 2.2 将子插件 ID 纳入合法路由

```tsx
const validModuleIds = useMemo(() => {
  const ids = new Set(['notes', 'extensions', 'settings', 'transfer']);
  mainPluginIds.forEach(id => ids.add(id));
  subPluginIds.forEach(id => ids.add(id));   // ★ 子插件也能作为 activeModule
  return ids;
}, [mainPluginIds, subPluginIds]);
```

### 2.3 activeModule 兜底

当插件被卸载导致当前 activeModule 不再合法时，回退到 notes：

```tsx
useEffect(() => {
  if (pluginRegistry && !validModuleIds.has(activeModule)) {
    setActiveModule('notes');
  }
}, [pluginRegistry, validModuleIds, activeModule, setActiveModule]);
```

### 2.4 布局结构（三栏）

```tsx
<div className="flex flex-1 overflow-hidden">
  <AppNav mainPluginIds={mainPluginIds} />   {/* 图标栏：始终显示全部模块 */}
  <HostSidebar />                              {/* 侧边栏：母目录/子模块内容切换 */}
  <div className="flex flex-1 h-full overflow-hidden">
    {renderModule()}                           {/* 主内容区：画布/编辑器等 */}
  </div>
</div>
```

关键点：HostSidebar 始终渲染，内部自行判断显示/隐藏和内容切换。

---

## 第三步：AppNav 图标栏（保持静态）

图标栏不参与子目录逻辑。子模块模式下，母目录图标保持高亮，不额外渲染任何内容。

```tsx
// AppNav.tsx
const activeDef = pluginRegistry?.get(activeModule);
const isNiaoluoChild = !!(activeDef && activeDef.parent === 'niuluo');

// 高亮逻辑
<button className={navBtnClass(
  activeModule === id 
  || (id === 'extensions' && isNiaoluoChild)  // ★ 子模块下母目录仍高亮
)}>
  <Icon size={20} />
</button>

// Logo 在子模块下沿用母目录图标
if (activeModule === 'extensions' || isNiaoluoChild) return <Puzzle size={18} />;
```

---

## 第四步：HostSidebar 核心逻辑

这是子母目录模式的枢纽，负责以下职责：

| 条件 | 显示/隐藏 | children 内容 | backAction | 搜索框 |
|------|----------|--------------|------------|--------|
| activeModule = 'extensions'（母目录） | 显示 | 子插件列表 | 无 | 有 |
| activeModule = 子插件（有 parent） | 显示 | 插件 sidebar 组件 | 有（返回母目录） | 无 |
| 其他模块（notes/settings） | 隐藏（return null） | — | — | — |

### 完整实现

```tsx
// HostSidebar.tsx
import { ModuleSidebarShell } from '@/components/ModuleSidebarShell';
import { PluginErrorBoundary } from '@/core/PluginHost';

export function HostSidebar() {
  const pluginRegistry = useAppStore(s => s.pluginRegistry) as PluginRegistry | null;
  const activeModule = useAppStore(s => s.activeModule);
  const setActiveModule = useAppStore(s => s.setActiveModule);

  // 1. 是否显示侧边栏：母目录模式 或 子插件模式
  const showSidebar =
    activeModule === 'extensions' ||                          // 母目录
    !!(pluginRegistry?.get(activeModule)?.parent);            // 子插件（有 parent 字段）

  if (!showSidebar || !pluginRegistry) return null;

  // 2. 搜索框仅在母目录模式显示
  const searchProps =
    activeModule === 'extensions'
      ? { searchQuery, onSearchChange, searchPlaceholder }
      : {};

  // 3. 内容区：母目录渲染列表，子插件渲染 sidebar 组件
  let content: React.ReactNode = null;

  if (activeModule === 'extensions') {
    // ---- 母目录：渲染归属 niuluo 的子插件列表 ----
    const children = pluginRegistry.getAll()
      .filter((p) => p.kind === 'module' && p.parent === 'niuluo');

    content = children.map(plugin => (
      <button 
        key={plugin.id} 
        onClick={() => setActiveModule(plugin.id)}  // ★ 切换到子插件
        className={/* 高亮选中项 */}
      >
        <PluginIcon name={plugin.iconName} />
        <span>{plugin.name}</span>
      </button>
    ));
  } else {
    // ---- 子插件：渲染其 sidebar 内容 ----
    const def = pluginRegistry.get(activeModule);
    if (def?.sidebar) {
      const PluginContent = def.sidebar;
      content = (
        <PluginErrorBoundary pluginId={activeModule}>
          <PluginContent />
        </PluginErrorBoundary>
      );
    }
  }

  // 4. 判断子插件模式，传递返回按钮
  const isChild = 
    activeModule !== 'extensions' 
    && !!pluginRegistry?.get(activeModule)?.parent;

  return (
    <ModuleSidebarShell
      moduleId="niuluo"
      icon={<Puzzle size={20} />}
      title="茑萝"
      backAction={
        isChild 
          ? { onClick: () => setActiveModule('extensions'), label: '返回' }  // ★
          : undefined
      }
      {...searchProps}
    >
      {content}
    </ModuleSidebarShell>
  );
}
```

### 关键设计决策

**子插件 sidebar 必须用 PluginErrorBoundary 包裹**：插件侧边栏组件是模块级函数，只能引用模块级常量。如果引用了画布内部的局部变量会导致 `ReferenceError`，没有错误边界包裹会白屏整个应用。

**返回按钮回到母目录**：`backAction.onClick` 执行 `setActiveModule('extensions')`，即把 activeModule 切回母目录 id。侧边栏内容随之切换回子插件列表。

**搜索框仅在母目录显示**：子插件模式下搜索由插件自己的 sidebar 组件自行处理（或不显示）。

---

## 第五步：ModuleSidebarShell 壳组件

壳组件不感知母目录/子模块的概念，仅提供 `backAction` 作为通用 prop。

### Props 接口

```ts
export interface ModuleSidebarShellProps {
  moduleId: string;                              // 用于 localStorage 折叠状态 key
  icon: ReactNode;                                // 标题图标
  title: string;                                  // 标题文本
  backAction?: { label?: string; onClick: () => void };  // ★ 返回按钮
  searchQuery?: string;                           // 搜索值
  onSearchChange?: (value: string) => void;       // 搜索回调
  searchPlaceholder?: string;                     // 搜索占位
  onOpenModuleSettings?: () => void;              // 设置按钮回调
  moduleSettingsLabel?: string;                   // 设置按钮 tooltip
  primaryAction?: { label: string; onClick: () => void };
  secondaryActions?: Array<{ icon: ReactNode; label: string; onClick: () => void }>;
  children: ReactNode;
}
```

### 返回按钮渲染位置

```tsx
// 标题区之后、搜索框之前
{backAction && (
  <div className="shrink-0 px-3 pb-2">
    <button
      onClick={backAction.onClick}
      title="返回母目录"
      className="btn-press flex items-center gap-1.5 px-2 py-1.5 
                 rounded-lg text-xs text-neutral-500 dark:text-stone-400 
                 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
    >
      <Home size={15} />
      {backAction.label && <span>{backAction.label}</span>}
    </button>
  </div>
)}
```

### 布局顺序（展开态）

```
┌──────────────────────────┐
│ 图标 + 标题               │  ← shrink-0
├──────────────────────────┤
│ 🏠 返回  （可选）          │  ← backAction
├──────────────────────────┤
│ 🔍 搜索  （可选）          │  ← searchQuery
├──────────────────────────┤
│                          │
│ children 内容区            │  ← flex-1 overflow-y-auto
│                          │
├──────────────────────────┤
│ ◀ 收起  ⚙ 设置           │  ← 底部栏 shrink-0
└──────────────────────────┘
```

---

## 复用检查清单

当需要为新的父模块新增子母目录侧边栏时，按以下步骤操作：

1. **插件侧**：子插件注册时声明 `parent: '<父模块id>'`，并提供 `sidebar` 组件（用于子模块页面左侧内容）。

2. **App.tsx**：`subPluginIds` 的过滤条件中，`p.parent` 已涵盖所有 parent 不为空的插件，无需改动。

3. **AppNav 图标栏**：如需对新的父模块做子模块高亮，增加 `isXxxChild` 判断（参照 `isNiaoluoChild`），并在高亮条件中加入 `|| (id === '<父模块id>' && isXxxChild)`。

4. **HostSidebar**：
   - `showSidebar` 条件中加入 `activeModule === '<父模块id>'`。
   - 母目录分支：渲染 `p.parent === '<父模块id>'` 的子插件列表。
   - `isChild` 判断自动适用（`activeModule !== '<父模块id>' && !!parent`）。
   - 传入 `backAction={{ onClick: () => setActiveModule('<父模块id>'), label: '返回' }}`。

5. **ModuleSidebarShell**：无需改动，`backAction` prop 是通用接口。

---

## 注意事项

- 图标栏（AppNav）必须保持静态，不添加/移除任何导航项，仅做高亮。
- 子插件 `sidebar` 组件必须被 `PluginErrorBoundary` 包裹，防止插件崩溃白屏整应用。
- `parent` 是插件注册时的静态声明，运行时不会改变；isChild 判断依赖此字段。
- 搜索框仅在母目录模式显示（`searchProps` 条件分发），子模块模式的搜索由插件自理。
- 本项目 UI 图标库为 `lucide-react`，返回按钮使用 `Home` 图标。
