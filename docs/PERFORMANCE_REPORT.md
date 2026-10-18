# 安得云荟 · 性能诊断报告

> 目标：定位「内存占用高 + 界面卡顿」的根因并给出可落地的优化路径。
> 报告基于对 `src/`（React 前端）、`src-tauri/`（Rust 后端）、`plugins/` 的静态审查。
> 仅诊断，不改动任何代码。

***

## 一、内存占用高：根因定位

### 1.1 独立浮窗 = 独立 WebView2 进程树（首要嫌疑）

一个 `WebView2Window` 就是一个独立的 `msedgewebview2.exe` 进程树，
单个即可占 **数百 MB 空闲内存**。本项目同时存在 截图 / 托盘菜单 / 剪贴板浮窗 /
中转站浮窗 / 浮窗笔记 / 歌词窗 / 桌宠 / 胶囊黄金棋盘 等十余类窗口。

- 好消息：`overlayWindow.ts` 已统一到 `ensureOverlayWindow`（复用优先 + `get_or_create`），
  `App.tsx#L128` 也把「启动即预热全部浮窗」改成了「首次使用懒建」，这已解决**最严重**的空闲内存问题
  （注释引用的 `research_report_memory_idle_audit.md` 显示此前空闲最高 3.9GB）。

- 残留问题：**窗口一旦创建就不会销毁**（`ensureOverlayWindow` 只复用、从不 destroy 空窗）。
  截过一次图 / 开过一次浮窗后，对应 WebView2 进程常驻到退出。按需懒建解决了「启动即高占用」，
  但**用过几次后占用仍会一路爬升、无法回落**。

### 1.2 后端重型模块未随窗口生命周期卸载

`recording_service.rs`（WGC 持续捕获 + ffmpeg 管道编码）是内存大户，但仅录屏期间存在、属预期。
需重点审计的是**长时间发呆也会占内存**的部分：

- OCR（onnxruntime-web / paddleocr）、AI 推理、ffmpeg、桌宠动效等，一旦加载就常驻内存不释放。

- 建议：确认这些模块只在**首次真实使用**时按需拉取（与 1.1 的懒建策略一致），并评估空闲降载。

### 1.3 前端 store 无限驻留、无 LRU/清理

- `notesStore.ts#L61-L168`：`notes` 全量列表 + `content` + `htmlContent` 全塞进 zustand。

  - 笔记越多，`notes` 数组越大；`htmlContent` 是渲染产物，缓存无上限。

  - 结论：**笔记模块是长期驻留的内存主要增量来源**，缺少「只保留当前/最近 N 篇正文，
    其余延迟按需加载」的分层缓存。

- 全局 `noteTagsMap`、`allSessions` 等派生数据也全部常驻。

### 1.4 无聚合内存观测

`DeskpetPet.tsx` 有 `MEM_POLL_MS` 内存轮询，说明项目已在关注但只有桌宠在看，缺少主窗级别的
统一内存监控与告警。

> 结论：内存高的主结构 = **多个常驻 WebView2 进程树** + **笔记内容全量驻留** + **重型模块懒加载策略不彻底**。
> 当前「启动即高」「空闲也高」已被缓解；剩下的是「用过就高、越用越高、不回落」。

***

## 二、卡顿 / 掉帧：根因定位

### 2.1 高频轮询（最直接的卡顿源）

`grep setInterval` 全仓检出 **十几处**,以下是高频且可能拉高 CPU 的:

| 位置                               | 频率       | 说明                                 |
| -------------------------------- | -------- | ---------------------------------- |
| `Capsule.tsx#L362`               | **每 2s** | 展开胶囊时轮询整机会话快照 `refreshSessionList` |
| `FileSearchPanel.tsx#L74`        | 每 1.5s   | 文件搜索状态轮询                           |
| `FloatingClipboardView.tsx#L100` | 每 2s     | 剪贴板浮窗轮询                            |
| `overlay-recorder.ts#L374`       | 每 1s     | 录屏状态轮询                             |
| `overlay-screenshot.ts#L185`     | 高频       | 截图覆盖窗轮询自愈                          |
| `capsule/icons.tsx#L155`         | 每 1s     | 时钟图标每秒刷新（本可仅界面对齐触发）                |
| `DeskpetPet.tsx`                 | 多处       | 桌宠多套 `setInterval` 常驻              |

其中 `Capsule` 每秒轮询是对后端 IPC 的持续压力，且每次 set 都会触发 `Capsule.tsx` 相关组件重渲染。
**这是「看着就卡、用久了更卡」的直接来源之一。**

### 2.2 高频事件 / 全局订阅导致整体重渲染

- `App.tsx#L31-L44` 在**顶层全局 store** 订阅了 `pluginRegistry / activeModule / visibilityTick` 等多状态，
  任一变化都可能触发 `App` 全树重渲染。

- `markdown.ts#L176`、`notesStore.scheduleMarkdownRender`：每次笔记内容变化都做全量 `marked.parse` +
  全量 `resolveLocalImagesInHtml`，大笔记下是明显同步阻塞点（虽有 rAF 去抖，但单次仍重）。

### 2.3 后端同步阻塞点

- `filesearch.rs#L216-L236`：索引线程与交互线程共享 `STATE.lock()`，虽已降优先级，但索引建库时
  锁竞争仍可能拖慢 `filesearch` 相关命令。

- 整体看：项目对「async 上下文里做同步 IO」的治理是到位的（`spawn_blocking` 使用一致），
  后端同步阻塞**不是**卡顿主因，重点在前端轮询与重渲染。

### 2.4 同步 JSON.parse / 大存储

- `core/storage/index.ts#L26-L29`：`JSON.parse` 在主线程同步解析存储值；若某 key 存了大对象
  （如 htmlContent 快照、会话列表），读取即主线程卡一下。

***

## 三、优化路径（按 ROI 排序）

### P0 · 立即可做、收益最大

1. **削减高频轮询**

   - `Capsule.tsx`：`refreshSessionList` 从 2s 改为「事件驱动」（后端 `session-changed` 推送）
     或拉长到 ≥10s 且仅在展开态。

   - `capsule/icons.tsx` 时钟：改为在分钟边界 tick，或改用 `requestAnimationFrame` 对齐一次。
2. **统一前端内存观测**：把桌宠的 `MEM_POLL` 提升为主窗级 `performance`/Rust 侧内存上报，
   低内存时**回收空窗**、释放 `htmlContent` 大对象，形成可验证的「占用回落」闭环。

### P1 · 结构性优化

1. **浮窗空闲回收**：`ensureOverlayWindow` 增加「长时间未显示的空窗自动 destroy」策略
   （如 30–60s 未显示的截图/托盘/中转站窗回收，下次用到再懒建）。
2. **笔记分层缓存**：`notesStore` 只保存当前笔记正文，其余笔记正文改为按需 `loadNoteContent`，
   限制 `htmlContent` 只缓存最近 N 篇；删超期缓存。
3. **`App.tsx`** **瘦身**：把浮窗管理、拖放导入、模块路由拆成独立 hook（`useFloatingWindows`/
   `useDragDrop`/`moduleRouter`），减少顶层的订阅与重渲染。

### P2 · 后端与运行时

1. 重型模块（OCR/AI/ffmpeg）建立**显式的加载/释放协议**，空闲时允许卸载。
2. 确认是否可开启 Tauri `WebviewWindow` 的 `shareProcess`/裁减浮窗 webview，降低每窗进程开销。

***

## 四、需要进一步（运行期）确认的测量项

以下仅静态审查无法量化，需结合真实运行 profile 决定优先级：

- 各 WebView2 进程在典型使用后（截图+浮窗+托盘各开一次）的实际驻留内存分布。

- `Capsule` 2s 轮询 + 天气 15min 轮询对 CPU 的实测占比。

- 打开一篇大笔记时，`marked.parse` 单次的真实耗时（是否 >16.7ms 造成掉帧）。

***

## 五、结论

- **注册时发现的最严重问题其实是磁盘满载**：`filesearch` 每次启动无条件全盘清空重建索引，
  表现为「磁盘活动 80%+、读 \~35MB/s、写 \~0.15MB/s、CPU 低」（典型随机小文件读，非本次卡顿警报）。
  已修复。

- **内存高**：主解决方向不是启动优化，而是**常驻窗口回收** + **笔记内容分层缓存** + **重型模块按需卸载**。
  让占用在「用过、不用」后有实际回落。

- **卡顿**：主解决方向是**消灭高频前端轮询**，其次降低全局重渲染与单次 markdown 重活。

- 后端 Rust 侧整体工程质量高，同步阻塞治理到位，**不是**主要卡顿源，优先级放后。

> 实际落地遵循「有明确收益、无副作用」原则（见下「六、执行状态」）。

***

## 六、执行状态（截至 2026-09-01）

### ✅ 已落地并提交（main 分支）

| Commit    | 改动                                                                           | 效果                                                         |
| --------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `3484021` | `filesearch`：仅**首次启动**全量建索引，非首启跳过全盘扫描、由既有 USN 增量 + notify 监听维护               | 修复每次启动磁盘 80%+ 满载                                           |
| `0640ef3` | 前端高频轮询降频：`Capsule` 会话对账 2s→15s；`FileSearchPanel` 状态轮询 1.5s→10s               | 减轻后台 IPC 空转；实时性由事件驱动（`smtc_update`/`indexProgress`）兜底，不降体验 |
| 待提交       | 笔记 Markdown 渲染缓存：`scheduleMarkdownRender` 对空行处理后的源码做缓存，源码未变跳过 `marked.parse` | 大笔记连续输入时避免每次按键全量重解析                                        |

### ⚖️ 审计后明确否决（如实记录，避免后续重复评估）

| 项                     | 原因                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| 浮窗空闲回收（自动 destroy 空窗） | `window_manager.rs` 是复杂自愈引擎（0x8007139F/坏窗/胶囊崩溃隔离）；自动销毁会引入新竞态，且现有 `ensureOverlayWindow` 已「复用优先」实现毫秒级显示 |
| 统一内存观测与自动降载           | 内存大头是外部 WebView2 进程（JS 无法回收）；自动降载有误删用户在用缓存（笔记/搜索）的风险                                                  |

### 🔍 审计结论：无隐藏时序泄漏

前端所有 `setInterval`/`setTimeout`/`listen` 均含 `return () => clearInterval/removeEventListener`，清理规范。
剪贴板 2s 轮询为功能必需，予以保留。

### ⏳ 待实机验证

- 重启安得云荟：确认磁盘不再持续满载、文件搜索与胶囊功能正常。

