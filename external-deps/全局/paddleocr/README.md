# 本地 OCR 依赖包（PaddleOCR PP-OCRv4）

纯前端 WASM/WebGL 推理，识别发生在 WebView2 内，**不增加 Rust 本体安装包体积**。
本目录是「依赖包」的源，构建后产出 `index.js`（引擎），连同 `models/` 一起经
`scripts/pack-mujin.mjs` 打成 `全局/paddleocr.mujin` 分发给用户。

## 目录结构
```
全局/paddleocr/
├── src/index.ts      # 引擎源码（onnxruntime-web + PP-OCRv4 det/rec 管线）
├── index.js          # 构建产物（esbuild IIFE，挂载 window.__EXT_PADDLEOCR__）
└── models/           # ONNX 模型 + 字符表（需自行下载，见 models/README.md）
```

## 构建
```
pnpm predev          # 触发 scripts/build-external-deps.mjs，生成 index.js
# 或单独构建：
node scripts/build-external-deps.mjs
```

## 打包为用户依赖包
```
node scripts/pack-mujin.mjs
# => dist-dlc/ext/全局/paddleocr.mujin
```

## 用户安装（侧载，复用现有热插拔逻辑）
1. 把 `paddleocr.mujin` 放入：`%APPDATA%\com.rosary.andengyuanhua\user_external_deps\`
2. 把 `ocr` 插件包 `.mufurong` 放入：`%APPDATA%\com.rosary.andengyuanhua\user_plugins\`
3. 应用通过 `notify` 监听自动解压并热插拔，无需重启。

## 引擎接口
`window.__EXT_PADDLEOCR__ = { recognize(dataUrl: string): Promise<string>, ready(): boolean }`
- `recognize`：接收图片 data URL，返回识别文本（按阅读顺序，行用 `\n` 连接）。
- 首次调用时按相对路径 `全局/paddleocr/models/*` 懒加载 ONNX 模型与字符表
  （二进制经 Rust 命令 `read_external_dep_bytes` 读取，无需 asset 协议）。
