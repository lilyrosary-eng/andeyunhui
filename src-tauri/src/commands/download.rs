//! 直链/HLS/分段视频下载与 ffmpeg 合并
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
// ================= 音乐下载命令 =================
/// 流式下载一个 URL 到本地文件（用于「下载歌曲」）。复用项目 reqwest 风格：
/// rustls-tls + no_proxy（禁用系统代理避免被拦截），带浏览器 UA 与大小上限保护。
/// save_path 由前端经 dialog 选好（含文件名与扩展名），Rust 仅负责落地。
#[tauri::command]
pub async fn download_file(
    app: tauri::AppHandle,
    plugin_id: Option<String>,
    url: String,
    save_path: String,
    progress_event: Option<String>,
) -> Result<(), String> {
    crate::services::plugin_access::ensure_plugin_write(&app, plugin_id.as_deref(), &save_path)?;
    use std::io::Write;
    use futures_util::StreamExt;
    // 安全上限：单曲一般不超 100MB，超限直接拒绝，避免异常大文件写爆磁盘。
    const MAX_BYTES: u64 = 100 * 1024 * 1024;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
        .build()
        .map_err(|e| format!("创建下载客户端失败: {}", e))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求下载地址失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("下载地址返回状态 {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    if total > MAX_BYTES {
        return Err(format!("文件过大（{}MB），已超过下载上限", total / 1024 / 1024));
    }
    let path = PathBuf::from(&save_path);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut f = fs::File::create(&path).map_err(|e| format!("创建文件失败: {}", e))?;

    // 流式下载：边读边写，并按固定间隔 emit 进度事件（downloaded/total/speed）。
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut last_emit_bytes: u64 = 0;
    if let Some(ref ev) = progress_event {
        let _ = app.emit(ev, serde_json::json!({
            "downloaded": 0,
            "total": total,
            "speed": 0,
        }));
    }
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取下载内容失败: {}", e))?;
        let len = chunk.len() as u64;
        if downloaded + len > MAX_BYTES {
            let _ = fs::remove_file(&path);
            return Err("文件过大，已超过下载上限".to_string());
        }
        f.write_all(&chunk).map_err(|e| format!("写入文件失败: {}", e))?;
        downloaded += len;
        // 每 ~200ms 上报一次，或收尾时上报，避免高频事件风暴。
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(last_emit).as_millis();
        if progress_event.is_some() && (elapsed >= 200 || downloaded == total) {
            let speed = if elapsed > 0 {
                (downloaded - last_emit_bytes) as f64 / (elapsed as f64 / 1000.0)
            } else {
                0.0
            };
            if let Some(ref ev) = progress_event {
                let _ = app.emit(ev, serde_json::json!({
                    "downloaded": downloaded,
                    "total": total,
                    "speed": speed,
                }));
            }
            last_emit = now;
            last_emit_bytes = downloaded;
        }
    }
    // 收尾上报 100%。
    if let Some(ref ev) = progress_event {
        let _ = app.emit(ev, serde_json::json!({
            "downloaded": downloaded,
            "total": total,
            "speed": 0,
        }));
    }
    if total > 0 && downloaded != total {
        // 服务端提前断流，文件不完整，删除避免产生坏文件。
        let _ = fs::remove_file(&path);
        return Err("下载中断，文件不完整".to_string());
    }
    Ok(())
}

// ================= 网络视频下载（纯 API 方案） =================
// 两类：直链（mp4/m4s）+ HLS(m3u8→mp4)。
//
// 与音乐 download_file 的关键差异（不能照搬）：
//  1) 上限：音乐单曲 100MB，视频放宽到 8GB。
//  2) 超时：reqwest 的 ClientBuilder::timeout 是「整个请求（含读完 body）」的总时限，
//     不是空闲超时。音乐单曲几 MB、几十秒跑完，60s 总时限没问题；视频动辄数百 MB，
//     用总时限必然在中途被中断，而中断分支会删掉半成品文件。故这里只设 connect_timeout。
//  3) 多段：B 站 playurl 的 durl 可能返回多段（长视频/高码率），必须按序拼接，
//     否则只能拿到第一段（表现为「只能播前几分钟」）。
//  4) 防盗链：bilibili / douyin 的 CDN 需要正确的 Referer 与 Cookie，故一并透传。

/// 视频下载专用客户端：只设连接超时，不设总超时（大文件不能用总时限）。
pub(crate) fn build_video_download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建下载客户端失败: {}", e))
}

/// 把单个 URL 流式写入 path。
/// 返回 (本段写入字节, 服务端声明的本段总长)。
/// base_done / grand_total 用于多段下载时把进度折算成「整条视频」的进度。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_one_segment(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    url: &str,
    path: &std::path::Path,
    referer: Option<&str>,
    cookie: Option<&str>,
    progress_event: Option<&str>,
    base_done: u64,
    grand_total: u64,
    max_bytes: u64,
) -> Result<(u64, u64), String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let mut req = client
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        )
        .header(reqwest::header::ACCEPT, "*/*");
    if let Some(r) = referer.filter(|s| !s.is_empty()) {
        req = req.header(reqwest::header::REFERER, r);
    }
    if let Some(c) = cookie.filter(|s| !s.is_empty()) {
        req = req.header(reqwest::header::COOKIE, c);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求下载地址失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("下载地址返回状态 {}", resp.status()));
    }
    let seg_total = resp.content_length().unwrap_or(0);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut f = fs::File::create(path).map_err(|e| format!("创建文件失败: {}", e))?;
    let mut stream = resp.bytes_stream();
    let mut seg_done: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut last_emit_bytes: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取下载内容失败: {}", e))?;
        let len = chunk.len() as u64;
        if base_done + seg_done + len > max_bytes {
            let _ = fs::remove_file(path);
            return Err("文件过大，已超过下载上限".to_string());
        }
        f.write_all(&chunk).map_err(|e| format!("写入文件失败: {}", e))?;
        seg_done += len;
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(last_emit).as_millis();
        if progress_event.is_some() && elapsed >= 200 {
            let speed = if elapsed > 0 {
                (seg_done - last_emit_bytes) as f64 / (elapsed as f64 / 1000.0)
            } else {
                0.0
            };
            if let Some(ev) = progress_event {
                let _ = app.emit(
                    ev,
                    serde_json::json!({
                        "downloaded": base_done + seg_done,
                        "total": if grand_total > 0 { grand_total } else { seg_total },
                        "speed": speed,
                    }),
                );
            }
            last_emit = now;
            last_emit_bytes = seg_done;
        }
    }
    Ok((seg_done, seg_total))
}

/// 用 ffmpeg concat demuxer 把多个同源分片按序拼接为单个 mp4（-c copy，不重编码）。
/// 分段来自同一次 playurl 响应，编码参数一致，可直接字节级拼接。
pub(crate) fn ffmpeg_concat_segments(
    app: &tauri::AppHandle,
    parts: &[PathBuf],
    out: &std::path::Path,
) -> Result<(), String> {
    use std::process::{Command, Stdio};
    if parts.is_empty() {
        return Err("没有可拼接的分片".to_string());
    }
    if parts.len() == 1 {
        return fs::rename(&parts[0], out).map_err(|e| format!("移动分片失败: {}", e));
    }
    let ffmpeg_dir = get_ffmpeg_dir(app)
        .ok_or_else(|| "未找到 ffmpeg（外部依赖未就绪），无法拼接分段视频".to_string())?;
    let ffmpeg = ffmpeg_dir.join("ffmpeg.exe");
    if !ffmpeg.exists() {
        return Err("ffmpeg.exe 不存在，无法拼接分段视频".to_string());
    }
    let list_path = out.with_extension("concat.txt");
    let mut list = String::new();
    for p in parts {
        // concat demuxer 的单引号转义：' -> '\''
        let s = p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
        list.push_str(&format!("file '{}'\n", s));
    }
    fs::write(&list_path, list).map_err(|e| format!("写入拼接清单失败: {}", e))?;

    let mut cmd = Command::new(&ffmpeg);
    cmd.arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        .arg("-i")
        .arg(&list_path)
        .arg("-c")
        .arg("copy")
        .arg("-y")
        .arg(out)
        .arg("-loglevel")
        .arg("error");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    // CREATE_NO_WINDOW (0x08000000)：子进程不弹出控制台窗口。
    // `Command::creation_flags` 是 Windows 独有的扩展方法（来自 std::os::windows::process），
    // Linux 上不存在 ⇒ 必须门控，否则整个 crate 编译失败。
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let output = cmd
        .output()
        .map_err(|e| format!("启动 ffmpeg 失败: {}", e))?;
    let _ = fs::remove_file(&list_path);
    if !output.status.success() {
        let _ = fs::remove_file(out);
        return Err(format!(
            "分段拼接失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// 视频下载：urls 为按播放顺序排列的分片地址（单段即普通直链）。
/// 单段 → 直接落地；多段 → 逐段下载到临时目录后经 ffmpeg 拼接。
#[tauri::command]
pub async fn download_video(
    app: tauri::AppHandle,
    plugin_id: Option<String>,
    urls: Vec<String>,
    save_path: String,
    referer: Option<String>,
    cookie: Option<String>,
    progress_event: Option<String>,
) -> Result<(), String> {
    crate::services::plugin_access::ensure_plugin_write(&app, plugin_id.as_deref(), &save_path)?;
    const MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;
    let urls: Vec<String> = urls
        .into_iter()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .collect();
    if urls.is_empty() {
        return Err("缺少下载地址".to_string());
    }

    let client = build_video_download_client()?;
    let target = PathBuf::from(&save_path);
    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // ---- 单段：直接落地 ----
    if urls.len() == 1 {
        let (done, total) = download_one_segment(
            &app,
            &client,
            &urls[0],
            &target,
            referer.as_deref(),
            cookie.as_deref(),
            progress_event.as_deref(),
            0,
            0,
            MAX_BYTES,
        )
        .await?;
        if let Some(ev) = progress_event.as_deref() {
            let _ = app.emit(
                ev,
                serde_json::json!({
                    "downloaded": done,
                    "total": if total > 0 { total } else { done },
                    "speed": 0,
                }),
            );
        }
        if total > 0 && done != total {
            let _ = fs::remove_file(&target);
            return Err("下载中断，文件不完整".to_string());
        }
        return Ok(());
    }

    // ---- 多段：逐段下载 → ffmpeg 拼接 ----
    let tmp_dir = target.with_extension("parts");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    // 先探一遍各段长度，让总进度尽量准确（HEAD 失败则退化为按已下载量估算）
    let mut grand_total: u64 = 0;
    for u in &urls {
        if let Ok(r) = client.head(u).send().await {
            grand_total += r.content_length().unwrap_or(0);
        }
    }

    let mut parts: Vec<PathBuf> = Vec::new();
    let mut base_done: u64 = 0;
    let mut failure: Option<String> = None;

    for (i, u) in urls.iter().enumerate() {
        let part = tmp_dir.join(format!("part-{:03}.mp4", i));
        match download_one_segment(
            &app,
            &client,
            u,
            &part,
            referer.as_deref(),
            cookie.as_deref(),
            progress_event.as_deref(),
            base_done,
            grand_total,
            MAX_BYTES,
        )
        .await
        {
            Ok((done, _seg_total)) => {
                parts.push(part);
                base_done += done;
            }
            Err(e) => {
                failure = Some(format!("第 {} 段下载失败：{}", i + 1, e));
                break;
            }
        }
    }

    if failure.is_none() {
        if let Err(e) = ffmpeg_concat_segments(&app, &parts, &target) {
            failure = Some(e);
        }
    }
    let _ = fs::remove_dir_all(&tmp_dir);
    if let Some(e) = failure {
        let _ = fs::remove_file(&target);
        return Err(e);
    }

    if let Some(ev) = progress_event.as_deref() {
        let _ = app.emit(
            ev,
            serde_json::json!({ "downloaded": base_done, "total": base_done, "speed": 0 }),
        );
    }
    Ok(())
}

/// HLS(m3u8) 转封装为 mp4：复用 external-deps 的 ffmpeg.exe 拉取切片并合并。
/// 适用于平台返回 m3u8 的情况（含加密 key 时依赖同域可访问）。
#[tauri::command]
pub async fn download_hls(
    app: tauri::AppHandle,
    plugin_id: Option<String>,
    m3u8_url: String,
    save_path: String,
    referer: Option<String>,
    cookie: Option<String>,
    progress_event: Option<String>,
) -> Result<(), String> {
    crate::services::plugin_access::ensure_plugin_write(&app, plugin_id.as_deref(), &save_path)?;
    let app2 = app.clone();
    let progress = progress_event.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_ffmpeg_hls(
            &app2,
            &m3u8_url,
            &save_path,
            referer.as_deref(),
            cookie.as_deref(),
            progress.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("ffmpeg 任务失败: {}", e))?
}

/// 阻塞运行 ffmpeg 转封装（在 spawn_blocking 内执行，避免阻塞 async 线程）。
pub(crate) fn run_ffmpeg_hls(
    app: &tauri::AppHandle,
    m3u8_url: &str,
    save_path: &str,
    referer: Option<&str>,
    cookie: Option<&str>,
    progress_event: Option<&str>,
) -> Result<(), String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let ffmpeg_dir = get_ffmpeg_dir(app).ok_or_else(|| "未找到 ffmpeg（外部依赖未就绪）".to_string())?;
    let ffmpeg = ffmpeg_dir.join("ffmpeg.exe");
    if !ffmpeg.exists() {
        return Err("ffmpeg.exe 不存在，无法转封装 HLS".to_string());
    }
    let path = PathBuf::from(save_path);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut cmd = Command::new(&ffmpeg);
    cmd.arg("-i").arg(m3u8_url).arg("-c").arg("copy").arg("-y").arg(save_path);
    cmd.arg("-loglevel").arg("error").arg("-stats");
    let mut headers = String::new();
    if let Some(r) = referer {
        headers.push_str(&format!("Referer: {}\r\n", r));
    }
    if let Some(c) = cookie {
        headers.push_str(&format!("Cookie: {}\r\n", c));
    }
    headers.push_str("User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36\r\n");
    cmd.arg("-headers").arg(headers);
    cmd.stdin(Stdio::null());
    cmd.stderr(Stdio::piped());
    if let Some(ev) = progress_event {
        let _ = app.emit(ev, serde_json::json!({ "downloaded": 0, "total": 0, "speed": 0, "phase": "hls" }));
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动 ffmpeg 失败: {}", e))?;
    let mut total_bytes: u64 = 0;
    if let Some(mut stderr) = child.stderr.take() {
        let mut buf = [0u8; 4096];
        let mut acc = String::new();
        // 进度节流：旧实现每读到 4 KB 就 emit 一次（长视频转封装会发出上千次事件）。
        let mut last_emit = std::time::Instant::now();
        loop {
            match stderr.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if let Some(pos) = acc.rfind("size=") {
                        let rest = &acc[pos + 5..];
                        let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                        if let Ok(b) = num.parse::<u64>() {
                            total_bytes = b;
                        }
                    }
                    if acc.len() > 4096 {
                        acc = acc[acc.len() - 2048..].to_string();
                    }
                    if let Some(ev) = progress_event {
                        if last_emit.elapsed().as_millis() >= 200 {
                            let _ = app.emit(ev, serde_json::json!({ "downloaded": total_bytes, "total": 0, "speed": 0, "phase": "hls" }));
                            last_emit = std::time::Instant::now();
                        }
                    }
                }
                Err(_) => break,
            }
        }
    }
    let status = child.wait().map_err(|e| format!("等待 ffmpeg 完成失败: {}", e))?;
    if !status.success() {
        let _ = fs::remove_file(&path);
        return Err(format!("ffmpeg 转封装失败 (退出码 {:?})", status.code()));
    }
    if let Some(ev) = progress_event {
        let _ = app.emit(ev, serde_json::json!({ "downloaded": total_bytes, "total": total_bytes, "speed": 0, "phase": "done" }));
    }
    Ok(())
}
