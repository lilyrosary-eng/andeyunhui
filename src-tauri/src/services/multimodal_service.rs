// 多模态服务（multimodal_service.rs）—— 阶段 5 · AI 发图 + 语音合成。
//
// 命令：
//   ai_generate_image(prompt, profile_id) -> data URL（OpenAI 兼容 /images/generations）
//   ai_tts(text, profile_id)             -> data URL（OpenAI 兼容 /audio/speech）
//
// 设计：
// - 复用 ai_service 的 profile 解析与认证（resolve_profile / load_profiles）。
// - 图片生成：POST {base_url}/images/generations，请求 b64_json，返回 data URL。
//   部分供应商返回 URL 而非 base64（如通义），两种都兼容。
// - 语音合成：POST {base_url}/audio/speech，请求 mp3，返回 audio data URL。
// - profile 需配置 image_model / tts_model 才可用；未配置返回明确错误。

use crate::services::ai_service;

/// AI 生成图片（OpenAI 兼容 /images/generations）。
/// 返回 data URL（png）；无法取 base64 时尝试取 url（再转 data URL 会失败则回退原 url）。
#[tauri::command]
pub async fn ai_generate_image(
    app: tauri::AppHandle,
    prompt: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    let config = ai_service::load_config(&app);
    let cfg = ai_service::resolve_target(&config, profile_id.as_deref());
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key".to_string());
    }
    let model = cfg
        .image_model
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "该算力来源未配置图片生成模型（image_model），无法发图".to_string())?;

    let url = format!("{}/images/generations", cfg.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": "1024x1024",
        "response_format": "b64_json",
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text.chars().take(300).collect::<String>()));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let data = &v["data"][0];
    // 1) b64_json
    if let Some(b64) = data["b64_json"].as_str() {
        return Ok(format!("data:image/png;base64,{}", b64));
    }
    // 2) url（部分供应商返回 URL）
    if let Some(u) = data["url"].as_str() {
        return Ok(u.to_string());
    }
    Err("图片生成响应缺少数据".to_string())
}

/// AI 语音合成（OpenAI 兼容 /audio/speech）。返回 audio/mpeg data URL。
#[tauri::command]
pub async fn ai_tts(
    app: tauri::AppHandle,
    text: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    let config = ai_service::load_config(&app);
    let cfg = ai_service::resolve_target(&config, profile_id.as_deref());
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key".to_string());
    }
    let model = cfg
        .tts_model
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "该算力来源未配置语音模型（tts_model），无法播报".to_string())?;

    let url = format!("{}/audio/speech", cfg.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "input": text,
        "voice": "alloy",
        "response_format": "mp3",
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text.chars().take(300).collect::<String>()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取音频失败: {}", e))?;
    if bytes.is_empty() {
        return Err("语音合成为空".to_string());
    }
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:audio/mpeg;base64,{}", b64))
}

/// 标准 SD1.5/SDXL 通用 txt2img 工作流（最小可用集，纯函数便于测试）。
/// CheckpointLoaderSimple 输出 [MODEL, CLIP, VAE]，索引分别 0/1/2，故 vae 取 ["1",2]。
pub fn build_default_txt2img(prompt: &str, ckpt: &str, seed: u64) -> serde_json::Value {
    serde_json::json!({
        "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": ckpt } },
        "2": { "class_type": "CLIPTextEncode", "inputs": { "text": prompt, "clip": ["1", 0] } },
        "3": { "class_type": "CLIPTextEncode", "inputs": { "text": "text, watermark, worst quality, low quality, blurry", "clip": ["1", 0] } },
        "4": { "class_type": "EmptyLatentImage", "inputs": { "width": 512, "height": 512, "batch_size": 1 } },
        "5": { "class_type": "KSampler", "inputs": {
            "seed": seed, "steps": 20, "cfg": 8.0,
            "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0,
            "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0]
        } },
        "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["1", 2] } },
        "7": { "class_type": "SaveImage", "inputs": { "images": ["6", 0], "filename_prefix": "andeyunhui" } }
    })
}

/// 解析 ComfyUI 有效基址：ComfyUI 每条路由同时挂在裸路径与 /api 前缀下，
/// 但 API-only 反向代理（如 comfy-api-proxy）只转发 /api/*，裸路径探测会 404。
/// 先试 {base}/system_stats，404 则试 {base}/api/system_stats，返回可用基址。
async fn resolve_comfy_base(client: &reqwest::Client, base: &str) -> Result<String, String> {
    for candidate in [base.to_string(), format!("{}/api", base)] {
        match client.get(format!("{}/system_stats", candidate)).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(candidate),
            _ => continue,
        }
    }
    Err(format!("ComfyUI 不可达或非 ComfyUI 服务（{}）：system_stats 探测失败", base))
}

/// 提交 API 工作流 → 轮询 /history 出图 → 从 /view 取图 → 图片 data URL。
/// 本地 SD 出图可能数十秒~数分钟，轮询上限 5 分钟。当前仅取图片输出（视频/音频后续）。
async fn run_comfy_workflow(
    client: &reqwest::Client,
    base: &str,
    workflow: &serde_json::Value,
) -> Result<String, String> {
    // 1) 提交工作流
    let submit_resp = client
        .post(format!("{}/prompt", base))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "prompt": workflow, "client_id": "andeyunhui" }))
        .send()
        .await
        .map_err(|e| format!("ComfyUI 不可达（{}）: {}", base, e))?;
    let submit_status = submit_resp.status();
    let submit_body: serde_json::Value = submit_resp
        .json()
        .await
        .map_err(|e| format!("解析 ComfyUI 提交响应失败: {}", e))?;
    if !submit_status.is_success() {
        return Err(format!(
            "ComfyUI 提交失败 HTTP {}: {}",
            submit_status,
            submit_body.to_string().chars().take(300).collect::<String>()
        ));
    }
    if let Some(errs) = submit_body.get("node_errors").and_then(|v| v.as_object()) {
        if !errs.is_empty() {
            return Err(format!(
                "ComfyUI 工作流节点错误: {}",
                submit_body["node_errors"].to_string().chars().take(300).collect::<String>()
            ));
        }
    }
    let prompt_id = submit_body
        .get("prompt_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "ComfyUI 提交响应缺少 prompt_id".to_string())?
        .to_string();

    // 2) 轮询 /history/{prompt_id} 直到产出图片
    let mut image_ref: Option<(String, String, String)> = None; // (filename, subfolder, type)
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    loop {
        if std::time::Instant::now() > deadline {
            return Err("ComfyUI 生成超时（5 分钟）".to_string());
        }
        let hist: serde_json::Value = client
            .get(format!("{}/history/{}", base, prompt_id))
            .send()
            .await
            .map_err(|e| format!("查询 ComfyUI 历史失败: {}", e))?
            .json()
            .await
            .map_err(|e| format!("解析 ComfyUI 历史失败: {}", e))?;
        // history["<prompt_id>"].outputs.<node>.images[0] = {filename, subfolder, type}
        if let Some(entry) = hist.get(&prompt_id) {
            if let Some(outputs) = entry.get("outputs").and_then(|v| v.as_object()) {
                'scan: for (_node, out) in outputs {
                    if let Some(imgs) = out.get("images").and_then(|v| v.as_array()) {
                        if let Some(img) = imgs.first() {
                            let filename = img.get("filename").and_then(|v| v.as_str()).unwrap_or("");
                            if !filename.is_empty() {
                                let subfolder = img.get("subfolder").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let typ = img.get("type").and_then(|v| v.as_str()).unwrap_or("output").to_string();
                                image_ref = Some((filename.to_string(), subfolder, typ));
                                break 'scan;
                            }
                        }
                    }
                }
            }
        }
        if image_ref.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }

    let (filename, subfolder, typ) = image_ref.ok_or_else(|| "ComfyUI 未返回图片".to_string())?;
    // 3) 取图字节 → data URL（content-type 缺省按 png）
    let img_resp = client
        .get(format!("{}/view", base))
        .query(&[("filename", filename.as_str()), ("subfolder", subfolder.as_str()), ("type", typ.as_str())])
        .send()
        .await
        .map_err(|e| format!("获取 ComfyUI 图片失败: {}", e))?;
    if !img_resp.status().is_success() {
        return Err(format!("获取 ComfyUI 图片 HTTP {}", img_resp.status()));
    }
    let content_type = img_resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = img_resp.bytes().await.map_err(|e| format!("读取 ComfyUI 图片失败: {}", e))?;
    if bytes.is_empty() {
        return Err("ComfyUI 图片为空".to_string());
    }
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", content_type, b64))
}

/// ComfyUI 本地生图（程序化接入）——与 ai_generate_image（OpenAI 兼容云端）并列的另一条生图后端。
/// 两种用法：
///   ① 传 prompt + checkpoint：走内置最小 txt2img 工作流（build_default_txt2img）；
///   ② 传 workflow（API 格式 JSON，前端已用 applyWorkflowParameters 应用参数覆盖）：直接提交，
///      复用用户在 ComfyUI 里调好的工作流（ControlNet/LoRA/精细流程均可）。
/// comfyui_url 形如 http://127.0.0.1:8188；checkpoint 为 ComfyUI models/checkpoints 下的模型文件名。
/// 轮询上限 5 分钟；当前仅返回首个图片输出（视频/音频输出后续支持）。
#[tauri::command]
pub async fn comfyui_generate_image(
    prompt: Option<String>,
    comfyui_url: String,
    checkpoint: Option<String>,
    workflow: Option<serde_json::Value>,
) -> Result<String, String> {
    let base = comfyui_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("未配置 ComfyUI 地址".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;
    let base = resolve_comfy_base(&client, &base).await?;

    // 用法②：调用方提交完整工作流（优先）
    if let Some(wf) = workflow {
        let obj = wf
            .as_object()
            .filter(|o| !o.is_empty())
            .ok_or_else(|| "workflow 必须是非空 JSON 对象".to_string())?;
        // 每个节点都应是 { class_type, inputs } 形状
        for (id, node) in obj {
            let ok = node.get("class_type").and_then(|v| v.as_str()).is_some()
                && node.get("inputs").and_then(|v| v.as_object()).is_some();
            if !ok {
                return Err(format!("workflow 节点 {} 缺少 class_type/inputs", id));
            }
        }
        return run_comfy_workflow(&client, &base, &wf).await;
    }

    // 用法①：内置最小 txt2img
    let ckpt = checkpoint.unwrap_or_default().trim().to_string();
    if ckpt.is_empty() {
        return Err("未配置 ComfyUI 模型（checkpoint 文件名）".to_string());
    }
    let prompt = prompt.unwrap_or_default().trim().to_string();
    if prompt.is_empty() {
        return Err("画图提示词为空".to_string());
    }
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let wf = build_default_txt2img(&prompt, &ckpt, seed);
    run_comfy_workflow(&client, &base, &wf).await
}

/// ComfyUI 节点定义（/object_info）——前端 convertGraphToApi 需要它把 UI 图转成 API 工作流。
/// 完整 object_info 可能有数 MB（自定义节点越多越大），按需拉取、经 Rust 中转（避开 WebView 直连的 CORS）。
#[tauri::command]
pub async fn comfyui_object_info(comfyui_url: String) -> Result<serde_json::Value, String> {
    let base = comfyui_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("未配置 ComfyUI 地址".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;
    let base = resolve_comfy_base(&client, &base).await?;
    let resp = client
        .get(format!("{}/object_info", base))
        .send()
        .await
        .map_err(|e| format!("ComfyUI 不可达（{}）: {}", base, e))?;
    if !resp.status().is_success() {
        return Err(format!("获取 ComfyUI object_info HTTP {}", resp.status()));
    }
    resp.json().await.map_err(|e| format!("解析 ComfyUI object_info 失败: {}", e))
}

/// 一个 ComfyUI 工作流文件（UI 图或已转好的 API 工作流，均为 .json）。
#[derive(serde::Serialize, Clone)]
pub struct ComfyWorkflowFile {
    /// 文件名（不含 .json）
    pub name: String,
    /// 完整路径
    pub path: String,
    /// 相对扫描目录的路径（子目录组织时保留层级，分隔符统一为 /）
    pub relative: String,
    /// 字节数
    pub size: u64,
    /// 修改时间（unix 秒）
    pub modified_at: u64,
}

/// 扫描目录下的 ComfyUI 工作流文件（*.json）：递归子目录（深度≤4）、跳过隐藏项、上限 500 个，
/// 按修改时间倒序（新的在前）。ComfyUI 端保存的工作流一般在
/// <ComfyUI>/user/default/workflows（新）或 <ComfyUI>/userdata/workflows（旧）。
pub fn scan_workflows_sync(dir: &str) -> Result<Vec<ComfyWorkflowFile>, String> {
    let root = std::path::PathBuf::from(dir.trim());
    if root.as_os_str().is_empty() {
        return Err("未配置 ComfyUI 工作流目录".to_string());
    }
    if !root.exists() {
        return Err(format!("目录不存在: {}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("不是目录: {}", root.display()));
    }
    let mut out: Vec<ComfyWorkflowFile> = Vec::new();
    walk_workflow_dir(&root, &root, 0, &mut out);
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(a.relative.cmp(&b.relative)));
    Ok(out)
}

fn walk_workflow_dir(root: &std::path::Path, dir: &std::path::Path, depth: usize, out: &mut Vec<ComfyWorkflowFile>) {
    if depth > 4 || out.len() >= 500 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            walk_workflow_dir(root, &path, depth + 1, out);
            continue;
        }
        let is_json = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if !is_json {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        out.push(ComfyWorkflowFile {
            name: stem,
            path: path.to_string_lossy().to_string(),
            relative,
            size: meta.len(),
            modified_at,
        });
    }
}

/// 扫描 ComfyUI 工作流目录（Tauri 命令壳，逻辑在 scan_workflows_sync）。
#[tauri::command]
pub async fn comfyui_scan_workflows(dir: String) -> Result<Vec<ComfyWorkflowFile>, String> {
    scan_workflows_sync(&dir)
}

/// 读取并解析一个工作流文件（JSON）。上限 8MB——UI 图内嵌缩略图元数据时可能较大。
#[tauri::command]
pub async fn comfyui_read_workflow(path: String) -> Result<serde_json::Value, String> {
    let p = std::path::PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("路径为空".to_string());
    }
    let meta = std::fs::metadata(&p).map_err(|e| format!("读取文件信息失败: {}", e))?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("工作流文件过大（>8MB）".to_string());
    }
    let text = std::fs::read_to_string(&p).map_err(|e| format!("读取文件失败: {}", e))?;
    serde_json::from_str(&text).map_err(|e| format!("解析工作流 JSON 失败: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_txt2img_shape() {
        let wf = build_default_txt2img("a cat", "sd_xl_base.safetensors", 42);
        let obj = wf.as_object().unwrap();
        assert_eq!(obj.len(), 7);
        assert_eq!(obj["1"]["class_type"], "CheckpointLoaderSimple");
        assert_eq!(obj["1"]["inputs"]["ckpt_name"], "sd_xl_base.safetensors");
        assert_eq!(obj["2"]["class_type"], "CLIPTextEncode");
        assert_eq!(obj["2"]["inputs"]["text"], "a cat");
        // CheckpointLoaderSimple 输出 [MODEL, CLIP, VAE] → vae 引 ["1",2]
        assert_eq!(obj["6"]["inputs"]["vae"], serde_json::json!(["1", 2]));
        assert_eq!(obj["5"]["inputs"]["seed"], 42);
        assert_eq!(obj["7"]["class_type"], "SaveImage");
        // 负向提示词固定兜底
        assert!(obj["3"]["inputs"]["text"].as_str().unwrap().contains("worst quality"));
    }

    #[test]
    fn scan_workflows_finds_json_recursively_and_skips_hidden() {
        let base = std::env::temp_dir().join(format!("ady_wf_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("a.json"), "{}").unwrap();
        std::fs::write(base.join("sub/b.json"), "{}").unwrap();
        std::fs::write(base.join("note.txt"), "x").unwrap();
        std::fs::write(base.join(".hidden.json"), "{}").unwrap();
        let files = scan_workflows_sync(&base.to_string_lossy()).unwrap();
        let mut relatives: Vec<String> = files.iter().map(|f| f.relative.clone()).collect();
        relatives.sort();
        assert_eq!(relatives, vec!["a.json".to_string(), "sub/b.json".to_string()]);
        assert_eq!(files.iter().find(|f| f.relative == "a.json").unwrap().name, "a");
        // 错误路径明确报错
        assert!(scan_workflows_sync(&base.join("nope").to_string_lossy()).is_err());
        assert!(scan_workflows_sync("").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
