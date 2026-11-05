//! 事件实时推送：监听 `<base>/events/*.ndjson`，把 MCP / 其它进程写入的增量推给前端。
//!
//! 为什么需要：MCP server 是独立进程，拿不到 `AppHandle`，没法直接 emit Tauri 事件；
//! 前端原来的 8s 轮询有延迟。这里用文件监听做「近实时」：写入后 ~200ms 内推送，
//! 轮询保留作兜底（监听失败时仍能靠它补齐）。
//!
//! 去重策略：监听器只读「水位线之后」的事件，水位线在启动时对齐到文件尾；
//! 宿主自己写入的事件也会被监听器看到并再推一次，前端按 seq 去重，重复无害。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::store;
use crate::types::CollabEvent;

/// 一次写入可能触发多条系统事件（创建 / 修改 / 关闭），合并窗口内的变化后再读。
const DEBOUNCE: Duration = Duration::from_millis(200);

static WATCH_STARTED: OnceLock<Mutex<bool>> = OnceLock::new();

/// 启动监听线程；重复调用直接返回。失败不阻断宿主：前端轮询仍能补齐。
pub fn start(app: AppHandle) -> Result<(), String> {
    let base = store::base_dir(&app)?;
    let flag = WATCH_STARTED.get_or_init(|| Mutex::new(false));
    {
        let mut started = flag.lock().map_err(|_| "监听状态锁已损坏".to_string())?;
        if *started {
            return Ok(());
        }
        *started = true;
    }

    let events_dir = base.join("events");
    std::fs::create_dir_all(&events_dir)
        .map_err(|e| format!("创建事件目录失败 {}: {e}", events_dir.display()))?;

    std::thread::Builder::new()
        .name("ai-collab-watch".to_string())
        .spawn(move || {
            if let Err(error) = run(app, base, events_dir) {
                eprintln!("[ai-collab] 事件监听已停止: {error}");
            }
        })
        .map_err(|e| format!("启动事件监听线程失败: {e}"))?;
    Ok(())
}

fn run(app: AppHandle, base: PathBuf, events_dir: PathBuf) -> Result<(), String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |result| {
        let _ = sender.send(result);
    })
    .map_err(|e| format!("创建文件监听失败: {e}"))?;
    watcher
        .watch(&events_dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("监听事件目录失败 {}: {e}", events_dir.display()))?;

    // 已有文件的历史交给快照，监听只推之后的新事件。
    let mut watermarks = initial_watermarks(&base, &events_dir);

    loop {
        let first = match receiver.recv() {
            Ok(Ok(event)) => event,
            Ok(Err(error)) => {
                eprintln!("[ai-collab] 文件监听事件异常: {error}");
                continue;
            }
            Err(_) => break,
        };
        let mut changed: HashSet<PathBuf> = first.paths.into_iter().collect();
        std::thread::sleep(DEBOUNCE);
        while let Ok(Ok(event)) = receiver.try_recv() {
            changed.extend(event.paths);
        }
        for event in collect_new_events(&base, &mut watermarks, &changed) {
            let _ = app.emit("collab-event", event);
        }
    }
    Ok(())
}

fn initial_watermarks(base: &Path, events_dir: &Path) -> HashMap<String, u64> {
    let mut watermarks = HashMap::new();
    let Ok(entries) = std::fs::read_dir(events_dir) else {
        return watermarks;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("ndjson") {
            continue;
        }
        let Some(room_id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if let Ok(seq) = store::last_event_seq(base, room_id) {
            watermarks.insert(room_id.to_string(), seq);
        }
    }
    watermarks
}

/// 按改动文件收集增量事件，并推进水位线。抽成纯函数便于单测（不依赖 Tauri）。
fn collect_new_events(
    base: &Path,
    watermarks: &mut HashMap<String, u64>,
    changed: &HashSet<PathBuf>,
) -> Vec<CollabEvent> {
    let mut out = Vec::new();
    for path in changed {
        if path.extension().and_then(|value| value.to_str()) != Some("ndjson") {
            continue;
        }
        let Some(room_id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let after = watermarks.get(room_id).copied().unwrap_or(0);
        match store::read_events(base, room_id, Some(after)) {
            Ok(events) => {
                if let Some(last) = events.last() {
                    watermarks.insert(room_id.to_string(), last.seq);
                }
                out.extend(events);
            }
            Err(error) => eprintln!("[ai-collab] 读取增量事件失败（{room_id}）: {error}"),
        }
    }
    out.sort_by_key(|event| event.seq);
    out
}

#[cfg(test)]
mod tests {
    use super::collect_new_events;
    use crate::store;
    use crate::types::CollabEvent;
    use std::collections::HashSet;
    use std::path::PathBuf;

    fn event(room_id: &str) -> CollabEvent {
        CollabEvent {
            seq: 0,
            at: 0,
            room_id: room_id.to_string(),
            kind: "message".to_string(),
            agent_id: None,
            assignment_id: None,
            text: Some("外部写入".to_string()),
            assignment: None,
            data: None,
        }
    }

    #[test]
    fn collect_only_events_after_watermark() {
        let base = std::env::temp_dir().join(format!(
            "ai-collab-watch-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        let room = "room_watch";
        for _ in 0..2 {
            store::append_event(&base, event(room)).unwrap();
        }
        let mut watermarks = std::collections::HashMap::new();
        watermarks.insert(room.to_string(), 2);

        let changed: HashSet<PathBuf> = [base
            .join("events")
            .join(format!("{room}.ndjson"))
            .to_path_buf()]
        .into_iter()
        .collect();

        // 没有新事件：不返回、也不推进水位线之外的垃圾。
        assert!(collect_new_events(&base, &mut watermarks, &changed).is_empty());

        store::append_event(&base, event(room)).unwrap();
        let collected = collect_new_events(&base, &mut watermarks, &changed);
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].seq, 3);
        assert_eq!(watermarks.get(room).copied(), Some(3));
        let _ = std::fs::remove_dir_all(base);
    }
}
