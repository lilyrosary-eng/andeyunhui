/// <reference path="../../../global.d.ts" />
// 茑萝 · 密码托管（vault）子插件
// 与 crypto 并列：crypto 负责 RSA/PGP/审计/字典，vault 负责「库 + 解锁 + 条目」。
// 加密全部在 Rust（src-tauri/src/services/vault_crypto.rs），前端拿不到 DK。

import { VaultModule, VaultSidebar } from './VaultModule';

window.__PLUGIN_REGISTRY__.register({
  id: 'vault',
  name: '密码托管',
  iconName: 'ShieldCheck',
  kind: 'module',
  visible: false,
  parent: 'niaoluo',
  category: '加密安全',
  desc: '本地密码库：主密码解锁 / 本机免密 / 备用码兜底 / 自动锁定',
  component: VaultModule,
  sidebar: VaultSidebar,
});
