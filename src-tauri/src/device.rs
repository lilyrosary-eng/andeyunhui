//! 全局设备监听（鼠标 / 键盘）：为桌宠浮窗提供「光标跟随」「拖拽」「按键显示」所需的原始输入。
//!
//! 实现：在独立线程运行 rdev 全局钩子（被动监听，不拦截、不吞输入），按事件类型 emit
//! `device-changed` 事件到 deskpet 浮窗。仅启动一次（`AtomicBool` 守卫），重复调用幂等。
//! 参考成熟方案：BongoCat（got-it/BongoCat-master）用同样机制实现猫娘跟随光标 + 按键可视化。
//!
//! 依赖 rdev 0.5.x：其 `listen` 接受 `FnMut(Event) + 'static` 捕获式闭包，故可直接 `move`
//! 捕获 `AppHandle`，无需旧版 0.3 的 `fn` 指针 + 全局静态 workaround。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Emitter;

/// 事件载荷：用 `t` 区分类型，前端按 `t` 分支处理。坐标均为物理像素（rdev 原始值）。
/// 键名 `key` 为 rdev `Key` 枚举的 `Debug` 字符串（0.5 中为 `KeyA` / `Num1` / `Return` 等，
/// 由前端 `friendlyKey` 统一翻译成可读标签）。
#[derive(Clone, serde::Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum DeviceEvent {
    MouseMove { x: f64, y: f64 },
    MouseDown,
    MouseUp,
    KeyDown { key: String },
    KeyUp { key: String },
}

static STARTED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn start_device_listening(app: tauri::AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return; // 已在监听，幂等返回
    }
    std::thread::spawn(move || {
        // MouseMove 节流到 ~60Hz（16ms）：高刷鼠标每秒可产生 500~1000 次移动事件，
        // 而 rdev 是系统级低级钩子——回调在「系统输入路径」上同步执行，回调里的任何耗时
        // 都会直接拖慢整机鼠标响应；且 emit 要序列化 payload 并跨 webview 投递。
        // 不节流时「移动鼠标 = 每秒数百次广播」，表现为全局发涩（不只应用内）。
        // 限频到与屏幕刷新率对齐即可（光标跟随/朝向本就按帧率更新，无视觉损失），事件量降 90%+。
        let mut last_move: Option<std::time::Instant> = None;
        // rdev 0.5 的 listen 接受捕获式 FnMut 闭包：把 app move 进回调即可（满足 'static）。
        let result = rdev::listen(move |event| {
            let payload = match event.event_type {
                rdev::EventType::MouseMove { x, y } => {
                    let now = std::time::Instant::now();
                    if let Some(t) = last_move {
                        if now.duration_since(t) < std::time::Duration::from_millis(16) {
                            return;
                        }
                    }
                    last_move = Some(now);
                    DeviceEvent::MouseMove { x, y }
                }
                rdev::EventType::ButtonPress(_) => DeviceEvent::MouseDown,
                rdev::EventType::ButtonRelease(_) => DeviceEvent::MouseUp,
                rdev::EventType::KeyPress(key) => DeviceEvent::KeyDown { key: format!("{:?}", key) },
                rdev::EventType::KeyRelease(key) => DeviceEvent::KeyUp { key: format!("{:?}", key) },
                _ => return,
            };
            // 定向投递到桌宠浮窗（label = "deskpet"，与 capsule:expand 同款 emit_to + 前端 listen）。
            // 原为 app.emit 全局广播：每条事件都要遍历所有 webview 投递，而监听者仅 deskpet 浮窗
            // （DeskpetPet.tsx 的 device-changed），其余窗口收到即丢弃——定向后彻底省掉这份开销。
            let _ = app.emit_to("deskpet", "device-changed", &payload);
        });
        // 钩子启动失败（如被其它全局钩子占用）：允许下次重试
        if result.is_err() {
            STARTED.store(false, Ordering::SeqCst);
        }
    });
}
