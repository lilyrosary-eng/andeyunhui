//! 真实 TLS 指纹通道（curl-impersonate 外部进程，MIT）
//!
//! 为什么需要它：rustls/reqwest 的 ClientHello 是**固定指纹**（实测 JA4
//! `t13d1011h1_61a7ad8aa9b6_3fcd1a44f3e3`、无 GREASE、HTTP/1.1），
//! 与真实 Chrome（JA4 `t13d1516h2_8daaf6152771_...`、Akamai `52d84b11...`）
//! 差异明显——换 UA 不改变 JA3/JA4，这正是「隐身头」掩盖不了的硬特征。
//!
//! 本模块以**外部进程**方式调用 curl-impersonate：其内嵌 BoringSSL，可按
//! `--impersonate <target>` 复现目标浏览器的 TLS ClientHello + HTTP/2 帧指纹
//! （含扩展置换、GREASE、ALPS、证书压缩），实测与本机真实 Chrome 完全对齐。
//!
//! 边界与约束：
//! - 二进制随 `external-deps/全局/curl-impersonate/` 分发（Android/lite 构建排除）；
//!   兼容 BoringSSL 进程内客户端（rquest 等）需 cmake/nasm/perl 工具链，本项目构建机没有。
//! - 找不到二进制时**不报错**：调用方降级回 rustls 通道，仅日志告警。
//! - `--impersonate` 会自行决定**全套请求头**（UA / sec-ch-ua / sec-fetch-* / Accept），
//!   因此本通道内**绝不**再叠加 `stealth::headers_for()`——否则「指纹说 Chrome123、
//!   头说 Windows Chrome122」反而是更强的爬虫特征。

use std::path::{Path, PathBuf};
use std::process::Stdio;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use tokio::process::Command;

/// 显式覆盖二进制的环境变量（调试/替换版本用，优先级最高）
pub const ENV_BIN: &str = "CURL_IMPERSONATE_PATH";

/// 相对「外部依赖根」的落地目录（dev 的 `external-deps/` 与打包后的
/// `user_external_deps/` 使用同一相对路径，故一套常量即可覆盖两种形态）
pub const REL_DIR: &str = "全局/curl-impersonate";

/// 平台对应的二进制文件名
#[cfg(windows)]
const BIN_NAME: &str = "curl-impersonate.exe";
#[cfg(not(windows))]
const BIN_NAME: &str = "curl-impersonate";

/// 宿主（Tauri app）注入的搜索根，优先级：user_external_deps > external-deps
static SEARCH_ROOTS: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// 已成功解析的路径缓存（避免每次抓取都重新探测文件系统）
static RESOLVED: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

/// 由宿主注入外部依赖搜索根（幂等；重复调用覆盖旧值）
///
/// - dev：`<repo>/external-deps`
/// - 打包：`<AppData>/user_external_deps`（.mujin 解压后）与 `<resource>/external-deps`
///
/// 不做存在性过滤：根目录可能晚于启动创建（用户运行中导入 .mujin），
/// 命中判定交给候选路径的 `is_file()`；成功解析才进缓存，故后到的二进制仍会被发现。
pub fn set_search_roots(roots: Vec<PathBuf>) {
    log::info!(
        "[impersonate] 搜索根已注入: {:?}",
        roots.iter().map(|p| p.display().to_string()).collect::<Vec<_>>()
    );
    *SEARCH_ROOTS.lock() = roots;
    // 搜索根变化后旧解析结果可能失效（例如用户刚导入 .mujin）
    *RESOLVED.lock() = None;
}

/// 定位 curl-impersonate 二进制
///
/// 顺序：`CURL_IMPERSONATE_PATH` → 宿主注入的搜索根 → 开发态兜底 → `PATH`。
pub fn binary_path() -> Option<PathBuf> {
    if let Some(p) = RESOLVED.lock().clone() {
        return Some(p);
    }
    for cand in candidates() {
        if cand.is_file() {
            log::info!("[impersonate] 通道二进制: {}", cand.display());
            *RESOLVED.lock() = Some(cand.clone());
            return Some(cand);
        }
    }
    None
}

/// 真实 TLS 指纹通道当前是否可用（feature 已编译 + 二进制可定位）
pub fn is_available() -> bool {
    binary_path().is_some()
}

/// 按优先级枚举候选路径（第一个实际存在的即为命中）
fn candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();

    // 1. 环境变量显式覆盖
    if let Ok(p) = std::env::var(ENV_BIN) {
        if !p.trim().is_empty() {
            v.push(PathBuf::from(p));
        }
    }

    // 2. 宿主注入的搜索根（user_external_deps 优先于 external-deps）
    for root in SEARCH_ROOTS.lock().iter() {
        v.push(root.join(REL_DIR).join(BIN_NAME));
    }

    // 3. 开发态兜底：crate 目录向上一层 src-tauri 再向上一层即仓库根
    //    （release 在用户机器上此路径不存在，is_file() 自动跳过）
    v.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("external-deps")
            .join(REL_DIR)
            .join(BIN_NAME),
    );

    // 4. PATH 扫描（用户自行 `go install`/解压到系统路径的情况）
    if let Ok(paths) = std::env::var("PATH") {
        for dir in std::env::split_paths(&paths) {
            v.push(dir.join(BIN_NAME));
        }
    }

    v
}

/// `Strategy.tls_profile` → curl-impersonate 目标名
///
/// 策略里的档案名（chrome_122 / firefox_120 / safari_17）是**语义标签**，
/// curl-impersonate 只提供离散的真实版本目标；此处取「不早于标签版本」的最近目标，
/// 保证指纹与标签描述的大版本特征一致（例如 chrome123 具备 Chrome 110+ 的扩展置换行为）。
pub fn profile_target(tls_profile: &str) -> &'static str {
    match tls_profile {
        "firefox_120" => "firefox133",
        "safari_17" => "safari170",
        // 含默认分支：chrome_122 及未知档案一律走 Chrome
        _ => "chrome123",
    }
}

/// 通道返回的一次响应（字段与爬虫 `AttemptOutcome::Response` 对齐）
#[derive(Debug, Clone)]
pub struct Impersonated {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// 全链路耗时（ms），取自 curl `time_total`，与 reqwest 侧 RTT 口径一致
    pub rtt_ms: f64,
    /// 实际协商出的 HTTP 版本（"1.1" / "2" / "3"），用于审计通道是否真的走了 h2
    pub http_version: String,
}

/// 临时文件对（headers/body），Drop 时自动清理，保证任何返回路径都不留残渣
struct TempPair {
    head: PathBuf,
    body: PathBuf,
}

impl TempPair {
    fn new() -> Self {
        // 进程内唯一：pid + 纳秒时间戳 + 原子计数（同一纳秒并发调用也不撞名）
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = std::env::temp_dir().join(format!(
            "andy-impersonate-{}-{}-{}",
            std::process::id(),
            nanos,
            seq
        ));
        Self {
            head: base.with_extension("head"),
            body: base.with_extension("body"),
        }
    }
}

impl Drop for TempPair {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.head);
        let _ = std::fs::remove_file(&self.body);
    }
}

/// 从 `-D` 头文件中取**最后一个**响应块（跟随重定向时前面还有 3xx 块）
fn parse_last_header_block(raw: &str) -> Vec<(String, String)> {
    let mut blocks: Vec<&str> = Vec::new();
    for chunk in raw.split("\r\n\r\n") {
        for b in chunk.split("\n\n") {
            let t = b.trim();
            if !t.is_empty() {
                blocks.push(t);
            }
        }
    }
    let block = blocks.last().copied().unwrap_or("");

    let mut out = Vec::new();
    for line in block.lines() {
        let line = line.trim_end_matches('\r');
        // 跳过状态行（HTTP/1.1 200 / HTTP/2 200）与 HTTP/2 伪头
        if line.starts_with("HTTP/") || line.starts_with(':') || line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim();
            // 续行（以空白开头）在此简化为丢弃：现代响应头几乎不再使用折叠
            if !k.is_empty() {
                out.push((k.to_string(), v.trim().to_string()));
            }
        }
    }
    out
}

/// 发一次请求（阻塞式进程 I/O，已在 async 上下文内以 tokio::process 调度）
///
/// - `proxy`：透传既有选路结果（网关节点或爬虫代理池），走标准 `--proxy`
/// - `tls_profile`：策略档案名，内部映射为 curl-impersonate 目标
pub async fn fetch(
    url: &str,
    proxy: Option<&str>,
    timeout_ms: u64,
    tls_profile: &str,
) -> Result<Impersonated, String> {
    let bin = binary_path().ok_or_else(|| {
        format!(
            "未找到 curl-impersonate 二进制（可经 {} 指定，或放入 external-deps/{}/）",
            ENV_BIN, REL_DIR
        )
    })?;
    let target = profile_target(tls_profile);
    let tmp = TempPair::new();

    // 秒级字符串：curl 的 --max-time 支持小数
    let secs = (timeout_ms.max(1_000) as f64) / 1000.0;
    let max_time = format!("{:.3}", secs);
    let connect_timeout = format!("{:.3}", secs.min(15.0));

    let mut cmd = Command::new(&bin);
    cmd.arg("--impersonate")
        .arg(target)
        .arg("--compressed") // gzip/br/zstd 解码（对齐 reqwest 的 gzip/br/deflate）
        .arg("-s") // 静默：不输出进度条
        .arg("-S") // 但仍输出错误信息（便于诊断，配合 -s 使用）
        .arg("-L") // 跟随重定向
        .arg("--max-redirs")
        .arg("5") // 与 gongfang_fetch 的 Policy::limited(5) 保持一致
        .arg("--max-time")
        .arg(&max_time)
        .arg("--connect-timeout")
        .arg(&connect_timeout)
        .arg("-o")
        .arg(&tmp.body)
        .arg("-D")
        .arg(&tmp.head)
        // 元信息经 stdout 回传（body 已被 -o 重定向，stdout 只有这行标记）
        .arg("-w")
        .arg("__ANDY_META__%{http_code}|%{time_total}|%{http_version}")
        .arg(url);

    if let Some(p) = proxy {
        cmd.arg("--proxy").arg(p);
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("curl-impersonate 进程启动失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();

    let (status, rtt_ms, http_version) = parse_meta(&stdout);

    if status == 0 {
        // curl 未能拿到响应（DNS/连接/TLS/超时/代理故障）→ 交由爬虫重试逻辑换代理
        let code = out.status.code().unwrap_or(-1);
        return Err(format!(
            "curl-impersonate 传输失败 (exit={}{}){}",
            code,
            if stderr.is_empty() { "" } else { ", " },
            stderr
        ));
    }
    if !out.status.success() {
        // 已拿到响应头但传输被中断（如 max-time 掐断 body）：保留结果，仅告警
        log::warn!(
            "[impersonate] {} 传输未完整结束 (exit={:?}): {}",
            url,
            out.status.code(),
            stderr
        );
    }

    let body = tokio::fs::read(&tmp.body)
        .await
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default();
    let head_raw = tokio::fs::read_to_string(&tmp.head).await.unwrap_or_default();

    let headers = parse_last_header_block(&head_raw);
    log::info!(
        "[impersonate] {} -> {} (target={} http={} rtt={}ms proxy={:?})",
        url,
        status,
        target,
        http_version,
        rtt_ms as u64,
        proxy
    );

    Ok(Impersonated {
        status,
        headers,
        body,
        rtt_ms,
        http_version,
    })
}

/// 解析 `-w` 回传的元信息行：`__ANDY_META__<code>|<time_total>|<http_version>`
fn parse_meta(stdout: &str) -> (u16, f64, String) {
    let Some(pos) = stdout.find("__ANDY_META__") else {
        return (0, 0.0, String::new());
    };
    let tail = &stdout[pos + "__ANDY_META__".len()..];
    let line = tail.lines().next().unwrap_or("").trim();
    let mut it = line.split('|');
    let status = it.next().unwrap_or("0").trim().parse::<u16>().unwrap_or(0);
    // 部分 locale 的小数分隔符是逗号，统一归一化后再解析
    let rtt_ms = it
        .next()
        .unwrap_or("0")
        .trim()
        .replace(',', ".")
        .parse::<f64>()
        .map(|s| s * 1000.0)
        .unwrap_or(0.0);
    let http_version = it.next().unwrap_or("").trim().to_string();
    (status, rtt_ms, http_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_mapping_is_stable() {
        assert_eq!(profile_target("chrome_122"), "chrome123");
        assert_eq!(profile_target("firefox_120"), "firefox133");
        assert_eq!(profile_target("safari_17"), "safari170");
        // 未知档案走 Chrome 默认，不应 panic
        assert_eq!(profile_target("whatever"), "chrome123");
    }

    #[test]
    fn parse_meta_ok_and_bad() {
        let (s, rtt, v) = parse_meta("__ANDY_META__200|0.1234|2");
        assert_eq!(s, 200);
        assert!((rtt - 123.4).abs() < 0.001);
        assert_eq!(v, "2");
        // 逗号小数分隔符也能解析
        let (s2, _, _) = parse_meta("__ANDY_META__404|0,5|1.1");
        assert_eq!(s2, 404);
        // 无标记 → status 0（调用方按传输失败处理）
        assert_eq!(parse_meta("").0, 0);
    }

    #[test]
    fn header_block_takes_last_response() {
        let raw = "HTTP/1.1 301 Moved\r\nLocation: https://b/\r\n\r\nHTTP/2 200\r\ncontent-type: text/html\r\ncf-ray: abc\r\n";
        let h = parse_last_header_block(raw);
        assert!(h.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")));
        // 3xx 块的 Location 不应出现（取最后一个响应块）
        assert!(!h.iter().any(|(k, _)| k.eq_ignore_ascii_case("location")));
    }

    #[test]
    fn binary_lookup_never_panics() {
        // 本机存在与否都不应 panic；存在时应拿到 curl-impersonate
        let _ = is_available();
    }
}