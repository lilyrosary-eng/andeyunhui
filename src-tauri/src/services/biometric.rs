//! 系统生物识别（跨平台抽象）。
//!
//! 各平台走各自的系统级设施，不直接对接硬件 SDK：
//!  - Windows：WinRT `UserConsentVerifier`（Windows Hello：指纹 / 人脸 / 系统 PIN）。
//!    可执行文件版必须用 `RequestVerificationForWindowAsync(hwnd)`：无窗口版在桌面应用里
//!    可能抢不到前台，用户按指纹没反应（实机踩过）。
//!  - Linux：fprintd（D-Bus，`net.reactivated.Fprint`）——尚未接入，返回明确原因。
//!  - Android：BiometricPrompt——尚未接入，返回明确原因。
//!
//! 语义：生物识别只作为**本机设备槽位的门闸**，不参与 KDF；验证成功后才允许解 device 槽位。
//! 文案一律用「生物识别 / 系统生物识别」，不把平台名写死到 UI。

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BiometricAvailability {
    pub supported: bool,
    /// 后端标识（windows-hello / linux-fprintd / android-biometric / none），仅诊断用
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
            detail: "系统生物识别可用（指纹 / 人脸 / 系统 PIN）".to_string(),
        },
        Ok(state) => BiometricAvailability {
            supported: false,
            platform: "windows-hello".to_string(),
            detail: if state == UserConsentVerifierAvailability::DeviceNotPresent {
                "未检测到系统生物识别设备"
            } else if state == UserConsentVerifierAvailability::NotConfiguredForUser {
                "当前用户尚未在系统设置里注册生物识别"
            } else if state == UserConsentVerifierAvailability::DisabledByPolicy {
                "系统生物识别被策略禁用"
            } else if state == UserConsentVerifierAvailability::DeviceBusy {
                "系统生物识别设备忙"
            } else {
                "系统生物识别当前不可用"
            }
            .to_string(),
        },
        Err(e) => BiometricAvailability {
            supported: false,
            platform: "windows-hello".to_string(),
            detail: format!("检查系统生物识别失败: {e}"),
        },
    }
}

#[cfg(windows)]
fn verify_without_window(reason: &str) -> Result<bool, String> {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};
    ensure_winrt();
    let op = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(reason))
        .map_err(|e| format!("发起系统验证失败: {e}"))?;
    let result = op.join().map_err(|e| format!("系统验证未完成: {e}"))?;
    Ok(result == UserConsentVerificationResult::Verified)
}

/// `hwnd` 为主窗口句柄（0 表示取不到，回退到无窗口版）。调用前调用方应先让窗口到前台。
#[cfg(windows)]
pub fn verify(hwnd: isize, reason: &str) -> Result<bool, String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::{IUserConsentVerifierInterop, RoGetActivationFactory};
    use windows::Security::Credentials::UI::UserConsentVerificationResult;
    use windows_future::IAsyncOperation;

    ensure_winrt();
    if hwnd != 0 {
        let factory = unsafe {
            RoGetActivationFactory::<IUserConsentVerifierInterop>(&HSTRING::from(
                "Windows.Security.Credentials.UI.UserConsentVerifier",
            ))
        };
        if let Ok(factory) = factory {
            let op = unsafe {
                factory.RequestVerificationForWindowAsync::<IAsyncOperation<UserConsentVerificationResult>>(
                    HWND(hwnd as *mut core::ffi::c_void),
                    &HSTRING::from(reason),
                )
            };
            if let Ok(op) = op {
                let result = op.join().map_err(|e| format!("系统验证未完成: {e}"))?;
                return Ok(result == UserConsentVerificationResult::Verified);
            }
        }
    }
    verify_without_window(reason)
}

#[cfg(not(windows))]
pub fn availability() -> BiometricAvailability {
    BiometricAvailability {
        supported: false,
        platform: "none".to_string(),
        detail: if cfg!(target_os = "linux") {
            "当前平台尚未接入系统生物识别（Linux 计划走 fprintd / D-Bus）"
        } else if cfg!(target_os = "android") {
            "当前平台尚未接入系统生物识别（Android 计划走 BiometricPrompt）"
        } else {
            "当前平台尚未接入系统生物识别"
        }
        .to_string(),
    }
}

#[cfg(not(windows))]
pub fn verify(_hwnd: isize, _reason: &str) -> Result<bool, String> {
    Err("当前平台尚未接入系统生物识别".to_string())
}
