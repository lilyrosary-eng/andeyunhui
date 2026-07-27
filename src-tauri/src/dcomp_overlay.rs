//! DirectComposition swapchain 呈现：根治透明浮窗（胶囊/歌词）在「外部媒体（Spotify/视频等）
//! 走硬件 overlay / independent-flip 直呈」时被 DWM 重定向(redirect)路径饿死、导致屏幕呈现
//! 卡顿数秒的根因。
//!
//! 旧路径：WS_EX_LAYERED 分层窗像素由 DWM 走重定向路径，仅 NotifyParentWindowPositionChanged
//! 时才 blit 上屏；外部媒体 overlay 抢占该路径 → 我们的窗不规则丢帧（渲染器 rAF 144fps 正常、
//! 但屏幕停在旧帧）。降频/按需上屏都无效，因为只要外部媒体 overlay 在跑，DWM 根本不给我们的
//! redirect 窗及时合成。
//!
//! 新路径：把 WebView2 控制器交给 DComp（RootVisualTarget），WebView2 渲染进我们自建的
//! DXGI swapchain，由 DComp 视觉合成进窗口——与媒体同走 DWM 常规合成管道、不被抢占，透明
//! 靠 swapchain 的 PREMULTIPLIED alpha 实现。点击穿透：胶囊用整窗交互（原布局即可）；全屏
//! 截图/录屏窗仍保持 layered 不变。
//!
//! 仅当环境变量 ANDY_DCOMP=1 且窗 label 为 capsule / floating-lyrics 时启用；任何一步失败都
//! 返回 false，窗保持原 layered 行为（不会变砖）。WebView2 的 SetRootVisualTarget 泛型约束
//! windows-core 0.61 的 Interface（webview2-com-sys 0.38 实现该版本），而 DComp 类型来自
//! windows 0.62（实现 windows-core 0.62），故用 cast::<IUnknown> + from_raw 做跨版本 COM 桥接。

#[cfg(windows)]
use std::collections::HashMap;
#[cfg(windows)]
use std::sync::{LazyLock, Mutex};

#[cfg(windows)]
use windows::core::{Interface, IUnknown};
#[cfg(windows)]
use windows::Win32::Foundation::{HMODULE, HWND, RECT};
#[cfg(windows)]
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_11_0,
};
#[cfg(windows)]
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, ID3D11Device,
    ID3D11DeviceContext,
};
#[cfg(windows)]
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice, IDCompositionDevice, IDCompositionTarget, IDCompositionVisual,
};
#[cfg(windows)]
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
};
#[cfg(windows)]
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory2, DXGI_CREATE_FACTORY_FLAGS, IDXGIDevice, IDXGIFactory2, IDXGISwapChain1,
    DXGI_SCALING_NONE, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
    DXGI_USAGE_RENDER_TARGET_OUTPUT,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetWindowLongPtrW, GWL_EXSTYLE, SetWindowLongPtrW, SetWindowPos, WS_EX_LAYERED,
    SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOACTIVATE, SWP_NOZORDER, SWP_NOSIZE,
};
#[cfg(windows)]
use webview2_com_sys::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2CompositionController, ICoreWebView2Controller,
};
#[cfg(windows)]
use windows_core_061::Interface as Interface061;
#[cfg(windows)]
use windows_core_061::IUnknown as IUnknown061;

#[cfg(windows)]
struct DcompKeep {
    // 保活 DComp 对象（不被 drop 否则视觉失效）；swap 用于将来 resize。
    _device: IDCompositionDevice,
    _target: IDCompositionTarget,
    _visual: IDCompositionVisual,
    _swap: IDXGISwapChain1,
}

// DComp COM 指针非 Send/Sync，但本程序只在主线程访问（repaint 定时器经 run_on_main_thread、
// is_active 只读 label 集合不碰对象），故安全声明 Send/Sync。绝不跨线程移动这些指针。
#[cfg(windows)]
unsafe impl Send for DcompKeep {}
#[cfg(windows)]
unsafe impl Sync for DcompKeep {}

// 记录哪些窗已成功切到 DComp，供 repaint 定时器 / present_overlay_now 跳过 Notify。
#[cfg(windows)]
static DCOMP_ACTIVE: LazyLock<Mutex<HashMap<String, DcompKeep>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(windows)]
pub fn is_active(label: &str) -> bool {
    DCOMP_ACTIVE.lock().unwrap().contains_key(label)
}

#[cfg(windows)]
pub fn on_destroy(label: &str) {
    DCOMP_ACTIVE.lock().unwrap().remove(label);
}

/// 在 set_overlay_transparent 内、透明背景设置完成后调用。返回 true 表示已切到 DComp。
/// ctrl 为已取出的 ICoreWebView2Controller；hwnd 从 Tauri 侧取，以裸指针(isize)传入以解耦
/// 调用方的 windows crate 版本与本 crate（windows 0.62）。
#[cfg(windows)]
pub fn try_enable(ctrl: ICoreWebView2Controller, label: &str, hwnd: Option<isize>) -> bool {
    if label != "capsule" && label != "floating-lyrics" {
        return false;
    }
    // 默认开启（ANDY_DCOMP 仅用于关闭：=0 / false 时退回 layered）。
    // 开启后浮窗经 DComp 交换链走 DWM 正常合成管线，去除 Notify 轮询，丝滑度显著提升。
    match std::env::var("ANDY_DCOMP") {
        Ok(v) if v == "0" || v.eq_ignore_ascii_case("false") => return false,
        _ => {}
    }
    if DCOMP_ACTIVE.lock().unwrap().contains_key(label) {
        return true;
    }
    let hwnd = match hwnd {
        Some(h) => HWND(h as *mut std::ffi::c_void),
        None => return false,
    };

    let comp: ICoreWebView2CompositionController = match ctrl.cast() {
        Ok(c) => c,
        Err(_) => return false,
    };

    // 1) D3D11 设备（BGRA 支持，供 DComp swapchain 使用）
    let mut device: Option<ID3D11Device> = None;
    let mut feature_level = D3D_FEATURE_LEVEL(0);
    let mut context: Option<ID3D11DeviceContext> = None;
    let feature_levels = [
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    ];
    if unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&feature_levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut feature_level),
            Some(&mut context),
        )
    }
    .is_err()
    {
        return false;
    }
    let device = match device {
        Some(d) => d,
        None => return false,
    };

    // 2) DXGI 工厂
    let factory: IDXGIFactory2 = match unsafe { CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0)) } {
        Ok(f) => f,
        Err(_) => return false,
    };

    // 3) 合成用 swapchain（alpha 预乘 → 透明）
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    unsafe { let _ = GetClientRect(hwnd, &mut rect); }
    let width = ((rect.right - rect.left).max(1)) as u32;
    let height = ((rect.bottom - rect.top).max(1)) as u32;
    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: width,
        Height: height,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        BufferCount: 2,
        Scaling: DXGI_SCALING_NONE,
        SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
        AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
        ..Default::default()
    };
    let swap: IDXGISwapChain1 = match unsafe { factory.CreateSwapChainForComposition(&device, &desc, None) } {
        Ok(s) => s,
        Err(_) => return false,
    };

    // 4) DComp 设备 / 目标 / 视觉（渲染设备传 None，DComp 自建）
    let dcomp: IDCompositionDevice = match unsafe { DCompositionCreateDevice::<Option<&IDXGIDevice>, IDCompositionDevice>(None) } {
        Ok(d) => d,
        Err(_) => return false,
    };
    let target: IDCompositionTarget = match unsafe { dcomp.CreateTargetForHwnd(hwnd, true) } {
        Ok(t) => t,
        Err(_) => return false,
    };
    let visual: IDCompositionVisual = match unsafe { dcomp.CreateVisual() } {
        Ok(v) => v,
        Err(_) => return false,
    };
    // 视觉内容 = swapchain（SetContent 接收 Param<IUnknown>，传 &swap）
    if unsafe { visual.SetContent(&swap) }.is_err() {
        return false;
    }
    if unsafe { target.SetRoot(&visual) }.is_err() {
        return false;
    }
    if unsafe { dcomp.Commit() }.is_err() {
        return false;
    }

    // 5) 交予 WebView2（跨 windows-core 0.61/0.62 桥接 IUnknown）
    // cast::<IUnknown> 内部 QueryInterface 会 AddRef（+1 引用）；forget 该临时以避免重复 Release，
    // 由 from_raw 把所有权转给 windows-core 0.61 的 IUnknown（WebView2 侧泛型约束 0.61 Interface）。
    let visual_unknown: IUnknown = match visual.cast() {
        Ok(u) => u,
        Err(_) => return false,
    };
    let raw_visual: *mut std::ffi::c_void = visual_unknown.as_raw();
    std::mem::forget(visual_unknown);
    let visual_for_wv2: IUnknown061 = unsafe { IUnknown061::from_raw(raw_visual) };
    if unsafe { comp.SetRootVisualTarget(&visual_for_wv2) }.is_err() {
        return false;
    }

    // 6) 移除 WS_EX_LAYERED（最后一步；此前任何失败都保持 layered 行为）
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !(WS_EX_LAYERED.0 as isize));
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE,
        );
    }

    DCOMP_ACTIVE.lock().unwrap().insert(
        label.to_string(),
        DcompKeep {
            _device: dcomp,
            _target: target,
            _visual: visual,
            _swap: swap,
        },
    );
    true
}
