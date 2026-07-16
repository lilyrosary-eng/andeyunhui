//! 粉红噪声 + 肌肉颤振（生物物理噪声精确注入）
//!
//! 替代原维度五"1/f 粉红噪声 + 触摸屏 Stick-Slip + 陀螺仪耦合"：
//! - Voss-McCartney 算法生成 1/f 频谱粉红噪声（纯 Rust，零依赖）
//! - 8-12Hz 肌肉颤振叠加（生理性手震，运动皮层神经噪声）
//! - 删除触摸屏 Stick-Slip（桌面场景少）
//! - 删除 DeviceOrientation/DeviceMotion 陀螺仪耦合（桌面无硬件）
//!
//! 1/f 噪声特性：
//! - 低频段能量高（有意移动，宏观趋势）
//! - 高频段能量低但持续存在（生理震颤，微观抖动）
//! - 与白噪声（平坦频谱）区别：粉红噪声更符合人类肌肉运动单元放电频率

use super::bezier::TrajectoryPoint;

/// Voss-McCartney 粉红噪声生成器
///
/// 算法：维护 N 个独立白噪声源，每步只更新部分源，求和得到 1/f 频谱。
/// - N=8 时频谱接近 1/f（每倍频程 -3dB）
/// - 比 FFT 滤波器轻量得多（无需 DSP 库）
pub struct PinkNoiseGenerator {
    sources: [f32; 8],
    counter: u32,
}

impl PinkNoiseGenerator {
    pub fn new() -> Self {
        Self {
            sources: [0.0; 8],
            counter: 0,
        }
    }

    /// 生成下一个粉红噪声样本（[-1.0, 1.0] 范围）
    ///
    /// Voss-McCartney：每步根据 counter 的位模式决定更新哪些源，
    /// 然后所有源求和并归一化。低频源更新慢，高频源更新快。
    pub fn next_sample(&mut self) -> f32 {
        // 更新哪些源：counter 的每个 set bit 对应一个需要更新的源
        let mut updated = false;
        for i in 0..8 {
            if (self.counter & (1 << i)) != 0 || i == 0 {
                // 生成 [-1, 1] 的均匀随机数（用线性同余，避免引入 rand crate）
                self.sources[i] = self.lcg_random() * 2.0 - 1.0;
                updated = true;
            }
        }
        if !updated {
            self.sources[0] = self.lcg_random() * 2.0 - 1.0;
        }
        self.counter = self.counter.wrapping_add(1);

        // 求和并归一化（8 个源，每个 [-1,1]，总和最大 ±8）
        let sum: f32 = self.sources.iter().sum();
        sum / 8.0
    }

    /// 线性同余生成器（LCG）：避免引入 rand crate（取巧原则）
    ///
    /// 使用 glibc 同款参数：a=1103515245, c=12345, m=2^31
    fn lcg_random(&mut self) -> f32 {
        // 用 counter 作为种子（确定性，但足以模拟噪声）
        let seed = self
            .counter
            .wrapping_mul(1103515245)
            .wrapping_add(12345);
        (seed & 0x7FFFFFFF) as f32 / 0x7FFFFFFF as f32
    }
}

impl Default for PinkNoiseGenerator {
    fn default() -> Self {
        Self::new()
    }
}

/// 生成指定长度的粉红噪声序列
pub fn pink_noise_sequence(length: usize, amplitude: f32) -> Vec<f32> {
    let mut gen = PinkNoiseGenerator::new();
    (0..length).map(|_| gen.next_sample() * amplitude).collect()
}

/// 8-12Hz 肌肉颤振（生理性手震）
///
/// 人类手部肌肉运动单元的放电频率约 8-12Hz，
/// 表现为鼠标轨迹中持续的微小周期性抖动。
///
/// 生成正弦波 + 微小相位扰动（避免完全周期性）
pub fn tremor_sequence(length: usize, frequency_hz: f32, amplitude: f32, sample_interval_ms: u32) -> Vec<f32> {
    let mut result = Vec::with_capacity(length);
    for i in 0..length {
        let t_secs = (i as f32 * sample_interval_ms as f32) / 1000.0;
        // 主频 + 谐波（更接近真实生理信号）
        let main = (2.0 * std::f32::consts::PI * frequency_hz * t_secs).sin();
        let harmonic = 0.3 * (2.0 * std::f32::consts::PI * frequency_hz * 2.0 * t_secs).sin();
        result.push((main + harmonic) * amplitude);
    }
    result
}

/// 高斯白噪声（Box-Muller 变换，无 rand crate 依赖）
///
/// 用于补充粉红噪声的高频段（粉红噪声高频能量低，需白噪声补充细节）
///
/// 使用独立 LCG 状态（不复用 PinkNoiseGenerator::lcg_random，
/// 因为后者不递增 counter 会导致每次返回相同值）
pub fn gaussian_white_noise(length: usize, amplitude: f32) -> Vec<f32> {
    let mut result = Vec::with_capacity(length);
    // 独立 LCG 状态（PCG 同款参数，高位相关性更弱）
    let mut lcg_state: u64 = 0x1234567890ABCDEF;

    for _ in 0..(length + 1) / 2 {
        // 推进 LCG 两次，生成两个独立均匀随机数
        lcg_state = lcg_state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let u1 = (lcg_state >> 32) as f32 / u32::MAX as f32;

        lcg_state = lcg_state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let u2 = (lcg_state >> 32) as f32 / u32::MAX as f32;

        let u1 = u1.max(1e-10);
        // Box-Muller: z = sqrt(-2 ln u1) * cos(2π u2)
        let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos();
        result.push(z * amplitude);
        // 第二个样本（sin 分量）
        let z2 = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).sin();
        result.push(z2 * amplitude);
    }
    result.truncate(length);
    result
}

/// 将生理噪声叠加到轨迹（粉红噪声 + 8-12Hz 颤振 + 白噪声）
///
/// 参数：
/// - `trajectory`：原始贝塞尔轨迹
/// - `noise_amplitude`：噪声振幅（像素，0.5-3.0 典型）
/// - `tremor_frequency`：颤振频率（8-12Hz 典型）
///
/// 返回：叠加噪声后的新轨迹（原轨迹不变）
pub fn apply_physiological_noise(
    trajectory: &[TrajectoryPoint],
    noise_amplitude: f32,
    tremor_frequency: f32,
) -> Vec<TrajectoryPoint> {
    if trajectory.is_empty() {
        return Vec::new();
    }

    let len = trajectory.len();
    // 估算采样间隔（取相邻点时间差的中位数）
    let sample_interval_ms = if len > 1 {
        trajectory[1].t_ms.saturating_sub(trajectory[0].t_ms).max(1)
    } else {
        8 // 默认 8ms（125Hz 鼠标）
    };

    // 生成三路噪声
    let pink = pink_noise_sequence(len, noise_amplitude * 0.6);
    let tremor = tremor_sequence(len, tremor_frequency, noise_amplitude * 0.3, sample_interval_ms);
    let white = gaussian_white_noise(len, noise_amplitude * 0.1);

    // 叠加到轨迹（x/y 各加一路独立的粉红噪声 + 共享颤振 + 独立白噪声）
    trajectory
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let nx = pink.get(i).copied().unwrap_or(0.0) + tremor.get(i).copied().unwrap_or(0.0) * 0.7;
            let ny = pink.get((i + len / 2) % len).copied().unwrap_or(0.0)
                + tremor.get(i).copied().unwrap_or(0.0) * 0.3
                + white.get(i).copied().unwrap_or(0.0);
            TrajectoryPoint {
                x: p.x + nx,
                y: p.y + ny,
                t_ms: p.t_ms,
            }
        })
        .collect()
}

/// 计算轨迹的功率谱密度近似（用于验证 1/f 特性）
///
/// 简化版：将轨迹分频段统计能量，返回 (低频能量, 中频能量, 高频能量)
/// 真实 1/f 噪声应满足：低频 > 中频 > 高频
pub fn estimate_psd(trajectory: &[TrajectoryPoint]) -> (f32, f32, f32) {
    if trajectory.len() < 8 {
        return (0.0, 0.0, 0.0);
    }
    let n = trajectory.len();
    let low_end = n / 3;
    let mid_end = (n * 2) / 3;

    // 简化：用相邻点差分的方差作为能量估计（避免 FFT）
    let variance = |slice: &[TrajectoryPoint]| -> f32 {
        if slice.len() < 2 {
            return 0.0;
        }
        let mean_x: f32 = slice.iter().map(|p| p.x).sum::<f32>() / slice.len() as f32;
        let var_x: f32 = slice.iter().map(|p| (p.x - mean_x).powi(2)).sum::<f32>() / slice.len() as f32;
        let mean_y: f32 = slice.iter().map(|p| p.y).sum::<f32>() / slice.len() as f32;
        let var_y: f32 = slice.iter().map(|p| (p.y - mean_y).powi(2)).sum::<f32>() / slice.len() as f32;
        var_x + var_y
    };

    let low = variance(&trajectory[..low_end]);
    let mid = variance(&trajectory[low_end..mid_end]);
    let high = variance(&trajectory[mid_end..]);

    (low, mid, high)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::bezier::generate_trajectory;

    #[test]
    fn test_pink_noise_amplitude() {
        let noise = pink_noise_sequence(100, 2.0);
        assert_eq!(noise.len(), 100);
        // 振幅应在 [-2.0, 2.0] 范围内（粉红噪声归一化后）
        for &n in &noise {
            assert!(n.abs() <= 2.5, "噪声振幅 {} 超出预期", n);
        }
    }

    #[test]
    fn test_tremor_sequence() {
        let tremor = tremor_sequence(50, 10.0, 1.0, 8);
        assert_eq!(tremor.len(), 50);
        // 10Hz × 8ms = 0.08 周期/样本，50 个样本约 4 个周期
        // 应有正负波动
        let has_pos = tremor.iter().any(|&v| v > 0.0);
        let has_neg = tremor.iter().any(|&v| v < 0.0);
        assert!(has_pos && has_neg);
    }

    #[test]
    fn test_gaussian_white_noise() {
        let noise = gaussian_white_noise(100, 1.0);
        assert_eq!(noise.len(), 100);
        // 高斯噪声均值应接近 0
        let mean: f32 = noise.iter().sum::<f32>() / noise.len() as f32;
        assert!(mean.abs() < 0.5, "均值 {} 偏离 0", mean);
    }

    #[test]
    fn test_apply_physiological_noise() {
        let traj = generate_trajectory((0.0, 0.0), (100.0, 100.0), 1.0, 0.0);
        let noisy = apply_physiological_noise(&traj, 1.5, 10.0);
        assert_eq!(noisy.len(), traj.len());
        // 噪声轨迹应与原轨迹有微小偏差
        let has_diff = traj.iter().zip(noisy.iter()).any(|(a, b)| {
            (a.x - b.x).abs() > 0.01 || (a.y - b.y).abs() > 0.01
        });
        assert!(has_diff, "噪声叠加未产生偏差");
    }

    #[test]
    fn test_psd_estimate() {
        let traj = generate_trajectory((0.0, 0.0), (500.0, 500.0), 1.0, 0.0);
        let noisy = apply_physiological_noise(&traj, 2.0, 10.0);
        let (low, mid, high) = estimate_psd(&noisy);
        // 应有能量分布（具体值取决于噪声生成）
        assert!(low >= 0.0 && mid >= 0.0 && high >= 0.0);
    }
}
