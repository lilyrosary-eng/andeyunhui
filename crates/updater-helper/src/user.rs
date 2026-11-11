use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::null_mut;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, LUID, STILL_ACTIVE};
use windows::Win32::Security::{
    AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES,
    SE_ASSIGNPRIMARYTOKEN_NAME, SE_INCREASE_QUOTA_NAME, SE_PRIVILEGE_ENABLED,
    TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::RemoteDesktop::{
    WTSEnumerateSessionsW, WTSFreeMemory, WTSGetActiveConsoleSessionId, WTSQueryUserToken, WTSActive,
    WTS_CURRENT_SERVER_HANDLE, WTS_SESSION_INFOW,
};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken,
    WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION,
    STARTUPINFOW,
};

/// 以当前活动桌面用户身份启动应用；helper 自身是 SYSTEM，不能直接 CreateProcess。
pub fn launch_as_user(exe: &Path, working_dir: &Path) -> Result<(), String> {
    if !exe.is_file() {
        return Err(format!("应用不存在: {}", exe.display()));
    }

    let mut token = find_user_token()?;
    let result = unsafe { spawn_with_token(&mut token, exe, working_dir) };
    unsafe {
        let _ = CloseHandle(token);
    }
    result
}

fn find_user_token() -> Result<HANDLE, String> {
    unsafe {
        let mut sessions: *mut WTS_SESSION_INFOW = null_mut();
        let mut count = 0u32;
        let enumerated = WTSEnumerateSessionsW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            0,
            1,
            &mut sessions,
            &mut count,
        );
        if enumerated.is_ok() && !sessions.is_null() {
            for index in 0..count as usize {
                let session = &*sessions.add(index);
                if session.State == WTSActive && session.SessionId != 0 {
                    let mut token = HANDLE::default();
                    if WTSQueryUserToken(session.SessionId, &mut token).is_ok()
                        && token != HANDLE::default()
                    {
                        WTSFreeMemory(sessions as *mut _);
                        return Ok(token);
                    }
                }
            }
            WTSFreeMemory(sessions as *mut _);
        }

        // 兜底：控制台会话
        let session_id = WTSGetActiveConsoleSessionId();
        if session_id != u32::MAX {
            let mut token = HANDLE::default();
            if WTSQueryUserToken(session_id, &mut token).is_ok() && token != HANDLE::default() {
                return Ok(token);
            }
        }
    }
    Err("找不到可用的交互式用户会话".into())
}

unsafe fn spawn_with_token(
    token: &mut HANDLE,
    exe: &Path,
    working_dir: &Path,
) -> Result<(), String> {
    let exe_w = to_wide(exe.as_os_str());
    let mut command_line = format!("\"{}\"", exe.display())
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<u16>>();
    let work_w = to_wide(working_dir.as_os_str());
    let mut desktop = "winsta0\\default\0".encode_utf16().collect::<Vec<u16>>();

    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        lpDesktop: PWSTR(desktop.as_mut_ptr()),
        ..Default::default()
    };
    let mut process_info = PROCESS_INFORMATION::default();

    // 不传用户环境块时子进程会继承 SYSTEM 的环境（APPDATA 指向 systemprofile），
    // 应用启动即退出；这里显式构造目标用户的环境。
    let mut env_block: *mut core::ffi::c_void = null_mut();
    let env_ready = CreateEnvironmentBlock(&mut env_block, Some(*token), false).is_ok();
    let creation_flags = if env_ready {
        CREATE_UNICODE_ENVIRONMENT
    } else {
        PROCESS_CREATION_FLAGS(0)
    };

    // CreateProcessWithTokenW 会在调用者会话（SYSTEM 的 Session 0）建进程，
    // GUI 应用会以 0xC0000142 启动失败；CreateProcessAsUser 按令牌所在会话创建。
    enable_privilege(SE_ASSIGNPRIMARYTOKEN_NAME);
    enable_privilege(SE_INCREASE_QUOTA_NAME);
    let result = CreateProcessAsUserW(
        Some(*token),
        PCWSTR(exe_w.as_ptr()),
        Some(PWSTR(command_line.as_mut_ptr())),
        None,
        None,
        false,
        creation_flags,
        if env_ready { Some(env_block) } else { None },
        PCWSTR(work_w.as_ptr()),
        &startup,
        &mut process_info,
    );
    if env_ready {
        let _ = DestroyEnvironmentBlock(env_block);
    }
    result.map_err(|e| format!("以用户身份启动应用失败: {e}"))?;

    // 启动即退出通常意味着环境/权限不对，留一条可诊断的记录。
    let _ = WaitForSingleObject(process_info.hProcess, 3000);
    let mut exit_code = 0u32;
    let alive = GetExitCodeProcess(process_info.hProcess, &mut exit_code).is_ok()
        && exit_code as i32 == STILL_ACTIVE.0;
    let _ = CloseHandle(process_info.hProcess);
    let _ = CloseHandle(process_info.hThread);
    if !alive {
        return Err(format!("应用启动后立即退出（退出码 {exit_code}）"));
    }
    Ok(())
}

/// 尽力启用本进程令牌上的特权；失败由后续 CreateProcessAsUser 报错兜底。
fn enable_privilege(name: PCWSTR) {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
        .is_err()
        {
            return;
        }
        let mut luid = LUID::default();
        if LookupPrivilegeValueW(PCWSTR::null(), name, &mut luid).is_ok() {
            let state = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                Privileges: [LUID_AND_ATTRIBUTES {
                    Luid: luid,
                    Attributes: SE_PRIVILEGE_ENABLED,
                }],
            };
            let _ = AdjustTokenPrivileges(token, false, Some(&state), 0, None, None);
        }
        let _ = CloseHandle(token);
    }
}

fn to_wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}
