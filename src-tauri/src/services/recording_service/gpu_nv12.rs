//! 进程内 GPU RGBA→NV12 零拷贝色彩转换（阶段二核心）。
//!
//! 旧链路：WGC 帧 → CPU readback(RGBA) → memcpy → ffmpeg 子进程 stdin(RGBA 8.3MB/帧) →
//! ffmpeg `sws_scale`(CPU RGBA→YUV) → 硬件编码。1080p60 下约 4 趟 ×8.3MB ≈ 2GB/s 内存带宽 +
//! 一个 CPU 核做色彩转换 = “常态卡顿”真源。
//!
//! 新链路：WGC 帧纹理 → `CopyResource`(GPU) → D3D11 Video Processor `RGBA→NV12`(GPU) →
//! `CopyResource` 到 staging → Map 读出 NV12(字节减半 3.11MB) → ffmpeg stdin(NV12) → 硬件编码。
//! 去掉 ffmpeg 的 `sws_scale`（省一个 CPU 核），管道字节减半；全部色彩转换在 GPU 完成，
//! 捕获线程仅在回调里做 1 次 GPU CopyResource + 1 次 Map（与旧 readback 同量级延迟，但后续零 CPU 转换）。
//!
//! 设备能力：windows-capture 自建设备仅带 `D3D11_CREATE_DEVICE_BGRA_SUPPORT`，未带
//! `D3D11_CREATE_DEVICE_VIDEO_SUPPORT`；但 MSDN 注明该标志“not currently used / 提供未来使用”，
//! Video Processor 在任意 D3D11 设备上本就可用，故 `probe_nv12` 与真实捕获设备能力一致。

use std::mem::ManuallyDrop;

use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Foundation::HMODULE;
use windows::core::{Interface, Result, BOOL};

/// 进程内 RGBA→NV12 转换器。持有在捕获所用同一台 `ID3D11Device` 上创建的 Video Processor 管线，
/// 纹理/视图在构造时一次性创建，每帧仅 `CopyResource` + `VideoProcessorBlt` + 读回。
pub struct GpuNv12Converter {
    ctx: ID3D11DeviceContext,
    video_ctx: ID3D11VideoContext,
    input_rgba: ID3D11Resource,
    nv12_rt: ID3D11Resource,
    nv12_staging: ID3D11Resource,
    video_processor: ID3D11VideoProcessor,
    output_view: ID3D11VideoProcessorOutputView,
    input_view: ID3D11VideoProcessorInputView,
    width: u32,
    height: u32,
}

unsafe fn create_tex(
    device: &ID3D11Device,
    w: u32,
    h: u32,
    fmt: DXGI_FORMAT,
    usage: D3D11_USAGE,
    bind: D3D11_BIND_FLAG,
    cpu: D3D11_CPU_ACCESS_FLAG,
) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: fmt,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: usage,
        BindFlags: bind.0 as u32,
        CPUAccessFlags: cpu.0 as u32,
        MiscFlags: D3D11_RESOURCE_MISC_FLAG(0).0 as u32,
    };
    let mut tex = None;
    device.CreateTexture2D(&desc, None, Some(&mut tex))?;
    Ok(tex.unwrap())
}

impl GpuNv12Converter {
    /// 在指定设备/上下文上构建完整 Video Processor 管线（输入 RGBA 纹理、NV12 输出/暂存纹理、视图）。
    /// `input_fmt` 必须与 WGC 帧纹理格式一致（通常为 `DXGI_FORMAT_R8G8B8A8_UNORM` 或 `..._B8G8R8A8_UNORM`）。
    pub fn new(
        device: &ID3D11Device,
        ctx: &ID3D11DeviceContext,
        w: u32,
        h: u32,
        input_fmt: DXGI_FORMAT,
    ) -> Result<Self> {
        let video_device: ID3D11VideoDevice = device.cast()?;
        let video_ctx: ID3D11VideoContext = ctx.cast()?;
        unsafe {
            // 输入 RGBA 纹理：WGC 原纹理只带 SHADER_RESOURCE，Video Processor 输入视图需要 RT|VIDEO_ENCODER，
            // 故建一张同格式的可渲染纹理，每帧 CopyResource 进来。
            let input_rgba = create_tex(
                device,
                w,
                h,
                input_fmt,
                D3D11_USAGE_DEFAULT,
                D3D11_BIND_RENDER_TARGET | D3D11_BIND_VIDEO_ENCODER,
                D3D11_CPU_ACCESS_FLAG(0),
            )?;
            // NV12 输出纹理（GPU 渲染目标）与暂存纹理（CPU 可读）。
            let nv12_rt = create_tex(
                device,
                w,
                h,
                DXGI_FORMAT_NV12,
                D3D11_USAGE_DEFAULT,
                D3D11_BIND_RENDER_TARGET | D3D11_BIND_VIDEO_ENCODER,
                D3D11_CPU_ACCESS_FLAG(0),
            )?;
            let nv12_staging = create_tex(
                device,
                w,
                h,
                DXGI_FORMAT_NV12,
                D3D11_USAGE_STAGING,
                D3D11_BIND_FLAG(0),
                D3D11_CPU_ACCESS_READ,
            )?;

            let content_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT(0), // PROGRESSIVE
                InputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
                InputWidth: w,
                InputHeight: h,
                OutputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
                OutputWidth: w,
                OutputHeight: h,
                Usage: D3D11_VIDEO_USAGE(1), // OPTIMAL_SPEED
            };
            let enumerator = video_device.CreateVideoProcessorEnumerator(&content_desc)?;
            let video_processor = video_device.CreateVideoProcessor(Some(&enumerator), 0)?;

            let in_res: ID3D11Resource = input_rgba.cast()?;
            let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION(1), // TEXTURE2D
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 },
                },
            };
            let mut input_view = None;
            video_device.CreateVideoProcessorInputView(
                Some(&in_res),
                Some(&enumerator),
                &input_desc,
                Some(&mut input_view),
            )?;

            let out_res: ID3D11Resource = nv12_rt.cast()?;
            let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION(1), // TEXTURE2D
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut output_view = None;
            video_device.CreateVideoProcessorOutputView(
                Some(&out_res),
                Some(&enumerator),
                &output_desc,
                Some(&mut output_view),
            )?;

            Ok(Self {
                ctx: ctx.clone(),
                video_ctx,
                input_rgba: in_res,
                nv12_rt: out_res,
                nv12_staging: nv12_staging.cast()?,
                video_processor,
                output_view: output_view.unwrap(),
                input_view: input_view.unwrap(),
                width: w,
                height: h,
            })
        }
    }

    /// 将一张 WGC 帧纹理（RGBA）转换为 NV12 写入 `out`。失败返回 `Err`（调用方应本帧回退/跳过，
    /// 切勿将错误格式字节写入 ffmpeg，以免损坏视频）。
    pub fn convert(&self, src: &ID3D11Texture2D, out: &mut Vec<u8>) -> Result<()> {
        unsafe {
            // 1) WGC 帧纹理 → 可渲染 RGBA 纹理（GPU 拷贝，无 CPU 参与）
            let src_res: ID3D11Resource = src.cast()?;
            self.ctx.CopyResource(Some(&self.input_rgba), Some(&src_res));

            // 2) Video Processor：RGBA → NV12（GPU）。输入视图每次 blt 需持有一个引用。
            let input_surface = ManuallyDrop::new(Some(self.input_view.clone()));
            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: BOOL(1),
                OutputIndex: 0,
                InputFrameOrField: 0,
                PastFrames: 0,
                FutureFrames: 0,
                ppPastSurfaces: std::ptr::null_mut(),
                pInputSurface: input_surface,
                ppFutureSurfaces: std::ptr::null_mut(),
                ppPastSurfacesRight: std::ptr::null_mut(),
                pInputSurfaceRight: ManuallyDrop::new(None),
                ppFutureSurfacesRight: std::ptr::null_mut(),
            };
            let mut streams = [stream];
            self.video_ctx.VideoProcessorBlt(
                Some(&self.video_processor),
                Some(&self.output_view),
                0,
                &streams,
            )?;
            // 释放本帧 clone 出的输入视图引用（避免引用计数泄漏）
            let _ = ManuallyDrop::take(&mut streams[0].pInputSurface);

            // 3) NV12 渲染目标 → 暂存纹理（GPU 拷贝）
            self.ctx
                .CopyResource(Some(&self.nv12_staging), Some(&self.nv12_rt));

            // 4) Map 读出 NV12（Y 平面在前，UV 交错平面在后；行 pitch 可能含对齐填充，逐行拷贝有效字节）
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.ctx.Map(
                Some(&self.nv12_staging),
                0,
                D3D11_MAP(1), // READ
                0,
                Some(&mut mapped),
            )?;
            let w = self.width as usize;
            let h = self.height as usize;
            out.clear();
            out.reserve(w * h + w * h / 2);
            let base = mapped.pData as *const u8;
            let pitch = mapped.RowPitch as usize;
            for y in 0..h {
                let s = base.add(y * pitch);
                out.extend_from_slice(std::slice::from_raw_parts(s, w));
            }
            let uv_base = base.add(h * pitch);
            for y in 0..(h / 2) {
                let s = uv_base.add(y * pitch);
                out.extend_from_slice(std::slice::from_raw_parts(s, w));
            }
            self.ctx.Unmap(Some(&self.nv12_staging), 0);
        }
        Ok(())
    }
}

/// 探针：用临时 D3D11 设备构建完整 Video Processor 管线并对一张 dummy 纹理做一次 RGBA→NV12，
/// 成功则说明本机驱动支持进程内 GPU 转换。返回 `true` 时调用方应将 ffmpeg 输入设为 NV12 并去掉 `sws_scale`。
pub fn probe_nv12(w: u32, h: u32, input_fmt: DXGI_FORMAT) -> bool {
    unsafe {
        let feature_levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
        let mut device = None;
        let mut feature_level = D3D_FEATURE_LEVEL(0);
        let mut ctx = None;
        if D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&feature_levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut feature_level),
            Some(&mut ctx),
        )
        .is_err()
        {
            return false;
        }
        let device = match device {
            Some(d) => d,
            None => return false,
        };
        let ctx = match ctx {
            Some(c) => c,
            None => return false,
        };
        let Ok(conv) = GpuNv12Converter::new(&device, &ctx, w, h, input_fmt) else {
            return false;
        };
        // dummy 源纹理（DEFAULT + SHADER_RESOURCE），填充后做一次转换验证管线可用
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: input_fmt,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: D3D11_CPU_ACCESS_FLAG(0).0 as u32,
            MiscFlags: D3D11_RESOURCE_MISC_FLAG(0).0 as u32,
        };
        let mut tex = None;
        if device.CreateTexture2D(&desc, None, Some(&mut tex)).is_err() {
            return false;
        }
        let tex = match tex {
            Some(t) => t,
            None => return false,
        };
        let mut out = Vec::new();
        conv.convert(&tex, &mut out).is_ok()
    }
}
