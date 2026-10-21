fn main() {
    tauri_build::build();

    // ---- 测试二进制的 Windows 清单（2026-10-21）----
    //
    // 现象：`cargo test --lib` 的测试进程一启动就 0xc0000139（STATUS_ENTRYPOINT_NOT_FOUND），
    // 一个测试都跑不了。用 PE 导入表定位根因：`muda`（Tauri 菜单 crate）**静态导入**了
    // comctl32 的 `TaskDialogIndirect`，这个导出只存在于 Common-Controls **v6**
    //（side-by-side 程序集）。测试二进制没有声明 v6 依赖的清单，加载器拿到 System32 的
    // comctl32 v5 → 缺导出 → 进程直接起不来。
    //
    // 修法：把带 v6 依赖的清单（tests.manifest）作为链接输入。用 `rustc-link-arg` 而不是
    // `rustc-link-arg-tests`：后者只认 `tests/` 下的集成测试目标，而这里要修的是 lib 的
    // 单元测试（cargo 会报 "does not have a test target"）。清单内容与 tauri 自带的
    // asInvoker 声明兼容，link.exe 会合并。
    #[cfg(windows)]
    {
        let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
        let manifest = std::path::Path::new(&dir).join("tests.manifest");
        if manifest.is_file() {
            println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", manifest.display());
            println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        } else {
            println!("cargo:warning=缺少 tests.manifest，测试二进制可能无法启动（comctl32 v6 清单）");
        }
    }
}
