/// <reference path="../../../global.d.ts" />
// 茑萝 · 加密解密（crypto）子插件 — 专业级加密套件
// 四大工具：RSA 密钥对 / PGP 信封 / 密码强度审计 / 字典生成
// 设计原则：零外部依赖，全用浏览器原生 Web Crypto API + 纯 JS
const React = window.__HOST_REACT__;

import { CryptoModule, CryptoSidebar } from './CryptoModule';

window.__PLUGIN_REGISTRY__.register({
  id: 'crypto',
  name: '加密解密',
  iconName: 'KeyRound',
  kind: 'module',
  visible: false, // 子模块：仅出现在「茑萝」侧边栏列表
  parent: 'niaoluo',
  category: '加密安全',
  desc: 'RSA 密钥对 / PGP 信封 / 密码强度审计 / 字典生成',
  component: CryptoModule,
  sidebar: CryptoSidebar,
});
