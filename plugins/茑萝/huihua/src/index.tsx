/// <reference path="../../../global.d.ts" />
// 茑萝 · 绘画子插件
// 前端按 SAI2 的组分对齐：DocBar / QuickBar / StatusBar / 图层+导航器（宿主侧栏）/ 颜色+工具+笔刷（右侧 Dock）。
import { EditorShell } from './ui/EditorShell';
import { HuihuaSidebar } from './ui/Sidebar';
import { editor } from './store';

window.__PLUGIN_REGISTRY__.register({
  id: 'huihua',
  name: '绘画',
  iconName: 'Paintbrush',
  kind: 'module',
  visible: false,
  parent: 'niaoluo',
  category: '创作',
  desc: '图层化画布：多图层 / 画笔压感硬度 / 填充吸管 / 图片导入 / 缩放平移 / 导出',
  component: EditorShell,
  sidebar: HuihuaSidebar,
  destroy: () => editor.destroy(),
});
