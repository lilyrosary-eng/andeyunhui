/// <reference path="../../../global.d.ts" />
const React = window.__HOST_REACT__;

import { WpsEditor, WpsSidebar } from './WpsEditor';

// 注册为「茑萝」(niaoluo) 下的子模块，出现在 茑萝 侧边栏列表，点击后满高渲染。
// sidebar: WpsSidebar 复用绘画「母目录+子目录」模板，由宿主 ModuleSidebarShell 渲染，
// 与编辑器主体通过文档列表共享总线联动。
window.__PLUGIN_REGISTRY__.register({
  id: 'wps',
  name: '办公',
  iconName: 'FileText',
  kind: 'module',
  visible: false, // 子模块：不进入顶层图标栏，仅出现在「茑萝」侧边栏列表
  parent: 'niaoluo',
  category: '办公',
  desc: '办公套件：文档、演示文件、表格',
  component: WpsEditor,
  sidebar: WpsSidebar,
});
