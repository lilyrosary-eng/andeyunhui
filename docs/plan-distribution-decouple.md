# 路线 A 执行计划：分发解耦

> 目标：安装包只含核心骨架，模块和重依赖在线下载。Rust 不改逻辑，仅加注释。

## 执行顺序

| 步骤 | 内容 | 文件 | 预估 |
|------|------|------|:---:|
| A1 | `generate_handler!` 按模块加分组注释 | `main.rs` | 10min |
| A2 | 创建插件清单生成脚本 | 新增 `scripts/gen-manifest.mjs` | 20min |
| A3 | 清单格式定义 + 示例输出 | 新增 `bundled-plugins/manifest.json` | 10min |
| A4 | 前端下载管理器 | `ExtensionManagerPanel.tsx` | 40min |
| A5 | 引导页（首次启动无模块时） | 新增组件 | 30min |
| A6 | 从 `bundle.resources` 移除 `bundled-plugins` + `external-deps` | `tauri.conf.json` | ⏸ 延后（需远程托管就绪） |
| A7 | 验证：全新安装 → 引导页 → 安装模块 → 生效 | 端到端 | ⚠ 待远程托管后测试 |

## 执行记录 (2026-07-11)

- **A1** ✅：`main.rs` generate_handler! 按模块加分组注释（核心 / 图片 / 音乐 / 视频 / 阅读 / 歌词 / WPS / 薄荷 / 截图）
- **A2** ✅：`scripts/gen-manifest.mjs` 创建，递归扫描 bundled-plugins 含 niuluo 子插件（10 个）
- **A3** ✅：清单格式确定（version/updated/plugins[]，含 id/name/version/parent/deps/size/files/hash）
- **A4** ✅：Rust 端新增 `install_bundled_plugin`（resource_dir→user_plugins 复制）+ `read_manifest`（三级候选路径）+ `install_plugin_file`（单文件写入）；前端 ExtensionManagerPanel 新增「可安装模块」列表+安装按钮（install_bundled_plugin 一次性复制）
- **A5** ✅：引导页——插件列表为空时显示「一键安装推荐模块」按钮
- **A6** ⏸：`bundle.resources` 移除延后。当前 `install_bundled_plugin` 以 resource_dir 为复制源，移除后需远程下载源替代
- **A7** ⏸：待远程托管就绪后验证

## 验证

- `cargo build` 零警告零错误
- `scripts/gen-manifest.mjs` 生成 10 个插件清单
- `deploy-plugins.mjs` 已集成 manifest 生成 + app_data 同步
- 前端 ExtensionManagerPanel lint 0 错误
- `install_bundled_plugin` + `install_plugin_file` + `read_manifest` 三个新命令已注册

## A1：generate_handler 分组注释

在 `main.rs` 的 `generate_handler!` 调用处，按模块归属加清晰的分隔注释。不改变任何命令名或注册顺序。

## A2：插件清单生成脚本

生成 `bundled-plugins/manifest.json`，包含每个插件的：
- `id`, `name`, `version`（从各 manifest.json 读取）
- `files`: 文件列表及其 sha256
- `size`: 总大小

此脚本在 `deploy-plugins.mjs` 之后执行，开发期每次 predev 刷新。

## A3：清单格式

```json
{
  "version": 1,
  "updated": "2026-07-11T...",
  "plugins": [
    {
      "id": "wps",
      "name": "办公",
      "version": "1.0",
      "parent": "niuluo",
      "description": "办公套件：文档、演示文件、表格",
      "size": 94200,
      "files": ["manifest.json", "index.js"],
      "hash": "sha256:..."
    }
  ]
}
```

## A4：下载管理器

在 `ExtensionManagerPanel` 中增加：
- 「可用模块」列表（从远程清单 / 本地 stub 加载）
- 每个模块的状态：已安装 / 可安装 / 有更新
- 「安装」按钮：下载 → 写入 `user_plugins/{id}/` → 自动热加载
- 进度条和错误处理

## A5：引导页

如果 `get_installed_plugins()` 返回空（首次启动无模块），显示引导页：
- 列出所有可安装模块
- 「一键安装推荐模块」按钮
- 「跳过，以后在扩展管理中安装」

## A6：移除 bundle.resources 中的模块

等 A4/A5 验证通过后，移除 `tauri.conf.json` 中的对应行。此后安装包不携带模块，首次启动走下载流程。

## A7：端到端验证

- 清空 app_data
- 启动应用 → 确认引导页出现
- 下载一个模块 → 确认自动加载
- 重启 → 确认模块保持
