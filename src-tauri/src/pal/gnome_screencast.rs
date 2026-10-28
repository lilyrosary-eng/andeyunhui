//! GNOME 自带录屏（`org.gnome.Shell.Screencast`）。
//!
//! # 为什么用它，而不是自己编码
//! 用户 2026-10-28 定调：**截图和录屏都走系统能力**，不要自绘选区、不要控制台。
//! GNOME 的截图 UI（`Screenshot(interactive)`）本身就带"录制"开关；而录屏还有一条更薄的
//! 独立接口：`org.gnome.Shell.Screencast`。实测（本机 GNOME Shell 50.1 / Wayland）：
//!
//! ```text
//! busctl --user introspect org.gnome.Shell.Screencast …
//!   .Screencast        method  sa{sv} -> bs
//!   .ScreencastArea    method  iiiisa{sv} -> bs
//!   .StopScreencast    method  -> b
//!   .ScreencastSupported property b = true
//! ```
//!
//! 而且**外部应用可以调用**（不像 `org.gnome.Shell.Screenshot` 会 `Access denied`）。
//!
//! # ★ 必须注意：录制绑定调用方的 D-Bus 连接
//! 用 `busctl` 试过一次：`Screencast()` 返回成功后 busctl 进程退出 ⇒ 连接断开 ⇒
//! shell 日志 `Fatal error while recording: Sender has vanished` ⇒ 产物只有 **48 字节**空 MP4。
//! ⇒ 必须在应用进程内用一条**常驻连接**，连接活到录制结束（存在 `ACTIVE` 里）。
//! 这与 portal ScreenCast 的 session 语义是同一类坑，但这次连授权弹窗都没有。
//!
//! # 与 portal/自研方案的关系
//! 本模块**不编码、不抓帧**：帧由 gnome-shell 自己录，文件由它自己写。我们只负责
//! 「开始 / 停止 / 把产物拿去中转站」。原来 `services/recording_service_linux.rs`（portal →
//! pipewire → ffmpeg）保留不动（快捷键那条链还在用它），浮岛按钮改走这里。

use std::collections::HashMap;
use std::sync::Mutex;

use zbus::zvariant::Value;

const DEST: &str = "org.gnome.Shell.Screencast";
const PATH: &str = "/org/gnome/Shell/Screencast";
const IFACE: &str = "org.gnome.Shell.Screencast";

struct Active {
    /// 常驻连接：它一断，shell 就认为发起方消失并中止录制。
    conn: zbus::Connection,
    /// shell 实际写的文件（它会自己补/改扩展名，返回值以它为准）。
    output: String,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

/// 开始录制。`path` 可以是 `/home/x/视频/录屏_20261028.mp4` 这种；shell 会按自己的容器改扩展名，
/// 所以**以返回值里的路径为准**。
pub async fn start(path: &str, fps: u32) -> Result<String, String> {
    if ACTIVE.lock().map(|g| g.is_some()).unwrap_or(false) {
        return Err("已经在录制中".to_string());
    }
    if let Some(dir) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建输出目录失败: {e}"))?;
    }
    // ★ shell 会**再补一次**扩展名：传 `x.mp4` 得到 `x.mp4.mp4`（实测）。
    //   所以传之前把已知的视频扩展名剥掉，让它自己加。
    let stem = {
        let p = std::path::Path::new(path);
        match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) {
            Some(ext) if matches!(ext.as_str(), "mp4" | "webm" | "mkv" | "mov" | "avi") => {
                p.with_extension("").to_string_lossy().to_string()
            }
            _ => path.to_string(),
        }
    };

    let conn = zbus::Connection::session()
        .await
        .map_err(|e| format!("连接会话总线失败: {e}"))?;

    let mut opts: HashMap<&str, Value<'_>> = HashMap::new();
    opts.insert("framerate", Value::from(fps.clamp(5, 60)));
    // 录屏默认带光标（GNOME 的截图 UI 也带），用户看回放需要它定位
    opts.insert("draw-cursor", Value::from(true));

    let reply = conn
        .call_method(Some(DEST), PATH, Some(IFACE), "Screencast", &(stem.as_str(), opts))
        .await
        .map_err(|e| format!("调用系统录屏失败: {e}"))?;

    // 先把 body 绑到变量，避免 Value 借用已释放的临时体（E0716）
    let body = reply.body();
    let (ok, actual): (bool, String) = body
        .deserialize()
        .map_err(|e| format!("解析录屏返回值失败: {e}"))?;
    if !ok {
        return Err("系统录屏没有启动（Screencast 返回 false）".to_string());
    }

    eprintln!("[录屏] 系统录屏已开始 → {actual}（fps={fps}）");
    {
        let mut g = ACTIVE.lock().map_err(|e| format!("锁失败: {e}"))?;
        *g = Some(Active {
            conn,
            output: actual.clone(),
        });
    }
    Ok(actual)
}

/// 停止录制，返回文件路径（文件由 shell 写好，我们只是等它收尾）。
pub async fn stop() -> Result<String, String> {
    let active = {
        let mut g = ACTIVE.lock().map_err(|e| format!("锁失败: {e}"))?;
        g.take()
    };
    let Some(a) = active else {
        return Err("当前没有在录制".to_string());
    };

    // StopScreencast 返回 false 常见于"已经自己结束了"，不当成错误：
    // 文件是否有效用大小判定（空 MP4 只有几十字节）。
    match a
        .conn
        .call_method(Some(DEST), PATH, Some(IFACE), "StopScreencast", &())
        .await
    {
        Ok(reply) => {
            let body = reply.body();
            match body.deserialize::<bool>() {
                Ok(true) => {}
                Ok(false) => eprintln!("[录屏] StopScreencast 返回 false（可能已自行结束）"),
                Err(e) => eprintln!("[录屏] 解析 StopScreencast 结果失败: {e}"),
            }
        }
        Err(e) => eprintln!("[录屏] StopScreencast 调用失败: {e}"),
    }

    // 连接释放后 shell 才会真正 flush 文件；等一小会儿再看大小
    drop(a.conn);
    let mut size = 0u64;
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        size = std::fs::metadata(&a.output).map(|m| m.len()).unwrap_or(0);
        if size > 4096 {
            break;
        }
    }
    eprintln!("[录屏] 已停止 → {}（{} KB）", a.output, size / 1024);
    if size <= 4096 {
        return Err(format!(
            "录制文件几乎没有内容（{} 字节）：{}",
            size, a.output
        ));
    }
    Ok(a.output)
}

/// 是否正在录制 + 目标文件。
pub fn status() -> Option<String> {
    ACTIVE
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|a| a.output.clone()))
}

/// 给上层用的常量（前端不关心，但命令签名里要用到）。
pub fn default_output() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let base = {
        let localized = std::path::PathBuf::from(&home).join("视频");
        if localized.is_dir() {
            localized
        } else {
            std::path::PathBuf::from(&home).join("Videos")
        }
    };
    let stamp = std::process::Command::new("date")
        .arg("+%Y%m%d_%H%M%S")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "recording".to_string());
    base.join("andeyunhui-recordings")
        .join(format!("录屏_{stamp}.mp4"))
        .to_string_lossy()
        .to_string()
}
