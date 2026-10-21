# 更新日志 / Changelog

> 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本（SemVer）。
> 本文件记录主要版本的演进。当前可构建版本为 2.4.0（Windows 桌面端，NSIS 安装包）；Android 端代码与桌面端同在 `main` 维护，仍是规划目标，尚未正式发布。稳定性与覆盖面仍在持续打磨，升级前请备份个人数据。
> **版本号唯一真源**：`src-tauri/tauri.conf.json` 的 `version`。`package.json` 与 `src-tauri/Cargo.toml` 的 `version` 必须同步为同一值（历史上后两者长期停留在 `0.1.0`，2026-10-18 已对齐到 2.4.0）。

## [Unreleased] - 工程化加固（未发布）

> 以下改动不改变用户可见功能，全部是「地基」类工作。每一条都实跑了质量门（`tsc` ×2 / `vitest` / `cargo check` / `cargo test` / `eslint`）。

### 新增
- **`codemode` 工具（模型写脚本循环调工具，复刻 pi-codemode）**：agent 需要连续调同一批工具时（批量读多个文件、换几种模式搜索、按列表逐个处理），模型可以给出**一段 JavaScript**，在进程内的 QuickJS 沙箱里跑完：`await tools.<名字>({...})` 调工具、`text()/return` 交出结果，**中间结果全部留在沙箱**，不进上下文。
  - 引擎：`src-tauri/src/services/ai_service/codemode.rs`（rquickjs 0.9，QuickJS 源码随 crate 编译，增量约 1.5MB）。VM 跑在独立线程（16MB 栈），工具调用以 Promise 挂起、由宿主按 id 回投，所以 `Promise.all` 是真并发。
  - 护栏：96MB 堆上限、2MB QuickJS 栈护栏（深递归变成可 catch 的 RangeError）、90s 墙钟（**等工具的时间不计入**，因为里面可能包含等用户点批准）、20 万字符输出上限、单个工具调用 10 分钟兜底；`while(true){}` 与 `while(true) await null` 都能被中断。
  - 安全边界：脚本只能调工具 + `text/console/exit`，没有 `fetch/require/setTimeout`；每个嵌套调用都走 `execute_tool_once`，**参数校验、审批 hook、写入即落盘、快照备份一条不少**；脚本里拿不到 `codemode` 自己（不套娃）。
  - 可读性：报错栈的行号还原到脚本自己的行（QuickJS 里 prelude 与脚本共用 `eval_script`，靠前置空行对齐后回算）；工具名拼错给「你是不是想用 X」（编辑距离 ≤2，能抓 `alpah`→`alpha`）。
  - 测试：13 项（含真跑 VM 的 6 项：调用链路、工具抛错可 catch、死循环中断、空等 promise 判卡住、拼错提示、行号还原）。
- **Rust 测试地基真的修好了（上一版是假修）**：`cargo test --lib` 的测试进程启动即 `0xc0000139`（`muda` 静态导入 `comctl32.dll!TaskDialogIndirect`，该导出只在 Common-Controls v6 side-by-side 程序集里）。上一版用 `cargo:rustc-link-arg-tests` 注入清单，**本机 cargo 1.96 直接报 `error: invalid instruction`，那条指令从没生效**；改用全目标 `rustc-link-arg` 又会让 app 二进制撞 `duplicate resource: type MANIFEST`（tauri-build 已内嵌一份）。
  - 现方案：新增 `test-manifest` feature 门控，只在开 feature 时注入；测试统一走 `pnpm test:rust`（= `cargo test --lib --features test-manifest`），`ci.yml` 同步。**339 项全绿**；不带 feature 时 `cargo build --bin` 完全不受影响。
- **CI**：`.github/workflows/ci.yml`——前端 job（`tsc --noEmit` + `tsc -p tsconfig.plugins.json` + `vitest`）与 Rust job（`cargo check` + `clippy --all-targets` + `cargo test`，`windows-latest`，因 windows-sys / WinRT / NVML 仅 Windows 可编译），push/PR 到 `main` 触发。此前仓库只有一条落地页部署 workflow，质量门全靠人肉。
- **`src/core/clock.ts`**：把「今天是第几天」收敛成模块级缓存 + 跨天定时刷新，替掉 4 处渲染期 `Date.now()`（React 渲染期 impure）。

### 修复
- **插件类型检查长期不可见**：`tsconfig.plugins.json` 原本只纳入攻防插件，其余插件（ai-chat / web-interface / rag / wps / 莲花 / 薄荷 …）共 16 处类型错误无人发现。已扩为 `plugins/**` 全量纳入并逐个清零。
  - 其中 `plugins/ai-chat` 的伴侣人设注入是**静默失效的真 bug**：`personaPrompt` / `systemPrompt` / `excludeGlobalPersona` 在 `useAiChat` 里从来是 hook 级 options，插件却按 per-send 参数传，导致人设完全没生效、消息对象还被塞了个假的 `images` 字段。修法是在 `send()` 上加第 4 个可选参 `SendOptions`（不改第 2 参语义，既有调用方零影响）。
  - `plugins/web-interface/src/Terminal.tsx`：`/// <reference path>` 多写了一级目录；`fb` 声明在 async IIFE 内而 cleanup 在外层引用，清理逻辑根本看不到它。
- **安装包每个都多带 76MB**：`scripts/lib/zip.mjs` 的 `zipDir` Windows 分支用 `ZipFile.CreateFromDirectory`，**完全忽略 `exclude` 参数**；`scripts/pack-mujin.mjs` 的 `PLATFORM_EXCLUDE` 又是单向的（Windows 侧为空数组）。两者叠加导致 Linux 版 ffmpeg 静态二进制被打进每个 Windows 安装包。已改为双向过滤 + 临时副本方案，`全局/ffmpeg.mujin` 302MB → 79MB。
- **13 条命令被静默拦截**：`ai_agent_approve` / `ai_agent_apply_edits` / `mcp_save_server` / `mcp_remove_server` / `wps_export_docx` / `wps_export_pptx` / `cleanup_thumbnail_cache` / `get_lyrics_widget_visible` / `music_create_playlist` / `music_get_all_mv_paths` / `music_set_mv_path` / `music_set_cover_url` / `read_external_dep_path` 被插件真实调用却从未进入沙箱白名单（白名单 236 → 249 条）。
- **`git add -u` 会炸干净 clone**：`commands.rs` 拆出的 15 个子模块与 `ci.yml` 一直没入库，而 `commands.rs` 本身已跟踪且被改成 95 行 re-export 文件。任何全量暂存都会只提交这 95 行，干净 clone 后 `cargo check` 直接 `file not found for module`，而本地有文件所以一直不报错。已暂存。
- **`.gitignore` 的 `*.mjs` 地雷**：所有新建 `.mjs` 脚本被静默忽略，`scripts/lib/zip.mjs` 因此漏出仓库，而 `scripts/pack-mujin.mjs` 等 3 个已跟踪脚本 import 它——干净 clone 后打包脚本直接 `MODULE_NOT_FOUND`。已改为只忽略 `scripts/_*`。
- **`scripts/prepare-bundled-dlc.mjs` 注释与实际不符**：注释写「essentials_build 或 full_build」，实测 `avcodec-62.dll` 92.9MB 说明取的是 full_build。换 essentials 预计再省 60–100MB，待实测。

### 重构
- **`commands.rs` 4638 行 → 95 行**：拆成 `src-tauri/src/commands/` 下 15 个领域模块（bootstrap 803 / plugins 775 / dropzone 707 / download 505 / notes 368 / storage_misc 217 / music 216 / wps 201 / transfer 297 / fs_dialog 136 / images 125 / install 156 / video_reading 89 / rag_commands 96 / archive 56 / dev 53）。`cargo test` 322 passed 不变。
- **`eslint src` 42 errors → 0**：重灾区是 `react-hooks/refs`（33 条「渲染期同步 ref 镜像」）。统一改成 `useEffect` 同步；撤销/重做栈与 ScreenshotOverlay 的画布引用改为 state；`useResourceUsage` 的 `hist` 从 ref 改为 state 持有的恒定对象；`useAiChat` 的 `groupSend` 去掉 `useCallback`（本项目未启用 React Compiler，手写 memo 保留不住）。
- **Rust warning 全清**：`cargo check` 13 条 + `--all-targets` 16 条。每条都判过「删」还是「留」——例如 `gpu_nv12.rs` 的 8 个 ID3D11 句柄字段看着没人读，但它们是 COM 接口、Drop 即 Release，删了 shader/纹理会被销毁而 nv12 缓冲区仍在用同一份 GPU 资源；`reverse/protocol.rs` 的 `is_closed` 是 Angluin L* 闭合判据，只因没有驱动循环才没调用方。这类都保留并写清「为什么不能删」。
- **manifest 声明式权限**：新增 `permissions.commands` 段，规则为「声明 ∩ 全局白名单」，清单不能比全局白名单更宽；未声明则回退全局白名单。15 个插件已填。宿主 alias 型插件（ai-chat）绕过沙箱直连，已用 `HOST_ALIASED_PLUGINS` 明确标注不参与告警。
- **i18n 补齐**：en-US +132 keys，zh-TW / ja-JP / ko-KR / de-DE / fr-FR 各 +195 keys，6 语言均对齐 zh-CN 的 1381 keys。`src/lib/i18n/locales.test.ts` 提供三道断言（不许多出 zh-CN 没有的 key / 新缺失必须落在基线内 / 缺失总数只许收敛）。
- **`frameworks.tsx` 4632 行 → 10 行壳**（全项目最大文件）：拆出 `frameworksShared.tsx` 563 行 + 五个面板（crawler 498 / reverse 779 / pentest 1145 / automation 771 / gateway 874）。切点踩过一个坑：`crawlerMeta` 与 `StatusCard` 原本落在爬虫段内却被渗透/网关两个面板引用，只能上移到 shared 段。
- **`ai_tools.rs` 5245 行 → 856 行父模块 + 10 个子模块**（core / basic / plan / fs_shell / search_web / subagent / devtools / media_gen / vision / comfyui）。`SafeEval` 定义在 fs_shell 却被 basic 用，整段搬到 basic；`SubWorker` 的 8 个字段提权到 `pub(crate)` 供父模块测试访问。
- **`noUnusedLocals` / `noUnusedParameters` 打开并全量清零**（src 41 处 + plugins 全量）。其中 4 处不是死代码而是真 bug：
  - `src/App.tsx` 的 `activeReloadKey`：setter 在 `plugin-registered` 事件里被调，value 从未被读，「插件热重载强制重挂组件」一直是静默空转。改为按插件 id 计数的 `reloadKeys`（全局计数会让每次切模块都重挂、把已保活模块的状态全丢）。
  - `src/core/ai/useAiChat.ts` 的 `CHAT_HISTORY_LIMIT = 40`：从未被使用，注释承诺的「条数上限」没生效，只有字符级硬切在跑（`HARD_MSG_CAP` / `HARD_TOTAL_CAP`）。
  - `src/overlay-recorder.ts` 的 `stopPolling()`：从未被调用，1s 状态轮询永不停。改为跟随录制 started/stopped 事件启停。
  - `src/core/settings/models/ComfyuiPanel.tsx` 的 `blueprintSlug`：只写不读，真实读取方全走 storage，是双状态源。
- **`capabilities` 死字段移除**：manifest 有这个字段、Rust 与 TS 也解析它，但全仓库没有任何读取方，只有 gongfang 声明了 `["network","process-spawn"]`——自述标签会给人「已生效」的错觉。已从结构体、类型与两份 manifest 中一并删除（serde 默认忽略未知键，旧清单不会解析失败）。

### 有意不做（记录决策，避免反复提起）
- `main.rs` 2135 行不拆：内含 428 个命令的 invoke_handler 注册表，拆它收益低风险高。
- `src-tauri/src/screenshot.rs` 3228 行不拆：Win32 捕获 + GDI/DXGI 双路径的单一职责单元，拆开只会把 `unsafe` FFI 句柄生命周期打散。
- 17 份插件 `vite.config.ts` 不收敛：经核实全部已是 2 行壳，真配置集中在 `plugins/_shared/vite.shared.config.ts`。
- `avcodec-62.dll` 92.9MB（full_build → essentials 可再省 60–100MB）不换：属二进制资产替换，需重跑录制/转码全链路验证。
- 版本号统一为 `tauri.conf.json` 的 2.4.0 单一真源，另两处已对齐。

### 文档
- `README.md`「截图 / 演示」节：原文引用 `docs/screenshots/*.png|gif` 五张图，但 `docs/` 整目录被 `.gitignore`，GitHub 上全是裂图。已改为诚实说明 + 约定路径表格，并放行 `docs/screenshots/**`。
- `README.md` / `CHANGELOG.md`：订正 Android 分支说法——`feat/android-v1` 分支在本地与远程均不存在，移动端代码一直与桌面端同在 `main` 维护。
- `ROADMAP.md`：上一版冻结于 2026-07-09，与实际进度严重脱节，已按 2026-10-18 实测重写；同时从 `.gitignore` 放行（路线图不进库等于没有）。
- `docs/PERFORMANCE_REPORT.md` 从 `.gitignore` 放行（`docs/*` 仍忽略，只放行这一个文件）。

## [2.4.0] - 当前构建版本（Windows 桌面端）

> 对应安装包：`安得云荟_2.4.0_x64-setup.exe`（产品版本 2.4.0）。

### 新增
- Web 接口模块（WebInterface）：本地 Web 服务，将本地软件 / 文件夹智能识别为可访问接口（识别软件名与入口端口），提供预设管理、PTY 终端与 iframe 预览，可在浏览器访问与调试本地运行的网页服务。
- AI 办公工作台：AIWork 为独立 AIGC 工作台（独立对话实例 + 独立产物库，产物落盘 / 分类展示 / 收藏 / 待决，与笔记解耦）；AIWorkflow 提供对话式蓝图——任务侧栏 + 节点连线画布（拖拽 / 选中、增改删连线、按任务生成蓝图、逐节点执行 + 日志 + 持久化），后端统一编排命令聚合上下文、持久化蓝图与执行日志。
- AI 聊天增强：子模块切换入口、文本与二进制附件发送、思考按钮与冷启动同步优化。

### 修复
- 阅读 · 三色堇：横板 / 双栏首测页码偏多（阅读字体与章节内图片异步加载导致 `scrollWidth` 偏大），新增字体就绪（`document.fonts.ready`）与内容图片加载完成后的自动重测，并把阅读位置钳制在当前章节内，无需切换模式即可获得正确页码。

## [2.1.0-alpha.1] - 待发布（草稿）

> 对应安装包：`安得云荟_2.1.0_x64-setup.exe`（产品版本 2.1.0，GitHub Release 标签为 `v2.1.0-alpha.1`）。
> 完整发布说明见 `docs/release-v2.1.0-draft.md`。

### 新增
- 本地优先的轻量保险库定位：阅读 / 图片 / 视频 / 音乐 / 笔记 五模态聚合，数据自主、离线可用、插件可热插拔。
- 笔记核心：富文本编辑（TipTap）、全文搜索、标签、置顶、快照存档与恢复、整库备份导出、浮窗笔记。
- 插件系统：`plugin://` 私有协议动态加载，IIFE 沙箱隔离，运行时热插拔；内置与第三方用户插件并存（用户插件可覆盖内置）。
- 音乐 · 铃兰：本地音乐扫描与播放、元数据/歌词解析、可锁定桌面悬浮歌词窗。
- 图片 · 莲花 / 视频 · 玉兰 / 阅读 · 三色堇 / 办公 · 茑萝 / 专业 · 薄荷 等内置模块。
- 全局截图与屏幕录制（Windows 原生能力）。
- 系统集成：单实例守卫、系统托盘、跨模块「中转站」、会话日志。

### 已知问题
- 当前发布仅覆盖 Windows 10 / 11；Linux / macOS 仍在规划中。
- 首个公开版本，可能存在未穷尽的问题；升级前请备份个人数据。

## 说明
- 本仓库源代码以 MIT License 授权。
- 安装包通过 GitHub Releases 分发（NSIS，perMachine 安装）。
