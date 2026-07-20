# 根治方案：单 WebView（主窗）+ React Portal 浮层架构

> 目标：彻底规避 0x8007139F（WebView2 运行时 150 回归——同进程第二个及以后控制器必失败）。
> 机制：进程内永远只有一个 WebView2 控制器（主窗）；所有浮窗改为在**主 webview 内部**用 `createPortal(..., document.body)` 渲染。
> 状态：**先给方案 + 待确认两个取舍，未实现**。
> 依据：git 对比 `fea8eb0`→`73e60d3` 代码零回归 + 运行时 150 安装时间线，坐实"运行时回归"而非机器/DWM 限制（见 MEMORY #15）。

## 〇、先澄清"会不会影响之前写好的那些"

**不影响（完全保留）的部分：**
- 所有业务逻辑、Rust 命令（`start_screenshot` / 录屏控制 / 歌词同步 / 插件沙箱 API / SMTC / 多显示器缩放坐标计算）。
- 截图实际捕获核心：Rust 用 WGC 直接抓显示器像素，从来不依赖独立 webview，只把 ox/oy/scale/windows 通过事件推给"人机交互层"。Portal 化只换交互层容器，**捕获逻辑一字不改**。
- 主应用 UI（笔记、插件、编辑器）、`PresentMode`（已用 `createPortal` + 元素级 `requestFullscreen`，是本次的现成先例）。

**会变（需重映射）的部分：**
- 9+ 个独立 webview 的"容器层"：每个浮窗的 HTML/React 内容需移植成主应用内的 Portal 组件。
- **两个原生能力必须重新实现**（见第三节），无法 DOM 1:1 等价。
- 小浮窗的空间行为（见第二节命门1）。

## 一、现状盘点（全部浮窗）

| 浮窗 | 当前形态 | 类 |
|------|----------|----|
| screenshot-overlay | 独立 HTML（`screenshot-overlay.html`），铺满虚拟桌面，物理像素 | 全屏覆盖型 |
| recorder-select | 独立 HTML，铺满虚拟桌面选区 | 全屏覆盖型 |
| recorder-widget | 独立 HTML，小控制台，`WDA_EXCLUDEFROMCAPTURE=0x11` | 全屏覆盖型 |
| recording-border | 透明边框，`SetWindowRgn` 画框镂空点击穿透 + `0x11` 排除捕获 | 全屏覆盖型 |
| lyrics-widget | `index.html?overlay=lyrics`，小窗 | 小浮窗型 |
| tray-menu | `index.html?overlay=tray-menu`，贴托盘 | 小浮窗型 |
| floating-clipboard | `index.html?floating=clipboard` | 小浮窗型 |
| floating-dropzone | `index.html?floating=dropzone`，拖入导入 | 小浮窗型 |
| floating-note-{id} | `index.html?note=...` | 小浮窗型 |
| 插件沙箱窗 | `new WebviewWindow`，IIFE 沙箱 | 小浮窗型 |

## 二、两个命门取舍（待用户拍板）

**命门1 — 小浮窗空间行为：**
`createPortal(..., document.body)` 渲染的浮层用 `position:fixed` 定位，相对**主窗视口**，无法超出主窗矩形到其它显示器/托盘旁。
- 现状这些小浮窗是独立 OS 窗，可出现在任意显示器、贴着系统托盘。
- Portal 化后将被**限制在主窗矩形内**（除非主窗本身变身全屏画布）。

**命门2 — 排除捕获（WDA_EXCLUDEFROMCAPTURE）：**
录屏控制台/边框用 `0x11` 避免被 WGC 录进视频。这是 HWND 级属性，**DOM 元素无法局部生效**。
- 单 webview 下只能对"主 webview 的 HWND"整体设排除。
- 替代：截屏/录屏时主 webview 整体设 `0x11`（Rust 现有 `set_exclude_from_capture` 可达主窗 HWND）。代价：录屏画面里看不到主应用窗口本身（通常更合理）。截图功能不受影响（Rust 后端直接抓真实桌面，覆盖层只是框选用 UI）。

## 三、原生能力替代方案

1. **点击穿透（recording-border 的 `SetWindowRgn` 画框镂空）**：
   DOM 方案 = 浮层容器 `pointer-events:none`，仅在边框线条/控制点上 `pointer-events:auto`。等价且更灵活，无需 HRGN。
2. **排除捕获**：如命门2，主 webview 整体设 `0x11`，覆盖层类浮层激活时统一设置，退出恢复。

## 四、多显示器适配（用户点名的复杂点，核心机制）

覆盖层（截图/录屏选区）需覆盖**所有显示器并集**（虚拟桌面矩形，含负坐标、多物理屏）。
- Rust 侧 `virtual_desktop_rect` / monitor 枚举 / physical 像素映射**已具备并复用**。
- 激活覆盖层时：主 webview `set_position(虚拟桌面原点)` + `set_size(虚拟桌面尺寸)` + `transparent:true` + 去 decorations + `always_on_top` + 整体 `0x11`（录屏时）。浮层 `position:fixed; inset:0` 铺满。
- 退出时恢复主窗原有 position/size/decorations/visibility。
- 坐标：Rust emit 的 `ox/oy/scale` 把显示器物理坐标映射到浮层 CSS 像素（与现 `screenshot-overlay` 一致）。

## 五、分阶段实施（建议）

- **阶段0（可选保险，零行为变化）**：`tauri.conf.json` 用 `fixedRuntime` 锁已知好版本随包发布。立刻让所有现有浮窗恢复可用，且验证根因。不影响后续 Portal 迁移。
- **阶段1（覆盖层类 Portal 化，A 类）**：screenshot-overlay / recorder-select / recording-border / recorder-widget 改主窗内 Portal + 主窗变身全屏画布。复用 PresentMode 的 `createPortal` 模式。这部分最常动态创建、最易被 0x8007139F 命中，优先级最高。
- **阶段2（小浮窗类 Portal 化，B 类）**：tray-menu / clipboard / dropzone / lyrics / floating-note / 插件沙箱改主应用内 Portal 组件（受命门1 取舍约束）。
- **阶段3（清理）**：删除独立 HTML（screenshot-overlay.html / recorder-*.html）、`window_manager.rs` 的建窗逻辑、前端 `new WebviewWindow` 散落调用，统一到 Portal 注册表。

## 六、风险与回滚

- 主窗变身全屏画布需保存/恢复主窗状态（position/size/decorations/visibility），处理不当会闪或丢失主窗布局 → 用 `enter/exit_overlay_canvas` 配对封装，失败回滚到原状态。
- B 类小浮窗 UX 折损（命门1）若用户不接受 → 该部分保留原生窗 + fixedRuntime 兜底（阶段0 已锁版本则无 0x8007139F）。
- 每阶段独立提交，可 `git revert` 单阶段。

## 七、工作量评估（纠正"简单迁移"）

- 不是简单迁移。真实工作量：A 类（覆盖层）中等（reuse PresentMode 模式 + 主窗 resize 逻辑）；B 类（小浮窗）中高（抽组件 + 空间行为决策）；两个原生能力重实现 + 多显示器主窗变身是**真正的技术难点**，与用户判断一致。
- 收益：彻底规避 0x8007139F（任何运行时版本都不会再触发）、去掉 9+ 个重复 React 实例、IPC/状态共享简化。
