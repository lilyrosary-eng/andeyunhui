# 项目长期记忆 — tauri-best

## 项目概述
- 项目：andengyuanhua（岸灯鸢花），Tauri v2 桌面应用（React 前端 + Rust 后端），笔记 + 插件系统
- 插件系统：music/image/video/reading/professional/markitdown + 扩展中心 gongjuxiang（IIFE 沙箱，`window.__HOST_*` 注入）；打包 NSIS，`bundled-plugins/` 随 `bundle.resources`

## 核心构建约定
- 重依赖走 `external-deps/`（esbuild IIFE，`scripts/build-external-deps.mjs`，接入 `predev`），绝不可进插件本体；运行时 `read_external_dep_file` → `new Function` → `window.__EXT_<NAME>__`
- 共享 React 走 `__HOST_REACT__`/`__HOST_REACT_DOM__`；`window.__HOST_UI__`(PluginHost) 主应用可直接用
- 自检：插件 `dist/index.js` 不得含 tiptap/prosemirror/codemirror

## 易回归坑（必读）
1. deploy 同步：`external-deps/` → `appDataRoot/external-deps`
2. Windows 路径：`read_external_dep_file` 比较 root 也 `canonicalize()`
3. 沙箱遮蔽 Function：非受信插件 `Function` 形参 undefined；`TRUSTED_FUNCTION_PLUGINS={'ide','wps'}` 或 manifest 声明 `deps`
4. TipTap Table 需 TableRow/TableHeader/TableCell + Table，大版本一致
5. `deps` 专指 external-deps，不做缺失拒绝
6. node_modules symlink 损坏（Windows reparse 不可跟随）→ 跑 `scripts/fix-node-modules.mjs`；`.npmrc` 已 `node-linker=hoisted`
7. @tiptap 类型实例重复（pnpm 物化）→ 根 tsconfig `paths` 加 `@tiptap/core`/`@tiptap/pm` 指向顶层 `node_modules/@tiptap/*`；Radix UI 类型缺 className/children → 组件类型显式补 `& {className?...}` 或 `const P = X as any`
8. **UI 缩放 zoom 只能挂在 ThemeProvider 包裹 children 的一层 `<div>` 上，绝不能挂 `document.documentElement`**：否则覆盖层（启动加载页、关于→预览）继承 zoom 被放大，装饰/莲花越界只剩居中莲花
9. **wait-page `vw/vh` 在打包版 WebView2 按"设备逻辑宽度"解析（非 iframe 实宽）** → 装饰放大溢出、只剩居中莲花（"打包后只剩莲花+放大"）。真正修复：wait-page 源 `<head>` 顶部内联脚本运行时自注入 `width=窗口实宽px` viewport（见 #15）。dev 用 localhost 按 iframe 实宽解析故正常，此 bug 只在打包版出现。
10. **打包 exe「有 HUD 无红条/装饰」几乎总是旧包**：`public/waiting-page-*.html` 是死副本（不参与注入）；`vite.config.ts` 读 `wait-page/*.html` 注入。验证解码 `dist/index.html` base64 确认。
11. **`pnpm tauri build` 走 PowerShell `pnpm.ps1` 会多传反斜杠 `\` 给 cargo，Rust 不编译、exe 不更新**：用 `build.bat`（`cmd /c`，后台 detached 跑，release 首次 ~8min，避开 5min 超时）。成功标志：build.log 有 `Compiling andengyuanhua` → `Finished release` → `makensis ... setup.exe` → `Finished 1 bundle`
12. **`pnpm` 卡 "Blocking waiting for file lock"**：删 `node_modules/.pnpm/lock.yaml`（陈旧锁，删了安全）
13. **哥特加载页有两条消费路径，修复须落在 wait-page 源本身**：①`index.html` 启动嵌入（iframe srcdoc，带父文档自愈注入）；②`wait-page` standalone（关于→预览 `bootPreview.ts` 的 `iframe.srcdoc=lightPageHtml`、双击打开 .html）。仅改 index.html 会漏掉 standalone 路径。

## 哥特加载页 / 莲花构建动画（2026-07-14 重点，动刀相关）
- 哥特加载页 = wait-page（哥特风 + 莲花 `@keyframes bloom` 描边绘制动画 + `buildRose()` 线描几何 + 四角/玫瑰窗/水印装饰），由 `wait-page/*.html` 源经 base64 注入。
- **启动页根因（#14，已修复）**：打包版 WebView2 偶发丢弃 srcdoc iframe 内联 `<style>`+`<script>` → 样式没上 bloom 不播、脚本没跑 `#roseG` 为空（莲花构建动画消失）。dev 同机制正常。`index.html` 的 `installBootHtml` onload 已加 **CSP 免疫自愈**：检测 `.app` 是否 flex、roseG 是否有子节点；未生效则样式用 `idoc.adoptedStyleSheets=[new CSSStyleSheet(); sheet.replaceSync(css)]`、脚本用 `idoc.defaultView.eval(code)` 重注（配置含 `unsafe-inline`/`unsafe-eval`）。
- **viewport 修复（#15，已落实）**：wait-page 源 `<head>` 顶部内联脚本运行时自注入 `width=窗口实宽(px)` viewport；index.html 注入检测到已有 viewport 则跳过（避免双 meta）。三路径（双击/关于预览/启动嵌入）均正确。
- **#18 关于→预览缺口（已修复 ✅）**：原 `bootPreview.ts` 的 `previewBootScreen` 直接 `iframe.srcdoc=lightPageHtml`，有 wait-page 自带 viewport 注入，但**缺 #14 的 style/script 自愈兜底**。已采用方向①：在 `bootPreview.ts` 的 iframe `onload` 移植 `index.html` 同款自愈（检测 `.app` 是否 flex、`#roseG` 是否有子节点；未生效则 `adoptedStyleSheets` 重注样式 + `eval` 重跑脚本，兜底 `<style>/<script>` 元素）。预览与启动页行为一致，根因覆盖。方向②（wait-page 改真实 HTML + `iframe.src`）未采用。
- 用户澄清：消失的是**莲花构建动画**（bloom+buildRose），**不是**流光 streamlight；此前把流光改 SVG SMIL 的尝试已被用户回退（SMIL 非根因）。包版本 2.1.1。
- 诊断仪（HUD `#bootDiag`/红条 `bootDiagIframeHost`/`postMessage` 探针/`DISABLE_BOOT_SCREEN`/`PREVIEW_BOOT_DISABLED`）已全部删除，仅保留自愈 + viewport 注入。

## 等待页打包链路（复用）
- `vite.config.ts` + `scripts/gen-waiting-pages.mjs`（接入 `predev`/beforeBuildCommand）读 `wait-page/*.html` 生成 `src/lib/_waitingPages.generated.ts`（gitignored，构建期重生成），`bootPreview.ts` 导入解码后 `iframe.srcdoc`。此机制规避了此前 `?raw` 导入被 Vite 生产构建当 HTML 入口拦截、dev 正常 build 丢内容的坑。

## 前端包体积优化（#17）
- `RichTextEditor.tsx` 改普通函数组件 + `editorRef` prop，由 `NotesEditor.tsx` 用 `React.lazy` 懒加载；`vite.config.ts` `manualChunks` 精确匹配 `react|react-dom|scheduler|use-sync-external-store`→react-vendor，`@radix-ui`→radix，`@tauri-apps`→tauri-vendor，`lucide-react`→icons，`chunkSizeWarningLimit:600`。eager ≈616KB(gzip205KB)。

## 外部依赖 / EPUB
- CodeMirror 6(IDE)、TipTap 2(wps) 走 external-deps；`__HOST_REACT_DOM__` 须完整 react-dom（flushSync）。
- EPUB：`reading_service.rs` 用 `epub=2.1.5`(GPL-3.0)+ammonia；维持现状不主动换（MIT 的 lib-epub 更有利但翻车成本高）。详见 `research_report_epub_ecosystem.md`。

## 命名 / 配置
- 「茑萝」= 扩展中心 `ExtensionsHub.tsx`(id `extensions`)；gongjuxiang(原 niaoluo) 是其 `visible:false` 子扩展
- CSP 含 `connect-src 'self' asset: https://asset.localhost`；`localStorage.log_level='debug'` 开调试；根 tsconfig `types:[]`、tsconfig.node `types:["node"]`
