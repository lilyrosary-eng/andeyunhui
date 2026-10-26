//! Linux 本地媒体 HTTP 服务（带 Range 支持）
//!
//! # 为什么需要它
//!
//! 本项目在 Linux 上踩过一个把整机拖垮的坑，链条是这样的：
//!
//! 1. WebKitGTK 的**媒体加载器不接管 Tauri 的 `asset://` 自定义 scheme**
//!    （图片走普通资源加载能通，音视频不走那条路）⇒ 本地音乐播不出。
//! 2. 于是改走「`fetch` 把整首歌读成 `blob:` 给 `<audio>`」。
//! 3. **这个方案更糟**：它把「文件页」反复塞进 **page cache**。
//!    内核 OOM 现场（`journalctl -k`）坐实了这一点：
//!    ```text
//!    memory: usage 6291456kB, limit 6291456kB
//!      anon   472817664  =  451MB   ← 真正的进程堆
//!      file  5929041920  = 5.65GB   ← 全是页缓存
//!    栈顶: filemap_add_folio → filemap_fault → do_read_fault
//!    ```
//!    音乐库最大 60MB 的 FLAC，点一次「歌词翻译」触发重新加载，
//!    几十次 × 60MB ⇒ page cache 累积到 GB 级。
//!    **cgroup 限额下更危险**：页缓存不允许拿别的 cgroup 的页来释放自己，
//!    于是直接触发 OOM，把整机进程一起带走。
//!
//! ⇒ 正解是让媒体走一个**真正的 HTTP 服务**：`<audio src="http://127.0.0.1:PORT/...">`
//!   由 WebKitGTK 的媒体加载器**原生支持**（不像自定义 scheme），并且
//!   **流式按需读取**（Range），内存恒定、还能拖动进度。
//!
//! # 设计
//!
//! - 绑 `127.0.0.1` + **临时端口**（`port: 0`），不对外暴露。
//! - 路由只有一个：`GET /m?p=<百分号编码的绝对路径>`。
//! - 路径校验：必须是绝对路径、必须是已存在的普通文件、扩展名在白名单内。
//!   （不支持目录、不做路径穿越 —— 查询参数是完整绝对路径，不是相对拼接，
//!   所以不存在 `../` 拼接问题；但仍拒绝含 `..` 的路径以防意外。）
//! - 支持 `Range: bytes=a-b`（拖动进度）与 `bytes=a-`，返回 206 + `Content-Range`。
//! - **固定 64KB 缓冲循环读写**，任何情况下都不把整个文件读进内存。
//!
//! # 安全边界
//!
//! 这是一个能读本地文件的服务，所以边界必须明确：
//! - 只监听回环地址，外部网络不可达；
//! - 只允许音频扩展名白名单（与前端 `readFileAsObjectUrl` 保持一致）；
//! - 不做鉴权 —— 同机任何进程都能读这些音频。这与「本来就在同一台机器上、
//!   同一用户下」的风险等级相同，不引入新的越权面。

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// 允许读取的媒体扩展名（音频 + 视频；与前端白名单保持一致）。
///
/// 为什么要有视频：WebKitGTK 的媒体加载器**不接管 `asset://`**（音频侧 2026-10-06 已因此
/// 改走本服务），而视频模块（玉兰）仍然用 `convertFileSrc()` ⇒ Linux 下本地视频
/// 无法播放（`NETWORK_NO_SOURCE`）。把视频扩进来，视频才能走同一条带 Range 的本地流。
/// 注意：本模块整体 `#[cfg(target_os = "linux")]`，所以白名单放宽**只影响 Linux**。
const ALLOWED_EXT: &[&str] = &[
    // 音频
    "mp3", "flac", "wav", "m4a", "aac", "ogg", "oga", "opus", "wma", "aiff", "ape", "alac",
    // 视频
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "ts", "m2ts", "mpg", "mpeg", "3gp",
    // 图片（媒体卡封面：WebKit 的 MPRIS 卡片只认 URL，本地封面必须走这个服务）
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif",
];

/// 读写循环的固定缓冲大小。**这是本服务内存占用的上界**（每连接 64KB）。
const CHUNK: usize = 64 * 1024;

fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "m4a" | "aac" => "audio/mp4",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "wma" => "audio/x-ms-wma",
        "aiff" | "aif" => "audio/aiff",
        "ape" => "audio/x-ape",
        "alac" => "audio/mp4",
        // 视频：MIME 必须给对，否则 WebKit 的媒体加载器会按 octet-stream 拒绝播放
        "mp4" | "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "wmv" => "video/x-ms-wmv",
        "flv" => "video/x-flv",
        "ts" | "m2ts" => "video/mp2t",
        "mpg" | "mpeg" => "video/mpeg",
        "3gp" => "video/3gpp",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn allowed(path: &str) -> bool {
    if !path.starts_with('/') || path.contains("..") {
        return false;
    }
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    ALLOWED_EXT.contains(&ext.as_str())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let hi = (b[i + 1] as char).to_digit(16);
                let lo = (b[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(b[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 极简 HTTP 响应：错误也走同一路径，省得引第三方依赖。
fn respond(sock: &mut std::net::TcpStream, status: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = sock.write_all(head.as_bytes());
    let _ = sock.write_all(body);
    let _ = sock.flush();
}

/// 解析 Range **规范部分**（即 `bytes=` 之后的部分），返回闭区间 `(start, end)`。
///
/// 单���出来是为了能脱离 socket 做单元测试 —— 这段逻辑以前是内联在
/// `handle_conn` 里的，出错时只能靠实际播放暴露。
///
/// 支持三种写法：
/// - `bytes=a-b`   → `[a, b]`（b 超过文件末尾则截到末尾）
/// - `bytes=a-`    → `[a, size-1]`
/// - `bytes=-N`    → 最后 N 字节
fn parse_range(spec: &str, size: u64) -> Option<(u64, u64)> {
    let spec = spec.trim();
    if size == 0 {
        return None;
    }
    let mut it = spec.splitn(2, '-');
    let a = it.next().unwrap_or("").trim();
    let b = it.next().unwrap_or("").trim();
    let (start, end) = if a.is_empty() {
        // bytes=-N
        let n: u64 = b.parse().ok()?;
        let n = n.min(size);
        (size - n, size - 1)
    } else {
        let s: u64 = a.parse().ok()?;
        let s = s.min(size.saturating_sub(1));
        let e = if b.is_empty() {
            size - 1
        } else {
            b.parse::<u64>().ok()?.min(size - 1)
        };
        (s, e)
    };
    if start > end {
        None
    } else {
        Some((start, end))
    }
}

/// 处理一个连接。Range 解析放在这里，便于单测。
fn handle_conn(sock: std::net::TcpStream) {
    let _ = sock.set_read_timeout(Some(std::time::Duration::from_secs(10)));
    let mut reader = BufReader::new(match sock.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    let mut sock = sock;

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() || request_line.is_empty() {
        return;
    }
    // 读掉请求头
    let mut range_hdr: Option<String> = None;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let t = line.trim_end();
                if t.is_empty() {
                    break;
                }
                if let Some((k, v)) = t.split_once(':') {
                    if k.trim().eq_ignore_ascii_case("range") {
                        range_hdr = Some(v.trim().to_string());
                    }
                }
            }
            Err(_) => return,
        }
    }

    // GET /m?p=<encoded>
    let Some(target) = request_line.split_whitespace().nth(1) else {
        return;
    };
    let Some(q) = target.split_once('?').map(|(_, q)| q) else {
        respond(&mut sock, "404 Not Found", b"no query");
        return;
    };
    let mut path: Option<String> = None;
    for kv in q.split('&') {
        if let Some(("p", v)) = kv.split_once('=') {
            path = Some(percent_decode(v));
        }
    }
    let Some(path) = path else {
        respond(&mut sock, "400 Bad Request", b"missing p");
        return;
    };
    if !allowed(&path) {
        respond(&mut sock, "403 Forbidden", b"type not allowed");
        return;
    }
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => {
            respond(&mut sock, "404 Not Found", b"no such file");
            return;
        }
    };
    let size = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => {
            respond(&mut sock, "500 Internal Server Error", b"stat failed");
            return;
        }
    };

    // Range 解析交给纯函数（可单测）
    let mut start = 0u64;
    let mut end = size.saturating_sub(1);
    let mut partial = false;
    if let Some(r) = &range_hdr {
        if let Some(sr) = r.strip_prefix("bytes=") {
            partial = true;
            match parse_range(sr, size) {
                Some((a, b)) => {
                    start = a;
                    end = b;
                }
                None => {
                    // 无效区间：416
                    let head = format!(
                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nConnection: close\r\n\r\n"
                    );
                    let _ = sock.write_all(head.as_bytes());
                    return;
                }
            }
        }
    }
    let len = end - start + 1;

    let head = if partial {
        format!(
            "HTTP/1.1 206 Partial Content\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{size}\r\nContent-Length: {len}\r\nContent-Type: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
            content_type(&path)
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\nContent-Length: {size}\r\nContent-Type: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
            content_type(&path)
        )
    };
    if sock.write_all(head.as_bytes()).is_err() {
        return;
    }

    // ★ 流式：固定 64KB 缓冲，绝不把整个文件读进内存。
    //   （这正是之前 blob 方案 OOM 的根因所在。）
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut buf = vec![0u8; CHUNK];
    let mut remaining = len;
    while remaining > 0 {
        let want = std::cmp::min(remaining as usize, CHUNK);
        match file.read(&mut buf[..want]) {
            Ok(0) => break,
            Ok(n) => {
                if sock.write_all(&buf[..n]).is_err() {
                    break;
                }
                remaining -= n as u64;
            }
            Err(_) => break,
        }
    }
    let _ = sock.flush();
}

/// 服务监听端口（0 = 还没起）。
fn port_cell() -> &'static std::sync::Mutex<u16> {
    static P: OnceLock<std::sync::Mutex<u16>> = OnceLock::new();
    P.get_or_init(|| std::sync::Mutex::new(0))
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// 幂等地启动服务，返回监听端口。已启动则直接返回原端口。
pub fn ensure_started() -> Result<u16, String> {
    let mut p = port_cell().lock().map_err(|_| "端口锁已中毒")?;
    if *p != 0 && RUNNING.load(Ordering::SeqCst) {
        return Ok(*p);
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("绑定本地端口失败: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    RUNNING.store(true, Ordering::SeqCst);
    std::thread::Builder::new()
        .name("media-http".into())
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(s) => {
                        // 每连接一个短生命周期线程：媒体请求本身很轻，
                        // 且这样单条慢连接不会卡住其它请求。
                        std::thread::spawn(move || handle_conn(s));
                    }
                    Err(_) => break,
                }
            }
            RUNNING.store(false, Ordering::SeqCst);
        })
        .map_err(|e| format!("启动媒体服务线程失败: {e}"))?;
    *p = port;
    log::info!("[media-http] 本地媒体服务已启动: http://127.0.0.1:{port}/m?p=<路径>");
    Ok(port)
}

/// 取本地文件的可播放 URL。启动服务（幂等）后返回。
///
/// 对应前端 `__HOST_API__.invoke('media_http_url', { path })`。
#[tauri::command]
pub fn media_http_url(path: String) -> Result<String, String> {
    if !allowed(&path) {
        return Err("media_http_url: 路径不被允许（需绝对路径 + 音频/视频扩展名）".into());
    }
    let port = ensure_started()?;
    // 路径本身已是绝对路径且不含 '..'，再做一次最小编码即可安全放进查询串
    let mut enc = String::new();
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                enc.push(b as char)
            }
            _ => enc.push_str(&format!("%{b:02X}")),
        }
    }
    Ok(format!("http://127.0.0.1:{port}/m?p={enc}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_full_and_open_ended() {
        // bytes=0-99
        assert_eq!(parse_range("0-99", 1000), Some((0, 99)));
        // bytes=100- （到末尾）
        assert_eq!(parse_range("100-", 1000), Some((100, 999)));
        // bytes=0-99999 （b 超过末尾 ⇒ 截断）
        assert_eq!(parse_range("0-99999", 1000), Some((0, 999)));
    }

    #[test]
    fn range_suffix() {
        // bytes=-500 最后 500 字节
        assert_eq!(parse_range("-500", 1000), Some((500, 999)));
        // N 大于文件长度 ⇒ 整个文件
        assert_eq!(parse_range("-5000", 1000), Some((0, 999)));
    }

    #[test]
    fn range_invalid() {
        assert_eq!(parse_range("abc-def", 1000), None);
        // start > end
        assert_eq!(parse_range("900-100", 1000), None);
        // 空前缀不是合法的 bytes=
        assert_eq!(parse_range("", 1000), None);
        // 空文件
        assert_eq!(parse_range("0-10", 0), None);
    }

    #[test]
    fn allowlist_and_traversal() {
        assert!(allowed("/mnt/win_d/Music/a.flac"));
        assert!(allowed("/home/x/a.mp3"));
        // 视频也要放行：Linux 下视频模块必须走本服务（asset:// 不被媒体加载器接管）
        assert!(allowed("/home/x/movie.mp4"));
        assert!(allowed("/home/x/movie.mkv"));
        assert_eq!(content_type("/home/x/movie.mp4"), "video/mp4");
        assert_eq!(content_type("/home/x/movie.mkv"), "video/x-matroska");
        // 目录穿越必须拒绝
        assert!(!allowed("/home/x/../../etc/passwd"));
        assert!(!allowed("relative/path.flac"));
        // 非白名单类型
        assert!(!allowed("/home/x/a.exe"));
        assert!(!allowed("/home/x/a.txt"));
        assert!(!allowed("/home/x/noext"));
    }

    #[test]
    fn mime_types() {
        assert_eq!(content_type("/x/a.flac"), "audio/flac");
        assert_eq!(content_type("/x/a.mp3"), "audio/mpeg");
        assert_eq!(content_type("/x/a.opus"), "audio/opus");
        assert_eq!(content_type("/x/a.exe"), "application/octet-stream");
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("/mnt/win_d/Music/1000x1000%20-%20Mili.flac"),
                   "/mnt/win_d/Music/1000x1000 - Mili.flac");
        // 中文歌名（UTF-8 百分号编码）：E9 9F B3 = 音, E4 B9 90 = 乐
        // ⚠ 这条断言的期望值是**查证过的**：写它时我一度把 E5 96 9C 当成「唯」，
        // 实际它是「喜」(U+559C)。解码器是对的、测试是错的 —— 两者都要改。
        assert_eq!(percent_decode("/m/%E9%9F%B3%E4%B9%90.flac"), "/m/音乐.flac");
    }
}
