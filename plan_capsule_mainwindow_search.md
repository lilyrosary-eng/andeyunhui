# 计划：黄金棋盘（主窗口子插件）填入集成搜索模块

> **状态**: ✅ 已实现（2026-07-27）
> 目标：把主窗口里属于茑萝的子插件「黄金棋盘」的空面板（CapsulePlaceholder → null）填成搜索模块，复用已有 fs_search/fs_index_status/fs_open_path。
> 红线：桌面浮岛胶囊（src/Capsule.tsx 浮窗）逻辑与外观一律不动。

## 已确认决策
- A: 侧栏点黄金棋盘 → 切主窗口搜索面板（浮岛靠 cursor-near-top 监视自动弹，触发路径不变）
- 搜索文案走 t() 国际化

## 已改动文件
1. **新增 `src/components/FileSearchPanel.tsx`**：共享搜索组件，`variant='panel'|'overlay'`、`onClose?`。panel 用 CSS 变量自适应主题；overlay 保留浮岛深色+金色观感。零外部依赖 SVG 图标。7 个 i18n key（niaoluo.search.*）。
2. **`src/App.tsx`**：import FileSearchPanel；renderModule 加 capsule 特判→`<FileSearchPanel variant="panel"/>`（在 deskpet 之后、通用插件渲染之前）。
3. **`src/components/HostSidebar.tsx`**：补 `import { api }`；capsule 点击改 `setActiveModule('capsule')`（替代 `dispatchEvent('capsule:show')`），加载逻辑保留。
4. **`src/Capsule.tsx`**：import FileSearchPanel；删除 SearchResult 接口、searchQuery/searchResults/searchStatus 状态、runSearch/onSearchInput/refreshIndexStatus/定时器 effect；搜索面板 JSX 替换为 `<FileSearchPanel variant="overlay" onClose={...}/>`。浮岛其余逻辑（ACTIONS、searchOpen 开关、高度/重绘等）不动。
5. **7 个 locale 文件**：各加 niaoluo.search.{title,placeholder,indexing,indexed,noResults,prompt,waitIndex} 翻译。

## 风险
- 纯前端改动、不动 src-tauri；浮岛行为完全保留（overlay 变体视觉一致 + searchOpen 所有引用不变）。
- CapsulePlaceholder 仍返回 null（作为兜底，App.tsx 特判优先命中）。
