import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 生成插件 vite 配置 — 所有插件共享相同的 IIFE + external react 构建 配置。
 *
 * 用法（插件 vite.config.ts）：
 *   import { createPluginConfig } from '../_shared/vite.shared.config';
 *   export default createPluginConfig('MusicPlugin');
 */
export function createPluginConfig(pluginName: string) {
  return defineConfig({
    plugins: [react()],
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    build: {
      lib: {
        entry: 'src/index.tsx',
        formats: ['iife'],
        name: pluginName,
      },
      rollupOptions: {
        // react 和 react-dom 由宿主提供，不打包进插件
        external: ['react', 'react-dom'],
        output: {
          globals: {
            react: '__HOST_REACT__',
            'react-dom': '__HOST_REACT_DOM__',
          },
          entryFileNames: 'index.js',
        },
      },
      outDir: 'dist',
      emptyOutDir: true,
    },
  });
}
