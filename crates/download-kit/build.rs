fn main() {
    // ---- 测试二进制的 Windows 清单 ----
    //
    // 与主 crate（src-tauri/build.rs）同一问题：依赖链里的 tauri/muda 静态导入了
    // comctl32 的 `TaskDialogIndirect`，该导出只存在于 Common-Controls **v6**。
    // 普通 cargo 测试二进制没有带 v6 依赖的清单 → 进程启动即 0xc0000139
    //（STATUS_ENTRYPOINT_NOT_FOUND），一个测试都跑不起来。
    //
    // 只在 `test-manifest` feature 打开时链接，避免影响正常库构建。
    // 用法：`cargo test --features test-manifest`。
    #[cfg(windows)]
    {
        if std::env::var_os("CARGO_FEATURE_TEST_MANIFEST").is_some() {
            let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
            let manifest = std::path::Path::new(&dir).join("tests.manifest");
            if manifest.is_file() {
                println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
                println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
            } else {
                println!(
                    "cargo:warning=缺少 tests.manifest，测试二进制可能无法启动（comctl32 v6 清单）"
                );
            }
        }
    }
}
