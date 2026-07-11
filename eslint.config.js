// ESLint Flat Config (ESLint v9+)
// 启用 react-hooks 规则，防止闭包陷阱和 Hook 误用
import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        HTMLAudioElement: 'readonly',
        HTMLVideoElement: 'readonly',
        HTMLElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLUnknownElement: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        DragEvent: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        Set: 'readonly',
        Map: 'readonly',
        Promise: 'readonly',
        Error: 'readonly',
        RegExp: 'readonly',
        JSON: 'readonly',
        Math: 'readonly',
        Date: 'readonly',
        Object: 'readonly',
        Array: 'readonly',
        String: 'readonly',
        Number: 'readonly',
        Boolean: 'readonly',
        parseInt: 'readonly',
        parseFloat: 'readonly',
        isNaN: 'readonly',
        isFinite: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        fetch: 'readonly',
        Image: 'readonly',
        Audio: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      'react-hooks': reactHooks,
    },
    rules: {
      ...typescript.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // 关键规则：Hook 顺序（error，防止真实 bug）与依赖完整性（warn）
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // react-hooks v7 引入的 React Compiler 感知规则，对合法惯用法（无状态图标动态查找、
      // mount 异步加载、ref 同步最新值）频繁误报，降为 warn 追踪，留作 P1/P2 增量优化
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/immutability': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['warn', { allowEmptyCatch: false }],
      'no-undef': 'off', // TypeScript 已处理
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'bundled-plugins/**',
      'plugins/*/dist/**',
      'src-tauri/**',
      '*.config.js',
      '*.config.ts',
      'eslint.config.js',
    ],
  },
];
