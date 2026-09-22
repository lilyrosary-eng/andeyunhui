// 黄金棋盘（原灵动岛）子插件 —— 作为「茑萝」的子插件承载。
// 功能本身由核心浮窗（src/Capsule.tsx，随主包经 ?floating=capsule 渲染）+ Rust 窗口管理层提供；
// 本插件仅负责：在「茑萝」侧栏作为子模块出现，并据插件可见性热插拔胶囊窗。
//
// 关键设计（仿 桌宠，解决「开关不联动 / 看不到」）：
//  - 启用/停用由「全局设置 → 茑萝 → 显示黄金棋盘」或「管理拓展」统一驱动，二者共用插件可见性
//    单一事实源（setPluginVisibility + pluginHot.load/unload + plugin-visibility-changed 事件）。
//  - 真正建/销窗在本插件内：加载即建窗（ensureCapsule），并监听 plugin-visibility-changed 热插拔。
//  - manifest.visible=false：默认不随启动加载，不绕过主程序安得云荟，须用户显式开启。
//  - 主面板保持空白（返回 null），后续功能待扩展。

(function () {
  var hostApi = window.__HOST_API__;
  var registry = window.__PLUGIN_REGISTRY__;
  var CAPSULE_LABEL = 'capsule';
  var CAPSULE_URL = 'index.html?floating=capsule';
  var PROFILE = {
    transparent: true,
    decorations: false,
    shadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: false,
  };

  // 单飞（single-flight）：并发召唤共用同一次建窗。
  // 启动期会有多条召唤链同时发生——插件加载即建、可见性事件、侧栏点击——它们各自
  // 「先 destroy 再 create」时会互相拆台：A 刚 build 好，B 的 destroy 就把它干掉，
  // 最终 5 次重试全败、胶囊凭空消失（需重启才恢复）。改为单飞后，后来的调用直接复用
  // 在飞的那次创建，配合 ensureOverlayWindow「复用优先」语义，不会再有互拆。
  // 注意：不再在入口做 destroy。停用场景由下方可见性分支与 destroy 钩子负责销毁，
  // 重新启用时窗已不存在，自然走新建；健康窗一律复用（重建整个 WebView2 代价数秒）。
  var inflight = null;
  function ensureCapsule() {
    if (inflight) return inflight;
    inflight = Promise.resolve(
      hostApi.createFloatingWindow(CAPSULE_LABEL, CAPSULE_URL, PROFILE)
    ).then(
      function (w) { inflight = null; return w; },
      function (e) { inflight = null; throw e; }
    );
    return inflight;
  }
  ensureCapsule().catch(function (e) {
    console.error('[黄金棋盘] 创建浮窗失败', e);
  });

  // 可见性热插拔：启用/停用统一由「全局设置 → 茑萝」或「管理拓展」驱动
  var unlisten = null;
  hostApi.listen('plugin-visibility-changed', function (e) {
    var payload = (e && e.payload) ? e.payload : {};
    if (payload.id !== CAPSULE_LABEL) return;
    if (payload.visible) {
      ensureCapsule().catch(function () {});
    } else {
      hostApi.invoke('overlay_window_destroy', { label: CAPSULE_LABEL }).catch(function () {});
    }
  }).then(function (u) { unlisten = u; }).catch(function () {});

  // 侧边栏「黄金棋盘」点击：HostSidebar 派发 capsule:show，确保浮窗被弹出（幂等，已存在则复用）。
  // 这样点击侧栏项只弹浮窗、不切到空面板、不回退到笔记模块。
  try {
    window.addEventListener('capsule:show', function () {
      ensureCapsule().catch(function (e) { console.error('[黄金棋盘] 弹出浮窗失败', e); });
    });
  } catch (_) { /* ignore */ }

  // 占位主组件：返回 null，主面板保持空白（仿 RAG 的 RagPlaceholder）
  function CapsulePlaceholder() {
    return null;
  }

  registry.register({
    id: CAPSULE_LABEL,
    name: '黄金棋盘',
    iconName: 'LayoutGrid',
    kind: 'module',
    visible: false,
    parent: 'niaoluo',
    component: CapsulePlaceholder,
    desc: '屏幕顶部居中常驻的黄金棋盘，后续功能待扩展。',
    codename: '茑萝',
    destroy: function () {
      if (unlisten) { try { unlisten(); } catch (_) { /* ignore */ } }
      hostApi.invoke('overlay_window_destroy', { label: CAPSULE_LABEL }).catch(function () {});
    },
  });
})();
