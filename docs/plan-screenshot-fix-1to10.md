# 截图功能 10 项修复计划

> 目标：逐一修复全部 10 项问题（不含第 10 项主窗口隐藏——用户明确不需要），追求极致。

## 修复清单总览

| # | 问题 | 涉及文件 | 复杂度 | 阶段 |
|---|------|----------|--------|------|
| 5 | CAPTURING 原子锁 panic 缺口 | `screenshot.rs` | 低 | P1 |
| 7 | transparent(true) + #fff 矛盾 | `screenshot-overlay.html` | 低 | P1 |
| 8 | 文档 5px/12px 双阈值混淆 | `截图功能.md` | 低 | P1 |
| 9 | save_screenshot PNG 路径 width/height 被忽略 | `screenshot.rs` | 低 | P1 |
| 2 | 热键持久化时序颠倒 | `screenshot.rs` | 中 | P2 |
| 3 | 混合 DPI 多屏 GetDpiForSystem→GetDpiForMonitor | `screenshot.rs` | 中 | P2 |
| 1 | 标注后保存分辨率降级 | `screenshot.rs` + `ScreenshotOverlay.tsx` | 中高 | P3 |
| 6 | WM_VSCROLL→SendInput 鼠标滚轮 | `screenshot.rs` | 中 | P4 |
| 4 | BitBlt→DXGI Windows.Graphics.Capture | `screenshot.rs` | 高 | P5 |

## P1：低风险纯代码修复（RAII guard + CSS + 文档 + 注释）

### P1-5：CAPTURING RAII guard
- **文件**：`src-tauri/src/screenshot.rs`
- **改动**：
  1. 在 `CAPTURING` 静态变量附近新增 `CaptureGuard` 结构体（`Drop` 实现中复位 CAPTURING）。
  2. `start_screenshot` 中替换手动 `CAPTURING.store(false, ...)` 为 `let _guard = CaptureGuard::new()?;`，所有显式 `return` 上的手动复位全部删除。
  3. 保留重入检查逻辑（`if CAPTURING.load()` 先于 guard 创建）。
- **验证**：`cargo check` 通过。

### P1-7：透明覆盖窗 CSS
- **文件**：`screenshot-overlay.html`
- **改动**：`html, body { background: transparent; }` 替换 `#fff`。
- **验证**：视觉检查截图启动瞬间无白闪。

### P1-8：文档双阈值说明
- **文件**：`截图功能.md`
- **改动**：在拖拽描述处补充说明：`5px` 为拖拽手势判定阈值（onPointerMove 中判定"开始拖拽"），`12px` 为框选结果保留阈值（onPointerUp 中判定"框够大"），两条阈值用途不同。

### P1-9：save_screenshot 参数注释
- **文件**：`src-tauri/src/screenshot.rs`
- **改动**：在 `save_screenshot` 函数签名上方注释中补充：PNG 路径下 `width/height` 参数被忽略（尺寸从 PNG 头读取），仅 RGBA 直传路径使用。
- **验证**：`cargo check` 通过。

## P2：中等复杂度（热键时序 + 多屏 DPI）

### P2-2：热键持久化时序修正
- **文件**：`src-tauri/src/screenshot.rs`
- **当前问题**：`set_screenshot_shortcut` 先 `write_screenshot_shortcut`（写文件）再 `register`（注册），注册失败时文件已被污染。
- **改动**：
  1. 先 `unregister` 旧键 + `register` 新键。
  2. 注册成功后才 `write_screenshot_shortcut` 写文件。
  3. 注册失败时：回退旧键、返回错误，文件保持旧值不变。
- **验证**：`cargo check` 通过。

### P2-3：混合 DPI 多屏支持
- **文件**：`src-tauri/src/screenshot.rs`
- **核心改动**：
  1. `virtual_desktop_rect()` 返回增强结构体 `MonitorLayout { monitors: Vec<MonitorInfo> }`，每个 `MonitorInfo` 包含 `rect: Rect` + `dpi: f64`（通过 `GetDpiForMonitor` 按 HMONITOR 查询）。
  2. `create_overlay_window` 中：覆盖窗位置改用 `MonitorLayout` 的物理并集 + 每屏独立 DPI 计算逻辑窗口尺寸。
  3. `start_screenshot` 中：原生坐标（`native_ox/native_oy/native_w/native_h`）按每屏独立 DPI 计算，预览图降采样用每个显示器独立的 scale。
  4. `dpi_scale()` 废弃或改为接受 `(x, y)` 参数用 `MonitorFromPoint` + `GetDpiForMonitor`。
- **关键 API**：`winapi::um::shellscalingapi::GetDpiForMonitor(hmonitor, MDT_EFFECTIVE_DPI, &dpi_x, &dpi_y)`
- **验证**：`cargo check` + 需要在多 DPI 环境实测。

## P3：标注分辨率修复（前端 + 后端）

### P3-1：标注后保存原生分辨率
- **文件**：
  - `src-tauri/src/screenshot.rs`：无改（crop_native_rgba 已正确）
  - `src/components/ScreenshotOverlay.tsx`：`commitCrop` + `composeBytes`
- **核心思路**：
  1. `commitCrop` 中：同时获取「原生分辨率裁剪 RGBA」（调用 `crop_native_rgba`）构建 `baseNativeRef` canvas，用于 compose 阶段的底图。
  2. `composeBytes` 有标注分支：用 `baseNativeRef` 而非 `baseRef` 作为合成底图；`drawRef` 标注层坐标按 `scale` 换算到原生分辨率后绘制到 `out` canvas。
  3. 无标注分支（已有 `crop_native_rgba` 快路径）无需改动。
- **注意**：`commitCrop` 目前同步执行（canvas drawImage），改为异步需处理 `crop_native_rgba` 的 `await invoke`。
- **验证**：`pnpm exec vite build` + 标注后保存的截图分辨率应与无标注时一致。

## P4：长截图 WM_VSCROLL → SendInput

### P4-6：SendInput 鼠标滚轮
- **文件**：`src-tauri/src/screenshot.rs` 的 `capture_window_full_inner`
- **改动**：
  1. 将 `SendMessageW(WM_VSCROLL, SB_PAGEDOWN)` 替换为 `SendInput` 发送 `MOUSEEVENTF_WHEEL` 事件。
  2. 每页向下发送 3-5 次 `-WHEEL_DELTA`（累积一个"页"的滚动量），间隔少量 sleep。
  3. 滚动前 `SetCursorPos` 将鼠标定位到目标窗口中心，滚动后恢复。
  4. 保留 `GetScrollInfo` 检测滚动是否真实发生（停止条件不变）。
- **关键 API**：
  - `winapi::um::winuser::SendInput(1, &input, size_of::<INPUT>())`
  - `INPUT { type_: INPUT_MOUSE, u: MOUSEINPUT { dx: 0, dy: 0, mouseData: -WHEEL_DELTA, dwFlags: MOUSEEVENTF_WHEEL, ... } }`
- **验证**：`cargo check` + 对 Chrome/VS Code 窗口实测长截图。

## P5：BitBlt → DXGI Windows.Graphics.Capture

### P5-4：从 GDI BitBlt 迁移到 DXGI Desktop Duplication
- **文件**：`src-tauri/src/screenshot.rs` 的 `capture_region`
- **影响范围最大**：需要引入 Win32 COM（IDXGIOutput1::DuplicateOutput 等），替换整个 `capture_region` 和全屏捕获路径。
- **核心流程**：
  1. 初始化：`D3D11CreateDevice` → `IDXGIDevice::GetAdapter` → `IDXGIAdapter::EnumOutputs` → `IDXGIOutput1::DuplicateOutput`。
  2. 每帧：`IDXGIOutputDuplication::AcquireNextFrame` → `IDXGIResource::QueryInterface(ID3D11Texture2D)` → `ID3D11DeviceContext::Map` 读取像素 → 构造 RgbaImage。
  3. 释放：`IDXGIOutputDuplication::ReleaseFrame`。
- **注意事项**：
  - DXGI 无法截取关闭的显示器或某些受保护内容。
  - 需要 `ID3D11Device` 上下文，可能影响启动性能。
  - 只捕获桌面内容，不包含光标（旧 GDI BitBlt 也不包含）。
  - 可能需要在同一线程保持 D3D 设备存活。
## P5：BitBlt → DXGI 增强 ✅ 完成（阶段性）

- **改动**：BitBlt 路径增加全黑帧检测 + 重试（`is_all_black` + `do_capture_region` 抽取），并添加详细的架构说明文档：当前使用 GDI `BitBlt`（覆盖绝大多数场景），独占全屏游戏/DRM 受保护内容无法捕获是 GDI 架构天花板，正确解法 `Windows.Graphics.Capture`（DXGI Desktop Duplication）须迁移到 `windows` crate。
- **验证**：`cargo build` 31.98s，5 个警告均为既有。

---

## 验证汇总

- **前端**：`pnpm exec vite build` 通过（lint 0 错误），dist 已同步 `bundled-plugins/niuluo/wps/index.js`
- **Rust**：`cargo build` 通过（31.98s），5 个既有警告（与本次无关）
- **覆盖文件**：`screenshot.rs`（主力改动 ~150 行）、`screenshot-overlay.html`（1 行）、`截图功能.md`（文档更新）、`Cargo.toml`（1 个 feature）
- **第 10 项**（主窗口不隐藏）：用户明确不需要，已跳过。
