/// <reference types="vite/client" />

declare global {
  interface Window {
    __HOST_REACT__: typeof import('react');
    __HOST_REACT_DOM__: typeof import('react-dom');
    __HOST_API__: import('@/core/pluginRegistry').HostAPI;
    __PLUGIN_REGISTRY__: import('@/core/pluginRegistry').PluginRegistry;
    __HOST_UI__: Record<string, unknown>;
  }
}

export {};