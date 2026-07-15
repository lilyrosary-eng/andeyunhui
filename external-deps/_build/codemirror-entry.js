// CodeMirror 6 外部依赖入口：打包为 IIFE，挂载到 window.__EXT_CM__
// 供 IDE 子插件按需加载（external-deps/niaoluo/ide/codemirror）。
// 与 TipTap 入口不同，CodeMirror 不依赖 react，故无需外部化宿主 react。
// 构建脚本（scripts/build-external-deps.mjs）会将本入口打成
// external-deps/niaoluo/ide/codemirror/index.js，由 IDE 运行时 read_external_dep_file + new Function 加载。
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  search,
  searchKeymap,
  openSearchPanel,
  closeSearchPanel,
} from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';

// 浅色主题：CodeMirror 6 官方未内置 light theme，这里自定义一个 GitHub 风格浅色，
// 供 IDE 在浅色模式下使用（与 oneDark 深色调成对）。
const lightTheme = EditorView.theme(
  {
    '&': { color: '#24292e', backgroundColor: '#ffffff' },
    '.cm-content': { caretColor: '#24292e' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#24292e' },
    '.cm-gutters': { backgroundColor: '#f6f8fa', color: '#959da5', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#f0f3f6' },
    '.cm-activeLineGutter': { backgroundColor: '#f0f3f6' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: '#c8e1ff',
    },
    '.cm-tooltip': { border: '1px solid #c8c8c8', backgroundColor: '#f6f8fa' },
  },
  { dark: false },
);

// 浅色高亮样式（IDE 插件未直接引用，但保持与原始 bundle 同形状导出，便于后续使用）
const lightHighlight = defaultHighlightStyle;

window.__EXT_CM__ = {
  EditorView,
  basicSetup,
  EditorState,
  Compartment,
  keymap,
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  syntaxHighlighting,
  defaultHighlightStyle,
  lightTheme,
  lightHighlight,
  javascript,
  python,
  html,
  css,
  json,
  oneDark,
  search,
  searchKeymap,
  openSearchPanel,
  closeSearchPanel,
};
