//! 攻防 Tauri 命令层
//!
//! 命令始终注册（gongfang-kit 骨架始终编译），feature 未启用时返回 stub 状态。
//! 重型依赖（chromiumoxide 等）在 gongfang-kit 的 feature 后，主二进制零污染。

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use tauri::AppHandle;

use crate::ai::{load_profiles, resolve_profile};
use crate::kernel::priority::UserCommand;
use crate::kernel::strategy::Strategy;
use crate::kernel::{KernelEngine, KernelHandle};

struct EngineState {
    engine: Arc<KernelEngine>,
    handle: Option<KernelHandle>,
}

static STATE: Lazy<Mutex<Option<EngineState>>> = Lazy::new(|| Mutex::new(None));

#[derive(Serialize)]
pub struct Features {
    pub crawler: bool,
    pub reverse: bool,
    pub pentest: bool,
    pub automation: bool,
    pub gateway: bool,
}

#[derive(Serialize)]
pub struct GongfangStatus {
    pub running: bool,
    pub strategy: Strategy,
    pub reward: i64,
    pub error_rate: f64,
    pub features: Features,
}

fn features() -> Features {
    Features {
        crawler: cfg!(feature = "crawler"),
        reverse: cfg!(feature = "reverse"),
        pentest: cfg!(feature = "pentest"),
        automation: cfg!(feature = "automation"),
        gateway: cfg!(feature = "gateway"),
    }
}

/// 查询攻防内核状态
#[tauri::command]
pub fn gongfang_status() -> Result<GongfangStatus, String> {
    let state = STATE.lock();
    if let Some(s) = state.as_ref() {
        Ok(GongfangStatus {
            running: true,
            strategy: s.engine.snapshot(),
            reward: s.engine.reward.total_reward(),
            error_rate: s.engine.reward.error_rate(),
            features: features(),
        })
    } else {
        Ok(GongfangStatus {
            running: false,
            strategy: Strategy::default(),
            reward: 0,
            error_rate: 0.0,
            features: features(),
        })
    }
}

/// 启动攻防内核（双轨制：AI 控制面 + 数据面执行）
#[tauri::command]
pub async fn gongfang_start(app: AppHandle, profile_id: Option<String>) -> Result<(), String> {
    {
        let state = STATE.lock();
        if state.is_some() {
            return Err("攻防内核已在运行".to_string());
        }
    }
    let profiles = load_profiles(&app);
    let profile = resolve_profile(&profiles, profile_id);
    if profile.api_key.trim().is_empty() {
        return Err("未配置 AI API Key，请先在全局设置 → 模型 中填写".to_string());
    }
    let engine = Arc::new(KernelEngine::new(app, profile));
    let handle = engine.start();
    let mut state = STATE.lock();
    *state = Some(EngineState {
        engine,
        handle: Some(handle),
    });
    log::info!("[gongfang] 双轨制内核启动（控制面 500ms 推理 + 数据面 50ms Tick）");
    Ok(())
}

/// 停止攻防内核
#[tauri::command]
pub async fn gongfang_stop() -> Result<(), String> {
    let handle_opt = {
        let mut state = STATE.lock();
        state.as_mut().and_then(|s| s.handle.take())
    };
    if let Some(h) = handle_opt {
        h.stop().await;
        log::info!("[gongfang] 内核停止");
    }
    *STATE.lock() = None;
    Ok(())
}

/// 注入用户提示词指令（@focus/@bypass/@pause 等）
#[tauri::command]
pub fn gongfang_inject(cmd: UserCommand) -> Result<(), String> {
    let state = STATE.lock();
    let s = state.as_ref().ok_or("攻防内核未启动，请先调用 gongfang_start")?;
    s.engine.inject_command(cmd);
    Ok(())
}
