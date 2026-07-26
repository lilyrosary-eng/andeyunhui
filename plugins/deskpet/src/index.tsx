/// <reference path="../../global.d.ts" />
import React from "react";
// 桌宠插件入口 — 常驻透明浮窗 + 多素材下发（keyed）+ Phase A 基础设置桥接
//
// 架构约定（务必遵循，否则 dev 不生效）：
//   - 插件源码必须放在 plugins/<id>/，predev 的 deploy-plugins.mjs 会把它 vite build
//     成 dist/ 并复制到 bundled-plugins/<id>/。直接改 bundled-plugins/ 会被 cleanStalePlugins 清掉。
//   - 本插件 kind=service：不进入左侧导航栏图标栏，但 visible:true 仍会被 PluginHost 加载并建浮窗。
//   - 宠物「素材」放在依赖包 external-deps/deskpet-assets/pet/（.mujin 分发），
//     插件包只放核心组件（本文件 + 浮窗组件），符合「素材在依赖包、插件只放核心」的约定。
//   - 加载即建浮窗；禁用时脚本不执行，destroy 钩子销毁浮窗（热插拔）。
//
// 素材与设置数据走向（双路加载）：
//   主路：浮窗（src/components/DeskpetPet.tsx）直接 invoke('read_external_dep_path') 取绝对路径
//   → convertFileSrc 映射为 asset:// URL 渲染（首选，无中继、无载荷上限）。
//   兜底：浮窗独立 webview 调用该命令失败/无权限时，浮窗 emit 'deskpet:request-asset'
//   事件，由本插件（在主窗，invoke 权限确定）经 hostApi.invoke 取同一绝对路径，
//   再用 hostApi.convertFileSrc 映射为 asset:// URL，全局 emit 'deskpet:asset' 事件（{key,url}）下发；
//   浮窗 listen 后直接作为 src 渲染。事件广播不需要权限，故兜底通道在「浮窗直读失败」时仍能打通。
//   两层都成功也无害（浮窗 applyAssetUrl 有 !assetsRef.current[key] 去重）。
//
//   设置：GlobalSettingsPanel 写 localStorage['deskpet:settings'] 并全局 emit
//   'deskpet:settings'（浮窗直接收到）；插件监听同一事件更新缓存并持久化，
//   并在浮窗 emit 'deskpet:request-settings' 时回复当前缓存值。

const hostApi = window.__HOST_API__ as any;

// 桌宠浮窗尺寸/素材由浮窗内 DeskpetPet 控制；本插件只负责建窗、热插拔、基础设置桥接。
// 素材清单（key/rel/mime）与浮窗一致，见下方 ASSETS（本插件作为兜底中继通道恢复，主路仍由浮窗直读）。

const DESKPET_LABEL = 'deskpet';
const DESKPET_URL = 'deskpet.html';
const SETTINGS_KEY = 'deskpet:settings';

// 浮窗 Profile：透明、无边框、无阴影、不在任务栏、常驻最顶层
const PROFILE = {
  transparent: true,
  decorations: false,
  shadow: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  resizable: false,
};

interface DeskpetSettings {
  scale: number;
  opacity: number;
  clickThrough: boolean;
}

function defaultSettings(): DeskpetSettings {
  return { scale: 1, opacity: 1, clickThrough: false };
}

function loadSettings(): DeskpetSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<DeskpetSettings>;
      return {
        scale: typeof p.scale === 'number' ? p.scale : 1,
        opacity: typeof p.opacity === 'number' ? p.opacity : 1,
        clickThrough: typeof p.clickThrough === 'boolean' ? p.clickThrough : false,
      };
    }
  } catch {
    /* 解析失败使用默认值 */
  }
  return defaultSettings();
}

// 插件进程内缓存（主窗 webview 可读 localStorage）
let currentSettings: DeskpetSettings = loadSettings();

// 创建浮窗（get_or_create，幂等）。窗口摆位由浮窗内 DeskpetPet 用宿主正确打包的
// @tauri-apps/api 完成（插件包未 externalize @tauri-apps/api，侧植入会导致第二份未初始化副本）。
async function ensurePet(): Promise<void> {
  await hostApi.createFloatingWindow(DESKPET_LABEL, DESKPET_URL, PROFILE);
}

// 素材兜底中转：浮窗直读失败/无权限时 emit 'deskpet:request-asset'，
// 携带 items:[{key, rel, mime}]，本插件（主窗权限确定）按 rel 经 hostApi.invoke 取绝对路径，
// 再用 hostApi.convertFileSrc 映射为 asset:// URL，全局 emit 'deskpet:asset' 事件 {key, url}
// （事件广播不需要权限）。asset 协议对大文件无载荷限制，避免 base64 超 IPC 上限导致破图。
hostApi
  .listen('deskpet:request-asset', (e: { payload?: { items?: Array<{ key: string; rel: string; mime: string }> } }) => {
    const items = e?.payload?.items || [];
    for (const it of items) {
      if (!it?.rel) continue;
      hostApi
        .invoke('read-external-dep-path', { relativePath: it.rel })
        .then((absPath: string) => {
          if (absPath) {
            const url = hostApi.convertFileSrc(absPath);
            hostApi.emit('deskpet:asset', { key: it.key, url }).catch(() => {});
          }
        })
        .catch((err: unknown) => console.warn('[桌宠] 中转素材失败:', it.rel, err));
    }
  })
  .catch(() => {});

// 素材清单 manifest：浮窗启动时 emit 'deskpet:request-manifest' 来取最新清单，
// 本插件从 localStorage（主窗 webview，与设置面板同源）回复；面板更新时同步缓存。
const MANIFEST_KEY = 'deskpet:manifest';
hostApi
  .listen('deskpet:request-manifest', () => {
    try {
      const raw = localStorage.getItem(MANIFEST_KEY);
      const m = raw ? JSON.parse(raw) : null;
      // 陈旧清单（引用已更名的 idle1/idle2、中文 常态* 或文件名与当前缺省不符）回发 null，
      // 并清除主窗 stale 缓存，让浮窗保留本地缺省清单，避免覆盖为失效素材。
      // 旧文件名（idle1/idle2、中文 常态*）或内置默认清单结构版本过低（无 user_external_deps 自定义素材、
      // 且缺省 idle 帧集合已变更如新增 idleup/idledown/idleright）→ 视为陈旧回退缺省。
      const hasUser =
        m && Array.isArray(m.states) &&
        m.states.some((s: any) => (s.assets || []).some((a: any) => (a.rel || '').includes('user_external_deps')));
      const schemaStale = !hasUser && !(m && (m as any).schemaVersion >= 2);
      const isLegacy =
        schemaStale ||
        (m && Array.isArray(m.states) &&
          m.states.some((s: any) =>
            (s.assets || []).some((a: any) =>
              ['idle1.png', 'idle2.png', 'idle1', 'idle2', '常态'].some((tok: string) =>
                (a.rel || a.file || '').toLowerCase().includes(tok),
              ),
            ),
          ));
      if (isLegacy) {
        try {
          localStorage.removeItem(MANIFEST_KEY);
        } catch {
          /* 忽略 */
        }
        hostApi.emit('deskpet:manifest', null).catch(() => {});
        return;
      }
      hostApi.emit('deskpet:manifest', m && Array.isArray(m.states) && m.states.length ? m : null).catch(() => {});
    } catch {
      hostApi.emit('deskpet:manifest', null).catch(() => {});
    }
  })
  .catch(() => {});

hostApi
  .listen('deskpet:manifest', (e: { payload?: any }) => {
    const m = e?.payload;
    if (m && Array.isArray(m.states)) {
      try {
        localStorage.setItem(MANIFEST_KEY, JSON.stringify(m));
      } catch {
        /* 忽略持久化失败 */
      }
    }
  })
  .catch(() => {});

// 加载即建浮窗（素材由浮窗直读，仅在直读失败时才走上面的兜底中继）
ensurePet().catch((e) => console.error('[桌宠] 创建浮窗失败', e));

// 基础设置：面板变更后全局 emit 同名字件，浮窗直接收到并应用；
// 此处仅更新进程内缓存并持久化（不再二次 emit 同名事件，避免 Tauri 全局 emit 回环）。
// 同时：浮窗挂载时 emit 'deskpet:request-settings' 来取初始值，这里重读 localStorage 回复最新值。
hostApi
  .listen('deskpet:settings', (e: { payload?: Partial<DeskpetSettings> }) => {
    const p = e?.payload;
    if (!p) return;
    currentSettings = {
      scale: typeof p.scale === 'number' ? p.scale : currentSettings.scale,
      opacity: typeof p.opacity === 'number' ? p.opacity : currentSettings.opacity,
      clickThrough: typeof p.clickThrough === 'boolean' ? p.clickThrough : currentSettings.clickThrough,
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings));
    } catch {
      /* 忽略持久化失败 */
    }
  })
  .catch(() => {});

hostApi
  .listen('deskpet:request-settings', () => {
    // 重读 localStorage，确保回复面板已写入的最新值（与 Tauri emit 是否回显到本窗无关）
    currentSettings = loadSettings();
    hostApi.emit('deskpet:settings', currentSettings).catch(() => {});
  })
  .catch(() => {});

// 监听可见性热插拔：运行时从「关→开」补充创建，从「开→关」销毁（与 ExtensionManagerPanel 派发的事件对齐）
let unlisten: (() => void) | null = null;
hostApi
  .listen('plugin-visibility-changed', (e: { payload?: { id?: string; visible?: boolean } }) => {
    const { id, visible } = e.payload || {};
    if (id !== DESKPET_LABEL) return;
    if (visible) {
      // 确保浮窗存在（素材由浮窗直读，仅在直读失败时才走兜底中继）
      ensurePet().catch(() => {});
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
  return React.createElement(
    'div',
    {
      className:
        'flex-1 flex flex-col items-center justify-center h-full gap-3 text-neutral-400 dark:text-stone-500',
    },
    React.createElement('span', { className: 'text-sm' }, '桌宠正在你的桌面上散步 🐾'),
    React.createElement(
      'span',
      { className: 'text-xs' },
      '在「全局设置 · 常规」或「茑萝」中可开关桌宠。',
    ),
  );
}

// ========== 注册 ==========
// 注意：本插件不挂 settings（避免本插件在导航栏出现图标）；常规页仅保留「桌宠显示」开关与基础设置。
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
