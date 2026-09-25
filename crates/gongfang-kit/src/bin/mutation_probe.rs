//! 自适应变异（UCB1 多臂老虎机）探针（dev-only）
//!
//! 用途：证明「自适应变异」是真学习而非纸面能力——在**已知真值**的规则模型上跑
//! N 轮选臂，检查 UCB1 是否把绝大多数次数收敛到真正能绕过的那一族编码。
//!
//! 运行（在 crates/gongfang-kit 内）：
//!   cargo run --bin mutation_probe --features pentest
//!   cargo run --bin mutation_probe --features pentest -- "union select 1" 300
//!
//! 说明：bin 是独立 crate root，故经包名 `gongfang_kit` 引用 lib。
#![cfg(feature = "pentest")]

use std::collections::HashSet;

#[tokio::main]
async fn main() {
    let input = std::env::args().nth(1).unwrap_or_else(|| "union select 1".to_string());
    let trials: usize = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);

    println!("=== 自适应变异（UCB1）探针 ===");
    println!("载荷: {:?}  轮数: {}", input, trials);

    // —— 真值：把 11 个臂全部枚举一遍，看谁真能绕过规则 ——
    let mut truth: Vec<(usize, &'static str, usize)> = Vec::new();
    for arm in 0..gongfang_kit::pentest::mutation::ARMS.len() {
        let payload = gongfang_kit::pentest::mutation::apply(arm, &input).unwrap_or_default();
        let bypassed = gongfang_kit::pentest::sim::bypassed_rules(&payload);
        truth.push((arm, gongfang_kit::pentest::mutation::ARMS[arm], bypassed.len()));
    }
    let max_bypass = truth.iter().map(|t| t.2).max().unwrap_or(0);
    let best_arms: HashSet<usize> = truth
        .iter()
        .filter(|t| t.2 == max_bypass && max_bypass > 0)
        .map(|t| t.0)
        .collect();
    println!("\n真值（枚举全部臂，绕过的规则条数）:");
    for (arm, name, n) in &truth {
        println!("   [{:>2}] {:<16} 绕过 {} 条{}", arm, name, n, if best_arms.contains(arm) { "  ← 最优" } else { "" });
    }
    if best_arms.is_empty() {
        println!("   该载荷下没有任何臂能绕过规则：本探针无法验证收敛，请换载荷");
        return;
    }

    // —— 学习：UCB1 选臂 + 用规则模型给奖励（奖励=比原文多绕过，与 mutation.rs 同口径）——
    let ctx = format!("probe:{}", input);
    // 先清空历史，保证结果可复现
    let _ = gongfang_kit::commands::gongfang_mutation_stats(Some(ctx.clone()), Some(true));

    let baseline_bypass = gongfang_kit::pentest::sim::bypassed_rules(&input).len();
    let mut chosen_bypass_sum = 0usize;
    let mut hits = 0usize;
    for t in 0..trials {
        let sel = match gongfang_kit::commands::gongfang_mutation_select(ctx.clone(), input.clone()) {
            Ok(s) => s,
            Err(e) => {
                println!("✗ 选臂失败: {e}");
                return;
            }
        };
        // 走产品命令回填**分级**奖励（与 mutation.rs::offline_trial 同口径）：
        // (本臂绕过数 - 原文绕过数) / 规则总数
        let payload = gongfang_kit::pentest::mutation::apply(sel.arm, &input).unwrap_or_default();
        let n_bypassed = gongfang_kit::pentest::sim::bypassed_rules(&payload).len();
        let gain = n_bypassed.saturating_sub(baseline_bypass);
        let reward = (gain as f64 / gongfang_kit::pentest::mutation::rule_count() as f64).clamp(0.0, 1.0);
        let _ = gongfang_kit::commands::gongfang_mutation_reward(
            ctx.clone(),
            sel.arm,
            None,
            Some(reward),
        );
        chosen_bypass_sum += n_bypassed;
        if best_arms.contains(&sel.arm) {
            hits += 1;
        }
        if t < 12 || t + 1 == trials {
            println!(
                "   trial {:>3}: arm={:>2} {:<16} exploring={:<5} 绕过 {} 条（多绕 {}）",
                t + 1,
                sel.arm,
                sel.arm_name,
                sel.exploring,
                n_bypassed,
                n_bypassed as i64 - baseline_bypass as i64
            );
        }
    }

    // —— 收敛评估 ——
    let stats = gongfang_kit::commands::gongfang_mutation_stats(Some(ctx.clone()), None).unwrap_or_default();
    // 结构：{ reset, arms: [臂名...], contexts: { ctx: [ArmReport...] } }
    let arms = stats
        .get("contexts")
        .and_then(|c| c.get(&ctx))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    println!("\n最终各臂统计（plays / mean）:");
    for a in &arms {
        let arm = a.get("arm").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
        let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let plays = a.get("plays").and_then(|x| x.as_u64()).unwrap_or(0);
        let mean = a.get("mean_reward").and_then(|x| x.as_f64()).unwrap_or(0.0);
        println!(
            "   [{:>2}] {:<16} plays={:>4}  mean={:.3}{}",
            arm,
            name,
            plays,
            mean,
            if best_arms.contains(&arm) { "  ← 最优" } else { "" }
        );
    }

    let ratio = hits as f64 / trials as f64;
    let baseline = best_arms.len() as f64 / gongfang_kit::pentest::mutation::ARMS.len() as f64;
    // 主判据：UCB1 平均绕过条数 vs 均匀随机策略的期望（=各臂绕过数均值）
    let avg_chosen = chosen_bypass_sum as f64 / trials as f64;
    let avg_random = truth.iter().map(|t| t.2 as f64).sum::<f64>() / truth.len() as f64;
    let converged = avg_chosen > avg_random + 0.05;
    println!(
        "\n自检（主判据）: UCB1 平均绕过 {:.3} 条 vs 均匀随机期望 {:.3} 条  →  {}",
        avg_chosen,
        avg_random,
        if converged { "✓ 学到偏好" } else { "✗ 无显著提升（该载荷下各臂收益接近，缺区分度）" }
    );
    println!(
        "自检（副判据）: 选中最优臂 {}/{} = {:.1}%（随机基线 {:.1}%，最优臂 {} / 共 {}）",
        hits,
        trials,
        ratio * 100.0,
        baseline * 100.0,
        best_arms.len(),
        gongfang_kit::pentest::mutation::ARMS.len()
    );
}