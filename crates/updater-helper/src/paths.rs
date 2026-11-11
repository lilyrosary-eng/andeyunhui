use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
use winreg::RegKey;

const APP_DISPLAY_NAME: &str = "andeyunhui";
const LEGACY_APP_DISPLAY_NAME: &str = "安得云荟";
const MAIN_EXE: &str = "andeyunhui.exe";

pub fn program_data_dir() -> PathBuf {
    std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join("AndeYunhuiUpdater")
}

pub fn staging_dir() -> PathBuf {
    program_data_dir().join("staging")
}

pub fn verified_dir() -> PathBuf {
    program_data_dir().join("verified")
}

pub fn logs_dir() -> PathBuf {
    program_data_dir().join("logs")
}

pub fn log_file() -> PathBuf {
    logs_dir().join("updater.log")
}

pub fn request_file() -> PathBuf {
    staging_dir().join("request.json")
}

pub fn status_file() -> PathBuf {
    program_data_dir().join("status.json")
}

pub fn ensure_dirs() -> Result<(), String> {
    for dir in [program_data_dir(), staging_dir(), verified_dir(), logs_dir()] {
        fs::create_dir_all(&dir).map_err(|e| format!("创建目录 {} 失败: {e}", dir.display()))?;
    }
    Ok(())
}

pub fn log(message: &str) {
    let line = format!(
        "[{}] {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        message
    );
    eprintln!("{}", line.trim_end());
    if ensure_dirs().is_err() {
        return;
    }
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file())
    {
        let _ = file.write_all(line.as_bytes());
    }
}

pub fn write_status(status: &str, version: &str, error: Option<&str>) {
    if ensure_dirs().is_err() {
        return;
    }
    let payload = serde_json::json!({
        "status": status,
        "version": version,
        "error": error,
        "timestamp": chrono::Local::now().timestamp(),
    });
    let _ = fs::write(
        status_file(),
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    );
}

fn decode_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

/// 安装目录以卸载注册表为准，避免请求文件里伪造路径。
pub fn install_dir() -> Option<PathBuf> {
    find_uninstall_key().and_then(|key| {
        key.get_value::<String, _>("InstallLocation")
            .ok()
            .and_then(|raw| decode_path(&raw))
    })
}

/// 当前已安装版本（DisplayVersion）；用于 helper 拒绝降级。
pub fn installed_version() -> Option<String> {
    find_uninstall_key().and_then(|key| key.get_value::<String, _>("DisplayVersion").ok())
}

fn find_uninstall_key() -> Option<RegKey> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let uninstall = hklm
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .ok()?;
    // 新旧产品名可能共存：优先精确匹配当前产品名，避免更新后重启到旧装目录。
    let mut legacy: Option<RegKey> = None;
    for name in uninstall.enum_keys().flatten() {
        let Ok(key) = uninstall.open_subkey_with_flags(&name, KEY_READ) else {
            continue;
        };
        let display: String = key.get_value("DisplayName").unwrap_or_default();
        if display.eq_ignore_ascii_case(APP_DISPLAY_NAME) {
            return Some(key);
        }
        if legacy.is_none() && display.contains(LEGACY_APP_DISPLAY_NAME) {
            legacy = Some(key);
        }
    }
    legacy
}

pub fn main_exe(install_dir: &Path) -> PathBuf {
    install_dir.join(MAIN_EXE)
}

/// 根目录只读、staging 允许当前登录用户写入；用 SID 避免中英文系统本地化差异。
pub fn set_secure_acls() -> Result<(), String> {
    let root = program_data_dir();
    let staging = staging_dir();
    ensure_dirs()?;

    run_hidden(
        "icacls",
        &[
            root.as_os_str(),
            std::ffi::OsStr::new("/inheritance:r"),
        ],
    )?;
    run_hidden(
        "icacls",
        &[
            root.as_os_str(),
            std::ffi::OsStr::new("/grant:r"),
            std::ffi::OsStr::new("*S-1-5-18:(OI)(CI)F"),
            std::ffi::OsStr::new("*S-1-5-32-544:(OI)(CI)F"),
            std::ffi::OsStr::new("*S-1-5-11:(OI)(CI)RX"),
        ],
    )?;
    // staging 需要普通用户可写：下载安装包与写请求文件都在这里。
    run_hidden(
        "icacls",
        &[
            staging.as_os_str(),
            std::ffi::OsStr::new("/grant:r"),
            std::ffi::OsStr::new("*S-1-5-11:(OI)(CI)M"),
        ],
    )?;
    Ok(())
}

pub fn run_hidden(program: &str, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("执行 {program} 失败: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{program} 失败 (exit {:?}): {}{}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}
