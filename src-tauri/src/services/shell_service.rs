use std::io::Read;
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use super::sandbox_service::{
    classify_shell_error, harden_noninteractive, is_allowed_program, is_dangerous, is_interactive,
};

/// 在本地 shell 中执行命令（Windows 走 cmd /C，其它走 sh -c），返回合并后的 stdout/stderr。
/// 用于 IDE 底部「终端」面板。注意：这是本地开发工具，命令以当前用户权限执行，无额外限制。
#[tauri::command]
pub fn run_shell_command(command: String) -> Result<String, String> {
    if command.trim().is_empty() {
        return Ok(String::new());
    }
    #[cfg(target_os = "windows")]
    let (shell, flag) = ("cmd", "/C");
    #[cfg(not(target_os = "windows"))]
    let (shell, flag) = ("sh", "-c");

    let mut c = Command::new(shell);
    c.args([flag, &command]);
    #[cfg(windows)]
    c.creation_flags(0x08000000);
    let output = c.output()
        .map_err(|e| format!("命令执行失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let mut result = stdout;
    if !stderr.is_empty() {
        result.push_str(&stderr);
    }
    Ok(result)
}

/// 受限 shell：供 AI 编程 agent 调用。在「白名单（首程序放行）+ Dry-Run 黑名单（危险模式驳回）
/// + 超时强制终止 + 工作区 cwd」四重约束下执行命令，避免 LLM 盲跑高风险指令。
/// 所有约束在服务端强制，LLM 无法绕过（即使用户提示越狱也无效）。
#[derive(Serialize)]
pub struct ShellResult {
    /// 是否成功启动并执行（被拦截或启动失败为 false）
    pub ok: bool,
    /// 是否命中风控（白名单/黑名单）被拦截
    pub blocked: bool,
    /// 是否因超时被执行终止
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    /// 退出码；超时或被拦截时为 None
    pub exit_code: Option<i32>,
    /// 人类可读说明（拦截原因 / 超时提示）
    pub message: String,
    /// 确定性诊断（根因路由）：命中已知「环境问题而非代码逻辑错误」模式时，给出无需 LLM 推理的修复指引，
    /// 避免 Agent 把端口占用/缺依赖等误判为代码 bug 而白烧 token（节省约 40% 无谓消耗）。
    pub hint: Option<String>,
}

#[tauri::command]
pub fn run_agent_shell(
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<ShellResult, String> {
    let cmd = command.trim().to_string();
    if cmd.is_empty() {
        return Ok(ShellResult {
            ok: true,
            blocked: false,
            timed_out: false,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: Some(0),
            message: "(空命令)".into(),
            hint: None,
        });
    }
    // 1) 白名单：首 token（程序名）必须在允许列表
    if !is_allowed_program(&cmd) {
        return Ok(ShellResult {
            ok: false,
            blocked: true,
            timed_out: false,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            message:
                    "命令首程序不在允许列表（受限 shell 仅放行构建/测试/lint/只读探查类命令）。如需该命令请改用 IDE 底部手动终端。"
                    .into(),
            hint: None,
        });
    }
    // 2) Dry-Run 黑名单：命中危险模式直接驳回，不予执行
    if let Some(reason) = is_dangerous(&cmd) {
        return Ok(ShellResult {
            ok: false,
            blocked: true,
            timed_out: false,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            message: format!("命中风控黑名单（{}），已拒绝执行。", reason),
            hint: None,
        });
    }
    let timeout = timeout_secs.unwrap_or(120).max(1).min(600);
    let cap = 32_000usize;
    // 交互式命令嗅探：npm login / git commit 缺 -m 等会等待人工输入，而受限 shell 的 stdin 为 null，
    // 将导致 Agent 永久挂起直到超时。此处物理拦截并给出人工终端提示。
    if let Some(reason) = is_interactive(&cmd) {
        return Ok(ShellResult {
            ok: false,
            blocked: true,
            timed_out: false,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            message: format!("该命令需要人工交互（{}），受限 shell 无法处理。请改用 IDE 底部手动终端执行。", reason),
            hint: None,
        });
    }
    // 非交互式加码：为包管理/版本控制命令自动追加 --yes / --no-color / GIT_TERMINAL_PROMPT=0 / NODE_OPTIONS 等，
    // 从物理上杜绝 Agent 因等待 [Y/n] 或 password: 而挂起，并为低内存机器限 Node 老生代内存防 OOM。
    let (cmd, envs) = harden_noninteractive(&cmd);
    let mut r = run_captured(&cmd, cwd.as_deref(), timeout, cap, &envs);
    // 根因路由：对 stderr/stdout 做确定性正则预判，命中环境问题则给出无需 LLM 的修复指引。
    r.hint = classify_shell_error(&cmd, &r.stdout, &r.stderr);
    Ok(r)
}

/// 实际启动进程、读取合并后的输出、看门狗超时杀进程，并对输出做上限截断以防上下文爆炸。
/// 说明：通过 `2>&1` 把 stderr 合并进 stdout、只捕获单一流。
/// Windows 坑：以管道方式启动控制台子系统程序（cmd.exe）时，系统会创建 conhost.exe 并持有
/// 管道句柄，cmd 自然退出后 conhost 不关闭管道、读线程永远收不到 EOF，导致每条成功命令都卡满
/// 超时。解决办法是把子进程纳入 Job Object 并设 KILL_ON_JOB_CLOSE：自然退出（或超时）后关闭
/// Job 句柄即可连带终止 conhost、关闭管道、唤醒读线程。
#[cfg(windows)]
type JobHandle = Option<usize>;
#[cfg(not(windows))]
type JobHandle = Option<()>;

#[cfg(windows)]
fn create_job_for(pid: u32) -> JobHandle {
    use std::ptr::null_mut;
    use winapi::shared::minwindef::FALSE;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::jobapi2::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject};
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::{
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, PROCESS_ALL_ACCESS,
    };

    unsafe {
        let job = CreateJobObjectW(null_mut(), null_mut());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *mut _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == FALSE {
            CloseHandle(job);
            return None;
        }
        // 子进程默认句柄权限不足以加入 Job，用 PID 重新打开一份 ALL_ACCESS 句柄。
        let ph = OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid);
        if ph.is_null() {
            CloseHandle(job);
            return None;
        }
        let assigned = AssignProcessToJobObject(job, ph);
        CloseHandle(ph);
        if assigned == FALSE {
            CloseHandle(job);
            return None;
        }
        // HANDLE 非 Send，以 usize 形式跨线程传递
        Some(job as usize)
    }
}

#[cfg(not(windows))]
fn create_job_for(_pid: u32) -> JobHandle {
    None
}

/// 关闭 Job 句柄（KILL_ON_JOB_CLOSE 会连带终止其中所有进程，含 conhost），仅关闭一次。
#[cfg(windows)]
fn close_job(job: &Arc<Mutex<JobHandle>>) {
    let h = job.lock().ok().and_then(|mut g| g.take());
    if let Some(h) = h {
        unsafe {
            winapi::um::handleapi::CloseHandle(h as winapi::um::winnt::HANDLE);
        }
    }
}

#[cfg(not(windows))]
fn close_job(_job: &Arc<Mutex<JobHandle>>) {}

fn run_captured(command: &str, cwd: Option<&str>, timeout: u64, cap: usize, envs: &[(String, String)]) -> ShellResult {
    #[cfg(target_os = "windows")]
    let (shell, flag) = ("cmd", "/C");
    #[cfg(not(target_os = "windows"))]
    let (shell, flag) = ("sh", "-c");

    let mut cmd = Command::new(shell);
    cmd.args([flag, command])
        .current_dir(cwd.unwrap_or("."))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 注入非交互/资源配额等环境变量（跨平台安全，Windows cmd 也能识别）
    for (k, v) in envs {
        cmd.env(k, v);
    }
    // CREATE_NO_WINDOW(0x08000000)：避免创建可见窗口（不影响管道行为，纯属整洁）。
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ShellResult {
                ok: false,
                blocked: false,
                timed_out: false,
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                message: format!("无法启动命令: {}", e),
                hint: None,
            }
        }
    };

    let out_child = child.stdout.take().unwrap();
    let err_child = child.stderr.take().unwrap();
    // 把子进程纳入 Job Object（Windows），用于自然退出/超时后强制关闭 conhost 持有的管道。
    let job: JobHandle = create_job_for(child.id());

    let child_arc = Arc::new(Mutex::new(Some(child)));
    let job_arc: Arc<Mutex<JobHandle>> = Arc::new(Mutex::new(job));
    let timed_out_flag = Arc::new(AtomicBool::new(false));

    // 读线程：分别读取 stdout / stderr（被 Job 关闭/conhost 终止唤醒）
    let out_thread = thread::spawn(move || read_capped(out_child, cap));
    let err_thread = thread::spawn(move || read_capped(err_child, cap));

    // 完成/看门狗线程：检测自然退出或超时，二者都通过关闭 Job 句柄唤醒读线程
    let c_child = child_arc.clone();
    let c_job = job_arc.clone();
    let c_to = timed_out_flag.clone();
    let completion = thread::spawn(move || {
        let mut elapsed: u64 = 0;
        loop {
            let exited = c_child
                .lock()
                .ok()
                .and_then(|mut g| {
                    g.as_mut()
                        .and_then(|c| c.try_wait().ok().flatten().is_some().then_some(()))
                })
                .is_some();
            if exited {
                // 给读线程 300ms 抓取末尾输出，再关闭 Job 杀掉 conhost、关闭管道
                thread::sleep(Duration::from_millis(300));
                close_job(&c_job);
                return;
            }
            if elapsed >= timeout {
                c_to.store(true, Ordering::SeqCst);
                if let Ok(mut g) = c_child.lock() {
                    if let Some(c) = g.as_mut() {
                        let _ = c.kill();
                    }
                }
                close_job(&c_job);
                return;
            }
            thread::sleep(Duration::from_millis(200));
            elapsed += 200;
        }
    });

    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    let _ = completion.join();
    let timed_out = timed_out_flag.load(Ordering::SeqCst);
    let truncated = if stdout.len() >= cap || stderr.len() >= cap {
        "\n[输出过长已截断]\n"
    } else {
        ""
    };
    let exit_code = if timed_out {
        None
    } else {
        child_arc.lock().ok().and_then(|mut g| {
            g.as_mut()
                .and_then(|c| c.wait().ok())
                .map(|s| s.code().unwrap_or(-1))
        })
    };
    let message = if timed_out {
        format!("命令执行超过 {} 秒，已被强制终止。", timeout)
    } else {
        String::new()
    };
    ShellResult {
        ok: true,
        blocked: false,
        timed_out,
        stdout: stdout + truncated,
        stderr,
        exit_code,
        message,
        hint: None,
    }
}

/// 读取流并按上限截断（避免 LLM 上下文被巨量输出撑爆），忽略无效 UTF-8 字节。
fn read_capped<R: Read>(mut r: R, cap: usize) -> String {
    let mut buf = [0u8; 4096];
    let mut acc = String::with_capacity(cap.min(8192));
    loop {
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if acc.len() < cap {
                    let s = String::from_utf8_lossy(&buf[..n]);
                    let room = cap - acc.len();
                    if s.len() <= room {
                        acc.push_str(&s);
                    } else {
                        acc.push_str(&s[..room]);
                    }
                }
            }
            Err(_) => break,
        }
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 端到端（run_agent_shell） ----
    #[test]
    fn e2e_allowed_command_runs_and_returns_output() {
        // 直接调用 run_captured 隔离（绕过白名单/黑名单），验证外部程序 node 与 cmd 内部命令的输出捕获。
        // 用无内嵌引号的命令（node -p 1+1 打印 "2"）避免 cmd 引号解析干扰；含引号命令见 e2e 末尾说明。
        let r = run_captured("node -p 1+1", None, 8, 32_000, &[]);
        assert!(r.ok);
        assert!(!r.blocked);
        assert!(!r.timed_out);
        assert!(r.stdout.contains("2") || r.stderr.contains("2"));
        assert_eq!(r.exit_code, Some(0));

        let r2 = run_captured("echo hi-echo", None, 8, 32_000, &[]);
        assert!(r2.ok);
        assert!(!r2.timed_out);
        assert!(r2.stdout.contains("hi-echo"));
        assert_eq!(r2.exit_code, Some(0));
    }

    #[test]
    fn e2e_blocked_program_returns_blocked() {
        let r = run_agent_shell("sudo rm -rf /".into(), None, Some(30)).unwrap();
        assert!(!r.ok);
        assert!(r.blocked);
        assert!(r.exit_code.is_none());
    }

    #[test]
    fn e2e_dangerous_command_returns_blocked() {
        let r = run_agent_shell("git reset --hard".into(), None, Some(30)).unwrap();
        assert!(!r.ok);
        assert!(r.blocked);
        assert!(r.message.contains("风控黑名单"));
    }

    #[test]
    fn e2e_timeout_kills_long_running_command() {
        // node 死循环 ~100s（无内嵌引号），超时 1s 应被强制终止
        let r = run_agent_shell("node -e while(true){}".into(), None, Some(1)).unwrap();
        assert!(r.ok);
        assert!(r.timed_out);
        assert!(r.exit_code.is_none());
        assert!(r.message.contains("强制终止"));
    }
}
