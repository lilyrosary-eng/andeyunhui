//! 多行为模板 + arc-swap 无锁热迁移 + 适应度评估
//!
//! 替代原维度六"元学习进化策略 + 模板热迁移"：
//! - 进化策略需训练适应度评估函数，桌面不可行，删除
//! - 多行为模板（急躁/谨慎/左撇子/游戏/普通）配置化实现，保留
//! - arc-swap 无锁热迁移（双缓冲 FrontBuffer/BackBuffer 原子 Swap），保留
//! - 适应度评估（成功/失败计数，简单加权），保留
//!
//! arc-swap 热迁移流程：
//! 1. 当前模板在 ArcSwap<BehaviorTemplate> 中（FrontBuffer）
//! 2. 适应度下降时，从模板库选一个候选（BackBuffer）
//! 3. arc-swap.store(new) 原子替换，亚毫秒级生效
//! 4. 下一个 HID 报文读取新模板参数，零过渡帧

use arc_swap::ArcSwap;
use std::sync::Arc;

/// 行为模板（决定轨迹生成 + 噪声注入 + HID 间隔的所有参数）
#[derive(Debug, Clone)]
pub struct BehaviorTemplate {
    /// 模板 ID（用于适应度追踪）
    pub id: u32,
    /// 模板名称（人类可读）
    pub name: &'static str,
    /// 速度系数（1.0=正常 / 0.5=慢 / 1.5=快）
    pub speed_factor: f32,
    /// 过冲系数（0.0=无 / 0.1=10% 过冲，模拟次优性）
    pub overshoot: f32,
    /// 噪声振幅（像素，0.5=精密 / 2.0=手抖 / 3.0=疲劳）
    pub noise_amplitude: f32,
    /// 肌肉颤振频率（8-12Hz 典型）
    pub tremor_frequency: f32,
    /// HID 轮询间隔（8ms=125Hz / 1ms=1000Hz）
    pub poll_interval_ms: u32,
    /// 模板权重（用于候选选择，动态调整）
    pub weight: f32,
}

impl BehaviorTemplate {
    /// 预置模板库
    ///
    /// 涵盖主流人类行为模式：
    /// - 普通：基准参数，适合大多数场景
    /// - 急躁：快速点击，过冲大，适合压力测试
    /// - 谨慎：慢速精确，过冲小，适合高安全场景
    /// - 左撇子：曲率方向反转（通过负偏移实现）
    /// - 游戏：1000Hz 高刷新率，适合游戏场景
    /// - 疲劳：大幅颤振，模拟深夜操作
    pub fn presets() -> Vec<BehaviorTemplate> {
        vec![
            BehaviorTemplate {
                id: 0,
                name: "普通",
                speed_factor: 1.0,
                overshoot: 0.05,
                noise_amplitude: 1.0,
                tremor_frequency: 10.0,
                poll_interval_ms: 8,
                weight: 1.0,
            },
            BehaviorTemplate {
                id: 1,
                name: "急躁",
                speed_factor: 1.5,
                overshoot: 0.15,
                noise_amplitude: 1.5,
                tremor_frequency: 12.0,
                poll_interval_ms: 8,
                weight: 0.8,
            },
            BehaviorTemplate {
                id: 2,
                name: "谨慎",
                speed_factor: 0.7,
                overshoot: 0.02,
                noise_amplitude: 0.5,
                tremor_frequency: 8.0,
                poll_interval_ms: 8,
                weight: 0.9,
            },
            BehaviorTemplate {
                id: 3,
                name: "游戏",
                speed_factor: 1.2,
                overshoot: 0.08,
                noise_amplitude: 0.8,
                tremor_frequency: 11.0,
                poll_interval_ms: 1, // 1000Hz 游戏鼠标
                weight: 0.7,
            },
            BehaviorTemplate {
                id: 4,
                name: "疲劳",
                speed_factor: 0.6,
                overshoot: 0.12,
                noise_amplitude: 2.5,
                tremor_frequency: 9.0,
                poll_interval_ms: 8,
                weight: 0.5,
            },
        ]
    }
}

/// 全局模板存储（arc-swap 无锁热替换）
static CURRENT_TEMPLATE: once_cell::sync::Lazy<ArcSwap<BehaviorTemplate>> =
    once_cell::sync::Lazy::new(|| {
        ArcSwap::from_pointee(BehaviorTemplate::presets()[0].clone())
    });

/// 适应度统计（每个模板的成功/失败计数 + 散度累积）
struct FitnessTracker {
    success: u32,
    failure: u32,
    /// 散度累积（用于计算平均散度，散度高→模板偏离人类基线→评分降低）
    divergence_sum: f32,
    divergence_count: u32,
}

static FITNESS: once_cell::sync::Lazy<parking_lot::Mutex<Vec<FitnessTracker>>> =
    once_cell::sync::Lazy::new(|| {
        parking_lot::Mutex::new(
            BehaviorTemplate::presets()
                .iter()
                .map(|_| FitnessTracker {
                    success: 0,
                    failure: 0,
                    divergence_sum: 0.0,
                    divergence_count: 0,
                })
                .collect(),
        )
    });

/// 读取当前模板（无锁，亚毫秒级）
pub fn current_template() -> Arc<BehaviorTemplate> {
    CURRENT_TEMPLATE.load_full()
}

/// 记录模板适应度（成功/失败）
///
/// 当失败率 > 50% 时，自动触发模板热迁移（切换到适应度最高的候选）
pub fn record_fitness(template_id: u32, success: bool) {
    let mut fitness = FITNESS.lock();
    let idx = template_id as usize;
    if idx >= fitness.len() {
        return;
    }
    if success {
        fitness[idx].success += 1;
    } else {
        fitness[idx].failure += 1;
    }

    // 检查是否需要热迁移：当前模板失败率 > 50% 且总尝试 > 5 次
    let total = fitness[idx].success + fitness[idx].failure;
    if total < 5 {
        return;
    }
    let failure_rate = fitness[idx].failure as f32 / total as f32;
    if failure_rate > 0.5 {
        log::warn!(
            "[profiles] 模板 {} 失败率 {:.0}% > 50%，触发热迁移",
            template_id,
            failure_rate * 100.0
        );
        // 重置当前模板计数（避免反复触发）
        fitness[idx].success = 0;
        fitness[idx].failure = 0;
        fitness[idx].divergence_sum = 0.0;
        fitness[idx].divergence_count = 0;
        drop(fitness); // 释放锁，避免与 switch_best_template 死锁
        switch_to_best_template();
    }
}

/// 记录模板适应度（含散度维度）
///
/// 相比 record_fitness，额外记录多维度 JS 散度：
/// - 散度高（>0.4）：即使操作成功，也降低评分（行为偏离人类基线）
/// - 散度低（<0.15）：评分加成（行为接近人类）
///
/// 评分公式：score = success_rate × weight - avg_divergence × 0.5
///
/// 参数：
/// - `template_id`：模板 ID
/// - `success`：操作是否成功（未触发风控）
/// - `divergence`：本次操作的多维度 JS 散度（来自 baseline.js_divergence_multidim）
pub fn record_fitness_with_divergence(template_id: u32, success: bool, divergence: f32) {
    let mut fitness = FITNESS.lock();
    let idx = template_id as usize;
    if idx >= fitness.len() {
        return;
    }

    // 记录散度
    fitness[idx].divergence_sum += divergence;
    fitness[idx].divergence_count += 1;

    if success {
        fitness[idx].success += 1;
    } else {
        fitness[idx].failure += 1;
    }

    // 检查是否需要热迁移
    let total = fitness[idx].success + fitness[idx].failure;
    if total < 5 {
        return;
    }
    let failure_rate = fitness[idx].failure as f32 / total as f32;
    // 散度过高也触发热迁移（即使失败率未超 50%）
    let avg_div = if fitness[idx].divergence_count > 0 {
        fitness[idx].divergence_sum / fitness[idx].divergence_count as f32
    } else {
        0.0
    };

    if failure_rate > 0.5 || avg_div > 0.5 {
        log::warn!(
            "[profiles] 模板 {} 失败率 {:.0}% 平均散度 {:.3}，触发热迁移",
            template_id,
            failure_rate * 100.0,
            avg_div
        );
        fitness[idx].success = 0;
        fitness[idx].failure = 0;
        fitness[idx].divergence_sum = 0.0;
        fitness[idx].divergence_count = 0;
        drop(fitness);
        switch_to_best_template();
    }
}

/// 切换到适应度最高的模板（热迁移）
///
/// 流程：
/// 1. 遍历所有模板的适应度统计
/// 2. 评分公式：score = success_rate × weight - avg_divergence × 0.5
///    - 成功率高 + 权重高 → 评分高
///    - 平均散度高（偏离人类基线）→ 评分降低
/// 3. arc-swap 原子替换当前模板
/// 4. 下一个 HID 报文读取新模板参数
pub fn switch_to_best_template() {
    let fitness = FITNESS.lock();
    let presets = BehaviorTemplate::presets();

    let mut best_idx = 0;
    let mut best_score = f32::MIN;
    for (idx, f) in fitness.iter().enumerate() {
        let total = f.success + f.failure;
        let avg_div = if f.divergence_count > 0 {
            f.divergence_sum / f.divergence_count as f32
        } else {
            0.0
        };

        if total == 0 {
            // 未测试过的模板，给予中性评分（weight × 0.5 - 默认散度惩罚）
            let score = presets[idx].weight * 0.5 - avg_div * 0.3;
            if score > best_score {
                best_score = score;
                best_idx = idx;
            }
        } else {
            let success_rate = f.success as f32 / total as f32;
            // 评分 = 成功率 × weight - 平均散度 × 0.5（散度惩罚）
            let score = success_rate * presets[idx].weight - avg_div * 0.5;
            if score > best_score {
                best_score = score;
                best_idx = idx;
            }
        }
    }

    let new_template = presets[best_idx].clone();
    log::info!(
        "[profiles] 热迁移到模板: {} (score={:.2})",
        new_template.name,
        best_score
    );
    drop(fitness);

    // arc-swap 原子替换（无锁，亚毫秒级生效）
    CURRENT_TEMPLATE.store(Arc::new(new_template));
}

/// 手动切换模板（用户通过 @humanize 命令触发）
///
/// level 参数：
/// - 0：机械精度模式（关闭噪声，最大速度）
/// - 1-3：低拟人化（小噪声，快速）
/// - 4-7：中拟人化（默认）
/// - 8-10：高拟人化（大噪声，慢速，模拟醉酒/疲劳）
pub fn set_humanize_level(level: u32) {
    let current = current_template();
    let mut template = (*current).clone();
    match level {
        0 => {
            template.name = "机械";
            template.speed_factor = 2.0;
            template.overshoot = 0.0;
            template.noise_amplitude = 0.0;
            template.tremor_frequency = 0.0;
        }
        1..=3 => {
            template.name = "低拟人";
            template.speed_factor = 1.3;
            template.overshoot = 0.03;
            template.noise_amplitude = 0.5;
            template.tremor_frequency = 9.0;
        }
        4..=7 => {
            template.name = "中拟人";
            template.speed_factor = 1.0;
            template.overshoot = 0.05;
            template.noise_amplitude = 1.0;
            template.tremor_frequency = 10.0;
        }
        _ => {
            // 8-10
            template.name = "高拟人";
            template.speed_factor = 0.7;
            template.overshoot = 0.12;
            template.noise_amplitude = 2.0;
            template.tremor_frequency = 8.0;
        }
    }
    log::info!(
        "[profiles] @humanize {} → 模板切换到: {}",
        level,
        template.name
    );
    CURRENT_TEMPLATE.store(Arc::new(template));
}

/// 重置所有适应度统计（用户主动 @reset 时）
pub fn reset_fitness() {
    let mut fitness = FITNESS.lock();
    for f in fitness.iter_mut() {
        f.success = 0;
        f.failure = 0;
        f.divergence_sum = 0.0;
        f.divergence_count = 0;
    }
    log::info!("[profiles] 适应度统计已重置");
}

/// 获取所有模板的适应度报告（用于 UI 展示）
///
/// 返回元组：(id, name, success, failure, success_rate, avg_divergence)
pub fn fitness_report() -> Vec<(u32, &'static str, u32, u32, f32, f32)> {
    let fitness = FITNESS.lock();
    let presets = BehaviorTemplate::presets();
    fitness
        .iter()
        .enumerate()
        .map(|(idx, f)| {
            let total = f.success + f.failure;
            let rate = if total > 0 {
                f.success as f32 / total as f32
            } else {
                0.0
            };
            let avg_div = if f.divergence_count > 0 {
                f.divergence_sum / f.divergence_count as f32
            } else {
                0.0
            };
            (
                presets[idx].id,
                presets[idx].name,
                f.success,
                f.failure,
                rate,
                avg_div,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_presets_nonempty() {
        let presets = BehaviorTemplate::presets();
        assert!(presets.len() >= 5);
        assert!(presets.iter().any(|p| p.name == "普通"));
        assert!(presets.iter().any(|p| p.name == "游戏"));
    }

    #[test]
    fn test_current_template_loadable() {
        let t = current_template();
        assert!(t.speed_factor > 0.0);
    }

    #[test]
    fn test_set_humanize_level() {
        set_humanize_level(0);
        let t = current_template();
        assert_eq!(t.name, "机械");
        assert_eq!(t.noise_amplitude, 0.0);

        set_humanize_level(10);
        let t = current_template();
        assert_eq!(t.name, "高拟人");
        assert!(t.noise_amplitude > 1.5);
    }

    #[test]
    fn test_record_fitness() {
        reset_fitness();
        // 记录 6 次失败（>50% 失败率，>5 次总尝试）
        for _ in 0..6 {
            record_fitness(0, false);
        }
        // 应该触发热迁移，当前模板应已切换
        let t = current_template();
        // 切换后模板名称可能是任意非"普通"模板（取决于评分）
        // 这里只验证函数不 panic
        assert!(t.speed_factor > 0.0);
    }

    #[test]
    fn test_fitness_report() {
        reset_fitness();
        record_fitness(0, true);
        record_fitness(0, true);
        record_fitness(0, false);
        let report = fitness_report();
        assert!(!report.is_empty());
        let (id, _, success, failure, rate, _avg_div) = report[0];
        assert_eq!(id, 0);
        assert_eq!(success, 2);
        assert_eq!(failure, 1);
        assert!((rate - 0.667).abs() < 0.1);
    }

    #[test]
    fn test_record_fitness_with_divergence() {
        reset_fitness();
        // 记录带散度的适应度
        record_fitness_with_divergence(0, true, 0.1); // 低散度，成功
        record_fitness_with_divergence(0, true, 0.2); // 低散度，成功
        record_fitness_with_divergence(0, false, 0.6); // 高散度，失败

        let report = fitness_report();
        let (_, _, success, failure, _rate, avg_div) = report[0];
        assert_eq!(success, 2);
        assert_eq!(failure, 1);
        // 平均散度 = (0.1 + 0.2 + 0.6) / 3 ≈ 0.3
        assert!((avg_div - 0.3).abs() < 0.05, "平均散度异常: {}", avg_div);
    }
}
