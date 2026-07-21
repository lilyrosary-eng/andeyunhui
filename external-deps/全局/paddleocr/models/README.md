# 模型与字符表（需自行下载，不入库）

将以下文件放入本目录后，再运行 `pack-mujin.mjs` 打包 `paddleocr.mujin`。
均来自 PaddleOCR 官方模型库（Apache-2.0），文件名需与本列表一致。

| 文件 | 说明 | 来源 |
| :--- | :--- | :--- |
| `ch_PP-OCRv4_det_infer.onnx` | 检测模型（DB 文本区域） | PaddleOCR 官方 PP-OCRv4 det onnx 导出 |
| `ch_PP-OCRv4_rec_infer.onnx` | 识别模型（CRNN + CTC） | PaddleOCR 官方 PP-OCRv4 rec onnx 导出 |
| `ppocr_keys_v1.txt`          | 中文字符表（6626 行） | PaddleOCR 仓库 `ppocr/utils/ppocr_keys_v1.txt` |

下载与导出提示：
- 检测/识别模型：从 PaddleOCR 的模型导出脚本（`tools/export_model`）或官方提供的 onnx 版本获取。
  引擎假设检测输出为 `[1,1,H,W]` 概率图（含 sigmoid），识别输入为 `[1,3,48,320]` 动态宽度，
  字符表类别数 = `ppocr_keys_v1.txt` 行数 + 1（末位为 CTC blank）。
- 若你的模型输入形状不同（如识别高度为 32 或固定宽度），调整 `src/index.ts` 中的
  `recW` 计算与 `det` 缩放阈值（`maxSide = 960`）即可。
