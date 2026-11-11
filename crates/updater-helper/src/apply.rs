use std::fs;
use std::path::PathBuf;
use std::process::Command;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::paths;
use crate::user;

#[derive(Debug, Deserialize)]
struct UpdateRequest {
    version: String,
    installer: String,
    sha256: String,
    signature: String,
    pid: Option<u32>,
}

pub fn run(pubkey_b64: &str) -> Result<(), String> {
    // 先记住原应用 PID：即使校验失败提前返回，也要等它退出后再拉起，
    // 否则单实例互斥会把“重启”顶回正在退出的旧进程。
    let app_pid = read_request_pid();
    let result = run_inner(pubkey_b64);
    // 应用已被更新流程退出；无论安装成功还是失败都把应用拉回来，
    // 失败时用户至少还能用旧版本，而不是面对“更新后应用没回来”。
    if let Some(pid) = app_pid {
        wait_for_process(pid, 15_000);
    } else {
        // 没有 PID（请求损坏）时给应用硬退出兜底留足时间。
        std::thread::sleep(std::time::Duration::from_secs(6));
    }
    if let Some(dir) = paths::install_dir() {
        let exe = paths::main_exe(&dir);
        if let Err(e) = user::launch_as_user(&exe, &dir) {
            paths::log(&format!("更新后重启应用失败: {e}"));
        }
    } else {
        paths::log("未能从注册表读取安装目录，需用户手动启动应用");
    }
    result
}

fn read_request_pid() -> Option<u32> {
    let raw = fs::read_to_string(paths::request_file()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("pid")
        .and_then(|item| item.as_u64())
        .map(|pid| pid as u32)
}

fn fail(version: &str, message: impl Into<String>) -> String {
    let message = message.into();
    paths::write_status("failed", version, Some(&message));
    paths::log(&format!("更新失败: {message}"));
    message
}

fn run_inner(pubkey_b64: &str) -> Result<(), String> {
    let request_path = paths::request_file();
    let raw = fs::read_to_string(&request_path).map_err(|e| {
        fail(
            "",
            format!("读取更新请求失败 {}: {e}", request_path.display()),
        )
    })?;
    let request: UpdateRequest = serde_json::from_str(&raw)
        .map_err(|e| fail("", format!("解析更新请求失败: {e}")))?;

    let installer = PathBuf::from(&request.installer);
    let staging = fs::canonicalize(paths::staging_dir())
        .map_err(|e| fail(&request.version, format!("定位 staging 目录失败: {e}")))?;
    let installer_real = fs::canonicalize(&installer)
        .map_err(|e| fail(&request.version, format!("定位安装包失败: {e}")))?;
    if installer_real.parent() != Some(staging.as_path()) {
        return Err(fail(
            &request.version,
            format!(
                "安装包不在 staging 目录内，拒绝执行: {}",
                installer_real.display()
            ),
        ));
    }

    let bytes = fs::read(&installer_real)
        .map_err(|e| fail(&request.version, format!("读取安装包失败: {e}")))?;
    let digest = sha256_hex(&bytes);
    if !digest.eq_ignore_ascii_case(request.sha256.trim()) {
        return Err(fail(&request.version, "安装包 SHA-256 不匹配"));
    }
    verify_signature(&bytes, &request.signature, pubkey_b64, &request.version)
        .map_err(|e| fail(&request.version, e))?;

    let target_version = semver::Version::parse(request.version.trim())
        .map_err(|e| fail(&request.version, format!("目标版本号无效: {e}")))?;
    if let Some(current) = paths::installed_version() {
        if let Ok(current) = semver::Version::parse(current.trim()) {
            if target_version <= current {
                return Err(fail(
                    &request.version,
                    format!("拒绝降级或重复安装：当前 {current}，目标 {target_version}"),
                ));
            }
        }
    }

    // 校验通过后复制到受保护目录，避免校验与执行之间被替换。
    let verified_dir = paths::verified_dir().join(
        chrono::Local::now()
            .format("%Y%m%d-%H%M%S")
            .to_string(),
    );
    fs::create_dir_all(&verified_dir)
        .map_err(|e| fail(&request.version, format!("创建校验目录失败: {e}")))?;
    let setup = verified_dir.join("setup.exe");
    fs::copy(&installer_real, &setup)
        .map_err(|e| fail(&request.version, format!("复制安装包失败: {e}")))?;
    let copied = fs::read(&setup)
        .map_err(|e| fail(&request.version, format!("读取校验副本失败: {e}")))?;
    if sha256_hex(&copied) != digest {
        return Err(fail(&request.version, "校验副本 SHA-256 不匹配"));
    }
    verify_signature(&copied, &request.signature, pubkey_b64, &request.version)
        .map_err(|e| fail(&request.version, e))?;

    paths::write_status("installing", &request.version, None);
    paths::log(&format!(
        "开始安装更新 {}，安装包 {}",
        request.version,
        setup.display()
    ));

    // 应用触发任务后还有约 1.5s 的退场时间；先等它真正退出，避免安装器 Restart Manager 强杀。
    if let Some(pid) = request.pid {
        wait_for_process(pid, 15_000);
    } else {
        std::thread::sleep(std::time::Duration::from_secs(2));
    }

    let install_result = run_installer_with_timeout(
        &setup,
        std::time::Duration::from_secs(10 * 60),
    );

    let _ = fs::remove_file(&installer_real);
    let _ = fs::remove_file(&request_path);
    let _ = fs::remove_file(&setup);

    match install_result {
        Ok(status) if status.success() => {
            paths::write_status("success", &request.version, None);
            paths::log(&format!("更新 {} 安装成功", request.version));
            Ok(())
        }
        Ok(status) => Err(fail(
            &request.version,
            format!("安装器退出码 {:?}", status.code()),
        )),
        Err(e) => Err(fail(&request.version, e)),
    }
}

/// 安装器超时兜底：超时后连带子进程一起结束，避免 helper 永远等下去。
fn run_installer_with_timeout(
    setup: &std::path::Path,
    timeout: std::time::Duration,
) -> Result<std::process::ExitStatus, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut child = Command::new(setup)
        .args(["/UPDATE", "/S"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("启动安装器失败: {e}"))?;
    let pid = child.id();
    let started = std::time::Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(e) => return Err(format!("等待安装器结束失败: {e}")),
        }
        if started.elapsed() > timeout {
            paths::log(&format!(
                "安装超时（{} 秒），终止安装器进程树 PID {pid}",
                timeout.as_secs()
            ));
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
            let _ = child.kill();
            let _ = child.wait();
            return Err("安装超时，已终止安装器；应用会尝试重新启动".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn wait_for_process(pid: u32, timeout_ms: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else {
            return;
        };
        let _ = WaitForSingleObject(handle, timeout_ms);
        let _ = CloseHandle(handle);
    }
}

fn base64_to_string(value: &str) -> Result<String, String> {
    let decoded = BASE64
        .decode(value.trim())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    String::from_utf8(decoded).map_err(|e| format!("签名/公钥不是 UTF-8: {e}"))
}

fn verify_signature(
    data: &[u8],
    signature_b64: &str,
    pubkey_b64: &str,
    announced_version: &str,
) -> Result<(), String> {
    if pubkey_b64.trim().is_empty() || pubkey_b64.contains("PLACEHOLDER") {
        return Err("更新公钥未配置".into());
    }
    let pubkey_text = base64_to_string(pubkey_b64)?;
    let public_key = minisign_verify::PublicKey::decode(&pubkey_text)
        .map_err(|e| format!("解析更新公钥失败: {e}"))?;
    let signature_text = base64_to_string(signature_b64)?;
    let signature = minisign_verify::Signature::decode(&signature_text)
        .map_err(|e| format!("解析更新签名失败: {e}"))?;
    public_key
        .verify(data, &signature, true)
        .map_err(|e| format!("更新签名校验失败: {e}"))?;

    if let Some(signed_version) = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
    {
        if signed_version.trim() != announced_version.trim() {
            return Err(format!(
                "签名版本 {} 与目标版本 {} 不一致",
                signed_version.trim(),
                announced_version.trim()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 由本项目更新密钥签名的固定测试向量；签名/公钥都不是秘密，可随源码入库。
    const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSZlNmbXZZeTBhYnh2L3pLa2xHUG9oS3d0REFiZSt1SE1XZ2p4NzZhLzE1Nzh0TlBVc05PenBKUElob3RYS0U1OTAxQlBmSHp6UzdkSTErZm5pTWFrdmRBSHQxT25BdEFRPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MzExMjMxCWZpbGU6cGF5bG9hZC50eHQKbmpDNnhXWmpqNDVsNkY4SGloZG9JRE95aDJIV1FnYnNrclREeTQ3OGMzWC9iYy9IMlU2Y09qVEJVN2pTeUpoLysvMHRlUjJyQVdPMzg3VHRuL242Q1E9PQo=";

    #[test]
    fn verifies_tauri_signature() {
        let data = b"andeyunhui-updater-test\n";
        verify_signature(data, SIG, include_str!("pubkey.txt").trim(), "0.1.0")
            .expect("项目公钥应能校验该项目签名");
    }

    #[test]
    fn rejects_modified_payload() {
        let data = b"andeyunhui-updater-test!\n";
        assert!(verify_signature(data, SIG, include_str!("pubkey.txt").trim(), "0.1.0").is_err());
    }
}
