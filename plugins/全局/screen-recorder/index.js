// 录屏服务插件 — 注册为 service 类型，不显示在导航栏。
// 录屏控制台（recorder-widget.html）由 Rust 后端 show_recorder_widget 命令创建独立窗口。
// 全局热键 Ctrl+Alt+R（Rust globalShortcut 注册）→ 派发 toggle-recorder-widget 事件 →
// 控制台窗口监听该事件，执行显隐 + 自动开始/停止录制。
//
// 此 index.js 仅完成插件注册（满足 PLUGIN_REGISTRY 接口要求），不渲染任何主界面 UI。
(function () {
  var React = window.__HOST_REACT__;

  function RecorderPlaceholder() {
    return null;
  }

  window.__PLUGIN_REGISTRY__.register({
    id: 'screen-recorder',
    name: '录屏',
    iconName: 'Video',
    kind: 'service',
    visible: false,
    component: RecorderPlaceholder,
    sidebar: undefined,
    settings: undefined,
    desc: '屏幕录制（Ctrl+Alt+R 开始/停止）',
  });
})();
