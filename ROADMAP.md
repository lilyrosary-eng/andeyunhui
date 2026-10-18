# 安得云荟（andeyunhui）路线图

> 版本：2026-10-18 重校（上一版冻结于 2026-07-09，已与实际进度严重脱节）
> 原则：本体极轻 + 一切插件化 + 先补地基再做花样 + 每一步可独立验证可回滚
>
> **本文件由 .gitignore 放行后首次重写**：旧版的「当前状态快照」停留在 7 月初，
> 而项目已推进到 v2.4.0（19 个插件、249 条沙箱命令白名单、428 个 Rust 命令）。
> 重写规则：只写有代码/测试证据的状态，拿不准的标「待确认」，不虚构进度。

## 一、当前状态快照（2026-10-18）

- 架构：Tauri v2 + React 18 轻本体 + 前端插件沙箱（双根扫描 `extensions` + `user_plugins`，运行时热插拔）
- 规模：`src/` 231 文件 5.3 万行、`src-tauri/src` 109 文件 5.5 万行、`plugins/` 157 文件 2.8 MB、`crates/` 5.6 万行中的 1.6 万行（攻防内核 gongfang-kit）
- 质量门（本轮全部实跑通过）：`tsc --noEmit` EXIT 0、`tsc -p tsconfig.plugins.json --noEmit` EXIT 0、`vitest` 31 文件 423 passed | 1 skipped、`cargo check` **0 warning**、`cargo test` 322 passed、`eslint src` **0 errors** / 124 warnings
- CI：`.github/workflows/ci.yml`（2026-10-18 新增）——前端 typecheck×2 + vitest，Rust check + clippy + test（windows-latest，因 windows-sys/WinRT/NVML 仅 Windows 可编译）
- 插件权限：manifest `permissions.commands` 声明式权限已落地（15 个插件已填），沙箱按「声明 ∩ 全局白名单」强制
- 插件类型检查：`tsconfig.plugins.json` 已从「只收攻防插件」扩为 `plugins/**` 全量纳入，历史 16 处类型错误逐个收敛清零（含 ai-chat 伴侣人设注入静默失效这类真 bug）
- 已知技术债：`eslint` 124 条 warning（react-hooks/immutability 为主，规则已降级为 warn）；`src/core/pluginSandbox.ts` 单文件 846 行；`ai_tools.rs` 5049 行 / `main.rs` 2039 行；i18n 已补齐 6 语言 1381 keys

## 二、设计原则（不变）

1. 本体永远极轻，重依赖一律走 external-deps 按需加载
2. 一切可插件化：新增能力 = 放文件夹 + 跑脚本（热插拔已落地，免重启已实现）
3. 不引入会锁死架构的方向性依赖
4. 每一项改动独立可验证、可回滚，不堆砌半成品
5. 先补地基（技术债），再做花样（功能）

## 三、阶段清单（按实际进度重排）

### Phase 0 — 技术债清零（地基）✅ 已完成

- [x] 运行时热插拔（`reload_plugin`/`unload_plugin` + 前端事件 + `ExtensionManagerPanel` 热重载按钮）
- [x] 用户态插件持久化（双根扫描，`user_plugins` 优先，不被版本更新清空）
- [x] 插件清单 schema 强化（`deps` / `min_app_version` / `required_assets` / `capabilities` / `permissions`）
- [x] 沙箱命令白名单审计与补漏（236 → 249 条；13 条"被调用却从未进白名单"的命令已补，详见 `src/core/pluginSandbox.ts` 注释）
- [x] `__TAURI__` / `parent` / `top` 等 window 别名遮蔽（2026-10-18，防遮蔽被 alias 绕开）

### Phase 1 — 统一体验与设计系统（大部分完成）

- [x] 设计令牌（2026-07-09 落地，`index.css` 顶部有消费约定）
- [x] 设置中心（`src/core/settings/**`：主题/字体/模型/AI 配置/个人资料，均有编解码测试）
- [x] 统一图标规范（全面改用 lucide-react，manifest 用 `iconName` 声明）
- [~] 通用组件库：`src/components/ui` 仅 4 个基础件（context-menu/inline-select/slider/switch），大量 UI 仍是 `components/bricks` 定制件 —— **未形成统一基线**
- [ ] **全局命令面板（Ctrl/Cmd+K）**：全仓无实现，仍是空白项
- [ ] 组件库收敛：把 bricks 里高频复用的 10~15 个件沉淀成 ui/ 正式组件并补测试

### Phase 2 — 插件能力深化

IDE（`plugins/茑萝/ide`，32 条命令）：
- [x] Git 基础操作（`git_status/diff/stage/unstage/commit/log`）
- [x] 真 PTY 终端（`pty_create/write/resize/kill` + xterm.js）
- [x] 多标签 / 查找替换 / 最近文件 / 主题切换
- [x] LSP 诊断（`lsp_diagnostics`）
- [ ] 多光标 / 列选择
- [ ] 侧边文件树 / 资源管理器
- [ ] 小地图（minimap）—— 注意：沙箱里 `Function` 被遮蔽，IIFE 外部依赖需走 `TRUSTED_FUNCTION_PLUGINS` 白名单（`ide` 已在列）

绘画（`plugins/茑萝/huihua`）：
- [x] 图层化画板 / 压感笔刷 / 吸管 / 导入 / 撤销 / 导出
- [ ] 选区与蒙版 / 文字图层 / 滤镜（模糊·锐化·色彩）/ 矢量路径（待确认：以源码为准，未逐项核对）

音乐（`plugins/铃兰`，55 条命令）：
- [x] 播放 / 歌单 / 收藏 / 封面 / MV / 歌词 / 桌面歌词窗 / 听歌统计 / SMTC 任务栏
- [x] 网易云 + 酷狗 + 汽水音源（Rust 代理 + 加密）
- [ ] 均衡器 / 音量归一化（未做）

RAG 知识库（`plugins/茑萝/rag`）：
- [~] ONNX 本地向量嵌入 + 摄取/检索/来源管理已通；`plugins/茑萝/rag/*` 与 `src-tauri` RAG 相关改动**仍在工作区未提交**（重构中）

### Phase 3 — 工程化与质量（进行中，本轮大幅推进）

- [x] 单元测试：前端 vitest 31 文件 423 passed；Rust cargo test 322 passed
- [x] 契约测试：`src/core/tauriCommands.test.ts` 校验 invoke 参数名与非 Option 参数齐全
- [x] CI：typecheck + vitest + cargo check/clippy/test（2026-10-18）
- [x] i18n key 完整性卡口：`src/lib/i18n/locales.test.ts`（基线固化，缺失只许收敛）
- [x] i18n 补齐：en-US +132、zh-TW/ja-JP/ko-KR/de-DE/fr-FR 各 +195，6 语言均为 1381 keys（comfyui 28 / music.stats 26 / moduleDrawer 20 / kugou 18 / lyrics 15 / track 14 / capsule.res 47 / capsule.action 4 / image 7 / 零散 16）
- [x] lint 清零：`eslint src` 42 errors → **0**（react-hooks/refs 33 条重灾区：渲染期 ref 镜像改 effect、撤销栈改 state、4 处 `Date.now()` 收敛到 `src/core/clock.ts`）
- [x] Rust warning 清零：`cargo check` 13 条 + `--all-targets` 16 条全清（dead code 逐个判定「删」或「留 + 注释说明为何不能删」）
- [x] 插件类型检查全量化：`tsconfig.plugins.json` include 扩到 `plugins/**`，16 处历史错误清零
- [x] 安装包瘦身：`scripts/lib/zip.mjs` 的 `zipDir` Windows 分支原本完全忽略 `exclude`，导致每个 Windows 安装包打进 76MB 的 Linux ffmpeg；已修，`全局/ffmpeg.mujin` 302MB → 79MB
- [ ] 前端组件级测试：现无 jsdom，测试集中在纯函数；`@testing-library/react` 引入后补关键交互
- [ ] 错误监控 / 崩溃日志落盘
- [ ] 性能基线与回归告警（`docs/PERFORMANCE_REPORT.md` 有一次性报告，未接入 CI）
- [x] god file 拆分（第一批）：`commands.rs` 4638 行 → 95 行 + `commands/` 下 15 个领域模块（bootstrap 803 / plugins 775 / dropzone 707 / download 505 / notes 368 …），`cargo test` 322 passed 不变
- [x] god file 拆分（第二批）：`ai_tools.rs` 5245 行 → 856 行 + 10 个子模块；`frameworks.tsx` 4632 行 → 10 行壳 + 6 个文件。`main.rs` 2135 行含 invoke_handler 注册表（428 个命令），拆它收益低风险高，**有意保留**
- [x] `noUnusedLocals` / `noUnusedParameters` 打开（src + plugins 全量化），清出 4 个真 bug（详见下方本轮改动 15）
- [x] 残留大文件评估：`src-tauri/src/screenshot.rs` 3228 行**有意不拆**——它是 Win32 捕获 + GDI/DXGI 两条路径的单一职责单元，内部按 capture 后端分组清晰、无跨域逻辑，拆开只会把 `unsafe` FFI 句柄生命周期打散
- [~] 安装包体积：已按平台排除 ffmpeg（302MB → 79MB）；`avcodec-62.dll` 92.9MB 指向 gyan.dev full_build 而非 essentials（预计再省 60–100MB），但属二进制资产替换、需重跑录制/转码全链路验证，暂缓
- [ ] 前端组件级测试：现无 jsdom，测试集中在纯函数；`@testing-library/react` 引入后补关键交互

### Phase 4 — 发布与生态

- [ ] 自动更新（Tauri updater）：`tauri.conf.json` 与 `Cargo.toml` 均无 updater 配置
- [ ] 安装包签名：本地有 `andeyunhui-signing.pfx`，但 `tauri.conf.json` 无 `signCommand`/`certificateThumbprint`，未自动化
- [x] 插件 SDK + 项目模板（`plugins/_template` 骨架 + README）
- [~] 插件分发：`scripts/deploy-plugins.mjs` + landing-page 已有雏形，缺「清单仓库 + 一键安装」
- [~] 用户文档：README 205 行质量高，但缺开发者文档与插件开发教程
- [ ] Android 端（代码在 `src/mobile/**`）：4 个占位 `onActivate` + `src/mobile/screens/SettingsScreens.tsx` 硬编码版本号 `0.1.0`，仍是规划目标。**订正**：`feat/android-v1` 分支并不存在（本地与远程均无），历史上只有 `backup/android-v1-preclean2` / `backup/android-v1-prefilter` 两个死分支；Android 代码一直跟在 main 上

## 四、执行节奏建议

- 每条独立可验证、可回滚；完成一条就更新本清单勾选状态
- Phase 3 的剩余项都属「体验面 / 观测面」，地基（lint / warning / 类型 / CI / i18n）本轮已清零
- `ai_tools.rs` 已拆完；`main.rs` 2135 行含 invoke_handler 注册表，拆它收益低风险高，有意保留；`screenshot.rs` 3228 行经评估同为有意保留
- 17 份插件 `vite.config.ts` 经核实**无需收敛**：全部已是 2 行壳（`export default createPluginConfig('Xxx')`），真配置集中在 `plugins/_shared/vite.shared.config.ts`
- 不并行铺太多功能，保持"一次一小步"

## 五、本轮（2026-10-18）已落地的工程化改动

1. `.github/workflows/ci.yml`：前端（typecheck×2 + vitest）与 Rust（check/clippy/test，windows-latest）双 job
2. `.gitignore`：删掉 `*.mjs` 全量忽略（曾导致构建脚本被静默漏出仓库）；放行 `ROADMAP.md`、`docs/PERFORMANCE_REPORT.md`、`docs/screenshots/**`；补 `.codebuddy/`、`.superpowers/`
3. 插件沙箱加固：window 别名（`parent/top/self/frames/globalThis`）与 `__TAURI__/__TAURI_INVOKE__/__TAURI_OS__` 遮蔽；`__TAURI_INTERNALS__` 故意不遮蔽（宿主 alias 型插件依赖它，见代码注释）
4. manifest 声明式权限：`permissions.commands` + 15 个插件清单填充 + 13 条白名单漏网命令补回
5. `notesStore` 缓存治理：标签拉取加 TTL + in-flight 合并 + 修剪到活笔记；`saveTags` 改本地增量修补（7 条单测）
6. i18n 完整性卡口 + 6 语言补齐 1381 keys + 本路线图重校
7. README「截图 / 演示」节改为诚实说明（原文引用的 `docs/screenshots/*` 全在 gitignore 里，GitHub 上全是裂图）
8. `commands.rs` 4638 行拆成 `commands/` 下 15 个领域模块（最大 803 行）；`cargo test` 322 passed 不变
9. `eslint src` 42 errors → 0：渲染期 ref 镜像一律改 `useEffect`，撤销/重做栈与画布引用改 state，4 处 `Date.now()` 收敛到新增的 `src/core/clock.ts`（天精度 + 跨天定时刷新，配 5 条单测）
10. Rust warning 全清：`cargo check` 13 条 + `--all-targets` 16 条，每条都判定「删」或「保留 + 注释说明为何不能删」（如 `gpu_nv12.rs` 的 8 个 COM 句柄字段看着没人读，删了 shader/纹理随 Drop 销毁而缓冲区仍在用）
11. `tsconfig.plugins.json` 全量化 + 16 处插件类型错误清零；其中 `plugins/ai-chat` 的伴侣人设注入是**静默失效的真 bug**（三个字段从来是 hook 级 options，被当成 per-send 参数传）
12. 安装包瘦身：`scripts/lib/zip.mjs` 的 `zipDir` Windows 分支原本完全忽略 `exclude` 参数，`pack-mujin.mjs` 的 `PLATFORM_EXCLUDE` 又是单向的，导致每个 Windows 安装包都打进 76MB 的 Linux ffmpeg；已改为双向过滤，`全局/ffmpeg.mujin` 302MB → 79MB
13. P0 级地雷拆弹：`commands.rs` 拆分出的 15 个子模块与 `ci.yml` 一直没入库，任何 `git add -u` 都会把 95 行 re-export 文件单独提交、干净 clone 后直接 `file not found for module`；已 `git add`
14. `frameworks.tsx` 4632 行（全项目最大文件）拆成 10 行壳 + `frameworksShared.tsx` 563 + 五个面板（crawler 498 / reverse 779 / pentest 1145 / automation 771 / gateway 874）；`ai_tools.rs` 5245 行拆成 856 行父模块 + 10 个子模块（core / basic / plan / fs_shell / search_web / subagent / devtools / media_gen / vision / comfyui），`cargo test` 322 + 23 passed 不变
15. `noUnusedLocals` / `noUnusedParameters` 打开后 src 41 处 + plugins 全量清零，其中揪出 4 个真 bug：`App.tsx` 的 `activeReloadKey` 只写不读（插件热重载是静默空转）、`useAiChat.ts` 的 `CHAT_HISTORY_LIMIT` 从未生效（条数上限承诺落空，只有字符硬切在跑）、`overlay-recorder.ts` 的 `stopPolling()` 没人调（1s 状态轮询永不停）、`ComfyuiPanel.tsx` 的 `blueprintSlug` 双状态源（真实读取方全走 storage）
16. `capabilities` 死字段移除：manifest 有这个字段、Rust 与 TS 也解析它，但全仓库没有任何读取方，只有 gongfang 声明了 `["network","process-spawn"]`——自述标签会给人"已生效"的错觉，已连同两处 manifest 一起删
