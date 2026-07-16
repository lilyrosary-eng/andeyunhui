//! 自动化测试框架（务实降级版）
//!
//! 替代原计划 6 维度（学术概念降级为桌面可行方案）：
//! - 维度一 IRL 逆向强化学习 + MPC 最优控制 → 删 IRL/MPC，保留贝塞尔+过冲回正
//!     · IRL 需训练数据集 + 梯度反传，桌面无 GPU 不可行
//!     · MPC 求解器（acados/casadi）GPL/LGPL 协议复杂，违背 MIT 优先原则
//!     · 贝塞尔曲线 + 过冲回正 + EWMA RTT 自适应速度（纯算法）足够覆盖 90% 场景
//! - 维度二 视觉显著性网络 + 扫视路径 → 删神经网络，保留扫视+注视延迟
//!     · Saliency Map 需轻量级视觉注意力网络（GPU 推理）
//!     · 扫视滞后 + 注视停留（200-300ms）纯算法可实现，模拟人类认知延迟
//! - 维度三 uinput/IOHIDFamily + eBPF → 删 Linux 专属，保留 SendInput
//!     · uinput（Linux）/ IOHIDFamily（macOS）跨平台不可用
//!     · eBPF 修改输入子系统环形缓冲区：Linux 专属，Windows 不可用
//!     · Windows SendInput（win32k.sys 内核调用）：isTrusted=true，主项目已有 winapi 依赖
//! - 维度四 Wasserstein 流形对齐 + FGSM → 删 Wasserstein，保留 JS 散度+探针
//!     · Wasserstein 最优传输库 Rust 生态弱（POT 是 Python）
//!     · JS 散度（Jensen-Shannon）纯 Rust 可实现，分布对比足够
//!     · 探针反馈调整噪声幅度（蒙特卡洛采样简化为单变量扫描）
//! - 维度五 粉红噪声 + 触摸屏 + 陀螺仪 → 保留粉红噪声，删触摸屏/陀螺仪
//!     · Voss-McCartney 算法纯 Rust 生成 1/f 频谱
//!     · 8-12Hz 肌肉颤振叠加（生理性手震）
//!     · 触摸屏 Stick-Slip 桌面场景少；DeviceOrientation 桌面无硬件
//! - 维度六 元学习进化策略 + 模板热迁移 → 删元学习，保留多模板+arc-swap
//!     · 进化策略需训练适应度评估函数
//!     · 多行为模板（急躁/谨慎/左撇子）+ arc-swap 无锁热迁移已落地
//!
//! 架构精神复用已有内核：
//! - 双缓冲 FrontBuffer/BackBuffer → arc-swap（kernel/strategy.rs 已用）
//! - @humanize [level] → priority.rs UserCommand
//! - EWMA RTT 自适应 → crawler/scheduler.rs
//! - 浏览器指纹一致性 → crawler/stealth.rs
//! - 错误率回滚 → reward.rs + strategy.rs rollback()

pub mod baseline;
pub mod bezier;
pub mod noise;
pub mod profiles;

#[cfg(target_os = "windows")]
pub mod hid;

use std::sync::Arc;
use crate::kernel::reward::RewardSignal;
use crate::kernel::strategy::Strategy;

/// Pivot 阶段执行入口（数据面 Tick 调用）
///
/// 自动化框架在 Pivot Phase 触发：
/// 1. 加载当前行为模板（arc-swap 无锁热替换，亚毫秒级）
/// 2. 生成贝塞尔轨迹 + 叠加粉红噪声 + 8-12Hz 颤振
/// 3. 通过 SendInput 注入 HID 事件（Windows）或回退到 CDP（crawler-browser）
/// 4. 滑动窗口对比行为分布与基线（JS 散度）
/// 5. 反馈 reward + 触发模板适应度更新
pub async fn execute_pivot(s: &Strategy, reward: &Arc<RewardSignal>) {
    let url = match &s.focus_url {
        Some(u) if !u.is_empty() => u.clone(),
        _ => {
            log::debug!("[automation] 无 focus_url，跳过 Pivot");
            return;
        }
    };

    log::info!(
        "[automation] Pivot 阶段 {} (stealth={} tls={})",
        url,
        s.stealth_level,
        s.tls_profile
    );

    // 1. 加载当前行为模板（arc-swap 无锁读取）
    let template = profiles::current_template();
    log::debug!(
        "[automation] 当前模板: {} (noise_amp={} speed_factor={})",
        template.name,
        template.noise_amplitude,
        template.speed_factor
    );

    // 2. 生成贝塞尔轨迹（从原点到目标，含过冲回正）
    //    实际场景中目标位置由前端 DOM 解析传入，这里用占位演示
    let target = (800.0f32, 600.0f32);
    let trajectory = bezier::generate_trajectory(
        (0.0, 0.0),
        target,
        template.speed_factor,
        template.overshoot,
    );
    log::debug!(
        "[automation] 生成 {} 个轨迹点（含过冲回正）",
        trajectory.len()
    );

    // 3. 叠加粉红噪声 + 肌肉颤振（Voss-McCartney 1/f 频谱）
    let noisy_trajectory = noise::apply_physiological_noise(
        &trajectory,
        template.noise_amplitude,
        template.tremor_frequency,
    );
    log::debug!("[automation] 已叠加粉红噪声 + {}Hz 颤振", template.tremor_frequency);

    // 4. 通过 SendInput 注入 HID 事件（仅 Windows）
    //    事件间隔匹配硬件轮询速率（普通鼠标 8ms / 游戏鼠标 1ms）
    //    用 spawn_blocking 包装：SendInput + thread::sleep 是同步阻塞调用，
    //    批量注入（数百事件）会累积阻塞 tokio runtime
    #[cfg(target_os = "windows")]
    {
        let trajectory_clone = noisy_trajectory.clone();
        let poll_interval = template.poll_interval_ms;
        let injected = tokio::task::spawn_blocking(move || {
            hid::inject_mouse_trajectory(&trajectory_clone, poll_interval)
        })
        .await;

        match injected {
            Ok(Ok(count)) => log::info!("[automation] SendInput 注入 {} 个 HID 事件", count),
            Ok(Err(e)) => {
                log::warn!("[automation] SendInput 失败: {}，回退到 CDP 模式", e);
                reward.record(crate::kernel::reward::EventKind::ValidationError);
            }
            Err(e) => {
                log::error!("[automation] spawn_blocking 任务失败: {}", e);
                reward.record(crate::kernel::reward::EventKind::ValidationError);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        log::debug!("[automation] 非 Windows 平台，HID 注入跳过（需通过 CDP 或外部进程）");
    }

    // 5. 行为分布对比（多维度加权 JS 散度，滑动窗口）
    //    方向 0.5 + 速度 0.3 + 加速度 0.2，比单维度方向散度更精确
    let mut baseline = baseline::BehaviorBaseline::new();
    baseline.add_observation(&noisy_trajectory);
    let divergence = baseline.js_divergence_multidim(&template);
    log::debug!(
        "[automation] 多维度 JS 散度: {:.4}（<0.15 人类相似，>0.4 异常）",
        divergence
    );

    if divergence > 0.4 {
        log::warn!(
            "[automation] 行为分布偏离基线（散度={:.4}），触发模板适应度下降",
            divergence
        );
        // 使用带散度的适应度记录：散度高→评分降低，即使操作成功也会影响热迁移决策
        profiles::record_fitness_with_divergence(template.id, false, divergence);
        reward.record(crate::kernel::reward::EventKind::Rejected);
    } else {
        profiles::record_fitness_with_divergence(template.id, true, divergence);
        reward.record(crate::kernel::reward::EventKind::Success);
    }

    log::info!(
        "[automation] Pivot 完成 reward={} error_rate={:.2}%",
        reward.total_reward(),
        reward.error_rate() * 100.0
    );
}
