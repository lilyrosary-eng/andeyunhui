//! Wayland 录屏后端：xdg-desktop-portal `ScreenCast` + PipeWire + gstreamer。
//!
//! # 为什么必须是 portal
//! 实测（2026-10-28，GNOME Shell 50.1 / Wayland）：
//! - `org.gnome.Shell.ScreenRecorder` 已被 GNOME **整个移除**（`name was not provided by any .service`）；
//! - `org.gnome.Shell.Screenshot` 对外 `Access denied`；
//! - GNOME 自带的录屏（Ctrl+Alt+Shift+R）是 shell 内部实现，**没有任何对外接口**。
//!
//! ⇒ 应用要录屏只有一条路：portal 的 `ScreenCast`。它给我们两样东西：
//!   ① 一个 PipeWire **node id**；② 一个指向私有 PipeWire remote 的 **fd**。
//!   谁把流写成文件？**必须是我们**（这里起 `gst-launch-1.0` 子进程）。
//!
//! # 与截图的关键差别：session 绑定在「发起调用的那条 D-Bus 连接」上
//! 用 `busctl` 一条条调是**不可能**跑通的：CreateSession 返回后 busctl 退出 ⇒ 连接断开
//! ⇒ session 立刻被销毁 ⇒ 后续 SelectSources/Start 全部 `Access denied`（不是权限问题）。
//! 而且 `session_handle_token` **必须给**，否则 xdg-desktop-portal 会
//! `xdp-session.c:300: assertion failed` 直接 SIGABRT（我用 busctl 试过一次，把服务打崩了）。
//! ⇒ 所以这三步必须在**同一个进程、同一条连接**里跑完，连接要一直活到录制结束
//!   （见 `ACTIVE` 里的 `conn`）。
//!
//! # 授权弹窗
//! `SelectSources` 会弹 GNOME 自己的「共享屏幕」对话框（用户选整个屏幕 / 某个窗口）。
//! 这是**系统 UI**，不是我们要重写的东西 —— 与截图那条「调系统能力」的策略一致。
//! `persist_mode = 2`（永久）+ 回传 `restore_token` 可以让同一应用第二次不再弹，
//! 但 token 的持久化还没做（下一轮）。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

const DEST: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const IFACE: &str = "org.freedesktop.portal.ScreenCast";
const SESSION_IFACE: &str = "org.freedesktop.portal.Session";

/// `types` 位掩码：1 = 显示器，2 = 窗口，4 = 虚拟。
const SOURCE_MONITOR: u32 = 1;
/// 光标：1 = 隐藏，2 = 嵌入画面，4 = 作为元数据。录屏要看得见光标 ⇒ 2。
const CURSOR_EMBEDDED: u32 = 2;

struct Active {
    /// 必须常驻：session 随这条连接的销毁而失效。
    conn: zbus::Connection,
    session: OwnedObjectPath,
    child: std::process::Child,
    /// 我们自己 dup 出来的 PipeWire remote fd（传给 gst 用），停止时关掉。
    pw_fd: Option<i32>,
    output: String,
    started: Instant,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

pub struct CastStarted {
    pub output: String,
    pub node_id: u32,
    pub elapsed: Duration,
}

/// 等一条 `org.freedesktop.portal.Request.Response(u32, a{sv})`。
///
/// `Ok(None)` = 用户取消（code 1）；`Err` = 真失败。取消不是错误，调用方不该报红。
async fn wait_response(
    stream: &mut zbus::MessageStream,
    req: &str,
    timeout: Duration,
) -> Result<Option<HashMap<String, OwnedValue>>, String> {
    use futures_util::StreamExt;

    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("portal 没有在期限内回应（可能对话框还开着）".to_string());
        }
        let next = tokio::time::timeout(left, stream.next())
            .await
            .map_err(|_| "portal 响应超时".to_string())?;
        let Some(msg) = next else {
            return Err("D-Bus 信号流结束".to_string());
        };
        let msg = msg.map_err(|e| format!("读取 D-Bus 消息失败: {e}"))?;

        let hdr = msg.header();
        if hdr.message_type() != zbus::message::Type::Signal {
            continue;
        }
        // 用 owned String 比较，避开 header 借用与临时值的生命周期纠缠（E0716）。
        let iface = hdr.interface().map(|i| i.as_str().to_owned());
        let member = hdr.member().map(|m| m.as_str().to_owned());
        let path = hdr.path().map(|p| p.as_str().to_owned());
        if iface.as_deref() != Some("org.freedesktop.portal.Request")
            || member.as_deref() != Some("Response")
        {
            continue;
        }
        if path.as_deref() != Some(req) {
            continue;
        }
        // 先把 body 绑到变量，否则 Value 借用已释放的临时体（E0716）。
        let body = msg.body();
        let (code, results): (u32, HashMap<String, OwnedValue>) = body
            .deserialize()
            .map_err(|e| format!("解析 Response 失败: {e}"))?;
        return match code {
            0 => Ok(Some(results)),
            1 => Ok(None), // 用户取消
            2 => Err("portal 拒绝了请求".to_string()),
            c => Err(format!("portal 返回错误码 {c}")),
        };
    }
}

/// 把 `.mp4` / `.mkv` 这类请求改写成 `.webm`。
///
/// 本机 gstreamer **没有 `x264enc`**（`gstreamer1.0-plugins-ugly` 未安装），H.264/MP4 出不来；
/// WebM（VP8）是零额外依赖的路径。把扩展名改对，免得用户拿到一个名为 mp4、实为 webm 的文件。
fn normalize_output(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    for ext in [".mp4", ".mkv", ".avi", ".mov"] {
        if lower.ends_with(ext) {
            return format!("{}.webm", &path[..path.len() - ext.len()]);
        }
    }
    if lower.ends_with(".webm") {
        return path.to_string();
    }
    format!("{path}.webm")
}

/// 让父进程里指定的 fd 在子进程里变成固定编号（`pre_exec` 里 `dup2`，顺带清掉 CLOEXEC）。
fn pass_fd_to_child(fd: i32, target: i32) -> impl FnMut() -> std::io::Result<()> + Send + Sync + 'static {
    move || {
        // SAFETY: dup2 是 async-signal-safe 的，pre_exec 里只允许这类调用。
        let rc = unsafe { libc::dup2(fd, target) };
        if rc < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

/// 默认输出位置：优先本地化的 `~/视频`，其次 `~/Videos`，都没有就建 `~/Videos`。
/// 文件名带时间戳，避免连续录制互相覆盖。
fn default_output() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let mut base = std::path::PathBuf::from(&home).join("Videos");
    let localized = std::path::PathBuf::from(&home).join("视频");
    if localized.is_dir() {
        base = localized;
    }
    let dir = base.join("andeyunhui-recordings");
    let stamp = std::process::Command::new("date")
        .arg("+%Y%m%d-%H%M%S")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "recording".to_string());
    dir.join(format!("录屏-{stamp}.webm"))
        .to_string_lossy()
        .to_string()
}

/// 起 `gst-launch-1.0` 把 PipeWire 流写成 WebM。
///
/// `-e` 非常关键：它让 gst 在收到 SIGINT 时**先发 EOS 再退出**，否则 webm 的
/// 头部/尾部索引不会写盘，文件打不开（这是"录完打不开"的经典原因）。
fn spawn_gst(node_id: u32, pw_fd: Option<i32>, output: &str, fps: u32) -> Result<std::process::Child, String> {
    // 有 fd 就用 fd（走 portal 给的私有 remote，权限最稳）；没有才退回 path（node id）。
    // fd 用 dup2 固定到 3，避免和子进程里其它 fd 撞号。
    let mut cmd = std::process::Command::new("gst-launch-1.0");
    cmd.arg("-e")
        .arg(if pw_fd.is_some() {
            format!("pipewiresrc fd=3 do-timestamp=true")
        } else {
            format!("pipewiresrc path={node_id} do-timestamp=true")
        })
        .args(["!", "videoconvert", "!", "videorate", "!", "video/x-raw,framerate="])
        .arg(format!("{fps}/1"))
        .args(["!", "vp8enc", "deadline=1", "cpu-used=8", "!", "webmmux", "!", "filesink"])
        .arg(format!("location={output}"))
        .stdout(std::process::Stdio::null());
    if let Ok(f) = std::fs::File::create(format!("{output}.gst.log")) {
        cmd.stderr(std::process::Stdio::from(f));
    } else {
        cmd.stderr(std::process::Stdio::null());
    }
    if let Some(fd) = pw_fd {
        use std::os::unix::process::CommandExt;
        // pre_exec 是 unsafe（闭包必须 async-signal-safe）；闭包里只做 dup2。
        unsafe {
            cmd.pre_exec(pass_fd_to_child(fd, 3));
        }
    }
    cmd.spawn().map_err(|e| format!("启动 gst-launch-1.0 失败: {e}"))
}

/// 建立 ScreenCast 会话并开始录制。**会弹一次系统授权框。**
pub async fn start(output_path: &str, fps: u32) -> Result<CastStarted, String> {

    if ACTIVE.lock().map(|g| g.is_some()).unwrap_or(false) {
        return Err("已经在录制中".to_string());
    }

    let output = if output_path.trim().is_empty() {
        default_output()
    } else {
        normalize_output(output_path)
    };
    if let Some(dir) = std::path::Path::new(&output).parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建输出目录失败: {e}"))?;
    }

    let conn = zbus::Connection::session()
        .await
        .map_err(|e| format!("连接会话总线失败: {e}"))?;
    // **先建信号流再发请求**：portal 的 Response 可能在我们订阅前就到达。
    // 整条流程（CreateSession → SelectSources → Start）共用这一条流。
    let mut stream = zbus::MessageStream::from(&conn);

    let pid = std::process::id();

    // ---------- 1) CreateSession ----------
    // `session_handle_token` 必须给：只给 handle_token 会让 xdg-desktop-portal
    // `xdp-session.c:300` assert 失败并 SIGABRT（我用 busctl 试过，把服务打崩了一次）。
    let mut opts: HashMap<&str, Value<'_>> = HashMap::new();
    let tok_handle = format!("andycs{pid}");
    let tok_session = format!("andysess{pid}");
    opts.insert("handle_token", Value::from(tok_handle.as_str()));
    opts.insert("session_handle_token", Value::from(tok_session.as_str()));

    let reply = conn
        .call_method(Some(DEST), PORTAL_PATH, Some(IFACE), "CreateSession", &(opts))
        .await
        .map_err(|e| format!("CreateSession 调用失败: {e}"))?;
    let req: OwnedObjectPath = reply
        .body()
        .deserialize()
        .map_err(|e| format!("解析 CreateSession 请求路径失败: {e}"))?;
    let res = wait_response(&mut stream, req.as_str(), Duration::from_secs(15))
        .await?
        .ok_or_else(|| "CreateSession 被取消".to_string())?;
    let session_str: String = res
        .get("session_handle")
        .and_then(|v| String::try_from(v.clone()).ok())
        .ok_or_else(|| "CreateSession 没有返回 session_handle".to_string())?;
    let session = OwnedObjectPath::try_from(session_str.clone())
        .map_err(|e| format!("session_handle 不是合法对象路径({session_str}): {e}"))?;

    // ---------- 2) SelectSources（这里弹系统授权框） ----------
    let mut sopt: HashMap<&str, Value<'_>> = HashMap::new();
    let tok_select = format!("andysel{pid}");
    sopt.insert("handle_token", Value::from(tok_select.as_str()));
    sopt.insert("types", Value::from(SOURCE_MONITOR));
    sopt.insert("multiple", Value::from(false));
    sopt.insert("cursor_mode", Value::from(CURSOR_EMBEDDED));
    // 2 = 永久：允许 portal 回传 restore_token，下次免二次确认（token 持久化下一轮做）
    sopt.insert("persist_mode", Value::from(2u32));

    let reply = conn
        .call_method(
            Some(DEST),
            PORTAL_PATH,
            Some(IFACE),
            "SelectSources",
            &(&session, sopt),
        )
        .await
        .map_err(|e| format!("SelectSources 调用失败: {e}"))?;
    let req: OwnedObjectPath = reply
        .body()
        .deserialize()
        .map_err(|e| format!("解析 SelectSources 请求路径失败: {e}"))?;
    // 给用户 2 分钟挑屏幕/确认共享；他可能在对话框里犹豫。
    wait_response(&mut stream, req.as_str(), Duration::from_secs(120))
        .await?
        .ok_or_else(|| "用户取消了屏幕共享".to_string())?;

    // ---------- 3) Start ----------
    let mut topt: HashMap<&str, Value<'_>> = HashMap::new();
    let tok_start = format!("andystart{pid}");
    topt.insert("handle_token", Value::from(tok_start.as_str()));
    let reply = conn
        .call_method(
            Some(DEST),
            PORTAL_PATH,
            Some(IFACE),
            "Start",
            &(&session, "", topt),
        )
        .await
        .map_err(|e| format!("Start 调用失败: {e}"))?;
    let req: OwnedObjectPath = reply
        .body()
        .deserialize()
        .map_err(|e| format!("解析 Start 请求路径失败: {e}"))?;
    let res = wait_response(&mut stream, req.as_str(), Duration::from_secs(30))
        .await?
        .ok_or_else(|| "Start 被取消".to_string())?;

    // streams: a(ua{sv}) —— 取第一路，元素是 (node_id, props)
    let node_id = res
        .get("streams")
        .and_then(|v| <Vec<(u32, HashMap<String, OwnedValue>)>>::try_from(v.clone()).ok())
        .and_then(|mut s| if s.is_empty() { None } else { Some(s.remove(0).0) })
        .ok_or_else(|| "Start 没有返回 PipeWire 流（streams 为空）".to_string())?;

    // ---------- 4) OpenPipeWireRemote：拿私有 remote 的 fd ----------
    // 只拿 node id 有些环境能连（pipewiresrc path=N），有些会被权限挡住；
    // 官方推荐是用这个 fd，所以能给就给。
    let pw_fd = match conn
        .call_method(
            Some(DEST),
            PORTAL_PATH,
            Some(IFACE),
            "OpenPipeWireRemote",
            &(&session, HashMap::<&str, Value<'_>>::new()),
        )
        .await
    {
        Ok(reply) => {
            let body = reply.body();
            match body.deserialize::<zbus::zvariant::Fd<'_>>() {
                Ok(fd) => {
                    use std::os::fd::AsRawFd;
                    let raw = fd.as_raw_fd();
                    // dup 一份自己持有，原 Fd 随 reply 一起 drop
                    let dup = unsafe { libc::dup(raw) };
                    if dup >= 0 {
                        Some(dup)
                    } else {
                        None
                    }
                }
                Err(e) => {
                    eprintln!("[录屏] 解析 PipeWire fd 失败: {e}");
                    None
                }
            }
        }
        Err(e) => {
            eprintln!("[录屏] OpenPipeWireRemote 失败（退回 path={node_id}）: {e}");
            None
        }
    };

    // ---------- 5) 起 gst ----------
    let child = match spawn_gst(node_id, pw_fd, &output, fps.max(5).min(120)) {
        Ok(c) => c,
        Err(e) => {
            if let Some(fd) = pw_fd {
                unsafe { libc::close(fd) };
            }
            return Err(e);
        }
    };
    eprintln!(
        "[录屏] 已开始：node={node_id} fd={} fps={fps} → {output}",
        pw_fd.map(|f| f.to_string()).unwrap_or_else(|| "-".into())
    );

    let started = Instant::now();
    {
        let mut g = ACTIVE.lock().map_err(|e| format!("锁失败: {e}"))?;
        *g = Some(Active {
            conn,
            session,
            child,
            pw_fd,
            output: output.clone(),
            started,
        });
    }

    // 是否真的在出帧：给 1.2 秒，看 gst 有没有立刻退出（连不上 node 会秒退）。
    tokio::time::sleep(Duration::from_millis(1200)).await;
    {
        let mut g = ACTIVE.lock().map_err(|e| format!("锁失败: {e}"))?;
        if let Some(a) = g.as_mut() {
            if let Ok(Some(st)) = a.child.try_wait() {
                let log = std::fs::read_to_string(format!("{}.gst.log", a.output)).unwrap_or_default();
                let tail: String = log.lines().rev().take(4).collect::<Vec<_>>().join(" | ");
                eprintln!("[录屏] gst 提前退出（code={:?}）：{tail}", st.code());
                let _ = g.take();
                return Err(format!("录屏管线启动失败（gst 退出）: {tail}"));
            }
        }
    }

    Ok(CastStarted {
        output,
        node_id,
        elapsed: started.elapsed(),
    })
}

/// 停止录制，返回文件路径。会先关 session（让流自然 EOS）再 SIGINT，确保 webm 收尾写盘。
pub async fn stop() -> Result<String, String> {
    let active = {
        let mut g = ACTIVE.lock().map_err(|e| format!("锁失败: {e}"))?;
        g.take()
    };
    let Some(mut a) = active else {
        return Err("当前没有在录制".to_string());
    };

    // 1) 关 portal session：流结束，gst 会收到 EOS
    let _ = a
        .conn
        .call_method(Some(DEST), a.session.as_str(), Some(SESSION_IFACE), "Close", &())
        .await;

    // 2) 给 gst 几秒自然收尾；不行再 SIGINT（gst -e 会在退出前写 trailer）
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut exited = false;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = a.child.try_wait() {
            exited = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    if !exited {
        unsafe {
            libc::kill(a.child.id() as i32, libc::SIGINT);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = a.child.try_wait() {
                exited = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
    if !exited {
        let _ = a.child.kill();
        let _ = a.child.wait();
    }
    if let Some(fd) = a.pw_fd {
        unsafe { libc::close(fd) };
    }

    let size = std::fs::metadata(&a.output).map(|m| m.len()).unwrap_or(0);
    eprintln!(
        "[录屏] 已停止：{}（{} 秒，{} MB）",
        a.output,
        a.started.elapsed().as_secs(),
        size / 1048576
    );
    if size < 2048 {
        return Err(format!(
            "录制文件几乎为空（{} 字节），可能没抓到画面。gst 日志: {}.gst.log",
            size, a.output
        ));
    }
    Ok(a.output)
}

/// 当前是否在录制 / 已录多久。
pub fn status() -> (bool, u64) {
    let g = match ACTIVE.lock() {
        Ok(g) => g,
        Err(_) => return (false, 0),
    };
    match g.as_ref() {
        Some(a) => (true, a.started.elapsed().as_secs()),
        None => (false, 0),
    }
}
