//! TLS 指纹探针（Phase 1 技术选型 spike，dev-only）
//!
//! 用途：测量当前 HTTP 客户端在真实站点上呈现的 **JA3 / JA4 / Akamai HTTP2 指纹**，
//! 作为「接入 impersonate 通道」前后的对照基线。
//!
//! 运行：
//!   cargo run --bin tls_probe --features crawler
//!   cargo run --bin tls_probe --features crawler,tls-impersonate   # 含真实指纹通道对比
//!   cargo run --bin tls_probe --features crawler -- https://tls.peet.ws/api/all
//!
//! 注意：这是验证工具，不是产品代码。它只做只读 GET，不改动任何状态。
//!
//! 关于导入路径：bin 是独立 crate root，故经包名 `gongfang_kit` 引用 lib。
#![cfg(feature = "crawler")]

use std::time::Duration;

use gongfang_kit::crawler::stealth;

/// 默认指纹回显端点（可被命令行参数覆盖）
const DEFAULT_ENDPOINTS: &[&str] = &[
    "https://tls.peet.ws/api/all",
    "https://tls.browserleaks.com/json",
];

/// 我们关心的指纹字段名（在返回 JSON 里递归搜集）
const WANTED_KEYS: &[&str] = &[
    "ja3",
    "ja3_hash",
    "ja3n",
    "ja3n_hash",
    "ja4",
    "akamai",
    "akamai_fingerprint",
    "akamai_fingerprint_hash",
    "peetprint",
    "peetprint_hash",
    "http_version",
];

/// 递归搜集 JSON 中所有目标字段（键名含目标子串即收集）
fn collect_keys(v: &serde_json::Value, out: &mut Vec<(String, String)>) {
    match v {
        serde_json::Value::Object(map) => {
            for (k, val) in map {
                let kl = k.to_lowercase();
                if WANTED_KEYS.iter().any(|w| kl == *w) {
                    let s = match val {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    out.push((k.clone(), s));
                }
                collect_keys(val, out);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_keys(item, out);
            }
        }
        _ => {}
    }
}

/// 用指定模式发一次请求并回显指纹
async fn probe(endpoint: &str, stealth_mode: bool) {
    let mode = if stealth_mode { "stealth(全隐身头)" } else { "direct(仅UA)" };
    println!("\n--- {endpoint}  [{mode}] ---");

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            println!("  ✗ 客户端构建失败: {e}");
            return;
        }
    };

    let mut req = client.get(endpoint);
    if stealth_mode {
        for (k, v) in stealth::headers_for("chrome_122").pairs() {
            req = req.header(k, v);
        }
        req = req.header("Referer", stealth::DEFAULT_REFERER);
    } else {
        req = req.header("User-Agent", stealth::user_agent("chrome_122"));
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            println!("  ✗ 请求失败（端点可能不可达/被墙）: {e}");
            return;
        }
    };

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    println!("  HTTP {status}  长度={}B", body.len());

    match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(v) => {
            let mut hits = Vec::new();
            collect_keys(&v, &mut hits);
            // 去重后打印
            let mut seen = std::collections::HashSet::new();
            for (k, val) in hits {
                if seen.insert(k.clone()) {
                    println!("  {k} = {val}");
                }
            }
            if seen.is_empty() {
                println!("  （未匹配到已知指纹字段，原始响应前 300 字）:");
                println!("  {}", body.chars().take(300).collect::<String>());
            }
        }
        Err(_) => {
            println!("  （非 JSON 响应，前 300 字）:");
            println!("  {}", body.chars().take(300).collect::<String>());
        }
    }
}

#[tokio::main]
async fn main() {
    println!("=== TLS 指纹探针（当前 rustls/reqwest 基线）===");
    println!("说明：UA 变化不会改变 JA3/JA4 —— 两者指纹应完全一致，这正是需要 impersonate 通道的原因。");

    let args: Vec<String> = std::env::args().skip(1).collect();
    let endpoints: Vec<&str> = if args.is_empty() {
        DEFAULT_ENDPOINTS.to_vec()
    } else {
        args.iter().map(|s| s.as_str()).collect()
    };

    for ep in &endpoints {
        // 两种模式各测一次：证明「换 UA 不换指纹」
        probe(ep, false).await;
        probe(ep, true).await;
    }

    // 真实指纹通道：同一端点、同一站点，对比 JA4/Akamai 是否对齐真实浏览器
    for ep in &endpoints {
        probe_impersonate(ep).await;
    }

    println!("\n=== 完成 ===");
}

/// 经**生产统一通道**（`http_channel::get`，与 gongfang_fetch / WAF 探测同一条路）发一次
/// 请求并回显指纹（需 `tls-impersonate` feature）
///
/// 期望（防退化基线）：
/// - `channel = impersonate`（若为 rustls，说明二进制没定位到 → 已静默降级）
/// - `http_version = 2`（h2 帧指纹参与识别，而 rustls 通道恒为 1.1）
/// - `ja4 = t13d1516h2_8daaf6152771_*`（与真实 Chrome 对齐）
/// - `akamai = 52d84b11737d980aef856699f885ca86`（真实 Chrome 的 h2 指纹）
async fn probe_impersonate(endpoint: &str) {
    #[cfg(feature = "tls-impersonate")]
    {
        use gongfang_kit::crawler::impersonate;
        use gongfang_kit::http_channel;

        println!("\n--- {endpoint}  [统一通道 chrome_122 → target {}] ---", impersonate::profile_target("chrome_122"));
        match impersonate::binary_path() {
            Some(bin) => println!("  二进制: {}", bin.display()),
            None => println!("  ✗ 未找到 curl-impersonate 二进制（external-deps/全局/curl-impersonate/ 或 CURL_IMPERSONATE_PATH）"),
        }

        match http_channel::get(endpoint, 20_000, "chrome_122").await {
            Ok(r) => {
                println!(
                    "  channel={}  HTTP {}  rtt={}ms  长度={}B",
                    r.channel,
                    r.status,
                    r.rtt_ms as u64,
                    r.body.len()
                );
                if r.channel == http_channel::CH_RUSTLS {
                    println!("  ⚠ 走了 rustls 通道：本次指纹将等同于上方基线，非真实浏览器指纹");
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&r.body) {
                    let mut hits = Vec::new();
                    collect_keys(&v, &mut hits);
                    let mut seen = std::collections::HashSet::new();
                    for (k, val) in hits {
                        if seen.insert(k.clone()) {
                            println!("  {k} = {val}");
                        }
                    }
                }
            }
            Err(e) => println!("  ✗ 通道失败: {e}"),
        }
    }
    #[cfg(not(feature = "tls-impersonate"))]
    {
        let _ = endpoint;
        println!("\n--- {endpoint}  [impersonate] ---");
        println!("  ⊘ 未启用 tls-impersonate feature（cargo run --bin tls_probe --features crawler,tls-impersonate）");
    }
}