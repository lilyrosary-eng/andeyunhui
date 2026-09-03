//! 代理池：轮转分配 + 故障标记
//!
//! 替代 Netns 网络命名空间（Windows 不可用，进程级 SOCKS5/HTTP 代理足够）

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyEntry {
    /// 代理 URL：socks5://host:port 或 http://host:port
    pub url: String,
    pub tag: String,
    pub alive: bool,
}

pub struct ProxyPool {
    inner: Mutex<Vec<ProxyEntry>>,
    cursor: Mutex<usize>,
}

impl ProxyPool {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Vec::new()),
            cursor: Mutex::new(0),
        }
    }

    pub fn add(&self, entry: ProxyEntry) {
        self.inner.lock().push(entry);
    }

    /// 轮转获取下一个存活代理
    pub fn next(&self) -> Option<ProxyEntry> {
        let inner = self.inner.lock();
        let alive: Vec<&ProxyEntry> = inner.iter().filter(|p| p.alive).collect();
        if alive.is_empty() {
            return None;
        }
        let mut cursor = self.cursor.lock();
        let entry = alive[*cursor % alive.len()];
        *cursor = (*cursor + 1) % alive.len();
        Some(entry.clone())
    }

    /// 标记代理死亡（403/429 触发）
    pub fn mark_dead(&self, url: &str) {
        let mut inner = self.inner.lock();
        if let Some(p) = inner.iter_mut().find(|p| p.url == url) {
            p.alive = false;
            log::warn!("[pool] 代理死亡: {}", url);
        }
    }

    pub fn count(&self) -> usize {
        self.inner.lock().iter().filter(|p| p.alive).count()
    }

    /// 列出全部代理（含死亡标记）
    pub fn list(&self) -> Vec<ProxyEntry> {
        self.inner.lock().clone()
    }

    /// 将所有代理重置为存活（换一轮/手动恢复时调用）
    pub fn reset(&self) {
        for p in self.inner.lock().iter_mut() {
            p.alive = true;
        }
    }
}

// ================= 全局代理池（供数据面 / 命令层共享） =================
// 与 EventBus / UrlQueue 的全局单例一致，无需穿过构造函数层层传递。

pub static POOL: once_cell::sync::Lazy<parking_lot::Mutex<ProxyPool>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(ProxyPool::new()));

/// 获取全局代理池句柄
pub fn pool() -> parking_lot::MutexGuard<'static, ProxyPool> {
    POOL.lock()
}
