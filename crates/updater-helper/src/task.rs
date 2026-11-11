use std::fs;
use std::path::Path;

use windows::core::{BSTR, GUID};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::TaskScheduler::{ITaskFolder, ITaskService};
use windows::Win32::System::Variant::VARIANT;

use crate::paths;

pub const TASK_NAME: &str = "AndeYunhuiUpdateHelper";
/// Task Scheduler 2.0 的 CLSID（ITaskService）。
/// windows crate 只导出了旧版 Task Scheduler 1.0 的 CLSID_CTaskScheduler，
/// 用它会得到 E_NOINTERFACE（0x80004002），所以这里手动定义 2.0 的 GUID。
const CLSID_TASK_SCHEDULER: GUID = GUID::from_u128(0x0f87369f_a4e5_4cfc_bd3e_73e6154572dd);
// 与系统自带任务同风格：管理员/SYSTEM 全权，Authenticated Users 可读+运行（FRFX）。
const TASK_SDDL: &str = "D:(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;;FRFX;;;AU)";
const HELPER_PREFIX: &str = "andeyunhui-updater-";

pub fn install() -> Result<(), String> {
    let helper = std::env::current_exe().map_err(|e| format!("读取当前 helper 路径失败: {e}"))?;
    let helper = fs::canonicalize(&helper).unwrap_or(helper);
    paths::ensure_dirs()?;
    paths::set_secure_acls()?;
    cleanup_old_helpers(&helper);

    let xml = task_xml(&helper);
    let xml_path = std::env::temp_dir().join(format!(
        "andeyunhui-update-task-{}.xml",
        std::process::id()
    ));
    write_utf16le_bom(&xml_path, &xml)?;

    let result = paths::run_hidden(
        "schtasks",
        &[
            std::ffi::OsStr::new("/create"),
            std::ffi::OsStr::new("/tn"),
            std::ffi::OsStr::new(TASK_NAME),
            std::ffi::OsStr::new("/xml"),
            xml_path.as_os_str(),
            std::ffi::OsStr::new("/f"),
        ],
    );
    let _ = fs::remove_file(&xml_path);
    result?;

    if let Err(e) = set_task_security() {
        // 没有 AU 的运行权限，应用无法触发任务；任务装了也没用，必须让安装器看到失败。
        return Err(format!("设置计划任务 ACL 失败: {e}"));
    }
    paths::log(&format!(
        "更新助手任务已安装: {} -> {}",
        TASK_NAME,
        helper.display()
    ));
    // 不再改 status.json：安装器中以 --install-task 运行时会把 apply 刚写下的
    // 成功状态覆盖成 "installed"，导致重启后看不到「已更新到 vX」提示。
    Ok(())
}

pub fn uninstall() -> Result<(), String> {
    let result = paths::run_hidden(
        "schtasks",
        &[
            std::ffi::OsStr::new("/delete"),
            std::ffi::OsStr::new("/tn"),
            std::ffi::OsStr::new(TASK_NAME),
            std::ffi::OsStr::new("/f"),
        ],
    );
    let _ = fs::remove_dir_all(paths::staging_dir());
    let _ = fs::remove_dir_all(paths::verified_dir());
    let _ = fs::remove_file(paths::status_file());
    match result {
        Ok(()) => {
            paths::log("更新助手任务已注销");
            Ok(())
        }
        Err(e) => {
            paths::log(&format!("注销更新助手任务失败（可能尚未安装）: {e}"));
            Ok(())
        }
    }
}

fn cleanup_old_helpers(current: &Path) {
    let Some(dir) = current.parent() else {
        return;
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(HELPER_PREFIX)
            && name.ends_with(".exe")
            && path != current
        {
            // 正在运行的旧 helper 会删除失败，忽略即可，下次更新再清。
            let _ = fs::remove_file(&path);
        }
    }
}

fn task_xml(helper: &Path) -> String {
    let command = xml_escape(&helper.to_string_lossy());
    let working_dir = xml_escape(
        &helper
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_string_lossy(),
    );
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>安得云荟 Windows 静默更新助手</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>--apply</Arguments>
      <WorkingDirectory>{working_dir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"#
    )
}

fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn write_utf16le_bom(path: &Path, text: &str) -> Result<(), String> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(path, bytes).map_err(|e| format!("写入任务 XML 失败: {e}"))
}

fn set_task_security() -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let service: ITaskService = CoCreateInstance(&CLSID_TASK_SCHEDULER, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("创建 TaskScheduler 失败: {e}"))?;
        let empty = VARIANT::default();
        service
            .Connect(&empty, &empty, &empty, &empty)
            .map_err(|e| format!("连接 TaskScheduler 失败: {e}"))?;
        let root: ITaskFolder = service
            .GetFolder(&BSTR::from("\\"))
            .map_err(|e| format!("打开任务根目录失败: {e}"))?;
        let task = root
            .GetTask(&BSTR::from(TASK_NAME))
            .map_err(|e| format!("读取任务 {TASK_NAME} 失败: {e}"))?;
        task.SetSecurityDescriptor(&BSTR::from(TASK_SDDL), 0)
            .map_err(|e| format!("设置任务 ACL 失败: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_xml_contains_helper_action_and_system_principal() {
        let xml = task_xml(Path::new(
            r"C:\Program Files\AndeYunhuiUpdater\andeyunhui-updater-2.4.3.exe",
        ));
        assert!(xml.contains(r"C:\Program Files\AndeYunhuiUpdater\andeyunhui-updater-2.4.3.exe"));
        assert!(xml.contains("<Arguments>--apply</Arguments>"));
        assert!(xml.contains("<UserId>S-1-5-18</UserId>"));
        assert!(!xml.contains("LogonType"));
    }
}
