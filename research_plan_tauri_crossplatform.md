# 跨平台（Linux / macOS）设计路线研究计划

## 用户问题
现有项目 andengyuanhua（岸灯鸢花）是 Tauri v2 桌面应用，目前仅面向 Windows 构建与运行。用户希望扩展到 Linux 与 macOS，需要一份**设计路线（roadmap）**：识别 Windows 专属依赖、给出跨平台架构与逐模块的迁移方案、打包/签名/CI 策略，以及分阶段实施路线图。

## 查询类型
混合：偏 Breadth-first（按子系统拆分独立研究流）+ Depth（跨平台架构决策需要多视角权衡）。默认 3 个研究子代理 + 微信文章检索。

## 已掌握的现状（自检）
- Cargo.toml：Windows 专属强依赖 `winapi`(截图 EnumWindows/PrintWindow) 与 `windows-capture`(WGC 屏幕捕获)；`drag`=2.1.1 基于 Windows DoDragDrop 实现文件拖出；`notify` 已对 macos_fsevent 开启、对 Linux inotify 自动选，文件监听本身跨平台良好。
- tauri.conf.json：`bundle.targets=["nsis"]`（仅 Windows），资源配置 `bundled-plugins` 与 `external-deps` 随包。
- 前端 WebView2 专属 hack：
  - `overlay-screenshot.ts` 打包版 WebView2 偶发丢 push 事件 → 轮询兜底
  - `bootPreview.ts` 自愈：WebView2 丢弃 srcdoc 内联 style/script
  - `api.ts` `run_on_main_thread` 同步 WebView2 build
  - `TransferStationPanel.tsx` 用原生系统拖拽绕过 WebView2 对 JS dataTransfer 拖出限制
  - wait-page `vw/vh` 在 WebView2 按设备逻辑宽度解析（#15）
- external-deps：需核查是否含原生绑定（如 ffmpeg/screen capture 直接调用）。

## 子任务划分
### 子代理 A：Tauri v2 跨平台通用知识与最佳实践（web + 文档为主）
- Tauri v2 各 OS 的 WebView 引擎：Windows WebView2(Edge)、macOS WKWebView(Safari)、Linux WebKitGTK（及 webkit2gtk 依赖、发行版包依赖、GPU/视频解码限制）。
- 跨平台构建：`tauri.conf.json` `bundle.targets`：Linux 的 `appimage`/`deb`/`rpm`/`app`，macOS 的 `app`/`dmg`/`app`(universal)。各格式适用场景。
- 条件编译：`#[cfg(target_os="...")]`、feature gating、capability 文件按平台、plugin 平台支持矩阵（tray/global-shortcut/opener/dialog 跨平台支持度）。
- 代码签名与公证：macOS 需 Apple Developer ID + notarization（tauri bundler 的 `macOS` 配置 `signingIdentity`/`hardenedRuntime`/`entitlements`），Linux 通常无需签名但 AppImage 需 fuse。
- 自动更新：tauri-plugin-updater 跨平台（GitHub Releases/self-host），Linux 因包格式差异支持度有限。
- CI：GitHub Actions 矩阵（ubuntu/macos/windows），Linux 需 apt 装 webkit2gtk-4.1、libsoup3、libjavascriptcoregtk 等。
- 已知坑：Wayland vs X11、Linux 屏幕捕获需 xdg-desktop-portal/PipeWire、macOS 沙盒与 ScreenCaptureKit 权限。

### 子代理 B：本项目 Windows 专属代码深度审计与迁移映射
- 详读 `src-tauri/src/screenshot.rs`、`recording_service.rs`：列出所有 Windows 专属 API（winapi / windows-capture / WGC / GDI / DwmGetWindowAttribute 等），标注功能点（窗口枚举、区域选择、长截图、录屏、音频捕获）。
- 检索全仓 `winapi`/`windows`/`windows-capture`/`DoDragDrop`/`drag` 调用点与数量。
- 审计 `external-deps/` 是否含原生绑定/硬编 Windows 路径（ffmpeg、screen capture、PDF/OCR），评估是否影响跨平台。
- 审计前端 4 处 WebView2 hack 在 WKWebView / WebKitGTK 下的等价问题与修复方向。
- 产出「模块 → Windows 现状 → Linux 方案 → macOS 方案 → 工作量」映射表。

### 微信文章检索（主线程用 wechat-article-search skill）
- 关键词：「Tauri 跨平台 Linux macOS 打包」「Tauri 屏幕录制 macOS ScreenCaptureKit」「Tauri 2 打包 dmg 公证 notarization」「Tauri Linux WebKitGTK 依赖」+ 时间近 2 年。
- 用途：补充中文社区实战经验与踩坑，与 web 文档交叉验证。

## 合成
- 将 A 的通用方案 + B 的迁移映射 + 微信/实战踩坑 → 形成分阶段路线图（M1 可编译可运行最小集 / M2 截图录屏跨平台后端 / M3 打包签名CI / M4 打磨与自动更新）。
- 输出含具体 crate 推荐（如 linux 屏捕 scraper/portal，macOS screen-capture-kit-rs）、配置片段、CI 矩阵、风险与限制。
