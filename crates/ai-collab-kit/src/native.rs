//! 应用自有模型 harness（native）的宿主注入点。
//!
//! 「自有」指应用进程内执行、使用宿主自己的 AI 配置；dsh / MCP / CLI / 信箱都是外部 harness，
//! 它们各自有独立的进程或协议边界，不在这里实现。
//!
//! ## 为什么是注册表而不是直接依赖
//! `ai-collab-kit` 是可拆卸内核，不能反过来依赖宿主（`andeyunhui_lib`）的 AI 服务。
//! 所以这里只定义「一次文本生成」的接口，由宿主的桌面入口在启动时注册实现：
//! - crate 负责任务状态机、事件流、取消与超时；
//! - 宿主负责把 prompt 交给自己的模型配置（provider / key / model）。
//!
//! 这样「应用自带模型」就能和 dsh / MCP / 信箱等外部 harness 共处一室：
//! 模型挂在成员上（`AgentSpec.model`），同一房间不同成员可以走不同的 harness 与模型。

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

/// 一次自有模型调用的输入。
#[derive(Debug, Clone)]
pub struct NativeRequest {
    pub room_id: String,
    pub assignment_id: String,
    pub agent_id: String,
    /// 成员级模型：`provider/model` 或纯模型 id；空串表示宿主当前选中的默认模型。
    pub model: String,
    /// 房间绑定的工作目录。宿主有工具能力时用它作为项目根（工作区内读写放行）。
    pub workspace: Option<String>,
    /// 已带成员人设与共享会话上下文的完整提示词。
    pub prompt: String,
}

pub type NativeFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

/// 宿主注入的一次性文本生成能力（非流式）。
pub trait NativeRunner: Send + Sync {
    fn run(&self, request: NativeRequest) -> NativeFuture;
}

static RUNNER: OnceLock<Arc<dyn NativeRunner>> = OnceLock::new();

/// 注册自有模型 runner。只接受一次注册：返回 false 表示已有实现，调用方可忽略。
pub fn register(runner: Arc<dyn NativeRunner>) -> bool {
    RUNNER.set(runner).is_ok()
}

/// 宿主是否注入过 runner。harness 目录用它决定 native 成员是否可选。
pub fn is_registered() -> bool {
    RUNNER.get().is_some()
}

/// 取一个待执行的 future；未注册时返回错误，由 runtime 走失败事件。
pub(crate) fn run(request: NativeRequest) -> Result<NativeFuture, String> {
    let runner = RUNNER
        .get()
        .ok_or_else(|| "自有模型 runner 未注册：native harness 仅在桌面版可用".to_string())?;
    Ok(runner.run(request))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeRunner {
        calls: Arc<AtomicUsize>,
    }

    impl NativeRunner for FakeRunner {
        fn run(&self, request: NativeRequest) -> NativeFuture {
            let calls = self.calls.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(format!("native:{}", request.prompt))
            })
        }
    }

    fn request() -> NativeRequest {
        NativeRequest {
            room_id: "room_native".to_string(),
            assignment_id: "task_native".to_string(),
            agent_id: "worker".to_string(),
            model: String::new(),
            workspace: None,
            prompt: "hello".to_string(),
        }
    }

    /// 注册表语义：注册后可用、能拿到宿主返回的文本；重复注册被拒绝。
    #[test]
    fn registry_dispatches_to_host_runner() {
        let calls = Arc::new(AtomicUsize::new(0));
        assert!(register(Arc::new(FakeRunner { calls: calls.clone() })));
        assert!(is_registered());
        assert!(!register(Arc::new(FakeRunner { calls: calls.clone() })));

        let text = tauri::async_runtime::block_on(run(request()).unwrap()).unwrap();
        assert_eq!(text, "native:hello");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
