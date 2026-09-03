//! 爬虫 URL 队列：去重 + 深度限制 + 全局共享
//!
//! 把爬虫从「锁定单一 focus_url，每 50ms 反复连打同一地址」升级为
//! 「带去重与深度的待爬队列」，配合数据面按 QPS 限速出队：
//! - 待爬用 VecDeque（FIFO = 广度优先）
//! - 已访问用 HashSet 去重（判重优先，避免重复抓取与环）
//! - depth 限制传播深度（seed 记 0；0 表示只抓 seed，不扩散）
//! - max_urls 兜底防失控

use parking_lot::Mutex;
use std::collections::{HashSet, VecDeque};

/// 默认单轮抓取上限（防失控兜底）
const DEFAULT_MAX_URLS: usize = 500;
/// 默认最大传播深度（seed=0，默认扩散 2 层）
const DEFAULT_MAX_DEPTH: u32 = 2;

/// 队列统计快照（供前端/命令层展示）
#[derive(Debug, Clone, Default)]
pub struct CrawlStats {
    pub pending: usize,
    pub visited: usize,
    pub total: usize,
}

#[derive(Debug)]
pub struct UrlQueue {
    pending: VecDeque<(String, u32)>,
    visited: HashSet<String>,
    max_urls: usize,
    max_depth: u32,
}

impl UrlQueue {
    pub fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            visited: HashSet::new(),
            max_urls: DEFAULT_MAX_URLS,
            max_depth: DEFAULT_MAX_DEPTH,
        }
    }

    /// 调整上限（0 表示取默认值）
    pub fn set_limits(&mut self, max_urls: Option<usize>, max_depth: Option<u32>) -> &mut Self {
        if let Some(u) = max_urls {
            self.max_urls = u.max(1);
        }
        if let Some(d) = max_depth {
            self.max_depth = d;
        }
        self
    }

    /// 入队：去重 + 深度/总量校验，成功返回 true
    pub fn enqueue(&mut self, url: &str, depth: u32) -> bool {
        if depth > self.max_depth {
            return false;
        }
        if self.visited.contains(url) {
            return false;
        }
        if self.pending.iter().any(|(u, _)| u == url) {
            return false;
        }
        if self.visited.len() >= self.max_urls {
            return false;
        }
        self.pending.push_back((url.to_string(), depth));
        true
    }

    /// 出队一个 URL（FIFO，广度优先），出队即标记已访问
    pub fn pop(&mut self) -> Option<(String, u32)> {
        let (url, depth) = self.pending.pop_front()?;
        self.visited.insert(url.clone());
        Some((url, depth))
    }

    pub fn is_visited(&self, url: &str) -> bool {
        self.visited.contains(url)
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn visited_len(&self) -> usize {
        self.visited.len()
    }

    pub fn stats(&self) -> CrawlStats {
        CrawlStats {
            pending: self.pending.len(),
            visited: self.visited.len(),
            total: self.pending.len() + self.visited.len(),
        }
    }

    /// 清空（换 seed 重启一轮时调用）
    pub fn clear(&mut self) {
        self.pending.clear();
        self.visited.clear();
    }
}

// ================= 全局队列（供数据面 execute_recon 共享） =================
// 与 EventBus 的全局单例一致：无需穿过构造函数层层传递状态。

pub static QUEUE: once_cell::sync::Lazy<Mutex<UrlQueue>> =
    once_cell::sync::Lazy::new(|| Mutex::new(UrlQueue::new()));

/// 获取全局队列句柄
pub fn queue() -> parking_lot::MutexGuard<'static, UrlQueue> {
    QUEUE.lock()
}

// ================= 单元测试：入队/去重/深度/出队 =================
// 纪律：期望值取当前真实行为，纯逻辑无 I/O 无需 mock。
#[cfg(test)]
mod tests {
    use super::*;

    fn mk(max_urls: usize, max_depth: u32) -> UrlQueue {
        let mut q = UrlQueue::new();
        q.set_limits(Some(max_urls), Some(max_depth));
        q
    }

    #[test]
    fn enqueue_and_pop_fifo() {
        let mut q = UrlQueue::new();
        assert!(q.enqueue("https://a.com/1", 0));
        assert!(q.enqueue("https://a.com/2", 0));
        assert_eq!(q.len(), 2);
        assert_eq!(q.pop(), Some(("https://a.com/1".to_string(), 0)));
        assert_eq!(q.pop(), Some(("https://a.com/2".to_string(), 0)));
        assert!(q.is_empty());
    }

    #[test]
    fn dedup_prevents_duplicate() {
        let mut q = UrlQueue::new();
        assert!(q.enqueue("https://a.com/1", 0));
        assert!(!q.enqueue("https://a.com/1", 0), "重复入队应被拒");
        assert!(!q.enqueue("https://a.com/1", 1), "已 pending/visited 都应拒");
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn pop_marks_visited_and_blocks_reseed() {
        let mut q = UrlQueue::new();
        q.enqueue("https://a.com/1", 0);
        assert_eq!(q.pop(), Some(("https://a.com/1".to_string(), 0)));
        assert!(q.is_visited("https://a.com/1"));
        // 已访问的 URL 不能再入队（防环）
        assert!(!q.enqueue("https://a.com/1", 0));
    }

    #[test]
    fn depth_limit_blocks_deep() {
        let mut q = mk(100, 2);
        assert!(q.enqueue("https://a.com/d0", 0));
        assert!(q.enqueue("https://a.com/d1", 1));
        assert!(q.enqueue("https://a.com/d2", 2));
        assert!(!q.enqueue("https://a.com/d3", 3), "超过 max_depth 应被拒");
        assert_eq!(q.len(), 3);
    }

    #[test]
    fn max_urls_blocks_overflow() {
        let mut q = mk(3, 99);
        assert!(q.enqueue("u1", 0));
        assert!(q.enqueue("u2", 0));
        assert!(q.enqueue("u3", 0));
        assert!(!q.enqueue("u4", 0), "达到 max_urls 应被拒");
        assert_eq!(q.len(), 3);
    }
}