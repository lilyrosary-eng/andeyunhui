//! 综合下载引擎2：内置单连接兼容模式。
//!
//! 与引擎1共用同一套分片/续传代码，但强制 `connections = 1`：
//! 不主动并发分段，只发单条流式请求，适合拒绝 Range 或多连接的反盗链站点。
//! 仍保留断点续传能力（服务器支持 Range 时按已下载字节继续）。

use std::path::PathBuf;

use async_trait::async_trait;

use crate::engine::native::NativeEngine;
use crate::engine::{DownloadEngine, EngineCtx, EngineOutcome};
use crate::types::{EngineConfig, EngineKind};

pub struct SimpleEngine {
    native: NativeEngine,
}

impl SimpleEngine {
    pub fn new(config: EngineConfig, ffmpeg: Option<PathBuf>) -> Self {
        Self {
            native: NativeEngine::new(config, ffmpeg),
        }
    }
}

#[async_trait]
impl DownloadEngine for SimpleEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::Simple
    }

    async fn run(&self, ctx: EngineCtx) -> Result<EngineOutcome, String> {
        self.native.run_with_mode(ctx, EngineKind::Simple, true).await
    }
}
