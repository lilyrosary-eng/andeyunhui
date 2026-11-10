//! 凭据引用桥：让其他模块的敏感字段以 `vault:<itemId>` 引用密码库条目，而不是复制明文。
//!
//! 约定：
//!  - 引用值本身不是机密（只是条目 id），可以明文落在各模块配置里；
//!  - 只在**真正使用**时解析（请求前），因此不做任何迁移、不删除既有密文；
//!  - 密码库未解锁/条目不存在时返回明确错误，绝不把 `vault:` 指针当作密钥发出去；
//!  - 目前接入 AI 供应商 api_key；音乐平台 cookie 等可复用同一套（在各自插件侧调用 vault_*）。

pub const PREFIX: &str = "vault:";

pub fn is_ref(value: &str) -> bool {
    value.starts_with(PREFIX)
}

pub fn ref_of(id: &str) -> String {
    format!("{PREFIX}{id}")
}

pub fn item_id(value: &str) -> Option<&str> {
    value.strip_prefix(PREFIX).map(str::trim).filter(|s| !s.is_empty())
}

/// 把引用解析成真实密钥；非引用原样返回。
pub fn resolve(app: &tauri::AppHandle, value: &str) -> Result<String, String> {
    if !is_ref(value) {
        return Ok(value.to_string());
    }
    let secret = resolve_with(value, |id| crate::services::vault_service::secret_by_id(app, id))?;
    if let Some(id) = item_id(value) {
        log::info!("[credential_ref] 已解析密码库引用条目 {}", id);
    }
    Ok(secret)
}

/// 可测试的解析内核：`get` 负责按条目 id 取密钥。
pub fn resolve_with(
    value: &str,
    get: impl FnOnce(&str) -> Result<String, String>,
) -> Result<String, String> {
    if !is_ref(value) {
        return Ok(value.to_string());
    }
    let id = item_id(value).ok_or_else(|| "密码库引用缺少条目 ID".to_string())?;
    get(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_for_plain_secret() {
        let r = resolve_with("sk-plain", |_| panic!("不应调用取密钥"));
        assert_eq!(r.unwrap(), "sk-plain");
    }

    #[test]
    fn resolves_ref_by_item_id() {
        let r = resolve_with("vault:abc-123", |id| Ok(format!("secret-of-{id}")));
        assert_eq!(r.unwrap(), "secret-of-abc-123");
    }

    #[test]
    fn rejects_empty_id_and_propagates_lookup_error() {
        assert!(resolve_with("vault:   ", |_| Ok("x".into())).is_err());
        assert_eq!(
            resolve_with("vault:gone", |_| Err("密码库已锁定".to_string())).unwrap_err(),
            "密码库已锁定"
        );
    }
}
