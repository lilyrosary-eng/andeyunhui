//! Windows SendInput HID 事件注入
//!
//! 替代原维度三"uinput/IOHIDFamily + eBPF 内核直写"：
//! - uinput（Linux）/ IOHIDFamily（macOS）跨平台不可用，删除
//! - eBPF 修改输入子系统环形缓冲区：Linux 专属，Windows 不可用，删除
//! - Windows SendInput（win32k.sys 内核调用）：
//!   · 浏览器 event.isTrusted 返回 true（OS 内核转发，非 JS 合成）
//!   · 主项目已有 winapi 依赖（screenshot.rs 滚轮注入同款模式）
//!   · 事件间隔匹配硬件轮询速率（125Hz=8ms / 1000Hz=1ms）
//!
//! 限制：
//! - SendInput 是同步阻塞调用（微秒级，单次注入不显著影响 tick）
//! - 批量注入（数百事件）会累积阻塞，建议用 spawn_blocking 包装
//! - 坐标为绝对坐标（归一化到 0-65535），需屏幕分辨率

use std::thread;
use std::time::Duration;
use winapi::um::winuser::{
    GetSystemMetrics, SendInput, INPUT, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_VIRTUALDESK, SM_CXSCREEN, SM_CYSCREEN,
};

use super::bezier::TrajectoryPoint;

/// 硬件轮询速率（鼠标刷新率）
pub const POLL_INTERVAL_NORMAL_MS: u32 = 8; // 125Hz 普通鼠标
pub const POLL_INTERVAL_GAMING_MS: u32 = 1; // 1000Hz 游戏鼠标

/// 将屏幕坐标归一化到 SendInput 的绝对坐标范围（0-65535）
fn normalize_absolute(x: f32, y: f32) -> (i32, i32) {
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) } as f32;
    let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) } as f32;
    let nx = ((x / screen_w) * 65535.0) as i32;
    let ny = ((y / screen_h) * 65535.0) as i32;
    (nx, ny)
}

/// 构造单个鼠标移动 INPUT 结构体
fn build_move_input(dx: i32, dy: i32) -> INPUT {
    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.type_ = INPUT_MOUSE;
    // 安全访问 union（winapi 0.3 模式，与主项目 screenshot.rs 一致）
    let mi = unsafe { &mut *(&mut input.u as *mut _ as *mut winapi::um::winuser::MOUSEINPUT) };
    mi.dx = dx;
    mi.dy = dy;
    mi.mouseData = 0;
    mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    mi.time = 0;
    mi.dwExtraInfo = 0;
    input
}

/// 注入鼠标轨迹（按指定间隔逐个发送 SendInput）
///
/// 参数：
/// - `trajectory`：轨迹点序列（含绝对坐标 x/y 和时间戳 t_ms）
/// - `poll_interval_ms`：事件间隔（8ms=125Hz / 1ms=1000Hz）
///
/// 返回：成功注入的事件数量
///
/// 注意：本函数同步阻塞，批量注入（>50 个点）建议用 spawn_blocking 包装。
pub fn inject_mouse_trajectory(
    trajectory: &[TrajectoryPoint],
    poll_interval_ms: u32,
) -> Result<usize, String> {
    if trajectory.is_empty() {
        return Ok(0);
    }

    let mut injected = 0usize;
    let interval = Duration::from_millis(poll_interval_ms as u64);

    for point in trajectory {
        let (dx, dy) = normalize_absolute(point.x, point.y);
        let mut input = build_move_input(dx, dy);

        let result = unsafe {
            SendInput(
                1,
                &mut input as *mut INPUT,
                std::mem::size_of::<INPUT>() as i32,
            )
        };

        if result == 0 {
            let err = std::io::Error::last_os_error();
            log::warn!(
                "[hid] SendInput 失败在第 {} 个事件: {} (dx={} dy={})",
                injected,
                err,
                dx,
                dy
            );
            // 不立即返回，继续尝试后续事件（部分失败容错）
        } else {
            injected += 1;
        }

        // 按硬件轮询速率间隔（模拟物理鼠标的报文频率）
        thread::sleep(interval);
    }

    log::info!(
        "[hid] 注入完成: {}/{} 个事件成功（间隔={}ms）",
        injected,
        trajectory.len(),
        poll_interval_ms
    );

    Ok(injected)
}

/// 单次点击注入（左键按下 + 释放）
pub fn inject_click(x: f32, y: f32) -> Result<(), String> {
    use winapi::um::winuser::{MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP};

    let (dx, dy) = normalize_absolute(x, y);

    // 移动到目标位置
    let mut move_input = build_move_input(dx, dy);
    unsafe {
        SendInput(
            1,
            &mut move_input as *mut INPUT,
            std::mem::size_of::<INPUT>() as i32,
        );
    }
    thread::sleep(Duration::from_millis(50)); // 人类点击前悬停

    // 左键按下
    let mut down_input: INPUT = unsafe { std::mem::zeroed() };
    down_input.type_ = INPUT_MOUSE;
    let mi = unsafe { &mut *(&mut down_input.u as *mut _ as *mut winapi::um::winuser::MOUSEINPUT) };
    mi.dx = dx;
    mi.dy = dy;
    mi.dwFlags = MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    unsafe {
        SendInput(
            1,
            &mut down_input as *mut INPUT,
            std::mem::size_of::<INPUT>() as i32,
        );
    }
    thread::sleep(Duration::from_millis(30)); // 人类点击按下到释放的间隔

    // 左键释放
    let mut up_input: INPUT = unsafe { std::mem::zeroed() };
    up_input.type_ = INPUT_MOUSE;
    let mi = unsafe { &mut *(&mut up_input.u as *mut _ as *mut winapi::um::winuser::MOUSEINPUT) };
    mi.dx = dx;
    mi.dy = dy;
    mi.dwFlags = MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    unsafe {
        SendInput(
            1,
            &mut up_input as *mut INPUT,
            std::mem::size_of::<INPUT>() as i32,
        );
    }

    Ok(())
}

/// 双击注入
pub fn inject_double_click(x: f32, y: f32) -> Result<(), String> {
    inject_click(x, y)?;
    thread::sleep(Duration::from_millis(80)); // 双击间隔
    inject_click(x, y)?;
    Ok(())
}

/// 滚轮注入（用于页面滚动模拟）
pub fn inject_scroll(delta: i32) -> Result<(), String> {
    use winapi::um::winuser::{MOUSEEVENTF_WHEEL, WHEEL_DELTA};

    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.type_ = INPUT_MOUSE;
    let mi = unsafe { &mut *(&mut input.u as *mut _ as *mut winapi::um::winuser::MOUSEINPUT) };
    mi.dx = 0;
    mi.dy = 0;
    mi.mouseData = (delta * WHEEL_DELTA as i32) as u32;
    mi.dwFlags = MOUSEEVENTF_WHEEL;
    mi.time = 0;
    mi.dwExtraInfo = 0;

    let result = unsafe {
        SendInput(
            1,
            &mut input as *mut INPUT,
            std::mem::size_of::<INPUT>() as i32,
        )
    };

    if result == 0 {
        Err(format!(
            "SendInput 滚轮失败: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

/// 检测当前是否可注入（SendInput 需要 UIPI 权限，被 UIPI 隔离的进程会失败）
pub fn can_inject() -> bool {
    // 尝试一次空移动（坐标 0,0），看 SendInput 是否成功
    let mut input = build_move_input(0, 0);
    let result = unsafe {
        SendInput(
            1,
            &mut input as *mut INPUT,
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    result > 0
}

// ==================== 键盘注入（INPUT_KEYBOARD）====================

/// 常用虚拟键码（Virtual Key Codes）
///
/// 完整列表见 winapi::um::winuser::VK_*，这里仅导出最常用的
pub mod vk {
    pub const BACK: u16 = 0x08; // Backspace
    pub const TAB: u16 = 0x09;
    pub const RETURN: u16 = 0x0D; // Enter
    pub const SHIFT: u16 = 0x10;
    pub const CONTROL: u16 = 0x11;
    pub const MENU: u16 = 0x12; // Alt
    pub const ESCAPE: u16 = 0x1B;
    pub const SPACE: u16 = 0x20;
    pub const LEFT: u16 = 0x25;
    pub const UP: u16 = 0x26;
    pub const RIGHT: u16 = 0x27;
    pub const DOWN: u16 = 0x28;
    pub const DELETE: u16 = 0x2E;
    pub const LWIN: u16 = 0x5B;
    pub const RWIN: u16 = 0x5C;
    pub const LSHIFT: u16 = 0xA0;
    pub const RSHIFT: u16 = 0xA1;
    pub const LCONTROL: u16 = 0xA2;
    pub const RCONTROL: u16 = 0xA3;
    pub const LMENU: u16 = 0xA4; // 左 Alt
    pub const RMENU: u16 = 0xA5; // 右 Alt
}

/// 构造单个键盘 INPUT 结构体
///
/// 参数：
/// - `vk`：虚拟键码（如 vk::RETURN）
/// - `flags`：键盘事件标志（0=按下，KEYEVENTF_KEYUP=释放）
fn build_keyboard_input(vk: u16, flags: u32) -> INPUT {
    use winapi::um::winuser::{INPUT_KEYBOARD, KEYBDINPUT};
    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.type_ = INPUT_KEYBOARD;
    let ki = unsafe { &mut *(&mut input.u as *mut _ as *mut KEYBDINPUT) };
    ki.wVk = vk;
    ki.wScan = 0;
    ki.dwFlags = flags;
    ki.time = 0;
    ki.dwExtraInfo = 0;
    input
}

/// 单键按下 + 释放
///
/// 参数：
/// - `vk`：虚拟键码
/// - `hold_ms`：按下到释放的间隔（毫秒，50-150 典型）
pub fn inject_key_press(vk: u16, hold_ms: u64) -> Result<(), String> {
    use winapi::um::winuser::KEYEVENTF_KEYUP;

    // 按下
    let mut down = build_keyboard_input(vk, 0);
    let result = unsafe {
        SendInput(
            1,
            &mut down as *mut INPUT,
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if result == 0 {
        return Err(format!(
            "SendInput 按下失败: {}",
            std::io::Error::last_os_error()
        ));
    }

    thread::sleep(Duration::from_millis(hold_ms));

    // 释放
    let mut up = build_keyboard_input(vk, KEYEVENTF_KEYUP);
    let result = unsafe {
        SendInput(
            1,
            &mut up as *mut INPUT,
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if result == 0 {
        return Err(format!(
            "SendInput 释放失败: {}",
            std::io::Error::last_os_error()
        ));
    }

    Ok(())
}

/// 键序列注入（逐个按下释放）
///
/// 例如输入 "abc" → 按下a→释放a→间隔→按下b→释放b→...
///
/// 参数：
/// - `vks`：虚拟键码序列
/// - `interval_ms`：键之间的间隔（80-150ms 典型，模拟人类打字节奏）
pub fn inject_key_sequence(vks: &[u16], interval_ms: u64) -> Result<(), String> {
    for &vk in vks {
        // 按键保持时间带随机抖动（30-90ms，模拟人类按键力度差异）
        let hold = 30 + lcg_jitter() % 60;
        inject_key_press(vk, hold)?;
        thread::sleep(Duration::from_millis(interval_ms));
    }
    Ok(())
}

/// 组合键注入（如 Ctrl+C）
///
/// 流程：按下所有键（顺序）→ 释放所有键（逆序）
/// 例如 [Ctrl, C]：按下Ctrl→按下C→释放C→释放Ctrl
///
/// 参数：
/// - `vks`：组合键序列（修饰键在前，主键在后）
pub fn inject_combination(vks: &[u16]) -> Result<(), String> {
    use winapi::um::winuser::KEYEVENTF_KEYUP;

    if vks.is_empty() {
        return Ok(());
    }

    // 按下所有键（顺序）
    for &vk in vks {
        let mut down = build_keyboard_input(vk, 0);
        let result = unsafe {
            SendInput(
                1,
                &mut down as *mut INPUT,
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        if result == 0 {
            return Err(format!(
                "SendInput 组合键按下失败: {}",
                std::io::Error::last_os_error()
            ));
        }
        thread::sleep(Duration::from_millis(20)); // 修饰键到主键的微小间隔
    }

    thread::sleep(Duration::from_millis(30)); // 组合键保持时间

    // 释放所有键（逆序）
    for &vk in vks.iter().rev() {
        let mut up = build_keyboard_input(vk, KEYEVENTF_KEYUP);
        let result = unsafe {
            SendInput(
                1,
                &mut up as *mut INPUT,
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        if result == 0 {
            return Err(format!(
                "SendInput 组合键释放失败: {}",
                std::io::Error::last_os_error()
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }

    Ok(())
}

/// 文本输入（支持 Unicode，绕过键盘布局）
///
/// 使用 KEYEVENTF_UNICODE 标志，直接发送 Unicode 字符的 scan code，
/// 无需关心键盘布局（适用于中文、日文等非 ASCII 字符）。
///
/// 参数：
/// - `text`：要输入的文本
/// - `interval_ms`：字符之间的间隔（80-150ms 模拟人类打字）
pub fn inject_text(text: &str, interval_ms: u64) -> Result<(), String> {
    use winapi::um::winuser::{INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE};

    // 将字符串编码为 UTF-16（Windows 内部使用 UTF-16）
    let utf16: Vec<u16> = text.encode_utf16().collect();

    for &ch in &utf16 {
        // 按下（KEYEVENTF_UNICODE 表示 wScan 是 Unicode 字符）
        let mut input: INPUT = unsafe { std::mem::zeroed() };
        input.type_ = INPUT_KEYBOARD;
        let ki = unsafe { &mut *(&mut input.u as *mut _ as *mut KEYBDINPUT) };
        ki.wVk = 0;
        ki.wScan = ch;
        ki.dwFlags = KEYEVENTF_UNICODE;
        ki.time = 0;
        ki.dwExtraInfo = 0;

        let result = unsafe {
            SendInput(
                1,
                &mut input as *mut INPUT,
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        if result == 0 {
            return Err(format!(
                "SendInput Unicode 按下失败: {}",
                std::io::Error::last_os_error()
            ));
        }

        thread::sleep(Duration::from_millis(20 + lcg_jitter() % 40));

        // 释放
        let mut up: INPUT = unsafe { std::mem::zeroed() };
        up.type_ = INPUT_KEYBOARD;
        let ki = unsafe { &mut *(&mut up.u as *mut _ as *mut KEYBDINPUT) };
        ki.wVk = 0;
        ki.wScan = ch;
        ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        ki.time = 0;
        ki.dwExtraInfo = 0;

        let result = unsafe {
            SendInput(
                1,
                &mut up as *mut INPUT,
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        if result == 0 {
            return Err(format!(
                "SendInput Unicode 释放失败: {}",
                std::io::Error::last_os_error()
            ));
        }

        thread::sleep(Duration::from_millis(interval_ms));
    }

    Ok(())
}

/// 简单 LCG 随机数（用于打字间隔抖动，避免引入 rand crate）
///
/// 线程本地状态，glibc 同款参数，仅用于产生微小时间抖动
fn lcg_jitter() -> u64 {
    use std::cell::Cell;
    thread_local! {
        static LCG_STATE: Cell<u64> = Cell::new(0x1234567890ABCDEF);
    }
    LCG_STATE.with(|state| {
        let s = state.get();
        let new_s = s
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        state.set(new_s);
        new_s % 1000
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_absolute() {
        // 不依赖实际屏幕分辨率，只验证返回值在合理范围
        let (nx, ny) = normalize_absolute(100.0, 100.0);
        assert!(nx >= 0 && nx <= 65535);
        assert!(ny >= 0 && ny <= 65535);
    }

    #[test]
    fn test_build_move_input() {
        let input = build_move_input(1000, 2000);
        assert_eq!(input.type_, INPUT_MOUSE);
        // 验证 MOUSEINPUT 字段（只读访问 union）
        let mi = unsafe { &*(&input.u as *const _ as *const winapi::um::winuser::MOUSEINPUT) };
        assert_eq!(mi.dx, 1000);
        assert_eq!(mi.dy, 2000);
        // dwFlags 应包含 MOVE | ABSOLUTE | VIRTUALDESK
        assert!(mi.dwFlags & MOUSEEVENTF_MOVE != 0);
        assert!(mi.dwFlags & MOUSEEVENTF_ABSOLUTE != 0);
    }

    #[test]
    fn test_can_inject() {
        // 在测试环境中 SendInput 可能成功也可能失败（取决于运行环境）
        // 这里只验证函数不 panic
        let _ = can_inject();
    }

    #[test]
    fn test_build_keyboard_input() {
        use winapi::um::winuser::INPUT_KEYBOARD;
        let input = build_keyboard_input(vk::RETURN, 0);
        assert_eq!(input.type_, INPUT_KEYBOARD);
        // 验证 KEYBDINPUT 字段（只读访问 union）
        let ki = unsafe { &*(&input.u as *const _ as *const winapi::um::winuser::KEYBDINPUT) };
        assert_eq!(ki.wVk, vk::RETURN);
        assert_eq!(ki.dwFlags, 0);
    }

    #[test]
    fn test_vk_constants() {
        // 验证常用虚拟键码符合 Windows 规范
        assert_eq!(vk::RETURN, 0x0D);
        assert_eq!(vk::ESCAPE, 0x1B);
        assert_eq!(vk::SPACE, 0x20);
        assert_eq!(vk::LCONTROL, 0xA2);
    }

    #[test]
    fn test_inject_key_press_no_panic() {
        // 不实际触发键盘事件（测试环境无焦点窗口），仅验证不 panic
        let _ = inject_key_press(vk::SPACE, 10);
    }

    #[test]
    fn test_inject_combination_empty() {
        // 空组合键应直接返回 Ok
        assert!(inject_combination(&[]).is_ok());
    }

    #[test]
    fn test_inject_text_empty() {
        // 空文本应直接返回 Ok
        assert!(inject_text("", 50).is_ok());
    }

    #[test]
    fn test_lcg_jitter_range() {
        let j = lcg_jitter();
        assert!(j < 1000, "jitter 应在 [0, 1000) 范围内，实际 {}", j);
    }
}
