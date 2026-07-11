# 诊断与修复报告（2026-07-09）

## 摘要

本文档回答四个问题：(1) 打包后哥特加载页为何不完整；(2) 莲花模块动图为何静止及如何改善；(3) 截图实现与微信的差距及「导入中转站时自动写入当前笔记」的落地；(4) 笔记中图片删除为何逐字符删及如何改为整块删除。其中 (2)(3)(4) 三项已实施代码修复，(1) 进行了配置缓解并给出根治方案。

---

## 一、打包后哥特加载页不完整

### 根因

加载页的前端实现位于 `index.html`（第 13-185 行）的同步内联预加载脚本（IIFE）。它用 `fetch('waiting-page-light.html')` 拉取 `tools/waiting-page-light.html` 的哥特 SVG/CSS 内容，以 `iframe.srcdoc` 注入整页动画。在 dev 模式下（`http://localhost:1420`），相对路径 fetch 命中 Vite 本地服务器，完整哥特页正常展示。在 release 包中，前端由 Tauri 的 `asset://localhost/index.html` 提供，fetch 在 asset: 协议下失败，触发 `index.html` 第 159 行 `.catch` 分支 → 进入 `useInlineFallback()`（第 165-183 行），仅渲染一个标题「岸灯鸢花」加一条进度条，没有任何哥特 SVG/CSS 元素。

此外，即使 fetch 成功，加载页 iframe 内的 `<script>`（玫瑰窗生成器、星点闪烁逻辑）也被 CSP（`tauri.conf.json` 第 24 行 `script-src`）拦截，因为 `script-src` 当时不含 `'unsafe-inline'`，导致 iframe srcdoc 内的内联脚本无法执行。

### 已实施的配置缓解

- `vite.config.ts`：新增 `base: "./"`，使 release 包中 Vite 注入的资源路径由绝对 `/assets/...` 变为相对 `./assets/...`，避免 asset: 协议下路径解析错误。
- `tauri.conf.json` CSP 调整：
  - `script-src`：新增 `'unsafe-inline'`（放行 iframe 内联脚本）
  - 新增 `font-src 'self' asset: https://fonts.googleapis.com https://fonts.gstatic.com data:`（减少字体缺失，「不完整」观感改善）

### 根治方案建议

配置缓解不能解决 fetch 失败这一根本问题。根治方案是将 waiting-page HTML 在构建时内联进 `index.html` 的预加载脚本，彻底消除 fetch 依赖。具体做法：修改 `scripts/copy-waiting.mjs`，在复制 `waiting-page-*.html` 到 `public/` 的同时，也生成一个 JS 文件（如 `public/waiting-pages.js`）导出 light/dark HTML 字符串为 `window.__WAITING_PAGES__`；然后在 `index.html` 预加载脚本中读取该 variable 而不是 fetch。此改动涉及构建管道，需单独验证。

---

## 二、莲花模块动图静止

### 根因分析

莲花模块（`plugins/image`）用原生 `<img>` 标签 + `hostApi.convertFileSrc(path)` 渲染原始 GIF 文件，源码层面没有任何 canvas 重绘、缩略图生成、帧提取等 strip 动画的逻辑。动图静止最可能的原因有三个：

1. **`content-visibility: auto` + `loading="lazy"`**：竖版视图（`ImageViewer.tsx` 行 334）和横版视图（行 372）的每个图片包裹 div 都设置了 `content-visibility: auto`。该 CSS 属性让浏览器跳过视口外元素的渲染管线，包括动画计算，导致用户的直观感受是「动图是静止的」。只有滑动到视口内的 GIF 才会激活动画。
2. **完整视图切换时动画不重置**：`FullView` 的 `<img>` 没有 `key` 属性，切换图片时 React 复用同一 DOM 节点只改 `src`，某些协议下 GIF 动画不会自动重播。
3. **可能的 asset: 协议运行时问题**：Tauri v2 的 asset: 协议在 WebView2 下对 GIF 文件的 Content-Type 判定 / 分块传输存在不确定行为（需运行时复现验证）。

### 已实施的修复

| 文件 | 改动 | 目的 |
|---|---|---|
| `plugins/image/src/ImageViewer.tsx` | 新增 `isGif(url)` 判定函数 | 根据 URL 扩展名 `.gif` 判断 |
| 同上 | FullView `<img key={currentIndex}>` | 切换图片时强制重建 img 节点，确保 GIF 重新播放 |
| 同上 | 竖版视图：`isGif(url) ? undefined : { contentVisibility: ... }` | GIF 不折叠 content-visibility，保持渲染管线激活 |
| 同上 | 横版视图：同上 | 同上 |

### 性能兼顾说明

- 竖版/横版仅对 GIF 跳过 `content-visibility`，非 GIF 图片仍享受该优化的渲染跳过收益。
- 建议后续为列表/缩略图生成**静态首帧缩略图**（在 Rust 端用 `image` crate 生成 200px 宽的 JPEG），主视图才用原图播放动画——这样列表和封面网格不加载全分辨率 GIF，兼顾性能和动画。（当前封面和缩略图条直接加载原图全分辨率，是扫描大量 GIF 时的性能短板）

### 后续排查

若应用上述修复后，完整视图的 GIF 仍然静止，则大概率是 Tauri asset: 协议 / WebView2 运行时的问题。此时可尝试备选方案：新增一个 Rust 命令将 GIF 文件以 `data:image/gif;base64,...` 读取出来供 `<img>` 直接渲染，绕过 asset: 协议的潜在限制。

---

## 三、截图体验 & 导入中转站时自动写入当前笔记

### 截图实现与微信的对比

当前截图架构（Rust `BitBlt` 抓屏 → 前端 `ScreenshotOverlay` 框选/标注 → `clipboard_write_image` + `addBytesToDropzone` 进中转站）已具备微信的核心能力：框选自由区域、单击窗口整窗截图、画笔/箭头/矩形/文字/橡皮标注、撤销清空、复制剪贴板、进中转站。

与微信的主要差距：

- **全局热键**：`Ctrl+Shift+S` 是 Web `keydown` 监听（`App.tsx:62`），应用失焦时无法触发，不是真正系统级热键。可使用 Tauri `globalShortcut` 插件改为系统级注册。
- **钉在桌面**：未实现置顶悬浮窗体。
- **截图后直接拖入笔记**：需先进中转站再拖，不能从截图层直接拖。
- **多显示器**：`capture_screen()` 仅用 `SM_CXSCREEN` 抓主屏。
- **长截图/滚动截屏**：未实现。
- **文字标注体验**：用 `window.prompt` 弹窗输入，非画布内联编辑。

### 「导入中转站时自动在当前笔记写入一份」——已实施

修改文件：`src/components/ScreenshotOverlay.tsx` 的 `save()` 函数。

原流程：`compose()` → `clipboard_write_image` → `addBytesToDropzone`（写入中转站，返回 ImportedFile 元信息）
新流程：`compose()` → `clipboard_write_image` → `addImageBytesToDropzone`（写入中转站，返回 `localimg://` 引用） → 若 `currentNoteId` 非空则调用 `setContent(content + snippet)` 追加 markdown 图片引用到当前笔记末尾。

关键点：
- `addImageBytesToDropzone`（Rust `add_image_bytes_to_dropzone`，`commands.rs:1681-1706`）内部仍调用 `copy_file_to_dropzone`，中转站行为不变。
- 使用 `useNotesStore.getState()`（zustand 的同步读取）而非 React hook，因为 `save()` 是普通 async 函数不在渲染上下文。
- `setContent` 会触发 1s 防抖自动保存（`scheduleAutoSave`），无需手动 save。
- 浮窗笔记（`FloatingNoteView`）使用独立 state，不共享 `notesStore.currentNoteId`，当前改动覆盖的是主窗口笔记。若需覆盖浮窗，需将浮窗 id 同步回主 store。

---

## 四、图片整体删除（不再逐字符删）

### 根因

图片在笔记数据模型中是 markdown 文本 `![文件名](localimg://...)`，存储在纯 `<textarea>` 中。textarea 对 Backspace/Delete 天然逐字符删。项目中没有任何「图片原子节点」或「整块删除」的特判逻辑。

### 已实施修复

修改文件：`src/core/notes/NotesEditor.tsx`

新增 `handleEditorKeyDown` 回调，挂载于 textarea 的 `onKeyDown`，逻辑如下：

1. 仅拦截 `Backspace` 和 `Delete`；有选区时（`selectionStart !== selectionEnd`）交给默认行为。
2. Vim 普通模式下跳过（不干扰 h/j/k/l/dd 等键位）。
3. 用正则 `/!\[[^\]]*\]\([^)]*\)/g` 扫描当前文本中的所有图片节点，找到光标紧邻或落入的图片块（扩展至包含前后换行符号）。
4. Backspace 删除条件：光标位于图片块结束位置（含后续换行），或光标在图片块内部任意位置。
5. Delete 删除条件：光标位于图片块起始位置，或光标在图片块内部任意位置。
6. 命中后 `preventDefault`，截去整段图片文本，光标重置到原图片起始位置。

这样用户在图片 `![name](ref)` 的任意位置（或刚好在其开头/结尾相邻）按 Backspace 或 Delete 即可一次性删掉整张图（连同前后孤立换行）。

---

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/core/notes/NotesEditor.tsx` | 导入 `ReactKeyboardEvent` 类型；新增 `handleEditorKeyDown` 回调（整块删除图片）；textarea 挂载 `onKeyDown` |
| `src/components/ScreenshotOverlay.tsx` | 导入 `useNotesStore`；`save()` 中 `addBytesToDropzone` → `addImageBytesToDropzone` + 写入当前笔记 |
| `plugins/image/src/ImageViewer.tsx` | 新增 `isGif()` 辅助；FullView img 加 `key={currentIndex}`；竖版/横版 GIF 跳过 `contentVisibility` |
| `vite.config.ts` | 新增 `base: "./"` |
| `src-tauri/tauri.conf.json` | CSP 新增 `'unsafe-inline'` 到 `script-src`；新增 `font-src` |

---

## 限制与后续

1. **哥特加载页**的根治方案（构建时内联 HTML）需单独实施，当前仅做了配置缓解。
2. **动图**若在完整视图仍静止且上述前端修复无效，需排查 Tauri asset: 协议 / WebView2 运行时行为，备选方案为 Rust 端以 base64 data URL 方式提供 GIF 文件。
3. **截图热键**改为系统级 `globalShortcut` 需引入 tauri-plugin-global-shortcut。
4. 浮窗笔记导入截图的覆盖逻辑未纳入当前改动，因为 `FloatingNoteView` 使用独立 state 不共享 `notesStore.currentNoteId`。
