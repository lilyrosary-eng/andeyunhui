# 岸灯鸢花（tauri-best）长期发展路线图

> 版本：2026-07-09 由 Rosary 与 AI 共同制定
> 原则：本体极轻 + 一切插件化 + 先补地基再做花样 + 每一步可独立验证可回滚

## 一、当前状态快照（基线）

- 架构：Tauri + 轻本体（Rust 只提供通用桥接命令）+ 前端插件沙箱（递归扫描 `app_data/extensions/**/manifest.json` 并沙箱执行）
- 重依赖走 `external-deps/` 按需加载（经 Rust `read_external_dep_file` 读取 IIFE，挂载 `window.__EXT_CM__` 等全局），本体保持极小
- 已落地插件：茑萝(niuluo) 父插件下含 `ide`（多标签/查找替换/状态栏/最近文件/主题切换）、`huihua`（图层化画板）、`gongjuxiang`（文本工具箱）、`薄荷(mint)`（16 个工具）
- 近期已修复两个关键 bug：① deploy 把 external-deps 同步到了错误路径 `extensions/external-deps`；② Windows 下 `canonicalize()` 加 `\\?\` 前缀导致路径越界误判
- 已知技术债：无运行时热插拔（启动一次性加载）、版本变更会 `remove_dir_all` 清空 `extensions` 洗掉用户插件

## 二、设计原则（健康长期计划的约束）

1. 本体永远极轻，重依赖一律走 external-deps 按需加载
2. 一切可插件化：新增能力 = 放文件夹 + 跑脚本 + 重启（终态 = 免重启）
3. 不引入会锁死架构的方向性依赖
4. 每一项改动独立可验证、可回滚，不堆砌半成品
5. 先补地基（技术债），再做花样（功能）

## 三、阶段划分与清单

### Phase 0 — 技术债清零（地基，P0，必须最早做，是后续一切的开关）

- [x] **运行时热插拔**：新增 RUST 命令 `reload_plugin`/`unload_plugin`（校验 id 后 emit 事件）→ 前端 `PluginHost` 监听并重读 manifest+入口沙箱重执行/注销，暴露 `window.__pluginHot__`；`ExtensionsHub` 订阅注册表事件强制重渲染。已落地（`src-tauri/src/commands.rs` + `src/core/PluginHost.tsx` + `src/core/extensions/ExtensionsHub.tsx`），待 `tauri dev` 实机验证。
- [x] **用户态插件持久化**：`get_installed_plugins` 与 `find_plugin_root` 现双根扫描 `extensions` + `user_plugins`（user_plugins 优先，不被版本更新清空）。
- [x] **插件清单 schema 强化**：`PluginManifest` 新增 `deps`（缺依赖拒绝）与 `min_app_version`（语义化点分比较，过低拒绝），扫描期给出可读 reason。
- [x] **沙箱命令白名单审计**：`ALLOWED_COMMANDS` 补入 `read_plugin_file`/`read_external_dep_file`/`clipboard_write_image`/`add_bytes_to_dropzone`（修掉 IDE 加载 CodeMirror 与绘画导出报"未授权命令"）。

### Phase 1 — 统一体验与设计系统（P0/P1）

- [x] **设计令牌(Design Tokens)**：颜色/间距/字号/圆角/阴影统一为 CSS 变量，消除各插件风格不一（2026-07-09 落地）。附带修复 tailwind 语义色映射 bug（`hsl(var())` 误用于 oklch 值导致 `text-foreground` 等失效），新增间距/字号/圆角/阴影/动效令牌尺度，并在 `index.css` 顶部写清令牌消费约定。
- [ ] **通用组件库**：按钮/输入/弹窗/标签页/侧栏/状态栏等基础组件（已有 `components.json`，可补 Shadcn 风格统一基线）
- [ ] **全局命令面板（Cmd/Ctrl+K）**：聚合所有插件动作，一处触达
- [ ] **设置中心**：偏好持久化（主题跟随/深/浅、字体、编辑器行为等），落盘 `app_data`
- [ ] **统一图标规范**：一套 SVG 图标，替换散落的 emoji/图片，统一视觉语言

### Phase 2 — 插件能力深化（按"一次一小步"推进）

IDE：
- [ ] 多光标 / 列选择
- [ ] 小地图（minimap）
- [ ] 侧边文件树 / 资源管理
- [ ] Git 基础操作（接 git2 或调用 cli，可选）
- [ ] 终端 / 运行（可选）

绘画：
- [ ] 选区与蒙版
- [ ] 文字图层
- [ ] 滤镜（模糊 / 锐化 / 色彩调整）
- [ ] 液化 / 变形（可选）
- [ ] 矢量图层 / 路径

薄荷 / 工具箱：
- [ ] 薄荷 16 个工具的完善与统一交互
- [ ] 文本差异 / 工具箱交互打磨
- [ ] 中转站能力扩展
- [ ] 截图 / 笔记与各插件联动

### Phase 3 — 工程化与质量（P1，伴随全程）

- [ ] 单元测试：Rust 用 `cargo test`，前端用 `vitest`
- [ ] 插件加载 / 沙箱关键路径集成测试
- [ ] CI：lint + typecheck + build 自动化
- [ ] 错误监控 / 崩溃日志落盘
- [ ] 性能基线（启动时间、内存）与回归告警

### Phase 4 — 发布与生态（P2）

- [ ] 自动更新（Tauri updater）
- [ ] 安装包签名
- [ ] 插件 SDK + 项目模板（一键生成新插件骨架）
- [ ] 插件市场 / 分发（最小可行：清单仓库 + 一键安装）
- [ ] 用户文档与开发者文档

## 四、执行节奏建议

- 每个 Phase 内按清单条目逐个落地，单条可独立验证、可回滚
- Phase 0 是后续一切的开关，优先做「运行时热插拔」+「用户态插件持久化」这两道坎
- 不要并行铺太多功能，保持"一次一小步"
- 每完成一条，更新本清单勾选状态并简要记录于 `.codebuddy/memory`

## 五、进度与下一步

- Phase 0 已落地（2026-07-09）：热插拔（reload/unload 命令 + 前端事件）+ 用户态持久化（双根扫描 extensions/user_plugins）+ manifest schema 强化（deps/min_app_version 校验）+ 沙箱白名单补完。待 `pnpm tauri dev` 实机验证。
- 顺带修掉两个运行期 bug：① 顶层孤儿 `extensions/gongjuxiang` 导致嵌套 `niuluo/gongjuxiang` 被重复 id 顶掉（已删除孤儿）；② IDE 加载 CodeMirror / 绘画导出因白名单缺 `read_external_dep_file`/`clipboard_write_image`/`add_bytes_to_dropzone` 报错（已补）。
- 绘画插件重做布局：SAI2 风格（顶栏面包屑 + 左工具轨 + 中画布 + 右图层面板/颜色），引擎逻辑不变。
- 下一步：进入 **Phase 1 — 统一体验与设计系统**（设计令牌 / 通用组件库 / 全局命令面板 / 设置中心 / 统一图标规范）。

### Phase 0 补充修复（第二轮 2026-07-09 下午）

用户五点，已全部处理并 `cargo check`/`tsc --noEmit`/`deploy-plugins.mjs` 三道校验 EXIT:0：

1. **IDE 加载 CodeMirror 失败「Function is not a constructor」**：根因在沙箱——`pluginSandbox.ts` 把 `Function` 遮蔽为 `undefined`，而 IDE 在沙箱内用 `new Function(code)` 加载 CodeMirror 外部依赖（external-deps/codemirror IIFE）时 `Function` 解析成 undefined。修复：新增受信任白名单 `TRUSTED_FUNCTION_PLUGINS = new Set(['ide'])`，`createSandboxGlobals` 对白名单插件暴露真实 `Function`（其余插件仍遮蔽，保留隔离）；接口 `SandboxGlobals.Function` 改为可选 `Function?: typeof Function`。
2. **绘画图层栏改为「子目录」导航**：`plugins/niuluo/huihua` 重构布局——左侧「图层」侧栏（仿视频/阅读左侧子目录范式），中央画布，右侧工具 + 调色板 + 笔刷参数。引擎逻辑（图层/笔刷压感硬度/形状/填充/吸管/导入/撤销/导出）完全保留，仅换壳 + 沿用现代 UI 令牌。
3. **选色升级为调色板**：右侧调色板 = 24 色网格（`PALETTE`）+ 原生 `<input type="color">` 取色 + 当前色块/hex 显示 + 选中高亮。
4. **茑萝面板热插拔真正可用**：`ExtensionManagerPanel.tsx` 原为「重启生效」可见性开关 + 写死"运行中"状态 → 现每插件加「热重载」「热卸载」按钮（调用 `reload_plugin`/`unload_plugin` RUST 命令，经 `plugin-reload`/`plugin-unload` 事件由 `PluginHost` 应用内重载/卸载，无需重启），状态改为动态（注册表存在=运行中，否则=已卸载），并 `useMemo`+订阅 `plugin-registered`/`plugin-unregistered`/`plugin-visibility-changed` 实时刷新列表。
5. **当前活动模块热重载后同步刷新**：`App.tsx` 订阅 `plugin-registered`/`plugin-unregistered` → `bumpVisibility()`，使正在显示的模块在重载后换用新组件重渲染。

> 说明：用户要求「继续推进 Phase 1」，但本轮先闭环了 Phase 0 遗留的运行期问题（CodeMirror/热插拔可见性）+ 绘画两项 UI 打磨；Phase 1 为下一阶段，按「一次一小步」从 设计令牌 或 Ctrl+K 命令面板 择一开始。
