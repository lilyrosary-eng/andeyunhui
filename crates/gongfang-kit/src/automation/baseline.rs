//! 行为基线滑动窗口 + JS 散度分布对比 + 探针反馈
//!
//! 替代原维度四"Wasserstein 流形对齐 + FGSM 对抗性攻击"：
//! - Wasserstein 最优传输库 Rust 生态弱（POT 是 Python），删除
//! - JS 散度（Jensen-Shannon）纯 Rust 可实现，对称且有界，保留
//! - FGSM 梯度上升需黑盒模型梯度，桌面不可行，删除
//! - 探针反馈调整噪声幅度（单变量扫描替代蒙特卡洛采样），保留
//!
//! JS 散度特性：
//! - JS(P||Q) = 0.5*KL(P||M) + 0.5*KL(Q||M)，M=0.5*(P+Q)
//! - 对称：JS(P||Q) = JS(Q||P)
//! - 有界：[0, ln(2)] ≈ [0, 0.693]
//! - 比 KL 散度更稳定（KL 当 Q(i)=0 时无定义）
//!
//! 应用：
//! - 滑动窗口维护过去 30 秒的行为分布
//! - 与模板基线分布对比 JS 散度
//! - < 0.1：人类相似 / 0.1-0.3：可疑 / > 0.3：异常

use std::collections::VecDeque;

use super::bezier::TrajectoryPoint;
use super::profiles::BehaviorTemplate;

/// 行为基线滑动窗口
///
/// 维护最近 N 次观察的轨迹分布，用于与模板基线对比。
/// 窗口大小默认 30（对应 30 次操作，约 30 秒）。
///
/// 三维度联合分布（提升对真实人类行为的判别力）：
/// - 方向角度分布：运动方向（0-360° 分桶）
/// - 速度分布：瞬时速度（px/s 分桶）
/// - 加速度分布：速度变化率（px/s² 分桶）
pub struct BehaviorBaseline {
    /// 方向角度分布窗口
    window: VecDeque<Vec<f32>>,
    /// 速度分布窗口
    velocity_window: VecDeque<Vec<f32>>,
    /// 加速度分布窗口
    acceleration_window: VecDeque<Vec<f32>>,
    /// 窗口大小上限
    max_size: usize,
    /// 分布分桶数（控制直方图粒度）
    bucket_count: usize,
}

impl BehaviorBaseline {
    pub fn new() -> Self {
        Self::with_size(30, 16)
    }

    /// 自定义窗口大小和分桶数
    pub fn with_size(max_size: usize, bucket_count: usize) -> Self {
        Self {
            window: VecDeque::with_capacity(max_size),
            velocity_window: VecDeque::with_capacity(max_size),
            acceleration_window: VecDeque::with_capacity(max_size),
            max_size,
            bucket_count,
        }
    }

    /// 添加一次观察（一条轨迹）
    ///
    /// 将轨迹转换为三维度分布直方图（方向+速度+加速度），分别存入滑动窗口
    pub fn add_observation(&mut self, trajectory: &[TrajectoryPoint]) {
        let dir_dist = self.trajectory_to_distribution(trajectory);
        let vel_dist = self.trajectory_to_velocity_distribution(trajectory);
        let acc_dist = self.trajectory_to_acceleration_distribution(trajectory);

        if self.window.len() >= self.max_size {
            self.window.pop_front();
            self.velocity_window.pop_front();
            self.acceleration_window.pop_front();
        }
        self.window.push_back(dir_dist);
        self.velocity_window.push_back(vel_dist);
        self.acceleration_window.push_back(acc_dist);
    }

    /// 将轨迹转换为分布直方图
    ///
    /// 分桶策略：按运动方向（角度）分桶
    /// - 0° = 右 / 90° = 下 / 180° = 左 / 270° = 上
    /// - 每桶 360°/bucket_count
    /// - 直方图归一化为概率分布（sum=1.0）
    fn trajectory_to_distribution(&self, trajectory: &[TrajectoryPoint]) -> Vec<f32> {
        let mut buckets = vec![0.0f32; self.bucket_count];
        if trajectory.len() < 2 {
            // 退化情况：所有权重均匀分布
            let uniform = 1.0 / self.bucket_count as f32;
            return vec![uniform; self.bucket_count];
        }

        for i in 1..trajectory.len() {
            let dx = trajectory[i].x - trajectory[i - 1].x;
            let dy = trajectory[i].y - trajectory[i - 1].y;
            let angle = dy.atan2(dx); // [-π, π]
            // 映射到 [0, 2π)
            let normalized = if angle < 0.0 { angle + 2.0 * std::f32::consts::PI } else { angle };
            let bucket_idx = ((normalized / (2.0 * std::f32::consts::PI)) * self.bucket_count as f32) as usize;
            let bucket_idx = bucket_idx.min(self.bucket_count - 1);
            buckets[bucket_idx] += 1.0;
        }

        // 归一化
        let total: f32 = buckets.iter().sum();
        if total > 0.0 {
            for b in buckets.iter_mut() {
                *b /= total;
            }
        } else {
            let uniform = 1.0 / self.bucket_count as f32;
            for b in buckets.iter_mut() {
                *b = uniform;
            }
        }
        buckets
    }

    /// 将轨迹转换为速度分布直方图
    ///
    /// 分桶策略：按瞬时速度（像素/秒）分桶
    /// - 速度归一化到 [0, max_vel]，然后均匀分桶
    /// - 低速度桶占比高（人类鼠标大部分时间慢速移动）
    fn trajectory_to_velocity_distribution(&self, trajectory: &[TrajectoryPoint]) -> Vec<f32> {
        let mut buckets = vec![0.0f32; self.bucket_count];
        if trajectory.len() < 2 {
            let uniform = 1.0 / self.bucket_count as f32;
            return vec![uniform; self.bucket_count];
        }

        // 计算每个点的瞬时速度（px/s）
        let mut velocities = Vec::with_capacity(trajectory.len() - 1);
        for i in 1..trajectory.len() {
            let dx = trajectory[i].x - trajectory[i - 1].x;
            let dy = trajectory[i].y - trajectory[i - 1].y;
            let dt_ms = trajectory[i]
                .t_ms
                .saturating_sub(trajectory[i - 1].t_ms)
                .max(1) as f32;
            let speed = (dx * dx + dy * dy).sqrt() / dt_ms * 1000.0;
            velocities.push(speed);
        }

        // 归一化到 [0, max_vel]
        let max_vel = velocities.iter().cloned().fold(0.0f32, f32::max).max(1.0);
        for v in velocities {
            let bucket_idx = ((v / max_vel) * self.bucket_count as f32) as usize;
            let bucket_idx = bucket_idx.min(self.bucket_count - 1);
            buckets[bucket_idx] += 1.0;
        }

        // 归一化
        let total: f32 = buckets.iter().sum();
        if total > 0.0 {
            for b in buckets.iter_mut() {
                *b /= total;
            }
        } else {
            let uniform = 1.0 / self.bucket_count as f32;
            for b in buckets.iter_mut() {
                *b = uniform;
            }
        }
        buckets
    }

    /// 将轨迹转换为加速度分布直方图
    ///
    /// 分桶策略：按瞬时加速度的绝对值（速度变化率）分桶
    /// - 加速度归一化到 [0, max_acc]，然后均匀分桶
    /// - 低加速度桶占比高（大部分时间匀速，只有起停时加速度大）
    fn trajectory_to_acceleration_distribution(&self, trajectory: &[TrajectoryPoint]) -> Vec<f32> {
        let mut buckets = vec![0.0f32; self.bucket_count];
        if trajectory.len() < 3 {
            let uniform = 1.0 / self.bucket_count as f32;
            return vec![uniform; self.bucket_count];
        }

        // 计算速度序列
        let mut velocities = Vec::with_capacity(trajectory.len() - 1);
        for i in 1..trajectory.len() {
            let dx = trajectory[i].x - trajectory[i - 1].x;
            let dy = trajectory[i].y - trajectory[i - 1].y;
            let dt_ms = trajectory[i]
                .t_ms
                .saturating_sub(trajectory[i - 1].t_ms)
                .max(1) as f32;
            let speed = (dx * dx + dy * dy).sqrt() / dt_ms * 1000.0;
            velocities.push(speed);
        }

        // 计算加速度序列（速度差分）
        let mut accelerations = Vec::with_capacity(velocities.len().saturating_sub(1));
        for i in 1..velocities.len() {
            let dv = velocities[i] - velocities[i - 1];
            let dt_ms = trajectory[i + 1]
                .t_ms
                .saturating_sub(trajectory[i].t_ms)
                .max(1) as f32;
            let acc = (dv / dt_ms * 1000.0).abs(); // px/s²，取绝对值分桶
            accelerations.push(acc);
        }

        let max_acc = accelerations.iter().cloned().fold(0.0f32, f32::max).max(1.0);
        for a in accelerations {
            let bucket_idx = ((a / max_acc) * self.bucket_count as f32) as usize;
            let bucket_idx = bucket_idx.min(self.bucket_count - 1);
            buckets[bucket_idx] += 1.0;
        }

        // 归一化
        let total: f32 = buckets.iter().sum();
        if total > 0.0 {
            for b in buckets.iter_mut() {
                *b /= total;
            }
        } else {
            let uniform = 1.0 / self.bucket_count as f32;
            for b in buckets.iter_mut() {
                *b = uniform;
            }
        }
        buckets
    }

    /// 计算当前窗口的平均方向分布
    pub fn current_distribution(&self) -> Vec<f32> {
        average_distribution(&self.window, self.bucket_count)
    }

    /// 计算当前窗口的平均速度分布
    pub fn current_velocity_distribution(&self) -> Vec<f32> {
        average_distribution(&self.velocity_window, self.bucket_count)
    }

    /// 计算当前窗口的平均加速度分布
    pub fn current_acceleration_distribution(&self) -> Vec<f32> {
        average_distribution(&self.acceleration_window, self.bucket_count)
    }

    /// 计算与模板基线的 JS 散度（单维度：方向角度）
    ///
    /// 模板基线分布：根据模板参数生成理论分布
    /// - 急躁型：角度分布更分散（快速移动多方向）
    /// - 谨慎型：角度分布集中（直线为主）
    /// - 游戏型：角度分布双峰（水平+垂直）
    pub fn js_divergence_from_template(&self, template: &BehaviorTemplate) -> f32 {
        let p = self.current_distribution();
        let q = template_baseline_distribution(template, self.bucket_count);
        js_divergence(&p, &q)
    }

    /// 多维度加权 JS 散度（方向 0.5 + 速度 0.3 + 加速度 0.2）
    ///
    /// 相比单维度方向散度，多维度联合分布能更精确判别真实人类行为：
    /// - 方向权重最大（0.5）：最稳定，是主导判别维度
    /// - 速度权重次之（0.3）：反映操作节奏
    /// - 加速度权重最小（0.2）：噪声大但能反映运动次优性
    ///
    /// 阈值建议：< 0.15 人类相似 / 0.15-0.4 可疑 / > 0.4 异常
    pub fn js_divergence_multidim(&self, template: &BehaviorTemplate) -> f32 {
        let dir_p = self.current_distribution();
        let dir_q = template_baseline_distribution(template, self.bucket_count);
        let dir_js = js_divergence(&dir_p, &dir_q);

        let vel_p = self.current_velocity_distribution();
        let vel_q = template_velocity_distribution(template, self.bucket_count);
        let vel_js = js_divergence(&vel_p, &vel_q);

        let acc_p = self.current_acceleration_distribution();
        let acc_q = template_acceleration_distribution(template, self.bucket_count);
        let acc_js = js_divergence(&acc_p, &acc_q);

        0.5 * dir_js + 0.3 * vel_js + 0.2 * acc_js
    }

    /// 窗口是否已满（达到 max_size）
    pub fn is_full(&self) -> bool {
        self.window.len() >= self.max_size
    }

    /// 当前窗口大小
    pub fn len(&self) -> usize {
        self.window.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.window.is_empty()
    }
}

impl Default for BehaviorBaseline {
    fn default() -> Self {
        Self::new()
    }
}

/// 根据模板参数生成理论基线分布
///
/// 不同模板的角度分布特征：
/// - 速度系数高（急躁）：分布更均匀（多方向快速移动）
/// - 速度系数低（谨慎）：分布更集中（少量主导方向）
/// - 过冲大：水平/垂直方向占比高（过冲方向）
fn template_baseline_distribution(template: &BehaviorTemplate, bucket_count: usize) -> Vec<f32> {
    let mut dist = vec![0.0f32; bucket_count];
    // 速度系数决定集中度：speed_factor 越高，分布越均匀
    let concentration = 1.0 / template.speed_factor.max(0.1);

    // 主导方向（水平 0° 和 180°，对应桶 0 和 bucket_count/2）
    let primary_bucket = 0usize;
    let secondary_bucket = bucket_count / 2;

    // 集中分布：主导桶占 concentration 比例，其余均匀
    let primary_weight = concentration * 0.4;
    let secondary_weight = concentration * 0.3;
    let remaining = 1.0 - primary_weight - secondary_weight;
    let uniform = remaining / (bucket_count as f32 - 2.0).max(1.0);

    for i in 0..bucket_count {
        if i == primary_bucket {
            dist[i] = primary_weight;
        } else if i == secondary_bucket {
            dist[i] = secondary_weight;
        } else {
            dist[i] = uniform;
        }
    }

    // 归一化（确保 sum=1.0）
    let total: f32 = dist.iter().sum();
    if total > 0.0 {
        for v in dist.iter_mut() {
            *v /= total;
        }
    }
    dist
}

/// 根据模板参数生成速度基线分布
///
/// 不同模板的速度分布特征：
/// - 速度系数高（急躁/游戏）：分布偏向高速度桶
/// - 速度系数低（谨慎/疲劳）：分布偏向低速度桶
/// - 中心位置 = speed_factor × bucket_count × 0.5
fn template_velocity_distribution(template: &BehaviorTemplate, bucket_count: usize) -> Vec<f32> {
    let mut dist = vec![0.0f32; bucket_count];
    // 速度系数决定分布中心位置
    let center = (template.speed_factor * bucket_count as f32 * 0.5) as usize;
    let center = center.min(bucket_count - 1);

    // 高斯分布（中心附近占比高）
    let sigma = 2.0f32;
    for i in 0..bucket_count {
        let d = (i as f32 - center as f32).abs();
        dist[i] = (-d * d / (2.0 * sigma * sigma)).exp();
    }

    // 归一化
    let total: f32 = dist.iter().sum();
    if total > 0.0 {
        for v in dist.iter_mut() {
            *v /= total;
        }
    }
    dist
}

/// 根据模板参数生成加速度基线分布
///
/// 不同模板的加速度分布特征：
/// - 过冲大（急躁/疲劳）：加速度分布更分散（频繁加减速）
/// - 过冲小（谨慎）：加速度分布更集中（匀速为主）
/// - 中心在低加速度桶（大部分时间匀速）
fn template_acceleration_distribution(template: &BehaviorTemplate, bucket_count: usize) -> Vec<f32> {
    let mut dist = vec![0.0f32; bucket_count];
    // 过冲大 → sigma 大 → 分布分散
    let sigma = 1.5 + template.overshoot * 20.0;
    // 中心在低加速度桶（bucket_count / 4）
    let center = bucket_count / 4;

    for i in 0..bucket_count {
        let d = (i as f32 - center as f32).abs();
        dist[i] = (-d * d / (2.0 * sigma * sigma)).exp();
    }

    // 归一化
    let total: f32 = dist.iter().sum();
    if total > 0.0 {
        for v in dist.iter_mut() {
            *v /= total;
        }
    }
    dist
}

/// 计算窗口内分布的平均值（辅助函数）
fn average_distribution(window: &VecDeque<Vec<f32>>, bucket_count: usize) -> Vec<f32> {
    if window.is_empty() {
        let uniform = 1.0 / bucket_count as f32;
        return vec![uniform; bucket_count];
    }

    let mut avg = vec![0.0f32; bucket_count];
    for dist in window {
        for (i, &v) in dist.iter().enumerate() {
            avg[i] += v;
        }
    }
    let n = window.len() as f32;
    for v in avg.iter_mut() {
        *v /= n;
    }
    avg
}

/// 计算 JS 散度（Jensen-Shannon Divergence）
///
/// JS(P||Q) = 0.5*KL(P||M) + 0.5*KL(Q||M)，M=0.5*(P+Q)
/// 返回值范围 [0, ln(2)] ≈ [0, 0.693]
pub fn js_divergence(p: &[f32], q: &[f32]) -> f32 {
    assert_eq!(p.len(), q.len(), "分布长度必须相同");
    if p.is_empty() {
        return 0.0;
    }

    let n = p.len();
    let mut m = Vec::with_capacity(n);
    for i in 0..n {
        m.push((p[i] + q[i]) / 2.0);
    }

    let kl_pm = kl_divergence(p, &m);
    let kl_qm = kl_divergence(q, &m);

    0.5 * kl_pm + 0.5 * kl_qm
}

/// KL 散度（Kullback-Leibler Divergence）
///
/// KL(P||Q) = Σ P(i) * log(P(i)/Q(i))
/// 当 Q(i)=0 且 P(i)>0 时返回 +∞（实际上用大数替代避免 NaN）
fn kl_divergence(p: &[f32], q: &[f32]) -> f32 {
    let mut sum = 0.0f32;
    for i in 0..p.len() {
        if p[i] <= 0.0 {
            continue; // 0 * log(0) = 0（极限）
        }
        if q[i] <= 0.0 {
            // P>0 但 Q=0：KL 发散，返回大值
            sum += p[i] * 100.0;
        } else {
            sum += p[i] * (p[i] / q[i]).ln();
        }
    }
    sum
}

/// 探针反馈调整器
///
/// 替代原方案"FGSM 梯度上升 + 蒙特卡洛采样"：
/// - 单变量扫描：逐步增加噪声幅度，观察是否触发风控
/// - 若触发风控（如弹出验证码）：回退到上一个成功值
/// - 若未触发：继续增加（试探边界）
pub struct ProbeAdjuster {
    /// 当前噪声振幅
    current_amplitude: f32,
    /// 最小振幅
    min_amplitude: f32,
    /// 最大振幅
    max_amplitude: f32,
    /// 步长（每次调整的增量）
    step: f32,
    /// 上一个成功值（触发风控时回退）
    last_success: f32,
}

impl ProbeAdjuster {
    pub fn new(min: f32, max: f32, step: f32) -> Self {
        Self {
            current_amplitude: min,
            min_amplitude: min,
            max_amplitude: max,
            step,
            last_success: min,
        }
    }

    /// 获取当前噪声振幅
    pub fn current(&self) -> f32 {
        self.current_amplitude
    }

    /// 反馈上次操作是否成功（未触发风控）
    ///
    /// - 成功：记录当前值为 last_success，尝试增加振幅
    /// - 失败：回退到 last_success，减小步长
    pub fn feedback(&mut self, success: bool) {
        if success {
            self.last_success = self.current_amplitude;
            // 试探增加
            self.current_amplitude = (self.current_amplitude + self.step).min(self.max_amplitude);
        } else {
            // 回退到上次成功值
            self.current_amplitude = self.last_success;
            // 减小步长（更精细的搜索）
            self.step *= 0.5;
            if self.step < 0.01 {
                self.step = 0.01; // 最小步长
            }
        }
    }

    /// 重置到初始状态
    pub fn reset(&mut self) {
        self.current_amplitude = self.min_amplitude;
        self.last_success = self.min_amplitude;
        self.step = (self.max_amplitude - self.min_amplitude) * 0.1; // 初始步长 10%
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::bezier::generate_trajectory;

    #[test]
    fn test_js_divergence_identical() {
        let p = vec![0.25, 0.25, 0.25, 0.25];
        let js = js_divergence(&p, &p);
        assert!(js < 0.001, "相同分布 JS 散度应接近 0，实际 {}", js);
    }

    #[test]
    fn test_js_divergence_different() {
        let p = vec![0.9, 0.1, 0.0, 0.0];
        let q = vec![0.0, 0.0, 0.1, 0.9];
        let js = js_divergence(&p, &q);
        assert!(js > 0.3, "差异大的分布 JS 散度应 > 0.3，实际 {}", js);
        // ln(2) ≈ 0.6931472，允许浮点误差
        assert!(
            js <= std::f32::consts::LN_2 + 0.001,
            "JS 散度应 ≤ ln(2)，实际 {}",
            js
        );
    }

    #[test]
    fn test_js_divergence_symmetric() {
        let p = vec![0.5, 0.3, 0.2, 0.0];
        let q = vec![0.1, 0.2, 0.3, 0.4];
        let js_pq = js_divergence(&p, &q);
        let js_qp = js_divergence(&q, &p);
        assert!((js_pq - js_qp).abs() < 0.001, "JS 散度应对称");
    }

    #[test]
    fn test_baseline_add_observation() {
        let mut baseline = BehaviorBaseline::new();
        let traj = generate_trajectory((0.0, 0.0), (100.0, 100.0), 1.0, 0.0);
        baseline.add_observation(&traj);
        assert_eq!(baseline.len(), 1);
        assert!(!baseline.is_empty());
    }

    #[test]
    fn test_baseline_distribution() {
        let mut baseline = BehaviorBaseline::new();
        let traj = generate_trajectory((0.0, 0.0), (100.0, 0.0), 1.0, 0.0); // 水平移动
        baseline.add_observation(&traj);
        let dist = baseline.current_distribution();
        assert!(!dist.is_empty());
        // 水平移动应在桶 0（0°方向）有较高权重
        assert!(dist[0] > 0.0);
    }

    #[test]
    fn test_probe_adjuster() {
        let mut adjuster = ProbeAdjuster::new(0.5, 3.0, 0.2);
        assert_eq!(adjuster.current(), 0.5);

        // 成功反馈：振幅增加
        adjuster.feedback(true);
        assert!(adjuster.current() > 0.5);

        // 失败反馈：回退到上次成功值
        let before_fail = adjuster.current();
        adjuster.feedback(false);
        assert!(adjuster.current() < before_fail);
    }

    #[test]
    fn test_template_baseline_distribution() {
        let template = BehaviorTemplate::presets()[0].clone();
        let dist = template_baseline_distribution(&template, 16);
        let total: f32 = dist.iter().sum();
        assert!((total - 1.0).abs() < 0.01, "分布应归一化为 1.0，实际 {}", total);
    }

    #[test]
    fn test_template_velocity_distribution() {
        let template = BehaviorTemplate::presets()[0].clone();
        let dist = template_velocity_distribution(&template, 16);
        let total: f32 = dist.iter().sum();
        assert!(
            (total - 1.0).abs() < 0.01,
            "速度分布应归一化为 1.0，实际 {}",
            total
        );
    }

    #[test]
    fn test_template_acceleration_distribution() {
        let template = BehaviorTemplate::presets()[0].clone();
        let dist = template_acceleration_distribution(&template, 16);
        let total: f32 = dist.iter().sum();
        assert!(
            (total - 1.0).abs() < 0.01,
            "加速度分布应归一化为 1.0，实际 {}",
            total
        );
    }

    #[test]
    fn test_multidim_divergence() {
        let mut baseline = BehaviorBaseline::new();
        let traj = generate_trajectory((0.0, 0.0), (100.0, 100.0), 1.0, 0.05);
        baseline.add_observation(&traj);

        let template = BehaviorTemplate::presets()[0].clone();
        let js_single = baseline.js_divergence_from_template(&template);
        let js_multi = baseline.js_divergence_multidim(&template);

        // 多维度散度应在合理范围 [0, 0.693]
        assert!(js_multi >= 0.0, "多维度散度不应为负");
        assert!(js_multi <= 0.693, "多维度散度应 ≤ ln(2)");
        // 多维度散度与单维度散度应在同一数量级
        assert!(
            js_multi < js_single + 0.5,
            "多维度散度异常偏高 single={} multi={}",
            js_single,
            js_multi
        );
    }

    #[test]
    fn test_velocity_distribution_nonempty() {
        let mut baseline = BehaviorBaseline::new();
        let traj = generate_trajectory((0.0, 0.0), (200.0, 100.0), 1.0, 0.0);
        baseline.add_observation(&traj);
        let vel_dist = baseline.current_velocity_distribution();
        assert_eq!(vel_dist.len(), 16);
        let total: f32 = vel_dist.iter().sum();
        assert!((total - 1.0).abs() < 0.01, "速度分布应归一化");
    }

    #[test]
    fn test_acceleration_distribution_nonempty() {
        let mut baseline = BehaviorBaseline::new();
        let traj = generate_trajectory((0.0, 0.0), (200.0, 100.0), 1.0, 0.1);
        baseline.add_observation(&traj);
        let acc_dist = baseline.current_acceleration_distribution();
        assert_eq!(acc_dist.len(), 16);
        let total: f32 = acc_dist.iter().sum();
        assert!((total - 1.0).abs() < 0.01, "加速度分布应归一化");
    }
}
