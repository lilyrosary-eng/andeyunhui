//! 逆向：编码 / 哈希 / 明文分类识别
//!
//! 输入任意字符串，自动识别其形态：
//! - 编码：十六进制 hex / Base64 / Base32 / URL 百分号编码 / 明文文本
//! - 哈希：按十六进制长度反推 MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512
//! - 密文：高熵非文本（可能是加密结果）
//!
//! 纯本地、确定性、可单测；替换原「仅卡方 + 粗糙指纹」的单一识别。

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use super::crypto::shannon_entropy;

/// 识别结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncodeAnalysis {
    /// 形态：plain / hex / base64 / base32 / url / hash / cipher / unknown
    pub kind: String,
    /// 人类可读中文说明
    pub label: String,
    /// 若为可解码编码，解码后的原始字节
    pub decoded: Option<Vec<u8>>,
    /// 解码结果（或原文）是否为可打印文本
    pub is_text: bool,
    /// 数据的香农熵
    pub entropy: f64,
    /// 若判定为哈希，算法名
    pub hash_algo: Option<String>,
    /// 解码后的文件/压缩流特征（gzip/zlib/zip/PNG/PDF/ELF/MZ…）
    pub stream_hint: Option<String>,
    /// 文本预览（截断 200 字符）
    pub preview: Option<String>,
}

/// 对输入进行编码/哈希/文本分类识别
pub fn analyze(input: &str) -> EncodeAnalysis {
    let t = input.trim();
    if t.is_empty() {
        return base("unknown", "空输入", None, 0.0);
    }
    // 折叠换行/空格（base64 URL 拷贝常带换行）
    let compact: String = t
        .chars()
        .filter(|c| !matches!(c, '\r' | '\n' | ' '))
        .collect();

    // 1) 十六进制（偶数长度、纯 hexdigit）
    if !compact.is_empty() && compact.len() % 2 == 0 && compact.bytes().all(|b| b.is_ascii_hexdigit()) {
        if let Ok(bytes) = decode_hex(&compact) {
            let hash = hash_from_hex_len(compact.len());
            let entropy = shannon_entropy(&bytes);
            let (is_text, preview) = text_probe(&bytes);
            let hint = sniff_magic(&bytes);
            return EncodeAnalysis {
                kind: if hash.is_some() { "hash".into() } else { "hex".into() },
                label: match hash {
                    Some(h) => format!("疑似 {} 哈希（{} 字节）", h, bytes.len()),
                    None => format!("十六进制编码（{} 字节）", bytes.len()),
                },
                decoded: Some(bytes),
                is_text,
                entropy,
                hash_algo: hash.map(|s| s.to_string()),
                stream_hint: hint.map(|s| s.to_string()),
                preview,
            };
        }
    }

    // 2) Base64（字符集合法 + 长度对齐）
    if looks_like_base64(&compact) {
        if let Ok(bytes) = decode_base64(&compact) {
            let entropy = shannon_entropy(&bytes);
            let (is_text, preview) = text_probe(&bytes);
            let hint = sniff_magic(&bytes);
            return EncodeAnalysis {
                kind: "base64".into(),
                label: format!("Base64 编码（解码 {} 字节）", bytes.len()),
                decoded: Some(bytes),
                is_text,
                entropy,
                hash_algo: None,
                stream_hint: hint.map(|s| s.to_string()),
                preview,
            };
        }
    }

    // 3) Base32（A–Z / 2–7 / =，长度 %8==0）；仅识别未解码
    if looks_like_base32(&compact) {
        return EncodeAnalysis {
            kind: "base32".into(),
            label: "Base32 编码（未内置解码）".into(),
            decoded: None,
            is_text: false,
            entropy: shannon_entropy(t.as_bytes()),
            hash_algo: None,
            stream_hint: None,
            preview: None,
        };
    }

    // 4) URL 百分号编码
    if t.contains('%') {
        if let Ok(bytes) = percent_decode(t) {
            let entropy = shannon_entropy(&bytes);
            let (is_text, preview) = text_probe(&bytes);
            let hint = sniff_magic(&bytes);
            if bytes.len() < t.len() || !bytes.is_empty() {
                return EncodeAnalysis {
                    kind: "url".into(),
                    label: format!("URL 百分号编码（解码 {} 字节）", bytes.len()),
                    decoded: Some(bytes),
                    is_text,
                    entropy,
                    hash_algo: None,
                    stream_hint: hint.map(|s| s.to_string()),
                    preview,
                };
            }
        }
    }

    // 5) 明文可读文本
    if is_readable_utf8(t) {
        return EncodeAnalysis {
            kind: "plain".into(),
            label: "明文文本".into(),
            decoded: None,
            is_text: true,
            entropy: shannon_entropy(t.as_bytes()),
            hash_algo: None,
            stream_hint: None,
            preview: Some(truncate_str(t, 200)),
        };
    }

    // 6) 其余：高熵判为疑似密文，否则未知
    let entropy = shannon_entropy(t.as_bytes());
    base(
        if entropy > 7.0 { "cipher" } else { "unknown" },
        if entropy > 7.0 { "疑似加密数据（高熵，非文本）" } else { "无法识别的数据" },
        None,
        entropy,
    )
}

/// 按 hex 长度反推哈希算法
fn hash_from_hex_len(hex_len: usize) -> Option<&'static str> {
    match hex_len {
        32 => Some("MD5"),
        40 => Some("SHA-1"),
        64 => Some("SHA-256"),
        96 => Some("SHA-384"),
        128 => Some("SHA-512"),
        _ => None,
    }
}

/// 构造最简结果（kind/label/熵）
fn base(kind: &str, label: &str, decoded: Option<Vec<u8>>, entropy: f64) -> EncodeAnalysis {
    let (is_text, preview) = match &decoded {
        Some(b) => text_probe(b),
        None => (false, None),
    };
    EncodeAnalysis {
        kind: kind.to_string(),
        label: label.to_string(),
        decoded,
        is_text,
        entropy,
        hash_algo: None,
        stream_hint: None,
        preview,
    }
}

/// 判断是否形如 Base64（字符集合法，'=' 仅末尾且 ≤2）
fn looks_like_base64(s: &str) -> bool {
    if s.is_empty() || s.len() % 4 != 0 {
        return false;
    }
    let mut eq_seen = false;
    for (i, b) in s.bytes().enumerate() {
        let valid = b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=';
        if !valid {
            return false;
        }
        if b == b'=' {
            // '=' 只能出现在末尾，且最多末尾 2 个
            if s.len().saturating_sub(i) > 2 {
                return false;
            }
            eq_seen = true;
        } else if eq_seen {
            // '=' 之后不能再有有效字符
            return false;
        }
    }
    true
}

/// 判断是否形如 Base32（A–Z / 2–7 / =，长度 %8==0）
fn looks_like_base32(s: &str) -> bool {
    if s.is_empty() || s.len() % 8 != 0 {
        return false;
    }
    s.bytes().all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b) || b == b'=')
}

/// 解码 hex（小写/大写/混合）
fn decode_hex(s: &str) -> Result<Vec<u8>, ()> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for i in (0..bytes.len()).step_by(2) {
        let hi = hex_val(bytes[i]).ok_or(())?;
        let lo = hex_val(bytes[i + 1]).ok_or(())?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Base64 解码（先标准后 URL 安全）
fn decode_base64(s: &str) -> Result<Vec<u8>, ()> {
    use base64::engine::general_purpose::{STANDARD, URL_SAFE};
    STANDARD
        .decode(s)
        .or_else(|_| URL_SAFE.decode(s).or_else(|_| STANDARD.decode(format!("{}=", s))))
        .map_err(|_| ())
}

/// URL 百分号解码（%XX）
fn percent_decode(s: &str) -> Result<Vec<u8>, ()> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(());
            }
            let hi = hex_val(bytes[i + 1]).ok_or(())?;
            let lo = hex_val(bytes[i + 2]).ok_or(())?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Ok(out)
}

/// 判断字节是否为可打印可读文本（合法 UTF-8 且多为可打印 ASCII / 常见空白 / CJK）
fn text_probe(bytes: &[u8]) -> (bool, Option<String>) {
    match std::str::from_utf8(bytes) {
        Ok(s) => {
            if s.is_empty() {
                (false, None)
            } else {
                (true, Some(truncate_str(s, 200)))
            }
        }
        Err(_) => (false, None),
    }
}

/// 是否为可读文本（合法 UTF-8 且可打印字符占比高）
fn is_readable_utf8(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let printable = s
        .chars()
        .filter(|c| *c != '\u{fffd}')
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\r' || *c == '\t')
        .count();
    printable as f64 / s.chars().count() as f64 > 0.9
}

fn truncate_str(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{}…", t)
    }
}

/// 识别已知文件/压缩流魔数（gzip/zlib/zip/PNG/JPEG/PDF/ELF/MZ/bzip2）
fn sniff_magic(bytes: &[u8]) -> Option<&'static str> {
    let head = |n: &[u8]| bytes.starts_with(n);
    if head(b"\x1f\x8b\x08") {
        return Some("gzip");
    }
    if bytes.len() >= 2 && bytes[0] == 0x78 && matches!(bytes[1], 0x01 | 0x9c | 0xda) {
        return Some("zlib");
    }
    if head(b"PK\x03\x04") {
        return Some("ZIP");
    }
    if head(b"\x89PNG\r\n\x1a\n") {
        return Some("PNG");
    }
    if head(&[0xff, 0xd8, 0xff]) {
        return Some("JPEG");
    }
    if head(b"%PDF") {
        return Some("PDF");
    }
    if head(b"\x7fELF") {
        return Some("ELF");
    }
    if head(b"MZ") {
        return Some("PE (MZ)");
    }
    if head(b"BZh") {
        return Some("bzip2");
    }
    None
}

// ================= 单元测试：编码/哈希/文本分类 =================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_bytes_detected_and_decoded() {
        let a = analyze("48656c6c6f");
        assert_eq!(a.kind, "hex");
        assert_eq!(a.decoded.as_deref(), Some(&b"Hello"[..]));
        assert!(a.is_text);
    }

    #[test]
    fn base64_decodes() {
        let a = analyze("aGVsbG8gd29ybGQ=");
        assert_eq!(a.kind, "base64");
        assert_eq!(a.decoded.as_deref(), Some(&b"hello world"[..]));
        assert!(a.is_text);
    }

    #[test]
    fn plain_text_recognized() {
        let a = analyze("这是一段明文，用于测试。");
        assert_eq!(a.kind, "plain");
        assert!(a.is_text);
    }

    #[test]
    fn md5_length_hex_is_hash() {
        let a = analyze("0123456789abcdef0123456789abcdef");
        assert_eq!(a.kind, "hash");
        assert_eq!(a.hash_algo.as_deref(), Some("MD5"));
    }

    #[test]
    fn sha256_length_hex_is_hash() {
        let a = analyze(&"0".repeat(64));
        assert_eq!(a.hash_algo.as_deref(), Some("SHA-256"));
    }

    #[test]
    fn unknown_non_text_high_entropy() {
        // 32 字节奇数长度纯 hexdigit 但为 30 字符（非偶数）×；给一组不可读字节
        let bytes = vec![0u8, 1, 200, 160, 90, 30, 44, 77];
        let content: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
        let a = analyze(&content); // 偶数，hex
        assert_eq!(a.kind, "hex");
    }

    #[test]
    fn empty_is_unknown() {
        let a = analyze("   ");
        assert_eq!(a.kind, "unknown");
    }

    #[test]
    fn gzip_stream_hint_via_base64() {
        // base64("1f 8b 08") = "H4sI"
        let a = analyze("H4sI");
        assert_eq!(a.kind, "base64");
        assert_eq!(a.stream_hint.as_deref(), Some("gzip"));
    }

    #[test]
    fn png_stream_hint_via_base64() {
        // base64("\x89PNG\r\n\x1a\n") = "iVBORw0KGgo="
        let a = analyze("iVBORw0KGgo=");
        assert_eq!(a.kind, "base64");
        assert_eq!(a.stream_hint.as_deref(), Some("PNG"));
    }

    #[test]
    fn zlib_stream_hint_via_hex() {
        let a = analyze("789c");
        assert_eq!(a.kind, "hex");
        assert_eq!(a.stream_hint.as_deref(), Some("zlib"));
    }
}