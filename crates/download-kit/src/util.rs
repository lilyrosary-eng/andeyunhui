//! 无副作用小工具：时间戳、文件名、人读大小、aria2/ffmpeg 进度解析。

use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/// 当前毫秒时间戳（落库用）。
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 去掉 Windows 非法字符，并限制长度；空结果回退 `download.bin`。
pub fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim().to_string();
    let limited: String = trimmed.chars().take(180).collect();
    if limited.is_empty() {
        "download.bin".to_string()
    } else {
        limited
    }
}

/// 从 URL 提取文件名（去 query/fragment，做一次最小 percent 解码）。
pub fn filename_from_url(url: &str) -> Option<String> {
    let no_query = url.split(['?', '#']).next().unwrap_or(url);
    let segment = no_query.rsplit('/').find(|s| !s.is_empty())?;
    let decoded = percent_decode(segment);
    let sanitized = sanitize_filename(&decoded);
    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

/// 仅处理 %XX 的 ASCII 解码；非法序列原样保留。
pub fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 是否是 HLS 清单地址（按路径后缀判断，忽略 query）。
pub fn is_hls_url(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    path.to_ascii_lowercase().ends_with(".m3u8")
}

/// 解析 `1.2MiB` / `34MB` / `512K` / `123` 这类人读大小。
pub fn parse_human_size(raw: &str) -> Option<u64> {
    let text = raw.trim();
    if text.is_empty() || text == "?" || text.eq_ignore_ascii_case("n/a") {
        return None;
    }
    let split_at = text
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(text.len());
    let (num_str, unit) = text.split_at(split_at);
    let number: f64 = num_str.parse().ok()?;
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    let multiplier = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "b" | "byte" | "bytes" => 1.0,
        "k" | "kb" | "kib" => 1024.0,
        "m" | "mb" | "mib" => 1024.0 * 1024.0,
        "g" | "gb" | "gib" => 1024.0 * 1024.0 * 1024.0,
        "t" | "tb" | "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((number * multiplier) as u64)
}

/// 解析 aria2 控制台进度行，返回 `(已下载, 总大小)`。
///
/// 形如：`[#2089b0 1.0MiB/5.0MiB(20%) CN:8 DL:1.0MiB ETA:4s]`
pub fn parse_aria2_progress(line: &str) -> Option<(u64, u64)> {
    let start = line.find('[')?;
    let rest = &line[start + 1..];
    let end = rest.find(']')?;
    let body = &rest[..end];
    let slash = body.find('/')?;
    let left = &body[..slash];
    let right = &body[slash + 1..];
    // 左侧最后一个空白之后才是大小（前面是 gid）。
    let downloaded_text = left.split_whitespace().next_back()?;
    let total_text = right
        .split(['(', ' '])
        .next()
        .unwrap_or("")
        .trim();
    let downloaded = parse_human_size(downloaded_text)?;
    let total = parse_human_size(total_text)?;
    if total == 0 {
        return None;
    }
    Some((downloaded.min(total), total))
}

/// 解析 ffmpeg `-progress pipe:1` 的累计写盘字节数。
pub fn parse_ffmpeg_total_size(line: &str) -> Option<u64> {
    line.strip_prefix("total_size=")?.trim().parse().ok()
}

/// 截取一段尾部文本，用于把外部进程的 stderr 塞进错误消息。
pub fn tail_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let count = trimmed.chars().count();
    if count <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().skip(count - max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_size_parses_units() {
        assert_eq!(parse_human_size("123"), Some(123));
        assert_eq!(parse_human_size("1.5MiB"), Some(1_572_864));
        assert_eq!(parse_human_size("2 GB"), Some(2 * 1024 * 1024 * 1024));
        assert_eq!(parse_human_size("?"), None);
        assert_eq!(parse_human_size("abc"), None);
    }

    #[test]
    fn aria2_progress_line_parses() {
        let line = "[#2089b0 1.0MiB/5.0MiB(20%) CN:8 DL:1.0MiB ETA:4s]";
        assert_eq!(parse_aria2_progress(line), Some((1_048_576, 5_242_880)));
        assert_eq!(parse_aria2_progress("no progress"), None);
    }

    #[test]
    fn ffmpeg_progress_line_parses() {
        assert_eq!(parse_ffmpeg_total_size("total_size=1048576"), Some(1_048_576));
        assert_eq!(parse_ffmpeg_total_size("frame=12"), None);
    }

    #[test]
    fn filename_sanitize_and_extract() {
        assert_eq!(sanitize_filename("a:b?.mp4"), "a_b_.mp4");
        assert_eq!(sanitize_filename("  ...  "), "download.bin");
        assert_eq!(
            filename_from_url("https://x.test/a/b%20c.mp4?token=1"),
            Some("b c.mp4".to_string())
        );
        assert!(is_hls_url("https://x.test/live/index.m3u8?x=1"));
        assert!(!is_hls_url("https://x.test/file.mp4"));
    }
}
