//! 攻防模块后端内核
//!
//! 架构：双轨制事件溯源（Dual-Track Event Sourcing）
//! - 控制面（AI 常驻推理核）：tokio::broadcast 下发策略补丁，绝不等待 I/O
//! - 数据面（执行引擎）：50ms Tick 循环，tokio::process 编排，绝不等待 AI
//! - 热交换：arc-swap 无锁 CAS 替换策略指针，亚毫秒级切换，零暂停
//! - 抢占：crossbeam 优先级队列接收 @focus/@bypass，软着陆过渡
//!
//! 隔离：重型依赖在 feature flag 后（crawler/reverse/pentest/automation/gateway），
//! 默认构建仅含 kernel 骨架 + commands stub，主二进制零污染。

pub mod ai;
pub mod kernel;
pub mod commands;
/// 统一 HTTP GET 通道（真实 TLS 指纹优先，否则 rustls）：始终编译
pub mod http_channel;

#[cfg(feature = "crawler")]
pub mod crawler;
#[cfg(feature = "reverse")]
pub mod reverse;
#[cfg(feature = "pentest")]
pub mod pentest;
#[cfg(feature = "automation")]
pub mod automation;
#[cfg(feature = "gateway")]
pub mod gateway;

// pentest 模块的无 feature 依赖子模块（encoder/payload/probe/regex_dfa）始终编译，
// 仅 topology.rs（依赖 petgraph）在 pentest feature 后。
// 注意：lib.rs 中 pentest 整体被 feature gate 控制，所以需要 pentest feature 才能使用。

pub use kernel::KernelEngine;

/// URL 规范化：无 scheme 的裸域名/IP 自动补 `https://`。
///
/// 全模块所有对外 URL 入口（fetch/waf/tech/methods/paths/wellknown/error_page/
/// Focus 注入/爬虫队列）都应先过此函数，避免裸域直传 reqwest 报
/// `builder error`（地址无法解析）。已带 scheme / 非 http(s) 协议原样返回。
pub fn normalize_url(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return t.to_string();
    }
    // 仅对「裸 http(s) 目标」补全：无 :// 且看起来像域名/IP 的输入
    if !t.contains("://") {
        // 形如 example.com / 10.0.0.1:8080 / localhost:8781 等
        return format!("https://{}", t);
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::normalize_url;

    #[test]
    fn normalize_ok() {
        // 裸域 → 补 https
        assert_eq!(normalize_url("adyh.cc.cd"), "https://adyh.cc.cd");
        // IP:端口
        assert_eq!(normalize_url("10.0.0.1:8080"), "https://10.0.0.1:8080");
        assert_eq!(normalize_url("127.0.0.1:8781"), "https://127.0.0.1:8781");
        // 已带 scheme 不动
        assert_eq!(normalize_url("http://x.com"), "http://x.com");
        assert_eq!(normalize_url("https://adyh.cc.cd/p"), "https://adyh.cc.cd/p");
        // 其它协议不动
        assert_eq!(normalize_url("ftp://x.com"), "ftp://x.com");
        // 空白
        assert_eq!(normalize_url("  "), "");
        assert_eq!(normalize_url(""), "");
    }
}
