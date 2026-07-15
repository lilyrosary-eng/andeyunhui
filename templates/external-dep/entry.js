// ============================================================
// 外部依赖构建入口模板
// ============================================================
// 复制本文件到 external-deps/_build/<dep>-entry.js，按注释填写，
// 再在 scripts/build-external-deps.mjs 的 TARGETS 里加一项即可。
//
// 构建：node scripts/build-external-deps.mjs（pnpm dev 会自动跑）
// 产物：external-deps/<relpath>/index.js  （IIFE，挂载到 window.__EXT_<DEP>__）
//
// 注意：external-deps/_build/ 已被 .gitignore 忽略（仅本地源、可重建），
//       本模板文件才是随仓库分发的「模板源」，请勿把真实入口的唯一来源只放在 _build。
// ============================================================

// —— 情况 A：纯 JS 库（不依赖 React），如 CodeMirror ——
// import { EditorView, basicSetup } from 'codemirror';
// import { javascript } from '@codemirror/lang-javascript';
// // ……按需 import 子模块
// window.__EXT_CODEMIRROR__ = { EditorView, basicSetup, javascript /* … */ };

// —— 情况 B（最常见）：依赖 React 的库（如 TipTap / 富文本编辑器）——
// 必须把 react / react-dom 外部化到宿主全局，才能与插件沙箱共享同一 React 实例，
// 否则 @tiptap/react 的 useEditor / EditorContent 等 hooks 会失效。
// scripts/build-external-deps.mjs 已内置 host-externals 插件完成此外部化，这里直接 import 即可：
// import { Editor, EditorContent, useEditor } from '@tiptap/react';
// import StarterKit from '@tiptap/starter-kit';
// // ……按需 import 扩展

// 挂载到全局，供插件运行时通过 window.__EXT_MYDEP__ 取用。
// 导出插件实际需要的成员即可，不必全量导出。
window.__EXT_MYDEP__ = {
  // Editor,
  // EditorContent,
  // useEditor,
  // StarterKit,
  // ……导出插件需要的成员
};
