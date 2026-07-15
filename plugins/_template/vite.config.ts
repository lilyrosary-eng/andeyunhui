import { defineConfig } from 'vite';
import { createPluginConfig } from '../_shared/vite.shared.config';

// 所有插件共用同一套 IIFE + react 外部化构建配置（见 _shared/vite.shared.config.ts）。
// react / react-dom 由宿主在运行时注入（window.__HOST_REACT__ / __HOST_REACT_DOM__），
// 不会打进插件包，保证插件体积极小、且与宿主共享同一 React 实例。
export default defineConfig(createPluginConfig('MyPlugin'));
