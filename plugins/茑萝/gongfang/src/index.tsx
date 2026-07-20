/// <reference path="../../../global.d.ts" />
// 茑萝 · 攻防（gongfang）子插件 — 安全攻防套件
// 四大框架：网络爬虫 / 逆向工程 / 渗透测试 / 自动化测试
// 设计原则：攻防一体、专业合法、极致高效、稳定防追踪
// 当前为 UI 骨架占位，后续按框架逐步填充能力。
const React = window.__HOST_REACT__;

import { GongfangModule, GongfangSidebar } from './GongfangModule';

window.__PLUGIN_REGISTRY__.register({
  id: 'gongfang',
  name: '攻防',
  iconName: 'Shield',
  kind: 'module',
  visible: false, // 子模块：仅出现在「茑萝」侧边栏列表
  parent: 'niaoluo',
  category: '安全攻防',
  desc: '安全攻防套件：爬虫 / 逆向 / 渗透 / 自动化',
  component: GongfangModule,
  sidebar: GongfangSidebar,
});
