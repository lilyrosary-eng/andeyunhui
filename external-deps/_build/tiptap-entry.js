// TipTap 外部依赖入口：打包为 IIFE，挂载到 window.__EXT_TIPTAP__
// react / react-dom 由 build-external-deps.mjs 外部化到宿主全局（__HOST_REACT__ / __HOST_REACT_DOM__），
// 与插件沙箱共享同一 React 实例，确保 @tiptap/react 的 hooks（useEditor / EditorContent）正常工作。
// react/jsx-runtime 则随包体一起打包，并回退到宿主 react，无需额外处理。
import { Editor, EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';

window.__EXT_TIPTAP__ = {
  Editor,
  EditorContent,
  useEditor,
  StarterKit,
  Image,
  Link,
  Placeholder,
  Table,
  TableRow,
  TableHeader,
  TableCell,
  TextAlign,
  Underline,
};
