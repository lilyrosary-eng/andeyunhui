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
    resolve: {
      // 关键：pnpm 符号链接下，每个 @codemirror/lang-* 的嵌套 node_modules
      // 会让 vite 把同一份 @codemirror/state 解析成多条路径并内联多份实例
      //（实测 ide 插件 bundle 内被打进 11 份 state），导致运行时
      // "multiple instances of @codemirror/state are loaded" instanceof 校验崩溃。
      // dedupe 强制这些包统一从项目根解析为唯一实例。对未用到 codemirror 的插件无副作用。
      dedupe: [
        '@codemirror/state',
        '@codemirror/view',
        '@codemirror/language',
        '@codemirror/commands',
        '@codemirror/search',
        '@codemirror/autocomplete',
        '@codemirror/lint',
        '@lezer/common',
        '@lezer/highlight',
        '@lezer/lr',
        'style-mod',
        'w3c-keyname',
        'crelt',
      ],
    },
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
