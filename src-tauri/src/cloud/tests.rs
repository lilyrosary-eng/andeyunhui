//! 云就绪 stub 最小单测基线（T3 验收要求）。
//!
//! 覆盖三个 trait 的 local-only 默认实现核心契约：
//! - `AccountProvider::sign_in` 返回 `Unsupported`；
//! - `backend_kind` 恒为 `Local`；
//! - `CloudSync::pull` / `push` 返回空 Delta；
//! - `RemoteStorage`（LocalBackend）读写 / 列举 / 删除本地落盘工作正常。

use super::account::{self, AccountProvider};
use super::local;
use super::storage::{self, RemoteStorage};
use super::sync::{self, CloudSync};
use super::{BackendKind, CloudError};

#[test]
fn local_account_sign_in_unsupported() {
    let a = account::LocalAccountProvider::new();
    let r = a.sign_in("google", "token");
    assert!(
        matches!(r, Err(CloudError::Unsupported(_))),
        "sign_in 在 v1 应返回 Unsupported"
    );
}

#[test]
fn local_account_backend_is_local_and_localonly() {
    let a = account::LocalAccountProvider::new();
    assert_eq!(a.backend_kind(), BackendKind::Local);
    assert_eq!(a.status(), account::AccountStatus::LocalOnly);
    let info = a.current();
    assert_eq!(info.status, account::AccountStatus::LocalOnly);
}

#[test]
fn local_storage_backend_is_local_and_roundtrip() {
    let root = std::env::temp_dir().join("andeyun_test_cloud_suite");
    let _ = std::fs::remove_dir_all(&root);
    let s = storage::LocalBackend::new(root.clone());
    assert_eq!(s.backend_kind(), BackendKind::Local);

    // write / read 往返
    s.write("notes/n1.md", b"hello").unwrap();
    assert_eq!(s.read("notes/n1.md").unwrap(), b"hello");

    // list 应能看到写入的对象
    let list = s.list("notes/").unwrap();
    assert!(list
        .iter()
        .any(|m| m.key == "notes/n1.md" && m.size == 5));

    // delete
    s.delete("notes/n1.md").unwrap();
    assert!(s.read("notes/n1.md").is_err());

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn local_sync_pull_and_push_empty_delta() {
    let s = sync::LocalSync;
    assert_eq!(s.backend_kind(), BackendKind::Local);
    let d = s.pull().unwrap();
    assert!(d.added.is_empty() && d.updated.is_empty() && d.removed.is_empty());
    let d2 = s.push(&["a".into(), "b".into()]).unwrap();
    assert!(d2.added.is_empty() && d2.updated.is_empty() && d2.removed.is_empty());
}

#[test]
fn local_sync_configure_unsupported() {
    let mut s = sync::LocalSync;
    let r = s.configure(sync::SyncTarget::SelfHosted {
        url: "https://example.test".into(),
    });
    assert!(
        matches!(r, Err(CloudError::Unsupported(_))),
        "configure 在 v1 应返回 Unsupported"
    );
}

#[test]
fn local_cloud_context_default_and_new() {
    let ctx = local::LocalCloudContext::default();
    assert_eq!(ctx.account.backend_kind(), BackendKind::Local);
    assert_eq!(ctx.storage.backend_kind(), BackendKind::Local);
    assert_eq!(ctx.sync.backend_kind(), BackendKind::Local);

    let ctx2 = local::LocalCloudContext::new(std::env::temp_dir().join("andeyun_ctx"));
    assert_eq!(
        ctx2.account_info().status,
        account::AccountStatus::LocalOnly
    );
}
