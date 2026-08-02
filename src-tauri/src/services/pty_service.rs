// IDE 真 PTY 终端服务（portable-pty，MIT）
//
// 设计要点：
// - portable-pty 跨平台 PTY：Windows 走 ConPTY（Win10 1809+ 内置），Unix 走 fork+exec。
//   纯 Rust，无原生依赖，契合「轻量高效、兼容至上」。
// - 沙箱屏蔽 WebSocket，无法走 WS 桥接；改用 Tauri 事件：
//     读线程 → app.emit("pty-output:<id>", data) → 前端 listen 写入 xterm.js
// - 全局注册表（Lazy + Mutex<HashMap>）管理活跃会话的 master + writer + child；
//   pty_kill 时移除并 kill child、drop master/writer，读线程随之收到 EOF 退出。
// - 每个会话由前端分配唯一 id（如 'pty_<ts>_<rand>'），事件名带 id 实现多标签隔离。
//
// 关键修复（2026-08-01）：
// 1. take_writer 只能调一次：portable-pty 0.8 的 MasterPty::take_writer 在 Unix（took_writer
//    标志位）与 Windows（writable.take()）均为「取出即置空」，重复调用返回 Err。故在 pty_create
//    中 take 一次存入 PtySession.writer，pty_write 复用，否则第二次按键即失败、终端假死。
// 2. UTF-8 跨缓冲区边界：原 from_utf8_lossy 在多字节字符被 read 切成两段时产生 U+FFFD，
//    CJK 输出会吞字符。改用 encoding_rs::UTF_8 流式解码器，保留跨边界不完整序列。
// 3. id 复用竞态：旧读线程在 EOF 时若直接 remove 同 id 会误删新会话。引入 generation 计数，
//    读线程仅在注册表中的会话 generation 仍为自身时才移除。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};

/// 单个 PTY 会话：master（resize）+ writer（输入，创建时 take 一次复用）+ child（kill）
struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Option<Box<dyn Write + Send>>,
    child: Box<dyn portable_pty::Child + Send>,
    /// 会话代号：用于读线程在 EOF 时判断注册表中的会话是否仍为自身（防 id 复用误删）
    generation: u64,
}

/// 全局注册表：id → PtySession。Lazy 保证懒初始化，Mutex 保证线程安全。
static PTY_REGISTRY: Lazy<Mutex<HashMap<String, PtySession>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// 会话代号生成器：每次 pty_create 自增，唯一标识一次会话生命周期（防 id 复用竞态）。
static GEN: AtomicU64 = AtomicU64::new(0);

/// 创建 PTY 会话并 spawn 默认 shell。
/// - id：前端分配的唯一会话 id
/// - cwd：工作目录（可选，默认用户家目录）
/// - cols/rows：初始终端尺寸
/// 读线程通过 app.emit("pty-output:<id>", data) 推流；进程退出时 emit("pty-exit:<id>")。
#[tauri::command]
pub async fn pty_create(
    app: AppHandle,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("pty_create: id 不能为空".to_string());
    }
    // 已存在同 id 会话 → 先清理旧会话（前端 id 含时间戳+随机数，正常不会命中，此处为防御）
    {
        let mut reg = PTY_REGISTRY.lock().map_err(|e| format!("注册表锁失败: {}", e))?;
        if let Some(mut old) = reg.remove(&id) {
            let _ = old.child.kill();
            drop(old.master);
        }
    }

    let pty_system = native_pty_system();
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let pair = pty_system.openpty(size).map_err(|e| format!("openpty 失败: {}", e))?;

    // 构造默认 shell 命令（new_default_prog 跨平台选 cmd.exe / $SHELL）
    let mut cmd = CommandBuilder::new_default_prog();
    if let Some(c) = &cwd {
        let p = std::path::Path::new(c);
        if p.is_dir() {
            cmd.cwd(p);
        }
    }
    // spawn 子进程
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn shell 失败: {}", e))?;
    // drop slave 让 master 能在子进程退出时检测到 EOF（否则 slave 句柄会撑住管道）
    drop(pair.slave);

    let master = pair.master;
    // 克隆 reader 供读线程使用（master 保留用于 resize）
    let reader = master.try_clone_reader().map_err(|e| format!("clone reader 失败: {}", e))?;
    // 关键修复：take_writer 只能调一次（portable-pty 0.8 在 Unix/Windows 均如此），
    // 这里取出后存入会话 writer 字段，后续 pty_write 复用，不再重复 take。
    let writer = master.take_writer().map_err(|e| format!("take_writer 失败: {}", e))?;
    let generation = GEN.fetch_add(1, Ordering::Relaxed);

    // 读线程：循环读取 PTY 输出 → 流式 UTF-8 解码 → emit 事件
    let app_clone = app.clone();
    let id_clone = id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        // 流式 UTF-8 解码器：保留跨 read 边界的不完整多字节序列，避免 CJK 被吞字符
        //（from_utf8_lossy 无状态，遇到截断的多字节序列会替换为 U+FFFD）
        let mut decoder = encoding_rs::UTF_8.new_decoder();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF：子进程已关闭
                Ok(n) => {
                    let mut out = String::with_capacity(n * 2 + 4);
                    // last=false：后续可能还有数据，decoder 暂存跨边界的不完整序列
                    let _ = decoder.decode_to_string(&buf[..n], &mut out, false);
                    if !out.is_empty() {
                        let _ = app_clone.emit(&format!("pty-output:{}", id_clone), out);
                    }
                }
                Err(e) => {
                    let _ = app_clone.emit(
                        &format!("pty-error:{}", id_clone),
                        format!("读错误: {}", e),
                    );
                    break;
                }
            }
        }
        // 收尾：flush decoder 内残留字节（输入已结束，last=true 强制输出待定序列或替换符）
        let mut tail = String::new();
        let _ = decoder.decode_to_string(&[], &mut tail, true);
        if !tail.is_empty() {
            let _ = app_clone.emit(&format!("pty-output:{}", id_clone), tail);
        }
        // 通知前端子进程已退出
        let _ = app_clone.emit(&format!("pty-exit:{}", id_clone), ());
        // 仅当注册表中的会话仍是自身（同 generation）才移除，防 id 复用误删新会话
        if let Ok(mut reg) = PTY_REGISTRY.lock() {
            if reg.get(&id_clone).map(|s| s.generation) == Some(generation) {
                reg.remove(&id_clone);
            }
        }
    });

    // 存入注册表
    let reg_result = PTY_REGISTRY.lock().map_err(|e| format!("注册表锁失败: {}", e));
    match reg_result {
        Ok(mut reg) => {
            reg.insert(id, PtySession { master, writer: Some(writer), child, generation });
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// 向 PTY 写入数据（键盘输入、粘贴）。
/// 复用 pty_create 时 take 的 writer（portable-pty 0.8 的 take_writer 不可重复调用）。
#[tauri::command]
pub async fn pty_write(id: String, data: String) -> Result<(), String> {
    let bytes = data.into_bytes();
    let mut reg = PTY_REGISTRY.lock().map_err(|e| format!("注册表锁失败: {}", e))?;
    let session = reg.get_mut(&id).ok_or_else(|| format!("PTY 会话不存在: {}", id))?;
    let writer = session
        .writer
        .as_mut()
        .ok_or_else(|| "PTY writer 未初始化".to_string())?;
    writer.write_all(&bytes).map_err(|e| format!("写入 PTY 失败: {}", e))?;
    writer.flush().ok();
    Ok(())
}

/// 调整 PTY 尺寸（窗口 resize 时调用）。
#[tauri::command]
pub async fn pty_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    let mut reg = PTY_REGISTRY.lock().map_err(|e| format!("注册表锁失败: {}", e))?;
    let session = reg.get_mut(&id).ok_or_else(|| format!("PTY 会话不存在: {}", id))?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("resize 失败: {}", e))?;
    Ok(())
}

/// 终止 PTY 会话（kill 子进程 + drop master/writer，读线程随之 EOF 退出）。
#[tauri::command]
pub async fn pty_kill(id: String) -> Result<(), String> {
    let mut reg = PTY_REGISTRY.lock().map_err(|e| format!("注册表锁失败: {}", e))?;
    if let Some(mut session) = reg.remove(&id) {
        let _ = session.child.kill();
        // 显式 drop 顺序：先 master（关 PTY）再 child；writer 随 session 出作用域自动 drop
        drop(session.master);
        drop(session.child);
    }
    Ok(())
}
