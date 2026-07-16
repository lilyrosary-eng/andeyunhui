//! 贝塞尔轨迹生成 + 过冲回正 + EWMA RTT 自适应速度
//!
//! 替代原维度一"IRL 逆向强化学习 + MPC 模型预测控制"：
//! - IRL 需训练数据集 + 梯度反传，桌面无 GPU 不可行
//! - MPC 求解器（acados/casadi）GPL/LGPL 协议复杂，违背 MIT 优先
//! - 贝塞尔曲线 + 过冲回正（Overshoot+Correction）+ EWMA RTT 自适应：
//!   · 三次贝塞尔足够模拟人类鼠标轨迹的平滑加速减速
//!   · 过冲回正模拟人类运动皮层神经噪声（次优性）
//!   · EWMA RTT 自适应：响应快时人类会下意识点击更快

use std::time::Duration;

/// 轨迹点（含时间戳，单位毫秒）
#[derive(Debug, Clone, Copy)]
pub struct TrajectoryPoint {
    pub x: f32,
    pub y: f32,
    pub t_ms: u32,
}

/// 三次贝塞尔曲线点计算
///
/// P(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃
fn cubic_bezier(p0: (f32, f32), p1: (f32, f32), p2: (f32, f32), p3: (f32, f32), t: f32) -> (f32, f32) {
    let one_minus_t = 1.0 - t;
    let m2 = one_minus_t * one_minus_t;
    let m3 = m2 * one_minus_t;
    let t2 = t * t;
    let t3 = t2 * t;

    let x = m3 * p0.0 + 3.0 * m2 * t * p1.0 + 3.0 * one_minus_t * t2 * p2.0 + t3 * p3.0;
    let y = m3 * p0.1 + 3.0 * m2 * t * p1.1 + 3.0 * one_minus_t * t2 * p2.1 + t3 * p3.1;
    (x, y)
}

/// 生成从 start 到 end 的拟人化轨迹
///
/// 参数：
/// - `start`：起始坐标
/// - `end`：目标坐标
/// - `speed_factor`：速度系数（1.0=正常，0.5=慢，2.0=快）
/// - `overshoot`：过冲系数（0.0=无过冲，0.1=10% 过冲，模拟人类次优性）
///
/// 流程：
/// 1. 计算两点距离 → 决定轨迹时长（距离越长，人类移动越快但总时长越长）
/// 2. 计算两个控制点（垂直偏移，模拟曲率）
/// 3. 若 overshoot > 0：先生成到过冲点的轨迹，再生成回正轨迹
/// 4. 时间戳基于速度系数缩放
pub fn generate_trajectory(
    start: (f32, f32),
    end: (f32, f32),
    speed_factor: f32,
    overshoot: f32,
) -> Vec<TrajectoryPoint> {
    let dx = end.0 - start.0;
    let dy = end.1 - start.1;
    let distance = (dx * dx + dy * dy).sqrt();

    // 距离决定基础时长：短距离 200ms，长距离 800ms（菲茨定律简化）
    // Fitts's Law: MT = a + b * log2(D/W + 1)，这里用线性近似
    let base_duration_ms = (200.0 + distance * 0.5).min(800.0).max(150.0);
    let duration_ms = (base_duration_ms / speed_factor.max(0.1)) as u32;

    // 控制点：在中点附近垂直偏移，模拟人类自然曲率（非直线）
    // 垂直方向偏移（距离的 10-20%）
    let perp_x = -dy / distance.max(1.0);
    let perp_y = dx / distance.max(1.0);
    let curvature = distance * 0.15;
    let c1 = (start.0 + dx * 0.3 + perp_x * curvature, start.1 + dy * 0.3 + perp_y * curvature);
    let c2 = (start.0 + dx * 0.7 + perp_x * curvature, start.1 + dy * 0.7 + perp_y * curvature);

    let mut trajectory = Vec::new();

    if overshoot > 0.0 {
        // 阶段 1：到过冲点（目标延长 overshoot 比例）
        let over_end = (end.0 + dx * overshoot, end.1 + dy * overshoot);
        let over_c2 = (c2.0 + dx * overshoot * 0.5, c2.1 + dy * overshoot * 0.5);
        let phase1_duration = duration_ms * 7 / 10; // 70% 时间到过冲点
        let steps1 = (phase1_duration / 8).max(5); // 每 8ms 一个点（125Hz 鼠标）
        for i in 0..=steps1 {
            let t = i as f32 / steps1 as f32;
            let (x, y) = cubic_bezier(start, c1, over_c2, over_end, t);
            trajectory.push(TrajectoryPoint {
                x,
                y,
                t_ms: (t * phase1_duration as f32) as u32,
            });
        }

        // 阶段 2：从过冲点回正到目标（30% 时间，更快更直）
        let phase2_duration = duration_ms - phase1_duration;
        let steps2 = (phase2_duration / 8).max(3);
        let phase1_last_t = trajectory.last().map(|p| p.t_ms).unwrap_or(0);
        for i in 1..=steps2 {
            let t = i as f32 / steps2 as f32;
            // 回正用二次贝塞尔（更直接）
            let one_minus_t = 1.0 - t;
            let x = one_minus_t * one_minus_t * over_end.0 + 2.0 * one_minus_t * t * end.0 + t * t * end.0;
            let y = one_minus_t * one_minus_t * over_end.1 + 2.0 * one_minus_t * t * end.1 + t * t * end.1;
            trajectory.push(TrajectoryPoint {
                x,
                y,
                t_ms: phase1_last_t + (t * phase2_duration as f32) as u32,
            });
        }
    } else {
        // 无过冲：单段三次贝塞尔
        let steps = (duration_ms / 8).max(5);
        for i in 0..=steps {
            let t = i as f32 / steps as f32;
            let (x, y) = cubic_bezier(start, c1, c2, end, t);
            trajectory.push(TrajectoryPoint {
                x,
                y,
                t_ms: (t * duration_ms as f32) as u32,
            });
        }
    }

    trajectory
}

/// 生成更自然的轨迹（5点双段贝塞尔，S形曲线）
///
/// 相比 generate_trajectory 的单段贝塞尔：
/// - 路径中点添加随机扰动（非对称，避免完美对称曲线）
/// - 前后两段曲率方向独立（可能形成 S 形，更符合人类鼠标移动）
/// - 时间戳基于两段拼接，C0 连续（位置连续）
///
/// 参数同 generate_trajectory
pub fn generate_trajectory_natural(
    start: (f32, f32),
    end: (f32, f32),
    speed_factor: f32,
    overshoot: f32,
) -> Vec<TrajectoryPoint> {
    let dx = end.0 - start.0;
    let dy = end.1 - start.1;
    let distance = (dx * dx + dy * dy).sqrt();

    let base_duration_ms = (200.0 + distance * 0.5).min(800.0).max(150.0);
    let duration_ms = (base_duration_ms / speed_factor.max(0.1)) as u32;

    // 垂直方向单位向量
    let perp_x = -dy / distance.max(1.0);
    let perp_y = dx / distance.max(1.0);

    // 路径中点（带随机扰动，非对称）
    let mid_x = start.0 + dx * 0.5;
    let mid_y = start.1 + dy * 0.5;
    let mid_offset = distance * 0.1 * lcg_sign(); // ±10% 距离，随机方向
    let mid_point = (mid_x + perp_x * mid_offset, mid_y + perp_y * mid_offset);

    // 前半段控制点（曲率方向 A）
    let curvature1 = distance * 0.12;
    let c1_a = (
        start.0 + dx * 0.15 + perp_x * curvature1,
        start.1 + dy * 0.15 + perp_y * curvature1,
    );
    let c1_b = (mid_point.0 - dx * 0.1, mid_point.1 - dy * 0.1);

    // 后半段控制点（曲率方向 B，可能与 A 相反，形成 S 形）
    let curvature2 = distance * 0.12 * lcg_sign();
    let c2_a = (mid_point.0 + dx * 0.1, mid_point.1 + dy * 0.1);
    let c2_b = (
        end.0 - dx * 0.15 + perp_x * curvature2,
        end.1 - dy * 0.15 + perp_y * curvature2,
    );

    let mut trajectory = Vec::new();

    if overshoot > 0.0 {
        // 过冲模式：两段贝塞尔到过冲点 + 回正
        let over_end = (end.0 + dx * overshoot, end.1 + dy * overshoot);
        let phase1_duration = duration_ms * 7 / 10;
        let steps1 = (phase1_duration / 8).max(8);

        // 前半段：start → c1_a → c1_b → mid_point
        let half_steps1 = steps1 / 2;
        for i in 0..=half_steps1 {
            let t = i as f32 / half_steps1 as f32;
            let (x, y) = cubic_bezier(start, c1_a, c1_b, mid_point, t);
            trajectory.push(TrajectoryPoint {
                x,
                y,
                t_ms: (t * phase1_duration as f32 * 0.5) as u32,
            });
        }
        // 后半段：mid_point → c2_a → c2_b → over_end
        let remaining_steps1 = steps1 - half_steps1;
        for i in 1..=remaining_steps1 {
            let t = i as f32 / remaining_steps1 as f32;
            let (x, y) = cubic_bezier(mid_point, c2_a, c2_b, over_end, t);
            let last_t = trajectory.last().map(|p| p.t_ms).unwrap_or(0);
            trajectory.push(TrajectoryPoint {
                x,
                y,
                t_ms: last_t + (t * phase1_duration as f32 * 0.5) as u32,
            });
        }

        // 回正阶段（二次贝塞尔）
        let phase2_duration = duration_ms - phase1_duration;
        let steps2 = (phase2_duration / 8).max(3);
        let phase1_last_t = trajectory.last().map(|p| p.t_ms).unwrap_or(0);
        for i in 1..=steps2 {
            let t = i as f32 / steps2 as f32;
            let one_minus_t = 1.0 - t;
            let x = one_minus_t * one_minus_t * over_end.0
                + 2.0 * one_minus_t * t * end.0
                + t * t * end.0;
            let y = one_minus_t * one_minus_t * over_end.1
                + 2.0 * one_minus_t * t * end.1
                + t * t * end.1;
            trajectory.push(TrajectoryPoint {
                x,
                y,
                t_ms: phase1_last_t + (t * phase2_duration as f32) as u32,
            });
        }
    } else {
        // 无过冲：两段贝塞尔拼接
        let steps = (duration_ms / 8).max(8);
        let half_steps = steps / 2;

        // 前半段
        for i in 0..=half_steps {
            let t = i as f32 / half_steps as f32;
            let (x, y) = cubic_bezier(start, c1_a, c1_b, mid_point, t);
            trajectory.push(TrajectoryPoint {
                x,
                y,
                t_ms: (t * duration_ms as f32 * 0.5) as u32,
            });
        }
        // 后半段
        let remaining_steps = steps - half_steps;
        for i in 1..=remaining_steps {
            let t = i as f32 / remaining_steps as f32;
            let (x, y) = cubic_bezier(mid_point, c2_a, c2_b, end, t);
            let last_t = trajectory.last().map(|p| p.t_ms).unwrap_or(0);
            trajectory.push(TrajectoryPoint {
                x,
                y,
                t_ms: last_t + (t * duration_ms as f32 * 0.5) as u32,
            });
        }
    }

    trajectory
}

/// LCG 随机符号（返回 +1.0 或 -1.0）
///
/// 用于轨迹曲率方向随机化，避免引入 rand crate
fn lcg_sign() -> f32 {
    use std::cell::Cell;
    thread_local! {
        static STATE: Cell<u64> = Cell::new(0xABCDEF1234567890);
    }
    STATE.with(|s| {
        let v = s.get();
        let new_v = v
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        s.set(new_v);
        if new_v & 1 == 0 {
            1.0
        } else {
            -1.0
        }
    })
}

/// EWMA RTT 自适应速度调整
///
/// 替代原方案"AI 监控响应延迟动态调整 MPC 时间权重"：
/// - 响应快时（RTT < 100ms）：人类会下意识点击更快 → speed_factor ↑
/// - 响应慢时（RTT > 500ms）：人类会更谨慎 → speed_factor ↓
///
/// 输入：基线 RTT（前几次请求的 EWMA）
/// 输出：调整后的 speed_factor（0.5-2.0 范围）
pub fn adapt_speed_to_rtt(baseline_rtt: Duration) -> f32 {
    let rtt_ms = baseline_rtt.as_secs_f64() * 1000.0;
    if rtt_ms < 100.0 {
        1.5 // 快响应 → 加速
    } else if rtt_ms < 300.0 {
        1.0 // 正常
    } else if rtt_ms < 800.0 {
        0.7 // 慢响应 → 减速
    } else {
        0.5 // 极慢 → 谨慎
    }
}

/// 菲茨定律计算点击时长（用于验证轨迹时长合理性）
///
/// MT = a + b * log2(D/W + 1)
/// - D：到目标距离
/// - W：目标宽度（像素）
/// - a, b：经验常数（a=50, b=150 桌面场景）
pub fn fitts_duration_ms(distance: f32, target_width: f32) -> u32 {
    let a = 50.0f32;
    let b = 150.0f32;
    let id = (distance / target_width.max(1.0) + 1.0).log2();
    (a + b * id) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_trajectory_no_overshoot() {
        let traj = generate_trajectory((0.0, 0.0), (100.0, 100.0), 1.0, 0.0);
        assert!(traj.len() >= 5);
        // 起点接近 (0,0)
        assert!((traj[0].x - 0.0).abs() < 1.0);
        // 终点接近 (100,100)
        let last = traj.last().unwrap();
        assert!((last.x - 100.0).abs() < 1.0);
        assert!((last.y - 100.0).abs() < 1.0);
    }

    #[test]
    fn test_generate_trajectory_with_overshoot() {
        let traj = generate_trajectory((0.0, 0.0), (100.0, 0.0), 1.0, 0.1);
        assert!(traj.len() >= 8); // 两段贝塞尔
        // 过冲点应超过 100
        let max_x = traj.iter().map(|p| p.x).fold(0.0f32, f32::max);
        assert!(max_x > 100.0);
        // 终点回到 100 附近
        let last = traj.last().unwrap();
        assert!((last.x - 100.0).abs() < 2.0);
    }

    #[test]
    fn test_adapt_speed_to_rtt() {
        assert_eq!(adapt_speed_to_rtt(Duration::from_millis(50)), 1.5);
        assert_eq!(adapt_speed_to_rtt(Duration::from_millis(200)), 1.0);
        assert_eq!(adapt_speed_to_rtt(Duration::from_millis(500)), 0.7);
        assert_eq!(adapt_speed_to_rtt(Duration::from_millis(1000)), 0.5);
    }

    #[test]
    fn test_fitts_duration() {
        let dur = fitts_duration_ms(500.0, 20.0);
        assert!(dur > 200 && dur < 1000);
    }

    #[test]
    fn test_generate_trajectory_natural_no_overshoot() {
        let traj = generate_trajectory_natural((0.0, 0.0), (200.0, 100.0), 1.0, 0.0);
        assert!(traj.len() >= 8, "自然轨迹应至少 8 个点，实际 {}", traj.len());
        // 起点接近 (0,0)
        assert!(traj[0].x.abs() < 5.0);
        assert!(traj[0].y.abs() < 5.0);
        // 终点接近 (200,100)
        let last = traj.last().unwrap();
        assert!((last.x - 200.0).abs() < 5.0, "终点 x 偏差过大: {}", last.x);
        assert!((last.y - 100.0).abs() < 5.0, "终点 y 偏差过大: {}", last.y);
    }

    #[test]
    fn test_generate_trajectory_natural_with_overshoot() {
        let traj = generate_trajectory_natural((0.0, 0.0), (200.0, 0.0), 1.0, 0.1);
        assert!(traj.len() >= 10, "过冲自然轨迹应至少 10 个点，实际 {}", traj.len());
        // 过冲点应超过 200
        let max_x = traj.iter().map(|p| p.x).fold(0.0f32, f32::max);
        assert!(max_x > 200.0, "过冲点应超过 200，实际 {}", max_x);
        // 终点回到 200 附近
        let last = traj.last().unwrap();
        assert!((last.x - 200.0).abs() < 5.0);
    }

    #[test]
    fn test_lcg_sign_returns_pm1() {
        let s = lcg_sign();
        assert!(s == 1.0 || s == -1.0, "lcg_sign 应返回 +1 或 -1，实际 {}", s);
    }
}
