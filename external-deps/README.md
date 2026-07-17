# 外部依赖 (External Dependencies)

本目录用于集中管理项目中需要引用的**外部重量级依赖/现成方案**，
与项目自身的 `plugins/`（前端插件）和 `src-tauri/`（Rust 后端）分开存放。

## 设计目标

- **解耦管理**：将第三方项目/工具从主项目目录中隔离，方便独立更新和版本控制
- **统一入口**：外部依赖统一在此目录下按名称分文件夹存放
- **复用方便**：后续引入其他现成方案（如 OCR 引擎、AI 模型服务、格式转换等）直接在此目录新增子文件夹即可

## 目录结构

```
external-deps/
├── README.md           # 本文件
├── _build/             # 外部依赖的「构建入口」源（如 codemirror-entry.js），由 scripts/build-external-deps.mjs 打成 IIFE
├── codemirror/         # CodeMirror 6 — IDE 插件的专业编辑器内核（IIFE，按需加载，不进插件包）
│   └── index.js
└── <future-deps>/       # 未来引入的外部依赖...
```

## 已集成依赖

## 添加新依赖

**JS / 前端重库（推荐走构建链路）**：需要 CodeMirror / TipTap 这类重库时，不要直接丢文件，而是用构建脚本打成 IIFE 按需加载。完整步骤与模板入口见 **`templates/external-dep/`**（复制 `templates/external-dep/entry.js` → `external-deps/_build/<dep>-entry.js`，在 `scripts/build-external-deps.mjs` 的 `TARGETS` 登记，跑 `node scripts/build-external-deps.mjs`）。这样重库不进插件包、可被多个插件复用、仅在用到时加载。

**其它第三方项目 / 工具（直接放置）**：

1. 在 `external-deps/` 下新建子文件夹，命名与依赖项目一致
2. 将第三方项目文件放入该子文件夹
3. 在本 README 的"已集成依赖"表中添加条目
4. 如需从代码引用路径，建议通过环境变量或配置而非硬编码

## 用户侧依赖安装（运行时）

应用启动后从 `bundled-dlc/` 复制 `.mujin` 到 `user_external_deps/` 自动解压，无需用户干预。
用户也可手动安装依赖（两种方式皆可识别）：

1. **`.mujin` 私有格式**：把 `.mujin` 文件放到 `user_external_deps/` 对应母文件夹下
   - 例：`user_external_deps/niaoluo/ide/codemirror.mujin`
   - 应用启动时自动解压，源文件 mtime 匹配则跳过（速度极快）
2. **源文件目录（直接放置）**：把解压后的依赖原始目录放到 `user_external_deps/` 对应位置
   - 例：`user_external_deps/niaoluo/ide/codemirror/index.js`
   - 应用直接识别目录，不解压也不覆盖
   - 适合从 GitHub 直接下载源码使用的场景
   - 若已存在 `.mujin` 解压产物（含 `.mujin.extracted` marker），新版 `.mujin` 会覆盖旧解压；
     若目录是用户手动放置（无 marker），`.mujin` 解压会自动跳过，保护用户源文件

> 路径优先级：`user_external_deps/`（用户安装，优先）> `bundled-dlc/` 解压产物（次之）

## 已集成依赖（JS / 前端）

### codemirror（CodeMirror 6）

- **用途**：IDE 子插件的专业代码编辑器内核（多语言语法高亮、行号、主题、查找/替换）。
- **设计**：作为「重依赖」单独打包为 IIFE（`external-deps/codemirror/index.js`），**不打包进插件本体**，运行时由 IDE 插件经 Rust 命令 `read_external_dep_file({ relativePath: 'codemirror/index.js' })` 读取，再以 `new Function(code)()` 在全局作用域执行，挂载到 `window.__EXT_CM__`（与插件沙箱加载同源机制）。这样前端插件包保持极轻，CodeMirror 仅在打开 IDE 时按需加载。
- **构建**：`node scripts/build-external-deps.mjs`（基于 esbuild）。入口源在 `external-deps/_build/codemirror-entry.js`，npm 依赖声明在根 `package.json` 的 devDependencies（`codemirror` 及 `@codemirror/*`，含 `@codemirror/search` 提供查找/替换面板）。
- **读取路径（重要）**：`read_external_dep_file`（src-tauri/src/commands.rs）按序尝试 ① `app_data/external-deps`（dev 期由 `scripts/deploy-plugins.mjs` 同步而来）与 ② `resource_dir()/external-deps`（打包资源，兜底）。注意 Windows 下 `canonicalize()` 会加 `\\?\` 前缀，故 root 也一并规范化再比较，否则会被误判"越界"拒绝。加载失败时不降级，IDE 直接显示错误面板与构建命令。
- **被引用位置**：`plugins/niuluo/ide/src/index.tsx`。

### tiptap（TipTap 2）

- **用途**：茑萝「文档编辑器」子插件（wps）的富文本编辑内核（标题/列表/引用/代码块/图片/链接/占位符 + A4 分页与打印）。
- **设计**：作为「重依赖」单独打包为 IIFE（`external-deps/tiptap/index.js`，约 326KB），**不打包进插件本体**；运行时由 wps 插件经 Rust 命令 `read_external_dep_file({ relativePath: 'tiptap/index.js' })` 读取，再以 `new Function(code)()` 在全局作用域执行，挂载到 `window.__EXT_TIPTAP__`（与插件沙箱加载同源机制）。这样前端插件包保持极轻（wps 本体仅 ~13KB），TipTap 仅在打开文档编辑器时按需加载，且多个插件可复用同一份。
- **react / react-dom 处理**：`scripts/build-external-deps.mjs` 通过 esbuild 插件把 `react` / `react-dom` 外部化到宿主全局 `__HOST_REACT__` / `__HOST_REACT_DOM__`，与插件沙箱共享同一 React 实例，确保 `@tiptap/react` 的 `useEditor` / `EditorContent` 等 hooks 正常工作；`react/jsx-runtime` 则随包体打包并回退宿主 react。
- **构建**：`node scripts/build-external-deps.mjs`（基于 esbuild）。入口源在 `external-deps/_build/tiptap-entry.js`，依赖声明在根 `package.json` 的 dependencies（`@tiptap/*`）。该脚本已接入 `pnpm predev`，每次启动开发自动重新生成。
- **已挂载到 `window.__EXT_TIPTAP__` 的成员**：`Editor` / `EditorContent` / `useEditor` / `StarterKit` / `Image` / `Link` / `Placeholder` / `Table` / `TableRow` / `TableHeader` / `TableCell` / `TextAlign` / `Underline`。
- **表格扩展注意（易踩坑）**：`@tiptap/extension-table` 在 2.x 的 `Table` 节点 `content: 'tableRow+'`，但**不会**自带 `tableRow` / `tableCell` / `tableHeader` 节点类型，必须**同时**注册 `@tiptap/extension-table-row` / `-header` / `-cell` 三个独立包（否则建表报 `No node type or group 'tableRow' found`）。本项目已将这三个包加进根 `package.json` 并在 `tiptap-entry.js` 一并打包导出，wps 编辑器 `extensions` 中也显式注册了 `TableRow` / `TableHeader` / `TableCell`。TipTap 各子包版本号独立，`@tiptap/extension-table` 解析到的 2.x 最高线可能与 `react`/`starter-kit` 的 `2.27.x` 不同（pnpm 目录名可能显示 `2.2`），但实际安装版本以各包 `package.json` 为准；务必保证 table 与 row/header/cell 三者大版本一致。
- **被引用位置**：`plugins/niuluo/wps/src/WpsEditor.tsx`。
