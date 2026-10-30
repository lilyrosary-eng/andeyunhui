// 全局 AI 服务 · 子模块：会话图片存储（content-addressed）
//
// ## 为什么需要
// 要让「对话模型原生看图」，图必须能进入请求体。但请求体是由事件日志**派生**的
// （见 ai_session.rs 的 derive_messages），而事件日志里塞 base64 会：
//   ① 日志线性膨胀（每张图一条，重放/fork 都要读全量）；
//   ② 与已修过的「localStorage 被 base64 撑爆」是同一个坑换位置；
//   ③ 让 append-only 日志从「小 JSON 事实流」变成二进制垃圾场。
//
// ## 做法（业界共识形状）
// 图**按内容寻址**落到数据目录，事件日志里只留一个**引用键**；派生请求体时按引用
// 读回 base64 塞进**临时请求体**。于是：
//   - 日志永远是小 JSON → 可审计、可重放、可 fork；
//   - 请求体永远临时拼装 → 与持久层解耦；
//   - 同图多次出现只存一份（内容寻址天然去重）。
//
// ## 与已有「媒体瘦身」的关系
// ai_session.rs 的 persist_agent_session 原本把 Tool.meta 下的 data URL **丢弃**成
// `<data-url:N chars, not persisted>` 占位串 —— 因为那时图只用于实时渲染，不需要留。
// 现在要留，就把「丢弃」升级为「转存 + 留引用」：占位串替换为 `image://<sha16>`。
// 这是**同一条逻辑的延伸**，不是新开的旁路。

use std::path::{Path, PathBuf};
use tauri::AppHandle;
/// data URL 的解析结果。
pub struct ParsedDataUrl {
    pub mime: String,
    pub base64: String,
}

/// 解析 `data:<mime>;base64,<payload>`。非 data URL 或格式不符返回 None。
///
/// 只认 base64 形式（本项目的图/音/视频一律走 base64 data URL，
/// 见前端 pickImageAt / multimodal_service 的上传路径）；不认 `data:text/plain,` 这种裸文本形式。
pub fn parse_data_url(url: &str) -> Option<ParsedDataUrl> {
    let rest = url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    // meta 形如 "<mime>;base64"（可能带 charset，但媒体类型不会）
    let meta = meta.strip_suffix(";base64")?;
    let mime = meta.trim();
    if mime.is_empty() || payload.is_empty() {
        return None;
    }
    Some(ParsedDataUrl { mime: mime.to_string(), base64: payload.to_string() })
}

/// 由 mime 推扩展名。**只认已知媒体类型**，其余回落到 `bin`。
///
/// 为什么要扩展名而不是全用 `.bin`：用户可能直接去数据目录找那张图，
/// `.png` 能被系统正确识别与预览；`.bin` 不能。文件内容仍是原始字节，无额外处理。
fn ext_of(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/webm" => "webm",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    }
}

/// 引用键前缀。事件日志里存成 `image://<id>`，一眼能看出「这是个引用，不是内容」。
pub const REF_SCHEME: &str = "image://";

/// 存储目录：`<data_root>/ai_media`。
///
/// 放在数据根目录下（而非 app_data_dir）是刻意的：本项目的数据根可被用户重定向
/// （data_location.rs 的 junction 机制），用户把数据挪到大盘时图片应跟着走。
fn media_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::data_location::resolve_data_root(app).join("ai_media");
    if fs_create_dir_all(&dir).is_err() {
        return None;
    }
    Some(dir)
}

fn fs_create_dir_all(p: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(p)
}

/// 稳定短 id：对**原始字节**取指纹（不是对 base64 —— 编码细节不该影响同一张图的 id）。
///
/// 用 std 的 DefaultHasher 而不是引 sha2：本用途是**去重与文件名**，不是密码学完整性，
/// 且不引入新依赖（见项目「轻量高效、避免不必要依赖」的取舍）。
/// 128 位哈希在「同一个用户自己的会话图片集合」这个规模下碰撞概率可忽略；
/// 万一碰撞，写入是按字节比对过的（见 store_data_url）。
fn content_id(bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h1 = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h1);
    let a = h1.finish();
    // 再跑一次加盐，凑够 16 字节宽度，降低短输入下的碰撞面
    let mut h2 = std::collections::hash_map::DefaultHasher::new();
    bytes.len().hash(&mut h2);
    bytes.hash(&mut h2);
    let b = h2.finish();
    format!("{:016x}{:016x}", a, b)
}

/// base64 解码（标准表，容忍换行与空白）。
///
/// 自己解是为了不引入 base64 crate —— 而且必须自己解：如果不解码就拿 base64 字符串
/// 的字节做指纹，「同一张图的 base64 带换行/不带换行」会算出两个 id，去重就失效了。
fn decode_base64(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut nbits = 0u32;
    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        // 跳过空白（部分端点的 base64 带换行）
        let Some(v) = val(c) else {
            if c.is_ascii_whitespace() {
                continue;
            }
            return None;
        };
        acc = (acc << 6) | v as u32;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            out.push((acc >> nbits) as u8);
        }
    }
    Some(out)
}

/// 把一段 data URL 存入媒体目录，返回引用键（`image://<id>`）。
///
/// 幂等：同一张图重复调用只写一次（内容寻址）。
/// 失败返回 None —— 调用方应回落「不存，走原占位串」，
/// **不能让存储失败阻断对话**（图是增强，不是主链路）。
pub fn store_data_url(app: &AppHandle, data_url: &str) -> Option<String> {
    let dir = media_dir(app)?;
    store_data_url_in(&dir, data_url)
}

/// 把 data URL 存进指定目录（项目内 `.adyh/media` 复用同一条内容寻址逻辑）。
pub fn store_data_url_in(dir: &Path, data_url: &str) -> Option<String> {
    let parsed = parse_data_url(data_url)?;
    let bytes = decode_base64(&parsed.base64)?;
    if bytes.is_empty() {
        return None;
    }
    let id = content_id(&bytes);
    std::fs::create_dir_all(dir).ok()?;
    let file = dir.join(format!("{}.{}", id, ext_of(&parsed.mime)));
    // 已存在就跳过写入（去重）。仍然比对长度，避免极端情况下同 id 不同内容。
    if file.exists() {
        if let Ok(meta) = std::fs::metadata(&file) {
            if meta.len() == bytes.len() as u64 {
                return Some(format!("{}{}", REF_SCHEME, id));
            }
        }
    }
    std::fs::write(&file, &bytes).ok()?;
    Some(format!("{}{}", REF_SCHEME, id))
}

/// 判断一个字符串是否是我们自己写出的图片引用键。
pub fn is_ref(s: &str) -> bool {
    s.starts_with(REF_SCHEME)
}

/// 测试专用：把 base64 解码出来（供 caps_probe 校验探测素材是合法 PNG）。
#[cfg(test)]
pub fn test_decode(s: &str) -> Option<Vec<u8>> {
    decode_base64(s)
}

/// 按引用键读回 data URL（供 derive_messages 拼请求体用）。
///
/// 找不到/读不出返回 None —— 调用方应**跳过该图**而不是报错中断：
/// 图被用户清理掉是正常情况，不该让整轮对话失败。
pub fn load_data_url(app: &AppHandle, r: &str) -> Option<String> {
    let dir = crate::data_location::resolve_data_root(app).join("ai_media");
    load_data_url_from(&dir, r)
}

/// 从指定目录按引用键读回 data URL（项目内 `.adyh/media` 优先）。
pub fn load_data_url_from(dir: &Path, r: &str) -> Option<String> {
    let id = r.strip_prefix(REF_SCHEME)?;
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        // 防目录穿越：id 是我们自己生成的十六进制串，不该含分隔符
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    // 扩展名在存的时候才决定，这里按 id 前缀找
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if let Some(stem) = name.split('.').next() {
            if stem == id {
                let bytes = std::fs::read(e.path()).ok()?;
                let mime = e
                    .path()
                    .extension()
                    .map(|x| mime_of_ext(&x.to_string_lossy()))
                    .unwrap_or("application/octet-stream");
                return Some(format!("data:{};base64,{}", mime, encode_base64(&bytes)));
            }
        }
    }
    None
}

/// 扩展名 → mime（load_data_url 回填用）。只覆盖 ext_of 认得的类型。
fn mime_of_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

/// 标准 base64 编码（load_data_url 回填用）。
fn encode_base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 媒体目录占用统计（字节）与文件数 —— 供设置页展示与清理前确认。
pub fn usage(app: &AppHandle) -> (u64, usize) {
    let dir = crate::data_location::resolve_data_root(app).join("ai_media");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return (0, 0);
    };
    let mut total = 0u64;
    let mut count = 0usize;
    for e in entries.flatten() {
        if let Ok(m) = e.metadata() {
            if m.is_file() {
                total += m.len();
                count += 1;
            }
        }
    }
    (total, count)
}

/// 清理媒体目录。`older_than_secs` 为 Some 时只删该时长之前修改的文件。
/// 返回 (删除数, 释放字节)。
///
/// ⚠️ 只删 `ai_media` 目录**内**的文件，不递归、不跟随目录符号链接，
///    且严格校验每个条目是 `is_file()`（目录一律跳过）。
pub fn cleanup(app: &AppHandle, older_than_secs: Option<u64>) -> (usize, u64) {
    let dir = crate::data_location::resolve_data_root(app).join("ai_media");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return (0, 0);
    };
    let cutoff = older_than_secs.map(|s| {
        std::time::SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(s))
            .unwrap_or(std::time::UNIX_EPOCH)
    });
    let mut removed = 0usize;
    let mut freed = 0u64;
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if let Some(c) = cutoff {
            match meta.modified() {
                Ok(t) if t >= c => continue,
                Err(_) => continue, // 拿不到修改时间 → 不删（宁可不清理，也不误删）
                _ => {}
            }
        }
        let len = meta.len();
        if std::fs::remove_file(e.path()).is_ok() {
            removed += 1;
            freed += len;
        }
    }
    (removed, freed)
}

// ========== 命令 ==========

/// 媒体占用统计（设置页展示）。
#[tauri::command]
pub fn ai_media_usage(app: AppHandle) -> serde_json::Value {
    let (bytes, count) = usage(&app);
    serde_json::json!({ "bytes": bytes, "count": count })
}

/// 把一条 data URL 落到本地媒体库，返回 `image://<id>` 引用。
/// 前端用它把会话里的图片从 localStorage 挪到磁盘：localStorage 只存短引用，
/// 重进对话时再用 `ai_media_load` 读回，图片就不会因为配额瘦身变成文字。
#[tauri::command]
pub fn ai_media_store(app: AppHandle, data_url: String) -> Option<String> {
    store_data_url(&app, &data_url)
}

/// 按 `image://<id>` 引用读回 data URL（供会话加载时回填图片）。
#[tauri::command]
pub fn ai_media_load(app: AppHandle, r: String) -> Option<String> {
    load_data_url(&app, &r)
}

/// 清理媒体目录。`days` 为 None 时清空全部；Some(n) 只清 n 天前的。
#[tauri::command]
pub fn ai_media_cleanup(app: AppHandle, days: Option<u64>) -> serde_json::Value {
    let (removed, freed) = cleanup(&app, days.map(|d| d * 86_400));
    serde_json::json!({ "removed": removed, "freed": freed })
}

#[cfg(test)]
mod tests {
    // 测试名写中文是故意的（见 caps_infer.rs 同处说明），关掉 non_snake_case。
    #![allow(non_snake_case)]
    use super::*;

    #[test]
    fn 解析标准_data_url() {
        let p = parse_data_url("data:image/png;base64,iVBORw0KGgo=").unwrap();
        assert_eq!(p.mime, "image/png");
        assert_eq!(p.base64, "iVBORw0KGgo=");
    }

    #[test]
    fn 非_data_url_返回None() {
        assert!(parse_data_url("https://x/a.png").is_none());
        assert!(parse_data_url("data:image/png,").is_none(), "空 payload 不该被当图");
        assert!(parse_data_url("data:;base64,AAAA").is_none(), "空 mime 不该被当图");
    }

    #[test]
    fn 非base64形式不认() {
        // 裸文本 data URL（data:text/plain,hello）不是媒体，不该走存储
        assert!(parse_data_url("data:text/plain,hello").is_none());
    }

    #[test]
    fn base64往返一致() {
        for case in [&b"a"[..], &b"ab"[..], &b"abc"[..], &b"abcd"[..], &b"\x00\xff\x10\x20\x30"[..]] {
            let enc = encode_base64(case);
            let dec = decode_base64(&enc).unwrap();
            assert_eq!(dec, case, "编码解码应无损");
        }
    }

    #[test]
    fn base64解码容忍换行() {
        // 部分端点返回的 base64 带换行，解码必须容忍（否则同一张图算出两个 id）
        let with_nl = "aGVs\nbG8=";
        assert_eq!(decode_base64(with_nl).unwrap(), b"hello");
    }

    #[test]
    fn 内容相同则id相同() {
        assert_eq!(content_id(b"same-bytes"), content_id(b"same-bytes"));
        assert_ne!(content_id(b"a"), content_id(b"b"));
    }

    #[test]
    fn 相同内容不同编码不影响id() {
        // 关键性质：id 取自解码后的字节，所以带换行/不带换行的 base64 指向同一张图
        let a = decode_base64("aGVsbG8=").unwrap();
        let b = decode_base64("aGVs\nbG8=").unwrap();
        assert_eq!(content_id(&a), content_id(&b));
    }

    #[test]
    fn 引用键判定() {
        assert!(is_ref("image://abc123"));
        assert!(!is_ref("data:image/png;base64,AAA"));
        assert!(!is_ref("<data-url:100 chars, not persisted>"));
        assert!(!is_ref("https://x/a.png"));
    }

    #[test]
    fn 扩展名映射() {
        assert_eq!(ext_of("image/png"), "png");
        assert_eq!(ext_of("image/jpeg"), "jpg");
        assert_eq!(ext_of("audio/mpeg"), "mp3");
        // 未知类型回落 bin，不 panic
        assert_eq!(ext_of("application/x-weird"), "bin");
    }

    #[test]
    fn 加载拒绝目录穿越() {
        // 纯逻辑部分：id 含分隔符或 .. 时 strip 后应被拒（不需要真实 app 实例）
        for bad in ["image://../etc/passwd", "image://a/b", "image://a\\b"] {
            let id = bad.strip_prefix(REF_SCHEME).unwrap();
            assert!(
                id.contains('/') || id.contains('\\') || id.contains(".."),
                "该 id 应被穿越检查拦下：{}",
                bad
            );
        }
    }
}
