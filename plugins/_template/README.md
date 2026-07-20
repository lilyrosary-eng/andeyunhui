# 插件模板（my-plugin）

复制本目录即可开始编写一个安得云荟插件。本目录**不会被打包进应用**（部署脚本排除 `_template`），仅作为「复制即用的起点」，并随源码仓库分发。

## 1. 快速开始

```bash
# 在 plugins/ 下复制一份，重命名为你的插件 id（建议小写中划线）
cp -r plugins/_template plugins/my-plugin
# 编辑 manifest.json 的 id / name / iconName
# 编辑 src/index.tsx 的组件与末尾 register 调用
```

开发时无需手动构建：项目 `pnpm dev` 启动会自动跑 `scripts/deploy-plugins.mjs`，把 `plugins/*` 构建并同步到 `bundled-plugins/`；Rust 端文件系统监听会热重载插件。也可单独构建：

```bash
cd plugins/my-plugin
pnpm exec vite build      # 产物在 dist/index.js
```

重启 / 热重载主应用后即可看到新插件。

## 2. manifest.json 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 插件唯一 id，须与入口 `register` 的 id 一致；建议小写中划线 |
| `name` | 是 | 导航栏 / 列表显示名 |
| `version` | 是 | 语义版本 |
| `kind` | 是 | `module`（有 UI 的模块）或 `service`（无 UI 的后台能力） |
| `visible` | 否 | 是否出现在导航栏，默认 `true` |
| `entry` | 是 | 入口文件名，固定 `index.js` |
| `iconName` | 是 | Lucide 图标名（如 `Puzzle` / `Music2` / `Code` / `FileText`） |
| `hostApiVersion` | 是 | 宿主 API 版本，固定 `1` |
| `parent` | 否 | 设为某父模块 id（如 `niaoluo` / `professional`）即成为其子插件，不再单独出现在导航栏 |
| `category` | 否 | 子插件分组名 |
| `desc` | 否 | 一句话描述 |
| `deps` | 否 | 字符串数组，声明本插件依赖的「外部依赖」名；**只要非空，沙箱就开放 `new Function`**，用于运行时加载重库 |
| `requiredAssets` | 否 | 字符串数组，声明运行所需的外部依赖资源相对路径（如 `茑萝/ide/codemirror/index.js`）；缺失时 Rust 会在加载阶段拒绝该插件，避免白屏 |

## 3. 入口（src/index.tsx）

- React 由宿主注入，写 `const React = window.__HOST_REACT__`，**不要 `import 'react'`**。
- hooks：`const { useState, useEffect } = React;`
- 宿主 API：`const hostApi = window.__HOST_API__;`
- 文件末尾必须调用 `window.__PLUGIN_REGISTRY__.register({ ... })`（见模板示例）。

## 4. 宿主 API

`window.__HOST_API__`（由 `src/core/pluginSandbox.ts` 提供，已做白名单与命令校验）：

- `invoke(cmd, args?)` —— 调用 Rust 命令。**仅白名单内命令可用**，调用未授权命令会抛错。常用：`pick_directory`、`pick_file`、`pick_save_file`、`read_text_file`、`write_text_file`、`list_directory`、`read_external_dep_file`、`read_plugin_file`、`plugin_storage_get/set`、`check_file_exists`、`convert_image`、`convert_document`、`clipboard_read/write`、`add_to_blacklist` 等。完整白名单见 `src/core/pluginSandbox.ts` 的 `ALLOWED_COMMANDS`。新增命令需：① 在 Rust 端实现 `#[tauri::command]`；② 把它加入 `ALLOWED_COMMANDS`；③ 若尚未在 `src-tauri/src/commands.rs` 注册则注册。
- `listen(event, handler)` / `emit(event, payload?)` —— 事件订阅 / 发布（透传 Tauri 事件）。
- `convertFileSrc(filePath)` —— 把本地路径转为 `asset:` 协议的可用 src（图片 / 视频用）。
- `createFrameBuffer(onFlush)` —— 高频数据批处理（rAF 合帧），避免渲染风暴；返回 `{ push, flush, destroy }`。

`window.__HOST_UI__` —— 宿主 UI 组件（直接当 React 组件用）：`ModuleSidebarShell`、`SecondaryNavShell`、`NestedNavList`、`ModuleSettingsPanel`、`CollapsibleSearch`、`IconButton`、`Icon`(=`PluginIcon`)、`ContextMenu` / `ContextMenuTrigger` / `ContextMenuContent` / `ContextMenuItem` / `ContextMenuSeparator`。

`window.__HOST_REACT__` / `__HOST_REACT_DOM__` —— 宿主 React / ReactDOM 实例。

## 5. 共享运行时（`_shared/pluginRuntime`）

导入：`import { useRootPaths, useBlacklist, useStreamingOpen, useScanStream, EmptyState, LoadingState, NoResultsState } from '../../_shared/pluginRuntime';`

- `useRootPaths(storageKey)` —— 根目录选择 + localStorage 持久化。
- `useBlacklist(module)` —— Rust 集中管理的黑名单（按模块隔离）。
- `useStreamingOpen(events, handlers, options?)` —— 流式打开大文件 / 大书（分块事件 + 帧缓冲 + 可取消）。
- `useScanStream(config)` —— 扫描根目录的高并发骨架（缓存命中 → 流式扫描 → 帧缓冲 → 取消）。
- `EmptyState` / `LoadingState` / `NoResultsState` —— 统一空 / 加载 / 无结果界面。

## 6. 沙箱约束（务必遵守）

插件在受限沙箱中执行（`src/core/pluginSandbox.ts`）：

- **禁用**：`fetch`、`XMLHttpRequest`、`indexedDB`、`eval`、`WebSocket`、`Worker`、`alert`、`prompt`、`confirm`。禁止裸调用它们（降低社会工程攻击面）。需要网络 / 存储请走 Rust 命令（`invoke`）或在 Rust 侧实现。
- **`Function` 默认禁用**：非受信插件 `new Function` 为 `undefined`。需要用 `new Function` 运行时加载外部依赖（CodeMirror / TipTap 等）时，必须在 manifest 声明 `"deps": ["<dep>"]`（或插件 id 在 `TRUSTED_FUNCTION_PLUGINS` 白名单），沙箱才会放开。
- **可用**：`document` / `localStorage` / `setTimeout` 等 DOM 与定时器；`react` / `react-dom` 由宿主注入。
- **包体自检**：插件 `dist/index.js` 不得包含 tiptap / prosemirror / codemirror 等重库——这些必须作为「外部依赖」走 `external-deps` 按需加载（见下）。保持插件轻量。

## 7. 引入「外部依赖」（重库按需加载）

当插件需要 CodeMirror / TipTap 等重库时，不要打包进插件本体，而是：

1. 在 `manifest.json` 写 `"deps": ["<dep>"]` 与 `"requiredAssets": ["<relpath>/index.js"]`；
2. 按 `templates/external-dep/README.md` 构建依赖并把产物放到 `external-deps/<relpath>/index.js`；
3. 在插件里 `hostApi.invoke('read_external_dep_file', { relativePath })` 读取 → `new Function(code)()` 执行 → 从 `window.__EXT_<DEP>__` 取用。

详细步骤与模板入口见仓库 `templates/external-dep/`。

## 8. 不要做

- 不要 `import` 未在根 `node_modules`（hoisted）里、又未声明为 external-dep 的 npm 包——要么用宿主注入的，要么做成 external-dep。
- 不要用 `fetch` 直接联网——走 Rust 命令。
- 不要把重库打进插件包——放 external-deps。
- 不要硬编码绝对路径——用 `invoke` 拿到的路径或 `convertFileSrc`。

## 9. 打包为 .mufurong 专属格式（分发）

插件开发完成后，可打包为 `.mufurong` 专属格式分发。`.mufurong` 本质是 ZIP 改后缀，用户放到 `user_plugins/` 目录即可自动解压。

### 打包方式

```bash
# 方式 1：用项目提供的打包脚本（自动扫描 bundled-plugins/ 下所有插件）
node scripts/pack-mufurong.mjs

# 方式 2：手动打包单个插件（PowerShell）
# 先构建插件产物（dist/index.js + manifest.json），然后：
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  "bundled-plugins/my-plugin",           # 源目录（含 manifest.json + dist/）
  "my-plugin.mufurong",                  # 输出文件（.mufurong 后缀）
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)
```

### .mufurong 内部结构

```
my-plugin.mufurong (ZIP)
├── manifest.json    （插件清单，必须含 version 字段）
├── dist/
│   └── index.js     （Vite 构建产物）
└── [其他资源文件]    （如有）
```

### 用户安装方式

1. 把 `.mufurong` 文件放到应用数据目录的 `user_plugins/` 文件夹
   - Windows: `%APPDATA%\com.rosary.andengyuanhua\user_plugins\`
2. 应用启动时自动扫描并解压到同名目录
3. 版本匹配时跳过解压（速度极快），版本更新时自动重新解压

### 大型模块（母文件夹）

茑萝（niaoluo）、全局、阅读 等大型模块保留母文件夹结构：

```
user_plugins/
├── 茑萝/                    # 母文件夹（手动创建）
│   ├── ai.mufurong             # 子插件
│   ├── gongjuxiang.mufurong
│   └── ...
├── 全局/
│   ├── markitdown.mufurong
│   └── ...
└── image.mufurong              # 顶级插件直接放 user_plugins/ 根目录
```

### 制作模板（供其他人复用）

1. 复制 `plugins/_template/` 目录
2. 修改 `manifest.json`（id、name、version、iconName）
3. 编写 `src/index.tsx`
4. 运行 `pnpm exec vite build`（在插件目录下）
5. 把 `manifest.json` + `dist/` 打包成 `.mufurong`
6. 分发给用户，用户放到 `user_plugins/` 即可

