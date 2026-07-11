/// <reference path="../../../global.d.ts" />
// 文本工具箱（gongjuxiang）— 把「乱码修复器」与「文本差异对比工具」两个桌面小工具
// 重写为本项目的 UI 风格，并作为单个插件挂到扩展中心（visible:false，不进导航）。
const React = window.__HOST_REACT__;

import { GongjuxiangModule } from './GongjuxiangModule';

window.__PLUGIN_REGISTRY__.register({
  id: 'gongjuxiang',
  name: '文本工具箱',
  iconName: 'Wrench',
  kind: 'module',
  visible: false,
  parent: 'niuluo',
  component: GongjuxiangModule,
  sidebar: undefined,
  settings: undefined,
});
