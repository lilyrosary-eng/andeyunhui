import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 显式传根 tailwind 配置的绝对路径：插件子构建（vite 的 cwd=插件目录）会经 postcss-load-config
// 向上命中本配置并触发 tailwindcss，但其自身按 cwd 找 tailwind.config 会落空，
// 退回空 content 默认配置 → 既打印告警、生成的插件样式又缺工具类。
// 传绝对路径后，任意 cwd 下的构建都能用上根 tailwind.config.js 的完整 content 扫描，告警消除。
const tailwindConfigPath = join(__dirname, 'tailwind.config.js');

export default {
  plugins: {
    tailwindcss: { config: tailwindConfigPath },
    autoprefixer: {},
  },
}