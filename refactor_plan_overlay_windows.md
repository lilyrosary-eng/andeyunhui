# 浮窗体系重构方案：统一 Overlay Window Manager

> 目标：把当前分散、不一致、抗 0x8007139F 脆弱的浮窗创建，重构为一套**统一、可重试、能自愈坏窗、带环境级自动修复**的专业稳定方案。
> 状态：**先给方案，未实现**。请审阅后决定是否开工。

## 一、现状诊断（为什么"还是不行"）

当前浮窗创建有 **两套并行的路径**，且三处关键能力严重不一致：

1. **创建主体不一致**：Rust `setup` 主线程预创建 4 个常驻透明窗（`lyrics-widget` / `recorder-widget` / `recorder-select` / `recording-border`）；前端 `new WebviewWindow` 动态创建 5+ 类按需浮窗（`screenshot-overlay` / `tray-menu` / `floating-clipboard` / `floating-dropzone` / `floating-note-{id}` / 插件沙箱窗）。两套心智模型并存。

2. **重试不一致**：只有 Rust `setup` 的 4 个窗套了 `create_transparent_with_retry`（4 次/300ms）；前端全部浮窗**零重试**，首启/清缓存后冷启动撞 GPU 合成面未就绪就直接失败。

3. **错误捕获不一致**：全代码库只有 `floating-note` 挂了 `tauri://error` 事件；截图/托盘/剪贴板/中转站/插件沙箱创建失败时**仅 `console.error` 静默**——用户感知就是"按了没反应"。

4. **坏窗残留（最致命）**：任何路径创建失败都**不销毁已注册窗**。当 `new WebviewWindow` 失败走 `tauri://error`（JS 对象已 resolve 但 WebView2 初始化失败），该 label 被半注册，下次 `getByLabel` 拿到的是坏窗，且无法重建。这正是"偶发、且越点越烂"的根因。

5. **死代码**：`screenshot.rs::create_overlay_window` 已弃用但仍在 `main.rs` 注册，存在被误调创建第二份 `screenshot-overlay` 的风险。

6. **参数不统一**：前端 `floating-note`/剪贴板/中转站未显式 `shadow:false`；DPI/缩放取法在 Rust 侧有 `min_monitor_scale`/`GetDpiForSystem`/`GetDpiForMonitor` 三种口径，前端又是另一套。

好消息：基线"抗 0x8007139F 写法"（透明窗用 `visible:true` + 离屏坐标 + `transparent` + `hide()`，绝不用 `visible:false`）已正确，重构**保留**它，只是把它收口到统一引擎。

## 二、重构目标

- 所有浮窗（常驻 + 按需）走**同一条**创建引擎，参数、重试、坏窗自愈、缩放口径完全一致。
- 创建失败**可识别、可重试、必清理坏窗**：杜绝坏窗残留与"按了没反应"。
- 消除"命令里建窗死锁"隐患，同时让前端动态窗也能继承 Rust 级重试。
- 环境级自动修复：检测到 WebView2 运行时大版本变化时，自动清掉 GPU/着色器合成缓存（直击你这次 0x8007139F 的真凶）。
- 删除死代码，收敛单例/去重逻辑到一个注册表。

## 三、目标架构：统一 WindowManager

新增 Rust 模块 `src-tauri/src/window_manager.rs`，作为**唯一**的浮窗创建入口；前端只通过一个 IPC 命令请求建窗，不再直接 `new WebviewWindow`。

```
前端 ensureOverlayWindow(label, url, profile)
        │  invoke('overlay_window_get_or_create', …)
        ▼
Rust overlay_window_get_or_create 命令
        │  app.run_on_main_thread(‖ { WindowManager::get_or_create(…) })
        ▼
WindowManager（managed state，含注册表 + 重试 + 坏窗检测 + 环境自修复）
        │  统一透明窗安全 profile（visible:true + 离屏 + transparent + shadow:false）
        ▼
成功 → 返回 label；失败 → 销毁坏窗 → 退避重试 → 仍失败返回明确错误码
        │
        ▼
前端用 WebviewWindow.getByLabel(label) 取句柄操作，并监听 tauri://error 兜底
```

`setup` 预创建常驻窗也改调 `WindowManager::get_or_create`（同一引擎），不再各自 `build` + 内联重试。

## 四、详细改动清单

### 4.1 新增 `src-tauri/src/window_manager.rs`
- `OverlayProfile` 配置结构体（统一所有安全参数）：`transparent:true`、`decorations:false`、`shadow:false`、`skip_taskbar`、`always_on_top`、`drag_drop_enabled`、`offscreen:bool`、`width/height`、`url`。预置常驻档（lyrics/recorder-*）与按需档（tray-menu/screenshot/floating-*）两套默认值。
- `WindowHealth` 枚举：`Creating | Healthy | Broken`。
- `WindowManager { registry: Mutex<HashMap<String, WindowHealth>> }`，用 `app.manage()` 托管。
- `get_or_create(app, label, profile) -> Result<WebviewWindow, WindowError>`：
  1. 加锁；若 `Healthy` 且句柄存在 → 直接返回。
  2. 若 `Broken`/残留 → 先 `destroy()` 清理，再从注册表移除。
  3. 用 `app.run_on_main_thread(...)` 把 `WebviewWindowBuilder` 的 `build()` marshal 到主线程（彻底消除命令建窗死锁/0x8007139F）。
  4. 套用统一 profile；创建后若 `offscreen` 则 `hide()`。
  5. **坏窗健康探测**：spawn 一个短延时（~300ms）后调用 `window.scale_factor()`，失败即判定 Broken → `destroy()`。
  6. **智能重试**：识别错误串含 `0x8007139F` / `failed to create webview` 视为瞬时故障，退避重试（150/300/600/1000ms，最多 5 次）；其余（URL 非法等）判致命，直接返回错误不重试。
  7. 每次失败先 `destroy()` 该 label 再重试，确保**无坏窗残留**。
- `destroy(app, label)`：从注册表与 `webview_windows` 彻底移除。
- `overlay_window_health(app) -> Vec<(label, health)>`：诊断命令（排 0x8007139F 时一眼看清哪个窗坏了）。
- `maybe_clear_gpu_cache_on_runtime_change(app)`：读注册表 WebView2 运行时版本（`HKLM\...\Clients\{F3017226-...}` pv），与 `app_data/runtime_version.txt` 比对；若变化则清 `EBWebView` 的 `GPUPersistentCache`/`GrShaderCache`/`ShaderCache`/`Default\GPUCache`/`Dawn*/`（**保留 cookie/localStorage**），并写回新版本。这一步就是把你这次手工清缓存变成**开机自动自愈**。

### 4.2 新增 Rust 命令（在 `main.rs` 注册）
- `overlay_window_get_or_create { label, url, profile, opts }` → 内部 `run_on_main_thread` + `WindowManager::get_or_create`。前端所有动态浮窗改调它。
- `overlay_window_destroy { label }`、`overlay_window_health` 如上。
- **删除**已弃用的 `screenshot.rs::create_overlay_window` 命令及其在 `main.rs` 的注册。

### 4.3 改造前端（统一入口）
新增 `src/core/overlayWindow.ts`：
- `async ensureOverlayWindow(label, url, profile): Promise<WebviewWindow>`：调 `invoke('overlay_window_get_or_create', …)` → 用 `getByLabel` 取句柄 → 挂 `tauri://error`（兜底日志+抛错）→ 返回。
- 把 `App.tsx` 的 `ensureScreenshotOverlay` / `openClipboardFloating` / `openDropzoneFloating` / `openTrayMenu`、 `api.ts::createFloatingNoteWindow`、 `pluginSandbox.ts::createFloatingWindow` 全部改为调 `ensureOverlayWindow`，删除各自散落的 `new WebviewWindow` + try/catch。
- 统一补 `shadow:false`、`dragDropEnabled:false`（仅中转站）、按需 `skipTaskbar`/`alwaysOnTop`，参数由 profile 决定而非各处手写。

### 4.4 改造 `setup`（Rust 主线程）
- 把 4 个常驻窗的 `create_transparent_with_retry(...)` 调用替换为 `WindowManager::get_or_create(...)`（同一引擎，移除 `main.rs` 里那段内联 `create_transparent_with_retry`）。
- 在 `setup` 早期调用 `maybe_clear_gpu_cache_on_runtime_change(app)`（仅需一次，不阻塞）。

### 4.5 统一缩放/DPI
- 把现有的三种 DPI 取法收敛为 `window_manager.rs` 里一个 `logical_to_physical(rect)` 助手；所有窗的定位（`set_position`/`reposition_and_show`）走它，Rust 与前端不再各写一套。

## 五、关键技术决策与依据

- **`run_on_main_thread`**：Tauri v2 `AppHandle::run_on_main_thread` 已确认存在。窗口必须在拥有事件循环的主线程创建；命令跑在 async 线程，直接 `build` 会 0x8007139F/死锁。marshal 到主线程后彻底规避，且让前端按需窗也能享受与 `setup` 相同的主线程安全创建 + 重试。
- **`additionalBrowserArgs` 是全局的**：它作用于整个 WebView2 环境，动态窗自动继承（无需逐窗设），所以"前端窗没继承 MediaSession 禁用"的担忧不成立；方案保留现有全局 args，不做逐窗拆分。
- **坏窗探测用 `scale_factor()` 而非依赖错误事件**：Rust 侧拿不到 JS 的 `tauri://error`，而坏窗最可靠的信号是"能 build 成功但取不到缩放比"。用延时探测兜底，杜绝"半注册坏窗"。
- **智能重试而非无脑重试**：区分瞬时（0x8007139F）与致命，避免把配置错误当成瞬时故障无限重试。

## 六、实施阶段（建议分两批，降低风险）

- **批次 A（核心，先上）**：`window_manager.rs` + 注册命令 + `setup` 改走引擎 + 环境自修复（GPU 缓存）+ 删死代码。这一步让常驻窗与"首启冷启动撞合成面"彻底稳定。
- **批次 B（收口前端）**：`overlayWindow.ts` 统一入口 + 改造 App.tsx/api.ts/pluginSandbox + 统一 shadow/dragDrop + 统一 DPI 助手。这一步消除所有"按了没反应"与坏窗残留。

## 七、验证标准

1. `cargo check` / `pnpm dev` 编译通过。
2. 删除 `EBWebView` GPU 缓存后冷启动 → 新 `session_*.log` 无 `0x8007139F`，4 个常驻窗正常预创建。
3. 逐个手测：Ctrl+Shift+S 截图 / Ctrl+Alt+C 剪贴板 / Ctrl+Alt+V 中转站 / 托盘右键菜单 / 音乐桌面歌词 / 录屏三窗 / 浮窗笔记 / 插件沙箱窗——每种都稳定弹出不抖动。
4. 反复开关同一浮窗 10 次，无坏窗残留（用 `overlay_window_health` 命令确认注册表干净）。
5. 模拟 WebView2 运行时版本变化（改 `runtime_version.txt`）→ 重启自动清缓存，无需手动。

## 八、风险与回滚

- `run_on_main_thread` 返回值需 `await` 后再回命令，否则命令可能在窗建好前返回（前端取到空句柄）。已在方案要求命令 `await` 该闭包。
- 若某窗 profile 配错（如常驻窗被误设 `offscreen:false`），表现是窗闪现。回滚即还原该 profile 默认档。
- 全部改动可 git 分两批提交；任一批出问题，单独 `git revert` 不影响另一批。
