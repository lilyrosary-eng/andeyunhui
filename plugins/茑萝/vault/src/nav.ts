/// <reference path="../../../global.d.ts" />
// 密码库视图导航：宿主侧栏（PluginSidebar）与内容区是两个组件实例，
// 用一个模块级 pub/sub 同步当前视图，避免把状态塞进宿主 store。
const React = window.__HOST_REACT__;

export type VaultView = 'all' | 'favorites' | 'trash' | 'security' | 'settings';

type Listener = (v: VaultView) => void;

let current: VaultView = 'all';
const listeners = new Set<Listener>();

export function getVaultView(): VaultView {
  return current;
}

export function setVaultView(view: VaultView): void {
  current = view;
  for (const l of listeners) l(view);
}

export function subscribeVaultView(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVaultView(): VaultView {
  const [view, setView] = React.useState<VaultView>(getVaultView);
  React.useEffect(() => subscribeVaultView(setView), []);
  return view;
}
