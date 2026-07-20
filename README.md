<div align="center">

# 安得云荟 · andeyunhui

一个本地优先的轻量保险库，把你的阅读、图片、视频、音乐与笔记收纳进同一个私密空间——数据自主、离线可用、插件可热插拔。
React + Rust，基于 Tauri v2 构建。

[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-2021-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)](#系统要求)
[![Release](https://img.shields.io/github/v/release/lilyrosary-eng/andeyunhui?label=Release)](https://github.com/lilyrosary-eng/andeyunhui/releases)
[![Downloads](https://img.shields.io/github/downloads/lilyrosary-eng/andeyunhui/total)](https://github.com/lilyrosary-eng/andeyunhui/releases)

> 安装包下载徽章对应 GitHub Releases，发布后自动显示版本号与累计下载量。

</div>

---

> **官方发布页：[adyh.cc.cd](https://adyh.cc.cd)** —— 最新安装包、更新日志与下载均托管于此，建议从此处获取版本。

## 简介

「安得云荟」是一个把富文本笔记与一套可扩展插件生态融合在一起的桌面工作台。主程序提供笔记的创建、检索、标签、置顶、快照存档与备份，并通过一个 IIFE 沙箱插件系统把音乐、图片、视频、阅读、办公、专业工具等能力以「模块」的形式挂载进来。所有插件在运行时动态加载、支持热插拔，第三方插件亦可放入用户目录被自动识别。

除了笔记与插件，应用还内置了一套「全局能力」：微信式全局截图（多屏、点窗、长截图、标注）、屏幕录制、系统托盘常驻、悬浮歌词窗、跨模块拖拽的「中转站」，以及一个哥特风格的莲花描边启动动画。

> 主窗口标题为「安得云荟 · 笔记」，各插件均有花名代号（音乐=铃兰、图片=莲花、视频=玉兰、阅读=三色堇、专业=薄荷、办公/IDE/绘画=茑萝）。

## 功能特性

- 笔记核心：富文本编辑（TipTap）、全文搜索、标签管理、置顶、复制、快照存档与恢复、整库备份导出、浮窗笔记。
- 插件系统：`plugin://` 私有协议动态加载，IIFE 沙箱隔离，`window.__HOST_*` 能力注入，文件系统监听实现插件目录热插拔，支持内置插件与第三方用户插件并存（用户插件可覆盖内置）。
- 音乐 · 铃兰：本地音乐扫描与播放、元数据/歌词解析、可锁定的桌面悬浮歌词窗；并接管 Windows 任务栏「正在播放」媒体控件（显示名「安得云荟」、封面与「歌手 · 专辑」、回传系统媒体键）。
- 图片 · 莲花：图库扫描、缩略图生成与缓存。
- 视频 · 玉兰：视频库扫描与文件夹浏览。
- 阅读 · 三色堇：EPUB 等电子书解析阅读（`epub-parser` 抽取纯文本 + `ammonia` 消毒）。
- 办公 · 茑萝：文档（docx）、演示（pptx）、表格（xlsx / csv）的导入、编辑与导出；文档用 TipTap 编辑、演示用原生幻灯片编辑器、表格用自研轻量表格引擎（SheetJS 读写 xlsx）；含 CodeMirror IDE 与绘画子模块。
- 专业 · 薄荷：环境变量管理、端口扫描、进程列表、剪贴板读写、图片/文档格式转换、ffmpeg 媒体转码等工具集合。
- 格式转换 · markitdown：多格式转 Markdown 服务。
- 全局截图：默认 `Ctrl+Shift+S`，多显示器捕获、拖拽框选、悬停点窗、窗口长截图、画笔/矩形/箭头/文字标注，毫秒级保存（原生 RGBA 直通），可复制、存中转站或导入当前笔记。基于 WGC（Windows.Graphics.Capture）硬件加速捕获。
- 屏幕录制 · 全局：默认 `Ctrl+Alt+R`，区域选择、暂停/继续、ffmpeg 编码。
- 系统集成：单实例守卫、系统托盘（自定义 UI 菜单）、原生文件拖出（基于 Windows DoDragDrop）、跨模块「中转站」暂存区、会话日志系统、Windows 任务栏媒体集成（SMTC：自定义显示名「安得云荟」、封面、媒体键回传）。
- 扩展中心：内置扩展管理界面，浏览与管理已安装插件。

## 截图 / 演示

> 敬请期待

| 主界面 | 阅读 · 三色堇 |
| --- | --- |
| ![主界面](docs/screenshots/main.png) | ![阅读界面](docs/screenshots/reader.png) |

- 全局截图（Ctrl+Shift+S）：![截图演示](docs/screenshots/screenshot.gif)
- 插件热插拔：![热插拔](docs/screenshots/plugins.gif)
- 哥特风莲花启动动画（浅色）：![启动动画](docs/screenshots/boot-light.gif)
- 哥特风莲花启动动画（深色）：![启动动画](docs/screenshots/boot.gif)

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 18、TypeScript、Vite 7、Tailwind CSS、Radix UI、Zustand、TipTap、lucide-react、SheetJS（xlsx）、lightweight-charts |
| 后端 | Rust 2021、Tauri v2、mimalloc、rayon |
| 桌面能力 | global-shortcut、tray-icon、dialog、opener、notify（跨平台文件监听） |
| 媒体/解析 | lofty、image、epub-parser、ammonia、pulldown-cmark、zip + quick-xml（OOXML）、pdf-extract |
| 截图/录屏 | winapi（GDI/枚举窗口）、windows-capture（WGC）、arboard、ffmpeg |
| 打包 | NSIS（perMachine），随包分发 `bundled-plugins/` 与 `external-deps/` |

## 项目结构

```
andeyunhui/
├─ src/                     # 前端（React）
│  ├─ components/           # 通用 UI、标题栏、侧栏、截图覆盖层、中转站面板等
│  ├─ core/                 # 插件宿主 PluginHost、注册表、沙箱、设置、笔记、歌词
│  ├─ lib/                  # 工具库（含等待页生成产物）
│  └─ overlay-*.ts          # 截图/录屏独立轻量覆盖窗入口
├─ src-tauri/               # 后端（Rust / Tauri）
│  └─ src/
│     ├─ main.rs            # 应用入口、托盘、单实例、热键、插件协议、FS 监听
│     ├─ commands.rs        # Tauri command 汇总（笔记/插件/中转站/托盘/工具…）
│     ├─ screenshot.rs      # 截图捕获与覆盖窗
│     └─ services/          # 各模块服务（音乐/图片/视频/阅读/办公/录屏/日志…）
├─ plugins/                 # 插件源码（茑萝 宿主：办公等；莲花/铃兰/玉兰/三色堇/薄荷/鸢尾花…）
├─ external-deps/           # 重依赖预打包（esbuild IIFE，运行时按需注入）
├─ crates/                  # Rust 子 crate（pro-tools-kit 专业工具、gongfang-kit 攻防内核）
├─ scripts/                 # 构建脚本（external-deps、等待页、部署插件等）
├─ wait-page/               # 哥特风莲花描边启动/等待页
├─ landing-page/            # 对外营销落地页（静态 HTML / CSS / JS）
└─ docs/                    # 设计与诊断文档
```

## 系统要求

- Windows 10 / 11（当前构建绑定 Windows 原生能力：截图、录屏、原生拖出等）。
- 开发环境：Node.js >= 20、pnpm >= 9、Rust 稳定版工具链、Tauri v2 相关系统依赖（WebView2）。

> 跨平台（Linux / macOS）已有设计规划，尚未落地；详见项目内跨平台调研文档（本地设计笔记，不随仓库发布）。

## 快速开始

```bash
# 安装依赖（postinstall 会自动修复 node_modules symlink）
pnpm install

# 开发模式（predev 会构建 external-deps、生成等待页、部署插件）
pnpm tauri dev

# 构建安装包（NSIS）
# 注意：Windows 下建议使用项目自带的 build.bat 走 cmd，避免 pnpm.ps1 传参问题
build.bat
```

常用脚本：

```bash
pnpm dev          # 仅前端 Vite 开发服务器
pnpm build        # tsc + vite build
pnpm lint         # ESLint 检查
pnpm lint:fix     # ESLint 自动修复
```

## 插件系统概览

插件以目录形式存在，每个插件包含 `manifest.json`（声明 `id`、`name`、`kind`、`entry`、`iconName`、可选 `parent`/`deps`/`requiredAssets` 等）与打包后的 `index.js`。运行时前端通过 `plugin://<id>/<file>` 私有协议加载脚本，在 IIFE 沙箱中执行，宿主通过 `window.__HOST_REACT__`、`window.__HOST_UI__` 等注入共享运行时。重依赖（如 CodeMirror、TipTap）不进插件本体，而是走 `external-deps/` 预打包、运行时按需注入，以控制插件体积并复用宿主 React。

内置插件位于 `bundled-plugins/`（随包分发），第三方插件放入用户数据目录下的 `user_plugins/` 即被自动扫描；用户插件可覆盖同名内置插件。目录变更由后端文件监听实时感知并通知前端热插拔。

## 许可证

本仓库源代码以 [MIT License](./LICENSE) 授权。

依赖均为宽松许可证（如 `epub-parser`、`ammonia` 等均为 MIT），后端不再静态链接 GPL-3.0 依赖，分发二进制 / 安装包无 copyleft 传染义务。EPUB 解析选型与迁移说明见本地设计笔记。

## 贡献指南

欢迎参与贡献。开始前请先阅读本指南。

- **环境**：参见「快速开始」。请使用 `pnpm` 与 Rust 稳定工具链，Node >= 20。
- **分支**：从 `main` 切出功能分支（如 `feat/xxx`、`fix/xxx`），完成后再提 PR 回 `main`。
- **提交信息**：建议采用 Conventional Commits（`feat:`、`fix:`、`docs:`、`refactor:`、`chore:` 等）。
- **代码风格**：`pnpm lint:fix` 可自动修复 ESLint 问题；Rust 侧请保持 `cargo fmt` 一致。
- **插件开发**：新增插件请放在 `plugins/`，并通过 `manifest.json` 声明元数据；重依赖走 `external-deps/`，不要直接打进插件本体。
- **验证**：PR 请描述改动动机与验证方式（最好附截图 / GIF），确保 `pnpm build` 与 `build.bat` 均通过。
- **议题**：bug 与功能建议请开 Issue，并尽量附上复现步骤与系统版本（Windows 10 / 11）。

## 致谢

基于 [Tauri](https://tauri.app/) 生态构建，感谢所有相关开源项目的作者与维护者。
