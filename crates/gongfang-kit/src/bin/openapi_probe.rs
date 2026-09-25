//! OpenAPI/Swagger 参数边界推演探针（dev-only）
//!
//! 用途：走**产品命令**（`commands::gongfang_openapi_analyze`，含真实网络抓取 spec）
//! 对公开真实的规范做一次端到端验证，证明「参数边界推演」不是纸面能力。
//!
//! 运行（在 crates/gongfang-kit 内）：
//!   cargo run --bin openapi_probe --features pentest
//!   cargo run --bin openapi_probe --features pentest -- https://example.com/openapi.json
//!
//! 说明：bin 是独立 crate root，故经包名 `gongfang_kit` 引用 lib。
#![cfg(feature = "pentest")]

/// 默认目标：公开真实 spec（Swagger 2.0 与 OpenAPI 3.x 各一，覆盖两条解析分支）
const DEFAULT_TARGETS: &[&str] = &[
    "https://petstore.swagger.io/v2/swagger.json",
    "https://petstore3.swagger.io/api/v3/openapi.json",
];

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let targets: Vec<String> = if args.is_empty() {
        DEFAULT_TARGETS.iter().map(|s| s.to_string()).collect()
    } else {
        args
    };

    println!("=== OpenAPI 参数边界推演探针（走产品命令）===");
    for t in &targets {
        println!("\n--- {t} ---");
        let started = std::time::Instant::now();
        match gongfang_kit::commands::gongfang_openapi_analyze(Some(t.clone()), None).await {
            Ok(r) => {
                println!(
                    "  spec={}  title={:?}  端点={}  schema={}  安全方案={:?}",
                    r.spec_version, r.title, r.endpoint_count, r.schema_count, r.security_schemes
                );
                println!("  servers={:?}", r.servers);
                // 抽 3 个带参数的端点，展示边界候选的类别分布
                let mut shown = 0;
                for ep in &r.endpoints {
                    if ep.params.is_empty() {
                        continue;
                    }
                    println!("  {} {}（body_schema={:?}）", ep.method, ep.path, ep.body_schema);
                    for p in ep.params.iter().take(4) {
                        let kinds: Vec<&str> = p.candidates.iter().map(|c| c.kind).collect();
                        println!(
                            "     · {:<16} in={:<7} type={:<8} required={:<5} 候选 {} 条 {:?}",
                            p.name,
                            p.location,
                            p.schema_type,
                            p.required,
                            p.candidates.len(),
                            kinds
                        );
                    }
                    shown += 1;
                    if shown >= 3 {
                        break;
                    }
                }
                if !r.warnings.is_empty() {
                    for w in &r.warnings {
                        println!("  ⚠ {w}");
                    }
                }
                println!("  耗时 {} ms", started.elapsed().as_millis());
            }
            Err(e) => println!("  ✗ 失败: {e}"),
        }
    }
    println!("\n=== 完成 ===");
}