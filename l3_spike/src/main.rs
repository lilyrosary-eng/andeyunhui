// L3 零拷贝可行性 spike（多格式版）—— 验证跨适配器共享纹理能否在目标 GPU 上打开。
// 源 = NVIDIA dGPU（捕获侧），目标 = Intel iGPU（QSV 侧）。测试 NV12 / BGRA8 / RGBA8。
use windows::core::Interface;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::System::Com::*;

const INTEL_VENDOR: u32 = 0x8086;
const NVIDIA_VENDOR: u32 = 0x10DE;

#[derive(Clone)]
struct AdapterInfo {
    index: u32,
    vendor: u32,
    description: String,
}

fn main() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
            Ok(f) => f,
            Err(e) => {
                eprintln!("CreateDXGIFactory1 失败: {e:?}");
                return;
            }
        };

        let mut adapters: Vec<AdapterInfo> = Vec::new();
        let mut i = 0u32;
        loop {
            let adapter = match factory.EnumAdapters1(i) {
                Ok(a) => a,
                Err(_) => break,
            };
            let desc = adapter.GetDesc1().expect("GetDesc1");
            let desc_str = String::from_utf16_lossy(
                &desc.Description[..desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len())],
            );
            adapters.push(AdapterInfo { index: i, vendor: desc.VendorId, description: desc_str });
            i += 1;
        }

        let source = adapters
            .iter()
            .find(|a| a.vendor == NVIDIA_VENDOR)
            .or_else(|| adapters.iter().find(|a| a.vendor != INTEL_VENDOR))
            .or_else(|| adapters.last())
            .cloned();
        let dest = adapters
            .iter()
            .find(|a| a.vendor == INTEL_VENDOR)
            .or_else(|| adapters.iter().find(|a| Some(a.index) != source.as_ref().map(|s| s.index)))
            .cloned();
        let (source, dest) = match (source, dest) {
            (Some(s), Some(d)) => (s, d),
            _ => {
                eprintln!("无法选出源/目标适配器");
                return;
            }
        };
        println!(
            "源设备: [{}] {} | 目标设备: [{}] {} | 跨适配器={}",
            source.index,
            source.description,
            dest.index,
            dest.description,
            if source.index != dest.index { "是" } else { "否" }
        );

        let src_adapter = match get_adapter(&factory, source.index) {
            Some(a) => a,
            None => {
                eprintln!("获取源适配器失败");
                return;
            }
        };
        let mut src_device = None;
        let mut _src_ctx = None;
        if let Err(e) = D3D11CreateDevice(
            Some(&src_adapter),
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            None,
            D3D11_SDK_VERSION,
            Some(&mut src_device),
            None,
            Some(&mut _src_ctx),
        ) {
            eprintln!("源设备 D3D11CreateDevice 失败: {e:?}");
            return;
        }
        let src_device = src_device.unwrap();

        let dst_adapter = match get_adapter(&factory, dest.index) {
            Some(a) => a,
            None => {
                eprintln!("获取目标适配器失败");
                return;
            }
        };
        let mut dst_device = None;
        let mut _dst_ctx = None;
        if let Err(e) = D3D11CreateDevice(
            Some(&dst_adapter),
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            None,
            D3D11_SDK_VERSION,
            Some(&mut dst_device),
            None,
            Some(&mut _dst_ctx),
        ) {
            eprintln!("目标设备 D3D11CreateDevice 失败: {e:?}");
            return;
        }
        let dst_device1: ID3D11Device1 = match dst_device.unwrap().cast() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("目标设备 cast ID3D11Device1 失败: {e:?}");
                return;
            }
        };

        // 逐格式测试跨适配器共享打开
        let formats: &[(DXGI_FORMAT, &str)] = &[
            (DXGI_FORMAT_NV12, "NV12"),
            (DXGI_FORMAT_B8G8R8A8_UNORM, "BGRA8"),
            (DXGI_FORMAT_R8G8B8A8_UNORM, "RGBA8"),
        ];
        let mut any_ok = false;
        for (fmt, name) in formats {
            let bind_flags = (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32;
            let cpu_flags = D3D11_CPU_ACCESS_FLAG(0).0 as u32;
            let misc_flags =
                (D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX).0 as u32;
            let tex_desc = D3D11_TEXTURE2D_DESC {
                Width: 1920,
                Height: 1080,
                MipLevels: 1,
                ArraySize: 1,
                Format: *fmt,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: bind_flags,
                CPUAccessFlags: cpu_flags,
                MiscFlags: misc_flags,
                ..Default::default()
            };
            let mut src_tex = None;
            if let Err(e) = src_device.CreateTexture2D(&tex_desc, None, Some(&mut src_tex)) {
                println!("[{}] 创建纹理失败: {e:?}", name);
                continue;
            }
            let src_res: IDXGIResource1 = match src_tex.unwrap().cast() {
                Ok(r) => r,
                Err(e) => {
                    println!("[{}] cast IDXGIResource1 失败: {e:?}", name);
                    continue;
                }
            };
            let handle = match src_res.CreateSharedHandle(None, DXGI_SHARED_RESOURCE_READ.0, None) {
                Ok(h) => h,
                Err(e) => {
                    println!("[{}] CreateSharedHandle 失败: {e:?}", name);
                    continue;
                }
            };
            match dst_device1.OpenSharedResource1::<ID3D11Texture2D>(handle) {
                Ok(_) => {
                    println!("✅ [{}] 跨适配器 OpenSharedResource1 成功", name);
                    any_ok = true;
                }
                Err(e) => {
                    let code = e.code().0 as u32;
                    println!(
                        "❌ [{}] 跨适配器打开失败: HRESULT {:#010x}{}",
                        name,
                        code,
                        if code == 0x80070057 { " (E_INVALIDARG)" } else { "" }
                    );
                }
            }
        }

        println!("\n[总结]");
        if any_ok {
            println!("存在可跨适配器共享的格式 → L3 方案 1 仍可行：共享该格式纹理，再在 iGPU 上转 NV12 喂 QSV，全程 GPU、无 CPU 落地。");
        } else {
            println!("所有格式均 E_INVALIDARG → 跨适配器共享纹理在本机被驱动硬墙挡死，L3 方案 1 死路；");
            println!("唯一零拷贝路径 = 编码器与捕获同设备(NVIDIA dGPU)= 启用 nvenc(L0，需升级驱动)。QSV 任何路径(iGPU)在此机都必然 CPU 落地。");
        }
    }
}

fn get_adapter(factory: &IDXGIFactory1, index: u32) -> Option<IDXGIAdapter> {
    unsafe {
        let a = factory.EnumAdapters1(index).ok()?;
        a.cast::<IDXGIAdapter>().ok()
    }
}
