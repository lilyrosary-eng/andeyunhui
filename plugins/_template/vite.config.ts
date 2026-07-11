import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 替换 process.env.NODE_ENV，避免浏览器环境报错
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: 'src/index.tsx',
      formats: ['iife'],
      name: 'MyPlugin',
    },
    rollupOptions: {
      // react 和 react-dom 由宿主提供，不打包进插件
      external: ['react', 'react-dom'],
      output: {
        globals: {
          react: '__HOST_REACT__',
          'react-dom': '__HOST_REACT_DOM__',
        },
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
});