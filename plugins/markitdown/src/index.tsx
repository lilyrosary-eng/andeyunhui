/// <reference path="../../global.d.ts" />
// MarkItDown 服务插件 — 文档格式转换辅助工具
// 不显示在导航栏，提供 Rust 命令供笔记编辑器/阅读模块调用：
//   - check_markitdown：检查 Python markitdown 是否可用
//   - convert_to_markdown：转换文件为 Markdown
//   - pick_file：文件选择对话框
const _React = window.__HOST_REACT__;

// 最小占位组件（service 插件不渲染，但接口要求提供）
function MarkitdownPlaceholder() {
  return null;
}

// 注册为 service 类型，不显示在导航栏
window.__PLUGIN_REGISTRY__.register({
  id: 'markitdown',
  name: '格式转换',
  iconName: 'FileText',
  kind: 'service',
  visible: false,
  component: MarkitdownPlaceholder,
  sidebar: undefined,
  settings: undefined,
});
