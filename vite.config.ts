import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths"
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const host = process.env.TAURI_DEV_HOST;

// 哥特加载页 HTML（构建 / 开发时由 Vite 插件内联进 index.html，消除外部脚本依赖）
const root = process.cwd();
const lightPageHtml = readFileSync(resolve(root, "wait-page/waiting-page-light.html"), "utf-8");
const darkPageHtml  = readFileSync(resolve(root, "wait-page/waiting-page-dark.html"), "utf-8");
const LIGHT_B64 = Buffer.from(lightPageHtml).toString("base64");
const DARK_B64  = Buffer.from(darkPageHtml).toString("base64");

// https://vite.dev/config/
export default defineConfig(() => ({
  base: "./",
  plugins: [
    react(),
    tsconfigPaths(),
    {
      name: "inject-waiting-pages",
      transformIndexHtml: {
        order: 'pre',
        handler(html: string) {
          return html
            .replace("___WAITING_LIGHT_B64___", LIGHT_B64)
            .replace("___WAITING_DARK_B64___",  DARK_B64);
        },
      },
    },
  ],

    // === 强制去重 react / react-dom ===
  resolve: {
    dedupe: ["react", "react-dom"],
  },

  // === 预构建时明确包含它们，防止遗漏 ===
  optimizeDeps: {
    include: ["react", "react-dom"],
  },

  // === 多页入口：截图覆盖窗使用独立轻量 HTML（不加载主应用），实现「秒开」 ===
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        "screenshot-overlay": "screenshot-overlay.html",
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
