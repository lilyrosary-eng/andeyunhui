/// <reference path="../../global.d.ts" />
// 桌宠插件入口 — 常驻透明浮窗 + 设置面板（风格切换经 Tauri 事件下发到浮窗）
//
// 架构约定（务必遵循，否则 dev 不生效）：
//   - 插件源码必须放在 plugins/<id>/，predev 的 deploy-plugins.mjs 会把它 vite build
//     成 dist/ 并复制到 bundled-plugins/<id>/。直接改 bundled-plugins/ 会被 cleanStalePlugins 清掉。
//   - PluginHost 只加载 visible:true 的插件，因此本脚本「加载即建浮窗」是安全的；
//     禁用时脚本不执行，destroy 钩子负责销毁浮窗（热插拔）。

const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback } = React;
const hostApi = window.__HOST_API__;

// 与 src/components/DeskpetPet.tsx 对齐
type StyleKey = 'bounce' | 'float' | 'idle';
const STYLES: StyleKey[] = ['bounce', 'float', 'idle'];

const DESKPET_LABEL = 'deskpet';
const DESKPET_URL = 'deskpet.html';
// 浮窗 Profile：透明、无边框、无阴影、不在任务栏、常驻最顶层
const PROFILE = {
  transparent: true,
  decorations: false,
  shadow: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  resizable: false,
};

function ensurePet() {
  return hostApi.createFloatingWindow(DESKPET_LABEL, DESKPET_URL, PROFILE);
}

function destroyPet() {
  return hostApi.invoke('overlay_window_destroy', { label: DESKPET_LABEL }).catch(() => {});
}

// 加载即建浮窗（仅 visible 插件会被 PluginHost 执行；ensureOverlayWindow 为 get_or_create，幂等）
ensurePet().catch((e) => console.error('[桌宠] 创建浮窗失败', e));

// 监听可见性热插拔：运行时从「关→开」补充创建，从「开→关」销毁（与 ExtensionManagerPanel 派发的事件对齐）
let unlisten: (() => void) | null = null;
hostApi
  .listen('plugin-visibility-changed', (e: { payload?: { id?: string; visible?: boolean } }) => {
    const { id, visible } = e.payload || {};
    if (id !== DESKPET_LABEL) return;
    if (visible) ensurePet().catch(() => {});
    else destroyPet();
  })
  .then((u) => {
    unlisten = u;
  })
  .catch(() => {});

// ========== 图标 ==========
function PetIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="13" r="7" />
      <circle cx="9.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <path d="M9 8.5 7.5 5M15 8.5 16.5 5" />
    </svg>
  );
}

// ========== 主界面模块视图（导航栏「桌宠」模块）==========
function DeskpetPanelInner() {
  const [style, setStyle] = useState<StyleKey>('bounce');

  useEffect(() => {
    const un = hostApi.listen('deskpet:set-style', (e: { payload?: StyleKey }) => {
      if (e.payload) setStyle(e.payload);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full gap-4 text-neutral-400 dark:text-stone-500">
      <PetIcon />
      <p className="text-sm">桌宠正在你的桌面上散步 🐾</p>
      <p className="text-xs">
        当前风格：<span className="text-[var(--element-bg)] font-medium">{style}</span>
      </p>
      <p className="text-xs text-neutral-400 dark:text-stone-500 max-w-xs text-center">
        在「全局设置 · 常规」或「茑萝」中可开关桌宠；点击右侧设置图标可切换风格。
      </p>
    </div>
  );
}

// ========== 设置面板 ==========
function DeskpetSettingsInner({ onClose }: { onClose: () => void }) {
  const ModuleSettingsPanel = (window.__HOST_UI__ as Record<string, unknown>)?.ModuleSettingsPanel as
    | React.FC<{ title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode }>
    | undefined;
  const [style, setStyle] = useState<StyleKey>('bounce');

  if (!ModuleSettingsPanel) return null;

  const pick = (s: StyleKey) => {
    setStyle(s);
    // 跨 WebView 下发到桌宠浮窗（DeskpetPet.tsx 监听 deskpet:set-style）
    hostApi.emit('deskpet:set-style', s).catch(() => {});
  };

  return React.createElement(
    ModuleSettingsPanel,
    { title: '桌宠', icon: React.createElement(PetIcon), onClose },
    React.createElement(
      'div',
      { className: 'space-y-3' },
      React.createElement('label', { className: 'block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2' }, '宠物风格'),
      ...STYLES.map((s) =>
        React.createElement(
          'button',
          {
            key: s,
            onClick: () => pick(s),
            className:
              'w-full flex items-center justify-between px-3 py-2 rounded-lg border transition-colors ' +
              (style === s
                ? 'border-[var(--element-bg)] bg-[var(--element-bg)]/10 text-[var(--element-bg)]'
                : 'border-neutral-200 dark:border-stone-700 hover:bg-neutral-50 dark:hover:bg-stone-800'),
          },
          React.createElement('span', { className: 'text-sm' }, s),
          style === s ? React.createElement('span', { className: 'text-xs' }, '✓') : null,
        ),
      ),
      React.createElement(
        'p',
        { className: 'text-xs text-neutral-400 dark:text-stone-500 pt-1' },
        '风格实时生效，无需重启。',
      ),
    ),
  );
}

// ========== 注册 ==========
window.__PLUGIN_REGISTRY__.register({
  id: DESKPET_LABEL,
  name: '桌宠',
  iconName: 'Sparkles',
  kind: 'module',
  visible: true,
  component: DeskpetPanelInner,
  settings: DeskpetSettingsInner,
  // 卸载/禁用时清理监听并销毁浮窗（热插拔，避免孤儿窗）
  destroy: () => {
    if (unlisten) unlisten();
    destroyPet();
  },
});
