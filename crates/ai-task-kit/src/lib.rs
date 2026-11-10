//! 通用任务调度：只决定「什么时候允许开始」，不关心任务是什么。
//!
//! 职责很窄，三件事：
//! - 按「并发域（scope）」限制同时执行数，超出的排队；
//! - 出队顺序 =（优先级, 入队顺序），同优先级不插队；
//! - 可选的单任务超时：到点丢掉执行 future 并回调通知调用方收尾。
//!
//! 不依赖 Tauri、不依赖具体业务：执行 future 的 spawn 方式由宿主注入
//! （Tauri 用 `tauri::async_runtime::spawn`，测试用 `tokio::spawn`）。
//! 这样协作房间、AI 工作、批处理任务可以共用同一套限流语义，
//! 而不是每个模块各写一份「信号量 + 队列」。

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// 宿主注入的执行载体：把 future 交给自己的 runtime。
pub type Spawner = Arc<dyn Fn(BoxFuture) + Send + Sync>;
pub type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// 一个待调度任务的元信息。
#[derive(Debug, Clone)]
pub struct JobSpec {
    pub id: String,
    /// 并发域：同一个 scope 共享槽位（房间 id / 模块 id / 会话 id）。
    pub scope: String,
    /// 0 高 / 1 普通 / 2 低；只在需要排队时影响顺序。
    pub priority: u8,
    /// 该 scope 的同时执行上限；None = 不限。
    pub limit: Option<usize>,
    /// 单任务超时；None = 不限，由任务自己兜底。
    pub timeout: Option<Duration>,
}

/// 入队结果：已开始执行，还是仍在排队。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enqueued {
    Started,
    Queued,
}

struct Job {
    run: Box<dyn FnOnce() -> BoxFuture + Send>,
    /// 超时后的收尾回调（落状态、发事件）。future 已被丢弃，不会再跑。
    on_timeout: Option<Box<dyn FnOnce() + Send>>,
}

struct Queued {
    spec: JobSpec,
    position: u64,
    job: Job,
}

#[derive(Default)]
struct Inner {
    /// scope -> 正在执行的任务数。
    running: HashMap<String, usize>,
    queue: Vec<Queued>,
    next_position: u64,
}

pub struct Scheduler {
    inner: Mutex<Inner>,
    spawn: Spawner,
}

/// 槽位守卫：任务结束（含 panic 展开）时释放槽位并拉起队列里的下一个。
struct SlotGuard {
    scheduler: Arc<Scheduler>,
    scope: String,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.scheduler.release(&self.scope);
    }
}

impl Scheduler {
    pub fn new(spawn: Spawner) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner::default()),
            spawn,
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // 锁中毒时继续用内部数据：调度出错不能把整个进程拖垮。
        self.inner.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// 入队并立刻尝试出队。同一个 id 重复入队会先摘掉旧条目，避免被执行两次。
    pub fn enqueue(
        self: &Arc<Self>,
        spec: JobSpec,
        run: impl FnOnce() -> BoxFuture + Send + 'static,
        on_timeout: Option<Box<dyn FnOnce() + Send>>,
    ) -> Enqueued {
        let id = spec.id.clone();
        let (started, already_started) = {
            let mut inner = self.lock();
            inner.queue.retain(|item| item.spec.id != id);
            let position = inner.next_position;
            inner.next_position += 1;
            inner.queue.push(Queued {
                spec,
                position,
                job: Job {
                    run: Box::new(run),
                    on_timeout,
                },
            });
            let started = self.pump_locked(&mut inner);
            let already_started = started.iter().any(|item| item.spec.id == id);
            (started, already_started)
        };
        for item in started {
            self.launch(item);
        }
        if already_started {
            Enqueued::Started
        } else {
            Enqueued::Queued
        }
    }

    /// 修改某个 scope 的并发上限：排队中的任务一起更新，并重新尝试出队。
    /// 改小不打断已经在跑的任务，只影响之后还能开始多少个。
    pub fn update_limit(self: &Arc<Self>, scope: &str, limit: Option<usize>) {
        let started = {
            let mut inner = self.lock();
            let mut changed = false;
            for item in inner.queue.iter_mut() {
                if item.spec.scope == scope && item.spec.limit != limit {
                    item.spec.limit = limit;
                    changed = true;
                }
            }
            if changed {
                self.pump_locked(&mut inner)
            } else {
                Vec::new()
            }
        };
        for item in started {
            self.launch(item);
        }
    }

    /// 取消排队中的任务。已经在跑的任务由调用方自己发取消信号。
    pub fn cancel(&self, id: &str) {
        self.lock().queue.retain(|item| item.spec.id != id);
    }

    /// 丢弃某个 scope 排队中的全部任务（房间/模块被删除时用）。
    pub fn discard_scope(&self, scope: &str) {
        self.lock().queue.retain(|item| item.spec.scope != scope);
    }

    /// 某个 scope 当前正在执行的任务数。
    pub fn running(&self, scope: &str) -> usize {
        self.lock().running.get(scope).copied().unwrap_or(0)
    }

    /// 排队中的任务总数（含所有 scope）。
    pub fn queued(&self) -> usize {
        self.lock().queue.len()
    }

    /// 取出所有可执行任务：并发未满的 scope 里，优先级小者先，同优先级按入队顺序。
    fn pump_locked(&self, inner: &mut Inner) -> Vec<Queued> {
        let mut started = Vec::new();
        loop {
            let mut best: Option<usize> = None;
            for (index, item) in inner.queue.iter().enumerate() {
                if let Some(limit) = item.spec.limit {
                    if inner.running.get(&item.spec.scope).copied().unwrap_or(0) >= limit {
                        continue;
                    }
                }
                best = match best {
                    None => Some(index),
                    Some(current) => {
                        let (current_item, candidate) = (&inner.queue[current], item);
                        let current_key = (current_item.spec.priority, current_item.position);
                        let candidate_key = (candidate.spec.priority, candidate.position);
                        if candidate_key < current_key {
                            Some(index)
                        } else {
                            Some(current)
                        }
                    }
                };
            }
            let Some(index) = best else {
                break;
            };
            let item = inner.queue.remove(index);
            *inner.running.entry(item.spec.scope.clone()).or_insert(0) += 1;
            started.push(item);
        }
        started
    }

    fn launch(self: &Arc<Self>, item: Queued) {
        let scheduler = Arc::clone(self);
        let scope = item.spec.scope.clone();
        let timeout = item.spec.timeout;
        let run = item.job.run;
        let on_timeout = item.job.on_timeout;
        (self.spawn)(Box::pin(async move {
            let _slot = SlotGuard {
                scheduler: Arc::clone(&scheduler),
                scope,
            };
            let future = run();
            let Some(timeout) = timeout else {
                future.await;
                return;
            };
            // 超时只负责结束执行；状态收尾交给调用方，避免这里依赖业务类型。
            if tokio::time::timeout(timeout, future).await.is_err() {
                if let Some(callback) = on_timeout {
                    callback();
                }
            }
        }));
    }

    fn release(self: &Arc<Self>, scope: &str) {
        let started = {
            let mut inner = self.lock();
            if let Some(count) = inner.running.get_mut(scope) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    inner.running.remove(scope);
                }
            }
            self.pump_locked(&mut inner)
        };
        for item in started {
            self.launch(item);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::time::Instant;

    fn tokio_scheduler() -> Arc<Scheduler> {
        Scheduler::new(Arc::new(|future| {
            tokio::spawn(future);
        }))
    }

    fn spec(id: &str, scope: &str, priority: u8, limit: Option<usize>) -> JobSpec {
        JobSpec {
            id: id.to_string(),
            scope: scope.to_string(),
            priority,
            limit,
            timeout: None,
        }
    }

    async fn sleep_ms(ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    /// 同 scope 并发到上限后排队；任务结束自动释放并拉起下一个。
    #[tokio::test]
    async fn enforces_scope_limit_and_releases_slots() {
        let scheduler = tokio_scheduler();
        let done = Arc::new(StdMutex::new(Vec::new()));
        let record = |done: Arc<StdMutex<Vec<&'static str>>>, name: &'static str| {
            move || -> BoxFuture {
                let done = Arc::clone(&done);
                Box::pin(async move {
                    sleep_ms(80).await;
                    done.lock().unwrap().push(name);
                })
            }
        };

        assert_eq!(
            scheduler.enqueue(spec("a", "room", 1, Some(1)), record(Arc::clone(&done), "a"), None),
            Enqueued::Started
        );
        assert_eq!(
            scheduler.enqueue(spec("b", "room", 1, Some(1)), record(Arc::clone(&done), "b"), None),
            Enqueued::Queued
        );
        assert_eq!(scheduler.running("room"), 1);
        assert_eq!(scheduler.queued(), 1);

        sleep_ms(250).await;
        assert_eq!(*done.lock().unwrap(), vec!["a", "b"]);
        assert_eq!(scheduler.running("room"), 0);
        assert_eq!(scheduler.queued(), 0);
    }

    /// 不限并发的 scope 不排队；不同 scope 之间互不占用槽位。
    #[tokio::test]
    async fn unlimited_and_scopes_are_independent() {
        let scheduler = tokio_scheduler();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let hold = |release: Arc<tokio::sync::Semaphore>| {
            move || -> BoxFuture {
                let release = Arc::clone(&release);
                Box::pin(async move {
                    let _ = release.acquire().await;
                })
            }
        };

        // 占住 room 的唯一槽位。
        assert_eq!(
            scheduler.enqueue(spec("hold", "room", 1, Some(1)), hold(Arc::clone(&release)), None),
            Enqueued::Started
        );
        assert_eq!(
            scheduler.enqueue(spec("wait", "room", 1, Some(1)), hold(Arc::clone(&release)), None),
            Enqueued::Queued
        );
        // 另一个 scope 不受影响；空 limit 表示不限。
        assert_eq!(
            scheduler.enqueue(spec("free", "work", 1, None), hold(Arc::clone(&release)), None),
            Enqueued::Started
        );
        assert_eq!(scheduler.running("room"), 1);
        assert_eq!(scheduler.running("work"), 1);

        release.add_permits(2);
        sleep_ms(50).await;
        assert_eq!(scheduler.queued(), 0);
    }

    /// 高优先级先出队；同优先级按入队顺序。
    #[tokio::test]
    async fn priority_then_arrival_order() {
        let scheduler = tokio_scheduler();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let order = Arc::new(StdMutex::new(Vec::new()));

        let runnable = |order: Arc<StdMutex<Vec<&'static str>>>, name: &'static str| {
            move || -> BoxFuture {
                let order = Arc::clone(&order);
                Box::pin(async move {
                    order.lock().unwrap().push(name);
                })
            }
        };

        // blocker 占住槽位，等测试放行。
        let release_blocker = Arc::clone(&release);
        let started = scheduler.enqueue(
            spec("blocker", "room", 1, Some(1)),
            move || -> BoxFuture {
                let release = Arc::clone(&release_blocker);
                Box::pin(async move {
                    let _ = release.acquire().await;
                })
            },
            None,
        );
        assert_eq!(started, Enqueued::Started);

        assert_eq!(
            scheduler.enqueue(spec("low", "room", 2, Some(1)), runnable(Arc::clone(&order), "low"), None),
            Enqueued::Queued
        );
        assert_eq!(
            scheduler.enqueue(spec("high", "room", 0, Some(1)), runnable(Arc::clone(&order), "high"), None),
            Enqueued::Queued
        );

        release.add_permits(1);
        sleep_ms(80).await;
        assert_eq!(*order.lock().unwrap(), vec!["high", "low"]);
    }

    /// 超时：future 被丢弃，回调只触发一次，槽位归还。
    #[tokio::test]
    async fn timeout_drops_future_and_notifies() {
        let scheduler = tokio_scheduler();
        let timed_out = Arc::new(StdMutex::new(0));
        let flag = Arc::clone(&timed_out);

        let mut job = spec("slow", "room", 1, Some(1));
        job.timeout = Some(Duration::from_millis(30));
        let started = scheduler.enqueue(
            job,
            move || -> BoxFuture {
                Box::pin(async move {
                    sleep_ms(10_000).await;
                })
            },
            Some(Box::new(move || {
                *flag.lock().unwrap() += 1;
            })),
        );
        assert_eq!(started, Enqueued::Started);

        sleep_ms(80).await;
        assert_eq!(*timed_out.lock().unwrap(), 1);
        assert_eq!(scheduler.running("room"), 0);
    }

    /// 取消只摘排队项，不影响同一 scope 的其他任务；重复入队不会执行两次。
    #[tokio::test]
    async fn cancel_and_dedupe() {
        let scheduler = tokio_scheduler();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let started_count = Arc::new(StdMutex::new(0));
        let hold = |release: Arc<tokio::sync::Semaphore>| {
            move || -> BoxFuture {
                let release = Arc::clone(&release);
                Box::pin(async move {
                    let _ = release.acquire().await;
                })
            }
        };

        assert_eq!(
            scheduler.enqueue(spec("blocker", "room", 1, Some(1)), hold(Arc::clone(&release)), None),
            Enqueued::Started
        );
        let counted = Arc::clone(&started_count);
        let run_wait = move || -> BoxFuture {
            Box::pin(async move {
                *counted.lock().unwrap() += 1;
            })
        };
        assert_eq!(
            scheduler.enqueue(spec("wait", "room", 1, Some(1)), run_wait, None),
            Enqueued::Queued
        );
        // 同 id 重排：队列里仍只有一条。
        let counted_again = Arc::clone(&started_count);
        let run_again = move || -> BoxFuture {
            Box::pin(async move {
                *counted_again.lock().unwrap() += 1;
            })
        };
        assert_eq!(
            scheduler.enqueue(spec("wait", "room", 1, Some(1)), run_again, None),
            Enqueued::Queued
        );
        assert_eq!(scheduler.queued(), 1);

        scheduler.cancel("wait");
        release.add_permits(1);
        sleep_ms(40).await;
        assert_eq!(scheduler.queued(), 0);
        assert_eq!(*started_count.lock().unwrap(), 0);
    }

    /// 改大上限后，排队任务立刻开始；改小不打断在跑的。
    #[tokio::test]
    async fn update_limit_repumps_queue() {
        let scheduler = tokio_scheduler();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let hold = |release: Arc<tokio::sync::Semaphore>| {
            move || -> BoxFuture {
                let release = Arc::clone(&release);
                Box::pin(async move {
                    let _ = release.acquire().await;
                })
            }
        };

        assert_eq!(
            scheduler.enqueue(spec("a", "room", 1, Some(1)), hold(Arc::clone(&release)), None),
            Enqueued::Started
        );
        assert_eq!(
            scheduler.enqueue(spec("b", "room", 1, Some(1)), hold(Arc::clone(&release)), None),
            Enqueued::Queued
        );
        scheduler.update_limit("room", Some(2));
        sleep_ms(30).await;
        assert_eq!(scheduler.running("room"), 2);
        assert_eq!(scheduler.queued(), 0);
    }
}
