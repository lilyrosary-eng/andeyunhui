//! 引擎抽象与注册表。
//!
//! 新增引擎只需：实现 `DownloadEngine` + 在 `build_registry` 里注册一个 `EngineKind`。
//! 管理器按 `EngineKind` 取实现，因此「换引擎」对上层透明。

pub mod aria2;
pub mod ffmpeg;
pub mod native;
pub(crate) mod tool;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use tauri::AppHandle;
use tokio::sync::watch;

use crate::manager::{Control, Inner, TaskProgress};
use crate::types::{
    DownloadPart, DownloadTask, EngineConfig, EngineKind, TaskStatus,
};
use crate::util::is_hls_url;

/// 单个分片的执行结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PartResult {
    Done,
    Paused,
    Canceled,
}

/// 整个引擎的执行结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineOutcome {
    Done,
    Paused,
    Canceled,
}

/// 引擎运行上下文：只暴露需要的操作，不让引擎直接碰数据库/事件细节。
#[derive(Clone)]
pub struct EngineCtx {
    pub(crate) inner: Arc<Inner>,
    pub task_id: String,
    /// 入队时已解析好的最终文件路径（避免引擎反复查库，也避免任务缺失时误写工作目录）。
    pub(crate) save_path: PathBuf,
    pub(crate) control: watch::Receiver<Control>,
}

impl EngineCtx {
    pub fn task(&self) -> Result<DownloadTask, String> {
        self.inner
            .store
            .task(&self.task_id)?
            .ok_or_else(|| format!("下载任务不存在: {}", self.task_id))
    }

    pub fn parts(&self) -> Result<Vec<DownloadPart>, String> {
        self.inner.store.parts(&self.task_id)
    }

    pub fn replace_parts(&self, parts: &[DownloadPart]) -> Result<(), String> {
        self.inner.store.replace_parts(&self.task_id, parts)
    }

    pub fn update_part(&self, part: &DownloadPart) -> Result<(), String> {
        self.inner.store.update_part(&self.task_id, part)
    }

    pub fn update_meta(
        &self,
        engine: EngineKind,
        filename: &str,
        total: u64,
    ) -> Result<(), String> {
        self.inner
            .store
            .update_meta(&self.task_id, engine, filename, total)
    }

    /// 推进到活动态（probing/downloading/merging）。任务已被暂停/取消时返回 false。
    pub fn transition(&self, status: TaskStatus) -> Result<bool, String> {
        self.inner.advance(&self.task_id, status)
    }

    pub fn emit_state(&self) {
        if let Ok(Some(task)) = self.inner.store.task(&self.task_id) {
            self.inner.emit_state(&task);
        }
    }

    /// 外部引擎（aria2/ffmpeg）自己解析进度时用。
    pub fn set_progress(&self, downloaded: u64, total: u64) {
        self.inner.set_live_progress(&self.task_id, downloaded, total);
    }

    /// 内部分片引擎的节流上报；返回 true 表示本次真的落了库/发了事件。
    pub(crate) fn tick(&self, progress: &TaskProgress) -> bool {
        self.inner.tick(&self.task_id, progress)
    }

    pub(crate) fn control_state(&self) -> Control {
        *self.control.borrow()
    }

    pub fn config(&self) -> EngineConfig {
        self.inner.config()
    }

    pub fn save_path(&self) -> PathBuf {
        self.save_path.clone()
    }

    /// 分片临时目录：`<save_path>.parts`。
    pub fn temp_dir(&self) -> PathBuf {
        let mut name = self.save_path.clone().into_os_string();
        name.push(".parts");
        PathBuf::from(name)
    }
}

#[async_trait]
pub trait DownloadEngine: Send + Sync {
    fn kind(&self) -> EngineKind;

    /// 外部引擎在这里返回「未安装/路径无效」；内置引擎恒可用。
    fn available(&self) -> Result<(), String> {
        Ok(())
    }

    fn tool_path(&self) -> Option<String> {
        None
    }

    async fn run(&self, ctx: EngineCtx) -> Result<EngineOutcome, String>;
}

pub fn build_registry(
    app: &AppHandle,
    config: &EngineConfig,
) -> HashMap<EngineKind, Arc<dyn DownloadEngine>> {
    let ffmpeg = tool::resolve(app, config.ffmpeg_path.as_deref(), &["ffmpeg.exe", "ffmpeg"]);
    let aria2 = tool::resolve(app, config.aria2_path.as_deref(), &["aria2c.exe", "aria2c"]);

    let mut registry: HashMap<EngineKind, Arc<dyn DownloadEngine>> = HashMap::new();
    registry.insert(
        EngineKind::Native,
        Arc::new(native::NativeEngine::new(config.clone(), ffmpeg.clone())),
    );
    registry.insert(
        EngineKind::Aria2,
        Arc::new(aria2::Aria2Engine::new(config.clone(), aria2)),
    );
    registry.insert(
        EngineKind::Ffmpeg,
        Arc::new(ffmpeg::FfmpegEngine::new(config.clone(), ffmpeg)),
    );
    registry
}

/// HLS 清单统一交给 ffmpeg（分段拉流 + 转封装是它的强项）。
pub(crate) fn is_hls(url: &str) -> bool {
    is_hls_url(url)
}
