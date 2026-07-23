/// <reference path="../../global.d.ts" />
// 桌宠插件入口 — 常驻透明浮窗 + 设置（风格经「全局设置·常规」下发到浮窗）
//
// 架构约定（务必遵循，否则 dev 不生效）：
//   - 插件源码必须放在 plugins/<id>/，predev 的 deploy-plugins.mjs 会把它 vite build
//     成 dist/ 并复制到 bundled-plugins/<id>/。直接改 bundled-plugins/ 会被 cleanStalePlugins 清掉。
//   - 本插件 kind=service：不进入左侧导航栏图标栏（mainPluginIds 仅收 module），
//     但 visible:true 仍会被 PluginHost 加载并建浮窗；「茑萝」仍会列出它供启用/关闭。
//   - 宠物「素材」放在依赖包 external-deps/deskpet-assets/pet/pet.svg（.mujin 分发），
//     插件包只放核心组件（本文件 + 浮窗组件），符合「素材在依赖包、插件只放核心」的约定。
//   - 加载即建浮窗；禁用时脚本不执行，destroy 钩子销毁浮窗（热插拔）。

const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback } = React;
const hostApi = window.__HOST_API__ as any;

// 桌宠浮窗尺寸/素材由浮窗内 DeskpetPet 控制；本插件只负责建窗、推素材、热插拔。

const DESKPET_LABEL = 'deskpet';
const DESKPET_URL = 'deskpet.html';
const ASSET_REL = 'deskpet-assets/pet/pet.svg';
// 浮窗 Profile：透明、无边框、无阴影、不在任务栏、常驻最顶层
const PROFILE = {
  transparent: true,
  decorations: false,
  shadow: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  resizable: false,
};

// 创建浮窗（get_or_create，幂等）。窗口摆位由浮窗内 DeskpetPet 用宿主正确打包的
// @tauri-apps/api 完成（插件包未 externalize @tauri-apps/api，侧植入会导致第二份未初始化副本）。
async function ensurePet(): Promise<void> {
  await hostApi.createFloatingWindow(DESKPET_LABEL, DESKPET_URL, PROFILE);
}

// 读取依赖包素材（external-deps/deskpet-assets/pet/pet.svg）→ base64 → 发给浮窗渲染。
// 失败不致命：浮窗用内置 CSS 小球兜底（保证「看得见」）。
async function pushAsset() {
  try {
    const b64 = await hostApi.invoke('read_external_dep_bytes', { relativePath: ASSET_REL });
    if (b64) await hostApi.emit('deskpet:asset', b64);
  } catch (e) {
    console.warn('[桌宠] 依赖包素材读取失败，使用内置 CSS 小球兜底', e);
  }
}

// 加载即建浮窗 + 推素材（仅 visible 插件会被 PluginHost 执行；ensureOverlayWindow 为 get_or_create，幂等）
ensurePet()
  .then(() => pushAsset())
  .catch((e) => console.error('[桌宠] 创建浮窗失败', e));

// 浮窗就绪后主动来要素材（避免「插件先 emit、浮窗还没监听」的竞态导致永远用兜底小球）
hostApi.listen('deskpet:request-asset', () => {
  void pushAsset();
}).catch(() => {});

// 监听可见性热插拔：运行时从「关→开」补充创建，从「开→关」销毁（与 ExtensionManagerPanel 派发的事件对齐）
let unlisten: (() => void) | null = null;
hostApi
  .listen('plugin-visibility-changed', (e: { payload?: { id?: string; visible?: boolean } }) => {
    const { id, visible } = e.payload || {};
    if (id !== DESKPET_LABEL) return;
    if (visible) {
      ensurePet().then(() => pushAsset()).catch(() => {});
    } else {
      hostApi.invoke('overlay_window_destroy', { label: DESKPET_LABEL }).catch(() => {});
    }
  })
  .then((u: () => void) => {
    unlisten = u;
  })
  .catch(() => {});

// ========== 占位组件（PluginDef.component 必填；service 插件不进导航栏、不会被当主模块渲染）==========
function DeskpetPlaceholder() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full gap-3 text-neutral-400 dark:text-stone-500">
      <span className="text-sm">桌宠正在你的桌面上散步 🐾</span>
      <span className="text-xs">在「全局设置 · 常规」或「茑萝」中可开关桌宠。</span>
    </div>
  );
}

// ========== 注册 ==========
// 注意：本插件不挂 settings（避免本插件在导航栏出现图标）；常规页仅保留「桌宠显示」开关。
window.__PLUGIN_REGISTRY__.register({
  id: DESKPET_LABEL,
  name: '桌宠',
  iconName: 'Sparkles',
  kind: 'service',
  visible: true,
  component: DeskpetPlaceholder,
  // 卸载/禁用时清理监听并销毁浮窗（热插拔，避免孤儿窗）
  destroy: () => {
    if (unlisten) unlisten();
    hostApi.invoke('overlay_window_destroy', { label: DESKPET_LABEL }).catch(() => {});
  },
});
