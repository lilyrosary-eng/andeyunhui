# 插件与外部依赖开发模板

本目录与 `plugins/_template` 是给「为岸灯鸢花写插件 / 外部依赖」的人准备的模板与指南，随源码仓库分发。

## 两套模板

- **插件模板** → `plugins/_template/`（含 `manifest.json` / `vite.config.ts` / `src/index.tsx` / `README.md`）。
  复制 `plugins/_template` 到 `plugins/<your-id>/` 即可开始。详见该目录 `README.md`。
- **外部依赖模板** → `templates/external-dep/`（`entry.js` 构建入口 + `README.md`）。
  用于把 CodeMirror / TipTap 等重库作为按需加载的外部依赖。详见该目录 `README.md`。

## 架构速览（为什么这样设计）

- 插件以 **IIFE** 形式构建（`vite` lib + `formats:['iife']`），`react` / `react-dom` 外部化到宿主全局 `__HOST_REACT__` / `__HOST_REACT_DOM__`，**不打包进插件**，保证轻量且共享同一 React 实例。
- 插件在**受限沙箱**中执行（`src/core/pluginSandbox.ts`）：禁用 `fetch` / `eval` / `Function`(默认) 等，仅能通过白名单命令 `invoke` Rust 端能力，避免恶意插件危害系统。
- 重库走 **external-deps**：单独打成 IIFE，运行时由插件 `read_external_dep_file` + `new Function` 按需加载，挂载到 `window.__EXT_<DEP>__`。
- 开发时 `pnpm dev` 自动构建并同步插件到 `bundled-plugins/`，Rust 文件系统监听热重载；打包时 `bundled-plugins/` 与 `external-deps/` 随 NSIS 资源分发。

## 贡献者工作流

1. 复制对应模板目录，按其 README 填写 `manifest.json` / 入口 /（可选）外部依赖。
2. 需要新 Rust 命令：在 `src-tauri/src/commands.rs`（或对应 service）实现 `#[tauri::command]`，并在 `src/core/pluginSandbox.ts` 的 `ALLOWED_COMMANDS` 加入命令名。
3. `pnpm dev` 验证；`build.bat` 出包验证。

更完整的宿主 API、沙箱约束、共享运行时说明见 `plugins/_template/README.md`。
