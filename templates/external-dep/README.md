# 外部依赖模板（external-deps）

当你需要 CodeMirror、TipTap 这类「重 JS 库」时，不要打包进插件本体，而是作为**外部依赖**：单独打成 IIFE，运行时由插件经 `read_external_dep_file` + `new Function` 按需加载。好处：插件包保持极轻、重库可被多个插件复用、且只在用到时才加载。

## 目录约定

- `external-deps/_build/<dep>-entry.js` —— **构建入口源**（你写的打包入口）。注意：该目录已被 `.gitignore` 忽略（仅本地、可重建），所以**不要把它当作分发来源**。
- `external-deps/<relpath>/index.js` —— **构建产物**（IIFE），被提交并随应用打包分发；插件运行时读的就是它。
- `templates/external-dep/entry.js` —— **本模板源**，随仓库分发，是复制起点。

## 步骤

1. **安装库**：在根 `package.json` 的 `dependencies`（或 `devDependencies`）加入该库，然后 `pnpm install`。
   ```bash
   pnpm add codemirror @codemirror/lang-javascript
   ```

2. **写入口**：复制 `templates/external-dep/entry.js` 到 `external-deps/_build/<dep>-entry.js`，按注释填写 import 与挂载（`window.__EXT_<DEP>__ = { ... }`）。
   - 纯 JS 库（CodeMirror 类）：直接 `import` 并挂载到全局。
   - 依赖 React 的库（TipTap 类）：**必须**把 `react` / `react-dom` 外部化到宿主全局（与插件沙箱共享同一 React 实例），`scripts/build-external-deps.mjs` 已内置 `host-externals` 插件完成此工作，入口里直接 `import` 即可。

3. **登记构建目标**：在 `scripts/build-external-deps.mjs` 的 `TARGETS` 数组追加一项：
   ```js
   { outDir: '茑萝/myplugin/mydep', entry: 'mydep-entry.js', global: '__EXT_MYDEP__' },
   ```
   `outDir` 是相对 `external-deps/` 的输出目录，`entry` 是 `_build/` 下的入口文件名，`global` 是 IIFE 内部全局名（仅打包用，不影响挂载）。

4. **构建**：
   ```bash
   node scripts/build-external-deps.mjs
   ```
   该脚本已接入 `pnpm predev`，开发启动会自动重建。`external-deps/茑萝/myplugin/mydep/index.js` 即生成。

5. **声明与加载**：在插件 `manifest.json`：
   ```json
   { "deps": ["mydep"], "requiredAssets": ["茑萝/myplugin/mydep/index.js"] }
   ```
   插件里加载（沙箱已因 `deps` 放开 `Function`）：
   ```ts
   const w = window as any;
   if (w.__EXT_MYDEP__) return w.__EXT_MYDEP__;
   const code = await hostApi.invoke<string>('read_external_dep_file', { relativePath: '茑萝/myplugin/mydep/index.js' });
   if (!code) throw new Error('外部依赖未找到');
   new Function(code)();           // 全局作用域执行，挂载到 window.__EXT_MYDEP__
   return w.__EXT_MYDEP__;
   ```

## 注意

- `external-deps/_build/` 被 gitignore 忽略：入口源只在本地存在，**不要**把重要依赖的「唯一来源」只放在 `_build`；本 `templates/external-dep/entry.js` 才是随仓库分发的模板。若希望入口源也入库，可调整 `.gitignore` 或把真实入口放在别处（如本 `templates/` 下）。
- 加载失败不要静默降级到内联实现（除非必要）；参考 `plugins/茑萝/ide` 给出明确错误与构建提示，便于排查。
- Windows 下 `read_external_dep_file` 会规范化路径（含 `\\?\` 前缀）做越界防护，正常无需关心。
