//! 集成测试入口（2026-10-21）。
//!
//! 存在的唯一目的：让 cargo 认为本包**有 test 目标**，从而 `build.rs` 里的
//! `cargo:rustc-link-arg-tests` 生效（它只作用于 test 目标）。lib 的单元测试二进制
//! 需要那条清单才能启动（见 build.rs 注释：comctl32 v6）。
#[test]
fn crate_links() {
    // 能编译能链接就算过；真正的断言都在 lib 的单元测试里。
    assert_eq!(2 + 2, 4);
}
