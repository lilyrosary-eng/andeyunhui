/// <reference types="vite/client" />

import type { PluginRegistry, HostAPI } from '@/core/pluginRegistry';

declare global {
  interface Window {
    __HOST_REACT__: typeof import('react');
    __HOST_REACT_DOM__: typeof import('react-dom');
    __HOST_API__: HostAPI;
    __PLUGIN_REGISTRY__: PluginRegistry;
    __HOST_UI__: Record<string, unknown>;
  }
}

export {};