fn main() {
    tauri_build::build();

    // ---- 测试二进制的 Windows 清单（2026-10-21 重做）----
    //
    // 现象：`cargo test --lib` 的测试进程一启动就 0xc0000139（STATUS_ENTRYPOINT_NOT_FOUND），
    // 一个测试都跑不了。用 PE 导入表定位根因：`muda`（Tauri 菜单 crate）**静态导入**了
    // comctl32 的 `TaskDialogIndirect`，这个导出只存在于 Common-Controls **v6**
    //（side-by-side 程序集）。测试二进制没有声明 v6 依赖的清单，加载器拿到 System32 的
    // comctl32 v5 → 缺导出 → 进程直接起不来。
    //
    // 修法：把带 v6 依赖的清单（tests.manifest）链进**测试**二进制。
    //
    // ⚠ 走的是 `test-manifest` feature，不是 `cargo:rustc-link-arg-tests`：
    // - 本机 cargo（1.96.0）**不认** `rustc-link-arg-tests` / `-bins` / `-benches`，
    //   直接报 `error: invalid instruction` —— 上一版写了这条，实际从没生效
    //   （症状就是测试进程照旧 0xc0000139）。
    // - `rustc-link-arg`（全目标）能生效，但 app 二进制已被 tauri-build 内嵌了清单，
    //   再链一次 lld 会报 `duplicate resource: type MANIFEST`。
    // 所以只有开了 feature 才链，且只跑 `--lib` 测试目标（见 package.json 的 test:rust 与 ci.yml）。
    #[cfg(windows)]
    {
        if std::env::var_os("CARGO_FEATURE_TEST_MANIFEST").is_some() {
            let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
            let manifest = std::path::Path::new(&dir).join("tests.manifest");
            if manifest.is_file() {
                println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
                println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
            } else {
                println!("cargo:warning=缺少 tests.manifest，测试二进制可能无法启动（comctl32 v6 清单）");
            }
        }
    }
}
