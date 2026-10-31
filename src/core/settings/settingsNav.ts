// 设置页导航（供命令面板/其他入口请求打开指定 tab）
// 背景：GlobalSettingsPanel 是懒挂载的，直接 dispatch 事件时组件可能还没挂上。
// 这里用模块级 pending 记录“挂载后应打开的 tab”，挂载时 consume 一次。
export type SettingsTab =
  | 'general'
  | 'themes'
  | 'extensions'
  | 'transfer'
  | 'model'
  | 'blacklist'
  | 'about';

let pending: SettingsTab | null = null;

export function requestSettingsTab(tab: SettingsTab): void {
  pending = tab;
  window.dispatchEvent(new CustomEvent('open-global-settings', { detail: { tab } }));
}

export function consumePendingSettingsTab(): SettingsTab | null {
  const t = pending;
  pending = null;
  return t;
}
