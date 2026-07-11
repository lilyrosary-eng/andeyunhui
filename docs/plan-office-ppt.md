# 办公套件计划：三容器侧边栏 + 演示文件（PPT）

> 版本：2026-07-11 · 归属：茑萝(niuluo) → `wps` 插件升级为「办公」套件
> 原则（承 ROADMAP）：本体极轻 + 复用已有依赖零新增 + 一次一小步可独立验证可回滚

## 一、目标与范围

把现有 `wps`（单文档编辑器）升级为统一「办公」模块：一个侧边栏、三个容器 **「文档 / 演示文件 / 表格」**，主区按当前文件类型切换对应编辑器。本轮重点交付 **演示文件（PPT）** 编辑与放映；表格容器先占位（即将推出）。

现状基线：
- 侧边栏 `WpsSidebar` 复用「母目录+子目录」模板（宿主 `ModuleSidebarShell` 提供外壳），仅一个「文档」列表。
- 主编辑器 `WpsEditorBody`（TipTap）与侧栏通过模块级共享总线 `docSnapshot`/`docListeners`/`docOps` 联动。
- 持久化 `docStore.ts` → `localStorage`（`wps:index` + `wps:doc:<id>`）。
- 已具备：docx 导入导出（`convert_to_markdown` + 原生 `wps_export_docx`/`services/docx_wps.rs`）、A4 分页参考线、页眉页脚页码、打印/PDF。

## 二、总体架构决策

采用「**单插件多编辑器**」：保留插件 id `wps`，主组件按当前文件 `kind` 分发到不同编辑器；侧边栏渲染三容器分组列表。理由：需求明确要求「一个侧边栏三容器」，单插件方案天然复用现有共享总线与侧栏外壳，避免三插件各自独立侧栏。

- 文件类型抽象：`kind: 'doc' | 'ppt' | 'sheet'`，向后兼容（旧数据无 kind 视为 `doc`）。
- 主区分发：`doc` → 现有 TipTap 编辑器；`ppt` → 新 `PptEditor`；`sheet` → 占位页。
- 技术选型：PPT 采用与绘画(huihua)一致的「**绝对定位元素 + 自绘缩放手柄**」自研轻画布，不引入 reveal.js/重型库；导出复用已有 `zip`+`quick-xml` Rust 依赖（仿 `docx_wps`），**零新增依赖**。

## 三、阶段划分

### P0 — 三容器侧边栏 + 文件类型抽象（地基，必须最先做） ✅ 已完成 (01:13)
- `docStore.ts`：`DocMeta`/`DocData` 增 `kind?`；新增 `kindOf()`（缺 kind 归 `'doc'`）+ `defaultTitle(kind,n)`；未改 `loadIndex` 而是用 `kindOf` 运行时兼容，更简单。索引仍单一 `wps:index`，内容键沿用 `wps:doc:<id>`。
- 共享总线：`docOps.create` 改为 `(kind: FileKind) => void`；`DocSnapshot` 维持 `{docs, activeId}`，侧栏用 `kindOf` 即时分组，未引入分组结构（更省改动）。
- `WpsSidebar`：重构成 `SidebarGroup` 三个可折叠容器（文档 / 演示文件 / 表格），每容器头部「+」按 kind 新建，列出该类型文件（含数量徽标）；底部重命名/删除跨容器通用。
- `WpsEditor` 主区：计算 active 文件 `kind`，`doc` 走现编辑器，`ppt`/`sheet` 提前返回 `ComingSoon` 占位；内容载入 effect 与 `flushSave` 均加 `kind==='doc'` 守卫，避免把 TipTap 内容误存进演示文件/表格。
- 验证：lint 0 错误。三容器可分别新建/切换；旧文档自动归入「文档」。
- 下一步：**P1** 演示文件 MVP 编辑器（缩略图条 + 中央画布 + 右侧属性面板），届时用 `PptEditor` 替换 `ComingSoon` 的 ppt 分支。

### P1 — PPT 演示编辑器 MVP ✅ 已完成 (01:20)
- 新增 `src/PptEditor.tsx`：自研轻画布（逻辑 960×540，16:9，按容器自适应缩放；DOM 绝对定位元素 + 右下角自绘缩放手柄，未引第三方库）。
- 数据模型：`docStore.ts` 增 `PptElement`/`PptSlide`/`PptContent`（slides 存 `wps:doc:<id>` 的 content）。
- 交互：拖拽移动、右下角手柄缩放、双击文本编辑、Delete 删除选中；左侧幻灯片缩略图条（新建/复制/删除/切换，含实时预览）；右侧属性面板（位置尺寸、文本字号/颜色/粗体斜体下划线/对齐、形状填充描边线宽、层级上下移、幻灯片背景、删除元素）；顶栏插入文本/图片/矩形/椭圆/直线。
- 持久化：PptEditor 自带节流保存，经 `onPersist(id, slides)` 回写；`WpsEditorBody.persistPpt` 按传入 id 写 content(kind:'ppt') 并刷新索引；切换文件时由 PptEditor 在调度时锁定自身 id，避免误存到目标文档。
- 复用：`WpsEditorBody` 主区按 `kind` 分发，ppt 渲染 `PptEditor`、sheet 仍 `ComingSoon` 占位。
- 验证：`pnpm exec vite build` 通过（15 模块，dist/index.js 78.46 kB）；lint 0 错误。
- 下一步：**P2** 放映模式 + 导出 pptx/pdf（需新增 Rust 服务 `services/pptx_wps.rs` 与命令 `wps_export_pptx`，重编二进制后生效）。
```
PptDoc  = { id, title, kind:'ppt', slides: Slide[], updatedAt }
Slide   = { id, background:string, elements: Element[] }
Element = { id, type:'text'|'image'|'shape', x,y,w,h, rotation?, z,
            text?, style?{fontSize,color,bold,italic,align,...},
            src?（图片）, shape?'rect'|'ellipse'|'line', fill?, stroke? }
```
- 逻辑画布 960×540（16:9），元素坐标为逻辑单位，渲染时按容器宽度等比缩放。
- 布局：顶部工具栏（插入文本框/图片/形状、撤销重做、放映、导出）+ 左侧幻灯片缩略图条（新增/复制/删除/拖拽排序）+ 中央编辑画布 + 右侧属性面板（选中元素字体/颜色/对齐/层级/位置尺寸）。
- 交互：单击选中、拖拽移动、8 向手柄缩放、Delete 删除、层级前后移、双击文本进入编辑。
- 持久化：复用 `docStore`（content 存 slides JSON），自动保存节流沿用现方案。
- 验证：新建演示 → 加文本/图片/形状 → 切换幻灯片 → 刷新后内容还原。

### P2 — 放映与导出 ✅ 已完成 (01:40)
- **放映模式**：`PptEditor` 新增 `PresentMode`（固定全屏覆盖层，按视口 16:9 自适应缩放渲染 `SlideView`）；支持方向键/空格/PageUp-Down 翻页、左右半屏点击热区翻页、Esc 或双击退出；顶栏「放映」按钮从当前页进入。
- **导出 PDF（前端零依赖）**：`renderSlideToJpeg` 用离屏 canvas 逐页绘制（文本按字符换行+字体/颜色/粗斜下划/对齐；矩形/椭圆/直线填充描边；图片经 `preloadImages` 预载，跨域图降级为灰块）→ `buildPdf` 以 DCTDecode(JPEG) 装配多页 PDF 并下载。页面 1280×720。
- **导出 PPTX（Rust）**：新增 `src-tauri/src/services/pptx_wps.rs`（`json_to_pptx`：slides JSON → PresentationML，含 `[Content_Types].xml`/`_rels/.rels`/`ppt/presentation.xml`+rels/`slideMasters`/`slideLayouts`/`theme`/逐页 `slides/slideN.xml`+rels 与 `ppt/media` 内嵌图片），仿 `docx_wps` 复用 zip/quick-xml/base64，**零新增依赖**；新增命令 `wps_export_pptx(path,json)` 并在 `services/mod.rs`、`main.rs` generate_handler 注册；`PptEditor` 顶栏「导出PPTX」经 `hostApi.invoke('wps_export_pptx')` 调原生。覆盖文本（字号/颜色/粗体/斜体/下划线/对齐/多行）、图片（仅内嵌 data: URL 的 png/jpeg，跨域 http(s) 跳过）、基本形状（矩形/椭圆/直线，填充+描边）；母版/主题用最小可用模板。
- 验证：`pnpm exec vite build` 通过（15 模块，dist/index.js 85.85 kB）；`cargo check` 通过（仅 `screenshot.rs` 既有未用变量警告，与本次无关）。**注意**：pptx 导出需 `cargo build`/`tauri dev` 重编二进制并重部署两目标（`app_data/extensions/niuluo/wps` 与 `bundled-plugins/niuluo/wps`）后生效。
- 下一步：**P3** 打磨/进阶（母版/主题、切换动画、对齐吸附参考线、形状库、`.pptx` 导入）+ 表格容器正式实现。

### P3 — 打磨/进阶（后置）
- 母版/主题、切换动画、对齐吸附参考线、形状库扩展、`.pptx` 导入。
- 表格容器正式实现（评估复用 TipTap table 或独立 grid 组件）。
- **本轮已完成（纯前端，零 Rust 重编）**：
  - **对齐吸附参考线**：拖拽移动时 `snapMove` 把元素左/中/右、上/中/下锚点对齐到其它元素或画布边界（阈值 6 逻辑像素），缩放时 `snapResize` 对齐右/下边；吸附处绘制蓝色参考线覆盖层，松手清除。
  - **放映切换动画**：`PptSlide.transition` 支持 `none|fade|slide`（默认 fade）；`PresentMode` 按当前页 transition 注入 keyframes（淡入/滑动）并重挂节点触发动画；属性面板幻灯片区新增「切换动画」选择。
  - **母版雏形**：幻灯片区「应用到全部」按钮把当前页背景批量套用到所有页（最小可用主题能力）。
- 验证：`pnpm exec vite build` 通过（15 模块，dist/index.js 88.76 kB）；lint 0 错误；已同步 `bundled-plugins/niuluo/wps/index.js`。
- 剩余 P3：**形状库扩展**（圆角矩形/三角/箭头，需前端渲染 + `pptx_wps.rs` 导出支持，需重编）、**`.pptx` 导入**（需新增 Rust 命令 `wps_import_pptx`）、**表格容器正式实现**。

### P3-c — 形状库扩展（圆角矩形 / 三角 / 箭头）(01:55)

- **数据模型**：`docStore.PptShapeKind = 'rect'|'roundRect'|'ellipse'|'line'|'triangle'|'arrow'`，`PptElement.shape` 改用此类型。
- **统一 SVG 渲染**：新增 `ShapeSvg({el, scale})` 组件（`svg` 内联几何，替代原先 CSS div 分支），同时覆盖缩略图 `PptThumb`（仅 shape）与编辑画布 `SlideView`。
  - `rect` → `<rect>`；`roundRect` → `<rect rx=ry=.18*min(w,h)>`；`ellipse` → `<ellipse>`；`triangle` → `<polygon>` 等腰三角；`arrow` → `<path>` 右箭头；`line` → `<line>`。
  - `SHAPE_KINDS` 常量数组与 `SHAPE_LABEL` 中文映射。
- **工具栏**：在「矩形/椭圆/直线」基础上增加「圆角」「三角」「箭头」三个插入按钮。
- **属性面板形状切换**：选中 shape 时最上方显示 6 个按钮（`SHAPE_KINDS.map`），可热切换形状类型（保留 fill/stroke 不变）。
- **Canvas 导出**：`renderSlideToJpeg` 中增加 `triangle`（moveTo→lineTo→closePath）、`arrow`（箭头路径）、`roundRect`（视为 rect 填充+描边）的 canvas 绘制。
- **Rust 导出**：`pptx_wps.rs:shape_shape` 的 prstGeom 映射由 `if-else` 升级为 `match`：`roundRect→roundRect`、`triangle→triangle`、`arrow→rightArrow`；模块注释放宽。
- **验证**：`pnpm exec vite build`（15 模块，dist/index.js 93.23 kB）+ `cargo build`（27.74s，仅 2 个截图既有警告）；lint 0 错误；已同步 `bundled-plugins/niuluo/wps/index.js` 并重建 Tauri 二进制。

### P3-d — .pptx 导入 (10:34, 本轮)

- **新增 Rust 模块**：`src-tauri/src/services/pptx_import.rs`（zip 读取→OOXML 字符串解析→JSON）。约 300 行。
  - `pptx_to_json(bytes: &[u8]) -> Result<String, String>` 入口。
  - `parse_slide_order`：从 `ppt/presentation.xml` 中 `p:sldIdLst/p:sldId` 解析幻灯片顺序。
  - `parse_slide`：逐解析每页 `ppt/slides/slideN.xml` 的背景（`p:bgPr`）、形状（`p:sp`）和图片（`p:pic`）。
  - `parse_sp`：提取 `a:xfrm`（位置/尺寸）、`a:prstGeom`（prst→shape 映射 `roundRect/triangle/rightArrow/ellipse/line`→PptShapeKind）、`p:spPr`（fill/stroke/strokeWidth）、`p:txBody`（段落文本 + 样式：字号/颜色/粗斜体/下划线/对齐）。
  - `parse_pic`：通过 `a:blip/@r:embed` → slide rels → `ppt/media/` 提取图片，转为 base64 data: URL。
  - `parse_rels`：解析 `ppt/slides/_rels/slideN.xml.rels` 获取图像引用。
  - 坐标逆映射：EMU→逻辑像素（`x / 12700`，与导出 `eu/ev` 一致）。
- **命令注册**：`commands.rs` 新增 `wps_import_pptx(path: String) -> Result<String, String>`；`services/mod.rs` 加 `pub mod pptx_import;`；`main.rs` 注册 `wps_import_pptx`。
- **前端**：`PptEditor` 工具栏增加「导入PPTX」按钮（`importPptx`），调用 `hostApi.invoke('wps_import_pptx', {path})` → 解析为 `PptContent` → 写入 `slides`/`sections` 状态并 `commit` 保存。
- **验证**：`pnpm exec vite build`（93.99 kB）+ `cargo build`（26.48s，1 个 dead_code 警告已清理）；lint 0 错误；已同步 `bundled-plugins/niuluo/wps/index.js` 并重建 Tauri 二进制。
- **剩余 P3**：**表格容器正式实现**（唯一）。
- **已知局限**：导入基于字符串截取而非严格 XML 解析，复杂嵌套或非标准格式可能遗漏元素；不支持 SmartArt/图表/组合形状/动画/母版格式继承；仅导入内嵌 media 图片。

### P3-b — 图标栏移除 + 幻灯片章节嵌套（用户追加）
- **图标栏修正**：`plugins/niuluo/wps/src/index.tsx` 注册由 `visible: true` 改为 `visible: false`（与 huihua 同范式）。`App.tsx` 的 `mainPluginIds = 全部 visible!==false 的 module`，故 wps 不再进 `AppNav` 图标栏；同时 `HostSidebar` 按 `parent==='niuluo'` 过滤（不查 visible）且 `ExtensionsHub` 用 `excludePluginIds={mainPluginIds}`，所以 wps 仍稳定出现在「茑萝」侧边栏列表与拓展主页。务必保持静态（模板要求：图标栏只做高亮、不改增删）。
- **幻灯片章节嵌套**：采用「扁平 `slides` 数组（有序，导出/放映零改动）+ `sections` 元数据」方案，类比「茑萝」母目录/子目录。
  - `docStore`：`PptSlide.sectionId?: string|null`、`PptSection{id,title,collapsed}`、`PptContent.sections?`。
  - `PptEditor`：`sections` 状态 + `sectionsRef`；载入时读 sections 并清洗指向不存在章节的 sectionId；`commit/scheduleSave` 同时落盘 slides 与 sections；卸载落盘同步。
  - 缩略图栏按连续 `sectionId` 分块（`slideBlocks`）：有 section 的块渲染可折叠章节头（▾/▸、标题、✎重命名、✕删除章节→幻灯片移出分组），其下幻灯片缩进 `ml-3`；无 section 的块直接平铺。顶栏加「章节」按钮（把当前页及之后归入新章节）。
  - 新建/复制幻灯片继承当前页 `sectionId` 以实现嵌套；删除幻灯片后自动清理空章节。
  - `WpsEditor.persistPpt(id, slides, sections=[])` 写入 `content.{slides,sections}`；`PptEditor.onPersist` 签名同步。
- 验证：`pnpm exec vite build` 通过（15 模块，dist/index.js 91.17 kB）；lint 0 错误；已同步 `bundled-plugins/niuluo/wps/index.js`。纯前端改动，无需 Rust 重编。
- 说明：章节为组织/折叠层，幻灯片顺序仍以扁平数组为准；导出 pptx/pdf、放映均不受章节影响（符合 MVP 预期）。

## 四、改动清单（预估）

前端 `plugins/niuluo/wps/src/`：
- `docStore.ts`：加 `kind` 与分组读取。
- `WpsEditor.tsx`：共享总线加 kind；`WpsSidebar` 改三容器；主区按 kind 分发。
- 新增 `PptEditor.tsx`（画布/缩略图/属性面板/放映）、`pptStore` 辅助（或并入 docStore）。

原生 `src-tauri/src/`：
- 新增 `services/pptx_wps.rs`；`services/mod.rs` 注册；`commands.rs` 加 `wps_export_pptx`；`main.rs` generate_handler 注册。

## 五、风险与取舍

- 真正 WYSIWYG 的 pptx 往返（母版/占位符/主题）较重；MVP 先保证「文本/图片/形状」基本元素的自有格式往返 + pptx 导出覆盖基本元素，进阶后置。
- 新增 Rust 命令 `wps_export_pptx` 需重编二进制（`cargo build`/`tauri dev`）后才暴露，与 docx 导出同理。
- dist 体积：PPT 画布为自研轻组件，不引重型库，预计增量可控。

## 六、执行顺序

P0（三容器 + 类型抽象）→ P1（PPT MVP 编辑）→ P2（放映 + 导出 pptx/pdf）→ P3（进阶 + 表格）。每阶段独立 vite build/cargo check 验证并同步两部署目标（`app_data/extensions/niuluo/wps` 与 `bundled-plugins/niuluo/wps`）。
