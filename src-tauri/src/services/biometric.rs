//! Windows Hello 生物识别（WinRT `UserConsentVerifier`）。
//!
//! 为什么不用 WebAuthn：本应用 webview 的源是 localhost / tauri.localhost，平台认证器会拒绝
//! （实测还导致 WebView2 崩溃 0xc0000409）。这里直接调系统 API，指纹 / 人脸 / PIN 都走
//! Windows Hello 已登记的凭据，与网页源无关。
//!
//! 语义：生物识别只作为**本机设备槽位的门闸**，不参与 KDF。验证成功后才允许解 device 槽位。
//! 非 Windows 平台返回 supported=false，由 UI 自然降级（不伪装可用）。

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BiometricAvailability {
    pub supported: bool,
    pub platform: String,
    pub detail: String,
}

#[cfg(windows)]
fn ensure_winrt() {
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
    // RPC_E_CHANGED_MODE（线程已按其它模型初始化）可直接继续
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
}

#[cfg(windows)]
pub fn availability() -> BiometricAvailability {
    use windows::Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability};
    ensure_winrt();
    match UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.join()) {
        Ok(state) if state == UserConsentVerifierAvailability::Available => BiometricAvailability {
            supported: true,
            platform: "windows-hello".to_string(),
            detail: "Windows Hello 可用（指纹 / 人脸 / PIN）".to_string(),
        },
        Ok(state) => {
            let reason = if state == UserConsentVerifierAvailability::DeviceNotPresent {
                "未检测到 Windows Hello 设备"
            } else if state == UserConsentVerifierAvailability::NotConfiguredForUser {
                "当前用户尚未在系统设置里注册 Windows Hello"
            } else if state == UserConsentVerifierAvailability::DisabledByPolicy {
                "Windows Hello 被策略禁用"
            } else if state == UserConsentVerifierAvailability::DeviceBusy {
                "Windows Hello 设备忙"
            } else {
                "Windows Hello 当前不可用"
            };
            BiometricAvailability {
                supported: false,
                platform: "windows-hello".to_string(),
                detail: reason.to_string(),
            }
        }
        Err(e) => BiometricAvailability {
            supported: false,
            platform: "windows-hello".to_string(),
            detail: format!("检查 Windows Hello 失败: {e}"),
        },
    }
}

#[cfg(windows)]
pub fn request_verification(reason: &str) -> Result<bool, String> {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};
    ensure_winrt();
    let op = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(reason))
        .map_err(|e| format!("发起 Windows Hello 验证失败: {e}"))?;
    let result = op.join().map_err(|e| format!("Windows Hello 验证未完成: {e}"))?;
    Ok(result == UserConsentVerificationResult::Verified)
}

#[cfg(not(windows))]
pub fn availability() -> BiometricAvailability {
    BiometricAvailability {
        supported: false,
        platform: std::env::consts::OS.to_string(),
        detail: "当前平台尚未接入生物识别（Windows 走 Windows Hello；其它平台需单独实现）".to_string(),
    }
}

#[cfg(not(windows))]
pub fn request_verification(_reason: &str) -> Result<bool, String> {
    Err("当前平台尚未接入生物识别".to_string())
}
