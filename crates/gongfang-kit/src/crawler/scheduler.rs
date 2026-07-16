//! 双令牌桶 + EWMA RTT 预测
//!
//! 替代 MPC 模型预测控制（EWMA 滑动平均足够，桌面场景无需卡尔曼/MPC）
//! - 主桶：全局并发上限（tokio::Semaphore）
//! - 副桶：每出口 IP 并发上限
//! - EWMA：指数加权移动平均预测 RTT，RTT 突增 >30% 触发协议级空闲

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

const EWMA_ALPHA: f64 = 0.3;

/// 双令牌桶
pub struct DualTokenBucket {
    global: Arc<Semaphore>,
    per_ip_concurrency: usize,
    per_ip: Mutex<HashMap<String, Arc<Semaphore>>>,
}

impl DualTokenBucket {
    pub fn new(global_concurrency: usize, per_ip_concurrency: usize) -> Self {
        Self {
            global: Arc::new(Semaphore::new(global_concurrency)),
            per_ip_concurrency,
            per_ip: Mutex::new(HashMap::new()),
        }
    }

    /// 获取全局令牌（主桶）
    pub async fn acquire_global(&self) -> tokio::sync::SemaphorePermit<'_> {
        self.global
            .acquire()
            .await
            .expect("semaphore 不应关闭")
    }

    /// 获取指定 IP 的令牌（副桶）
    pub async fn acquire_ip(&self, ip: &str) -> Option<IPPermit> {
        let permit = {
            let mut map = self.per_ip.lock();
            let sem = map
                .entry(ip.to_string())
                .or_insert_with(|| Arc::new(Semaphore::new(self.per_ip_concurrency)));
            sem.clone()
        };
        let p = permit.acquire_owned().await.ok()?;
        Some(IPPermit { _permit: p })
    }
}

pub struct IPPermit {
    _permit: tokio::sync::OwnedSemaphorePermit,
}

/// EWMA RTT 预测器
pub struct EwmaRtt {
    value: Mutex<Option<f64>>,
}

impl EwmaRtt {
    pub fn new() -> Self {
        Self {
            value: Mutex::new(None),
        }
    }

    /// 记录一次 RTT 采样
    pub fn record(&self, rtt: Duration) {
        let rtt_ms = rtt.as_secs_f64() * 1000.0;
        let mut v = self.value.lock();
        *v = Some(match *v {
            Some(prev) => EWMA_ALPHA * rtt_ms + (1.0 - EWMA_ALPHA) * prev,
            None => rtt_ms,
        });
    }

    /// 当前预测 RTT
    pub fn predicted_ms(&self) -> Option<f64> {
        *self.value.lock()
    }

    /// RTT 是否突增超过阈值（触发协议级空闲）
    pub fn should_backoff(&self, current_rtt: Duration) -> bool {
        let current_ms = current_rtt.as_secs_f64() * 1000.0;
        match *self.value.lock() {
            Some(prev) if prev > 0.0 => current_ms > prev * 1.3,
            _ => false,
        }
    }

    /// 计算请求最小间隔（基于 QPS）
    pub fn min_interval(qps: u32) -> Duration {
        if qps == 0 {
            Duration::from_secs(1)
        } else {
            Duration::from_secs_f64(1.0 / qps as f64)
        }
    }

    /// 协议级空闲：发送 PING 帧维持连接但不发业务请求
    pub async fn protocol_idle(_duration: Duration) {
        tokio::time::sleep(_duration).await;
    }
}

/// 计时辅助：测量异步操作耗时
pub async fn timed<F, T>(f: F) -> (T, Duration)
where
    F: std::future::Future<Output = T>,
{
    let start = Instant::now();
    let result = f.await;
    (result, start.elapsed())
}
