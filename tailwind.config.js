/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./plugins/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Android v1 移动端断点（§7.3 / §9.4.2）。
      // 🔴 必须用 md-win / lg-win 语义键，绝不复用 md / lg ——
      // 后者会覆盖 Tailwind 默认断点（md=768 / lg=1024），破坏桌面端既有响应式样式（L0-8 回归）。
      // 语义：compact <600 / medium 600–839 / expanded ≥840（dp）
      screens: {
        'md-win': '600px',
        'lg-win': '840px',
      },
      colors: {
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        outline: "oklch(var(--outline) / <alpha-value>)",
        "outline-ring": "oklch(var(--outline-ring) / <alpha-value>)",
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
      },
      borderRadius: {
        xl: "var(--radius-xl)",
        full: "var(--radius-full)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        card: "var(--shadow-md)",
        pop: "var(--shadow-lg)",
        float: "var(--shadow-xl)",
      },
      transitionTimingFunction: {
        standard: "var(--ease-standard)",
        out: "var(--ease-out)",
      },
      transitionDuration: {
        fast: "var(--dur-fast)",
        base: "var(--dur-base)",
        slow: "var(--dur-slow)",
      },
    },
  },
  plugins: [],
}