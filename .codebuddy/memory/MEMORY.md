# 项目长期记忆 — tauri-best

## 项目概述
- 项目名称：andengyuanhua（岸灯鸢花），Tauri v2 桌面应用（React 前端 + Rust 后端），笔记应用 + 插件系统
- 插件系统：music/image/video/reading/professional/markitdown + 扩展中心 gongjuxiang，IIFE 沙箱执行，`window.__HOST_*` 全局注入宿主 API
- 打包：NSIS，`bundled-plugins/` 随 `bundle.resources` 打包

## ★ 核心构建约定
- **重依赖走 `external-deps/`，插件走 `bundled-plugins/`**。重依赖（CodeMirror/TipTap 等 >100KB）必须外部化到 `external-deps/<name>/index.js`（esbuild IIFE，`scripts/build-external-deps.mjs` 构建），绝不可打包进插件本体。插件产出经 `scripts/deploy-plugins.mjs` 部署到 `bundled-plugins/` + `app_data/extensions/` + `app_data/user_plugins/`。
- 运行时加载：`read_external_dep_file({relativePath})` → `new Function(code)()` → 读 `window.__EXT_<NAME>__` 全局
- 共享 React 实例：ESM 依赖构建时外部化 react/react-dom 到 `__HOST_REACT__`/`__HOST_REACT_DOM__`
- `build-external-deps.mjs` 已接入 `pnpm predev`（自动重生成）
- 自检：插件 `dist/index.js` 不得含 tiptap/prosemirror/codemirror 字样

## ★ Windows node_modules symlink 问题（2026-07-11 修复）
- **症状**：pnpm 的 symlink/junction 全部损坏，`fs.statSync('node_modules/react')` 返回 "UNKNOWN: unknown error"，导致 TypeScript 找不到 `@types/react`（TS2688），级联出 3303 个错误
- **根因**：Windows 系统 reparse point 不可跟随（可能是 Defender/NTFS 权限），symlink 和 junction 都无法被 `fs.statSync` 解析
- **修复**：`scripts/fix-node-modules.mjs` 将所有断掉的 symlink 替换为真实目录拷贝（从 `.pnpm` store 复制）；`.npmrc` 添加 `node-linker=hoisted`（未来 pnpm install 使用扁平模式避免 symlink）
- **tsconfig 修复**：根 `tsconfig.json` 和 `plugins/tsconfig.json` 的 `types` 从 `["react","react-dom"]` 改回 `[]`（React 类型通过模块导入解析，不需要全局 types 声明）

## 架构
- **状态管理**：Zustand 3 store（notesStore/appStore/floatingNoteStore），零 prop drilling
- **插件共享运行时**：`plugins/_shared/pluginRuntime.tsx`（useRootPaths/useBlacklist/EmptyState 等）
- **ESLint**：flat config，rules-of-hooks: error
- **热插拔**：`reload_plugin`/`unload_plugin` Rust 命令 + 前端事件监听，`window.__pluginHot__`
- **扫描双根**：`app_data/extensions` + `app_data/user_plugins`；`deps` 专指 external-deps，不做缺失依赖拒绝

## 命名易混淆
- **「茑萝」**= 扩展中心模块（`src/core/extensions/ExtensionsHub.tsx`，导航 id `extensions`），不是插件
- **gongjuxiang**（原 niaoluo）= 茑萝内的 `visible:false` 子扩展（文本工具箱），2026-07-07 更名
- `window.__HOST_UI__` 由 PluginHost 设在全局 window，主应用模块也能直接用 `ModuleSidebarShell` 等

## 关键配置
- CSP 含 `connect-src 'self' asset: https://asset.localhost http://asset.localhost`
- `localStorage.setItem('log_level', 'debug')` 开启调试日志
- TS Node 类型隔离：根 tsconfig `"types":[]`（防 @types/node 污染 DOM 类型），`tsconfig.node.json` `"types":["node"]`
- `.npmrc`：`shamefully-hoist=true`、`public-hoist-pattern[]=*types*`、`node-linker=hoisted`

## Radix UI 类型修复（2026-07-11）
- Radix UI 2.3+/1.4+ 的 TypeScript 类型不包含 `className`/`children`/`onClick` 等标准 HTML 属性
- 修复模式：在 shadcn/ui 组件的类型注解中显式添加 `& { className?: string; children?: React.ReactNode; onClick?: ... }`，JSX 中用 `const P = SomePrimitive as any` 绕过 Radix 类型限制
- 受影响文件：`src/components/ui/context-menu.tsx`、`slider.tsx`、`switch.tsx`
- TipTap `Editor` 类型：用 `type Editor = NonNullable<ReturnType<typeof useEditor>>` 替代 `import { Editor } from '@tiptap/core'`（后者是传递依赖，可能未 hoist）

## 外部依赖
- CodeMirror 6（IDE 插件）、TipTap 2（wps 文档编辑器）→ `external-deps/` 按需 IIFE 加载
- TipTap 表格需 TableRow/TableHeader/TableCell 三个独立包 + Table，四者大版本须一致
- `__HOST_REACT_DOM__` 必须是完整 `react-dom`（含 flushSync，@tiptap/react 需要）
- IDE 加载失败不降级，显错误面板+构建命令+重试

## ★ 易回归坑（精简）
1. **deploy 同步路径**：`external-deps/` 同步到 `appDataRoot/external-deps`（不含 extensions）
2. **Windows 路径前缀**：`read_external_dep_file` 比较 root 也要 `canonicalize()`
3. **沙箱遮蔽 Function**：非受信插件 `Function` 形参为 undefined；`TRUSTED_FUNCTION_PLUGINS={'ide','wps'}` 或 manifest 声明 `deps` 自动开放
4. **TipTap tableRow**：Table 不自带 tableRow/cell/header，需独立安装注册
5. **deps 不是插件依赖**：`deps` 专指 external-deps，不做缺失拒绝
6. **gongjuxiang 重复 id**：`deploy-plugins.mjs` 按结构部署不会再生孤儿
7. **node_modules symlink 损坏**：Windows reparse point 不可跟随时运行 `scripts/fix-node-modules.mjs`
