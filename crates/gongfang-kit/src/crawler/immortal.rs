//! 原子销毁与瞬时重建
//!
//! 替代 netns 网络命名空间重置 + MAC 轮转（Windows 无 netns，进程级代理切换 + 浏览器实例重建）
//! 目标：被封禁时 <50ms 切换代理 + 清空会话票据，数据面请求队列自动重试

use std::sync::Arc;

use crate::crawler::pool::{ProxyEntry, ProxyPool};

pub struct ImmortalRebuilder {
    pool: Arc<ProxyPool>,
}

impl ImmortalRebuilder {
    pub fn new(pool: Arc<ProxyPool>) -> Self {
        Self { pool }
    }

    /// 检测是否被封禁（403/429 + body 含 blocked/challenge）
    pub fn is_blocked(status: u16, body: &str) -> bool {
        if status != 403 && status != 429 {
            return false;
        }
        let lower = body.to_lowercase();
        lower.contains("blocked")
            || lower.contains("challenge")
            || lower.contains("captcha")
            || lower.contains("access denied")
    }

    /// 重建：标记旧代理死亡 → 轮转新代理 → 清空会话票据
    ///
    /// 返回新代理（若有）。数据面请求队列中的等待任务自动用新代理重试。
    pub async fn rebuild(&self, dead_proxy_url: Option<&str>) -> Option<ProxyEntry> {
        if let Some(url) = dead_proxy_url {
            self.pool.mark_dead(url);
        }
        let next = self.pool.next();
        if next.is_some() {
            log::info!("[immortal] 实例重建完成，已切换代理");
        } else {
            log::warn!("[immortal] 代理池耗尽，无法重建");
        }
        // 会话票据清空（TLS resumption 缓存）由 reqwest Client 重建实现
        // 下次握手发送完整 ClientHello，已切换新 IP + 新指纹
        next
    }
}
