//! Markdown/pptx/docx 转换（LibreOffice/WPS）
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
/// 调用原生解析器将文件转换为 Markdown（无需 Python，毫秒级；PDF 也能出图）。
/// 同时把原始文档存入图标栏中转站（dropzone），解析出的图片仅用于预览、不进中转站列表。
#[tauri::command]
pub async fn convert_to_markdown(app: tauri::AppHandle, file_path: String) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // 原生文档解析（OOXML / PDF）可能很慢且同步阻塞，
    // 放到专用阻塞线程，避免卡住 Tauri 命令通道（阅读模块已采用此方式）。
    let fp = file_path.clone();
    let ad = app_data.clone();
    let parsed = tauri::async_runtime::spawn_blocking(move || {
        document_parser::convert_document_to_markdown(&fp, &ad)
    })
    .await
    .map_err(|e| format!("解析线程异常: {}", e))??;
    // 原始文档存入图标栏中转站（轻量，主线程即可）
    let _ = copy_file_to_dropzone(&app_data, &file_path, None, None);
    Ok(parsed)
}

/// wps 文档编辑器：将 TipTap 文档 JSON 导出为 .docx 文件。
#[tauri::command]
pub fn wps_export_docx(app: tauri::AppHandle, plugin_id: Option<String>, path: String, json: String) -> Result<(), String> {
    crate::services::plugin_access::ensure_plugin_write(&app, plugin_id.as_deref(), &path)?;
    let bytes = crate::services::docx_wps::json_to_docx(&json)?;
    std::fs::write(&path, &bytes).map_err(|e| format!("写入 {} 失败: {}", path, e))?;
    Ok(())
}

/// wps 演示文件编辑器：将幻灯片 JSON 导出为 .pptx 文件（PresentationML）。
#[tauri::command]
pub fn wps_export_pptx(app: tauri::AppHandle, plugin_id: Option<String>, path: String, json: String) -> Result<(), String> {
    crate::services::plugin_access::ensure_plugin_write(&app, plugin_id.as_deref(), &path)?;
    let bytes = crate::services::pptx_wps::json_to_pptx(&json)?;
    std::fs::write(&path, &bytes).map_err(|e| format!("写入 {} 失败: {}", path, e))?;
    Ok(())
}

/// wps 演示文件编辑器：从 .pptx 文件导入为幻灯片 JSON。
///
/// 图片以本地文件形式落盘到 app_data/pptx_media/，src 仅记录路径（前端用 asset: 协议加载），
/// 避免 base64 内联导致内存/JSON 体积爆炸、导入大文件时卡死或闪退。
/// 重活（PPTX 解析 + LibreOffice 全量转 PNG，冷启动可达数十秒）放专用阻塞线程，
/// 避免占用 Tauri 命令通道卡住其它同步 IPC（与 convert_to_markdown 同策略）。
#[tauri::command]
pub async fn wps_import_pptx(app: AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let bytes = std::fs::read(&path).map_err(|e| format!("读取 {} 失败: {}", path, e))?;
        let media_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("pptx_media");
        std::fs::create_dir_all(&media_dir).map_err(|e| format!("创建图片目录失败: {}", e))?;
        // 防御：解析若 panic，返回错误而非崩溃整个应用（之前解析崩溃会导致导入闪退）
        let work = std::panic::AssertUnwindSafe(|| {
            crate::services::pptx_import::pptx_to_json(&bytes, &media_dir)
        });
        let mut json = match std::panic::catch_unwind(work) {
            Ok(r) => r?,
            Err(_) => return Err(
                "导入解析发生崩溃（panic）。请重新导入并查看弹出的「导入诊断」摘要，或把 app_data/logs/app.log 发我定位。".into(),
            ),
        };

        // 尝试用 LibreOffice headless 生成每页高精度 PNG，注入到幻灯片数据中。
        // 成功则放映时直接展示图片（像素级还原）；失败或不装 LibreOffice 则退回自定义渲染。
        let png_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("pptx_png");
        if let Ok(pngs) = export_slides_png_libreoffice(&path, &png_dir) {
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&json) {
                if let Some(slides) = v.get_mut("slides").and_then(|s| s.as_array_mut()) {
                    for (i, png) in pngs.iter().enumerate() {
                        if let Some(s) = slides.get_mut(i) {
                            if let Some(obj) = s.as_object_mut() {
                                obj.insert("pngSrc".into(), serde_json::json!(png));
                            }
                        }
                    }
                }
                json = serde_json::to_string(&v).map_err(|e| e.to_string())?;
            }
        }

        Ok(json)
    })
    .await
    .map_err(|e| format!("导入线程异常: {}", e))?
}

// ---- LibreOffice headless：PPTX → 每页 PNG ----

/// 探测系统是否已装 LibreOffice（`soffice` / `libreoffice`）
pub(crate) fn find_libreoffice() -> Option<std::path::PathBuf> {
    let cands = [
        "soffice", "soffice.exe", "libreoffice",
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        r"/usr/bin/soffice",
        r"/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ];
    for c in &cands {
        let p = std::path::Path::new(c);
        if p.is_file() || p.is_absolute() && p.exists() {
            return Some(p.to_path_buf());
        }
    }
    // PATH 中查找
    let mut so_cmd = std::process::Command::new("soffice");
    so_cmd.arg("--version");
    #[cfg(windows)]
    so_cmd.creation_flags(0x08000000);
    if let Ok(output) = so_cmd.output()
    {
        if output.status.success() {
            return Some(std::path::PathBuf::from("soffice"));
        }
    }
    None
}

pub(crate) fn export_slides_png_libreoffice(
    pptx_path: &str,
    out_dir: &std::path::Path,
) -> Result<Vec<String>, String> {
    let soffice = find_libreoffice().ok_or_else(|| "未检测到 LibreOffice（可安装 libreoffice.org 后重试）".to_string())?;
    std::fs::create_dir_all(out_dir).map_err(|e| format!("mkdir {:?}: {}", out_dir, e))?;

    let out_str = out_dir.to_string_lossy().to_string();
    let mut lo_cmd = std::process::Command::new(&soffice);
    lo_cmd.args(["--headless", "--convert-to", "png", "--outdir", &out_str, pptx_path]);
    #[cfg(windows)]
    lo_cmd.creation_flags(0x08000000);
    let child = lo_cmd.output()
        .map_err(|e| format!("执行 LibreOffice 失败: {}", e))?;

    if !child.status.success() {
        let stderr = String::from_utf8_lossy(&child.stderr);
        return Err(format!("LibreOffice 导出失败: {}", stderr.trim()));
    }

    // LibreOffice 生成文件命名为 Slide1.png, Slide2.png ……
    let mut pngs: Vec<String> = Vec::new();
    for i in 1..=200 {
        let name = format!("Slide{}.png", i);
        let p = out_dir.join(&name);
        if p.exists() {
            // 转换成 Tauri asset 可用的绝对路径
            pngs.push(p.to_string_lossy().to_string());
        } else if i > 1 {
            break; // 连续编号停止
        }
    }
    Ok(pngs)
}

/// 将 base64 文件内容写入临时文件，调用原生解析器转换为 Markdown。
#[tauri::command]
pub async fn convert_bytes_to_markdown(
    app: tauri::AppHandle,
    base64: String,
    extension: String,
    original_name: Option<String>,
) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let ad = app_data.clone();
    let oname = original_name.clone();
    // 重解码 + 写临时文件 + 原生解析：放在阻塞线程，避免大文件卡住命令通道
    let parsed = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let bytes = base64
            .split(',')
            .nth(1)
            .unwrap_or(&base64)
            .as_bytes();
        let decoded = base64_decode(bytes).map_err(|e| format!("解码失败: {}", e))?;
        // 超大文件防护：避免一次性解码进内存导致崩溃 / 卡死
        if decoded.len() > 300 * 1024 * 1024 {
            return Err("文件过大（>300MB），暂不支持解析".into());
        }
        let tmp = std::env::temp_dir().join(format!("andeng_drop_{}.{}", uuid::Uuid::new_v4(), extension));
        std::fs::write(&tmp, &decoded).map_err(|e| format!("写临时文件失败: {}", e))?;
        let tmp_str = tmp.to_string_lossy().to_string();
        let result = document_parser::convert_document_to_markdown(&tmp_str, &ad);
        // 原始文档存入图标栏中转站（使用原始文件名）
        let _ = copy_file_to_dropzone(&ad, &tmp_str, oname.as_deref(), None);
        let _ = std::fs::remove_file(&tmp);
        result
    })
    .await
    .map_err(|e| format!("解析线程异常: {}", e))??;
    Ok(parsed)
}
