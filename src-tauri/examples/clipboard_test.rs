// 剪贴板写入算法的「全面彻底」离线测试。
//
// 目标：用与 screenshot.rs `build_dib_and_png` + `write_clipboard_win32_fallback` 完全相同的
// Win32 算法（OpenClipboard(NULL) + EmptyClipboard + SetClipboardData(CF_DIB) + SetClipboardData("PNG")）
// 写入一张测试图，然后从两个维度验证：
//   1) 进程内回读：OpenClipboard + GetClipboardData(CF_DIB / "PNG")，确认字节确实在剪贴板上；
//   2) 跨进程回读：派生 powershell `Get-Clipboard -Format Image`，模拟「在微信里 Ctrl+V」的
//      跨进程读取，确认数据真的存活在系统剪贴板（不被本进程/WebView2 清空）。
//
// 运行：cargo run --example clipboard_test
// 若跨进程读回为空但进程内回读正常 → 算法本身没问题，问题在「写入后被别的进程清空 / 目标应用读取方式」。

use std::process::Command;

use image::{ImageBuffer, Rgba};

unsafe fn build_dib_and_png(
    raw: &[u8],
    w: u32,
    h: u32,
    png: &[u8],
) -> Result<(winapi::shared::minwindef::HGLOBAL, winapi::shared::minwindef::HGLOBAL), String> {
    let row_bytes = (w as usize) * 4;
    let pixel_bytes = (w as usize) * (h as usize) * 4;
    let header_size = std::mem::size_of::<winapi::um::wingdi::BITMAPINFOHEADER>();
    let dib_total = header_size + pixel_bytes;

    let h_dib = winapi::um::winbase::GlobalAlloc(winapi::um::winbase::GMEM_MOVEABLE, dib_total);
    if h_dib.is_null() {
        return Err("GlobalAlloc (DIB) 失败".into());
    }
    let ptr = winapi::um::winbase::GlobalLock(h_dib);
    if ptr.is_null() {
        winapi::um::winbase::GlobalFree(h_dib);
        return Err("GlobalLock (DIB) 失败".into());
    }
    let hdr = ptr as *mut winapi::um::wingdi::BITMAPINFOHEADER;
    (*hdr).biSize = header_size as u32;
    (*hdr).biWidth = w as i32;
    (*hdr).biHeight = h as i32; // 正数 = bottom-up
    (*hdr).biPlanes = 1;
    (*hdr).biBitCount = 32;
    (*hdr).biCompression = winapi::um::wingdi::BI_RGB;
    (*hdr).biSizeImage = pixel_bytes as u32;
    (*hdr).biXPelsPerMeter = 0;
    (*hdr).biYPelsPerMeter = 0;
    (*hdr).biClrUsed = 0;
    (*hdr).biClrImportant = 0;
    let px = (ptr as *mut u8).add(header_size);
    let dst = std::slice::from_raw_parts_mut(px, pixel_bytes);
    for y in 0..(h as usize) {
        let src_off = y * row_bytes;
        let dst_off = (h as usize - 1 - y) * row_bytes;
        let src_row = &raw[src_off..src_off + row_bytes];
        let dst_row = &mut dst[dst_off..dst_off + row_bytes];
        for x in 0..(w as usize) {
            let si = x * 4;
            dst_row[si] = src_row[si + 2];
            dst_row[si + 1] = src_row[si + 1];
            dst_row[si + 2] = src_row[si];
            dst_row[si + 3] = 255;
        }
    }
    winapi::um::winbase::GlobalUnlock(h_dib);

    let h_png = winapi::um::winbase::GlobalAlloc(winapi::um::winbase::GMEM_MOVEABLE, png.len());
    if h_png.is_null() {
        winapi::um::winbase::GlobalFree(h_dib);
        return Err("GlobalAlloc (PNG) 失败".into());
    }
    let pptr = winapi::um::winbase::GlobalLock(h_png);
    if pptr.is_null() {
        winapi::um::winbase::GlobalFree(h_dib);
        winapi::um::winbase::GlobalFree(h_png);
        return Err("GlobalLock (PNG) 失败".into());
    }
    std::ptr::copy_nonoverlapping(png.as_ptr(), pptr as *mut u8, png.len());
    winapi::um::winbase::GlobalUnlock(h_png);

    Ok((h_dib, h_png))
}

unsafe fn write_win32(h_dib: winapi::shared::minwindef::HGLOBAL, h_png: winapi::shared::minwindef::HGLOBAL, png_format: u32) -> Result<(), String> {
    let mut opened = false;
    for _ in 0..10u32 {
        if winapi::um::winuser::OpenClipboard(std::ptr::null_mut()) != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if !opened {
        winapi::um::winbase::GlobalFree(h_dib);
        winapi::um::winbase::GlobalFree(h_png);
        return Err("OpenClipboard 失败".into());
    }
    winapi::um::winuser::EmptyClipboard();
    let r_dib = winapi::um::winuser::SetClipboardData(winapi::um::winuser::CF_DIB, h_dib as *mut _);
    eprintln!("[测试] SetClipboardData(CF_DIB) = {}", if r_dib.is_null() { "失败" } else { "成功" });
    let r_png = if png_format != 0 {
        let r = winapi::um::winuser::SetClipboardData(png_format, h_png as *mut _);
        eprintln!("[测试] SetClipboardData(PNG) = {}", if r.is_null() { "失败" } else { "成功" });
        r
    } else {
        std::ptr::null_mut()
    };
    winapi::um::winuser::CloseClipboard();
    if r_dib.is_null() {
        winapi::um::winbase::GlobalFree(h_dib);
    }
    if r_png.is_null() {
        winapi::um::winbase::GlobalFree(h_png);
    }
    if r_dib.is_null() && r_png.is_null() {
        return Err("SetClipboardData 全部失败".into());
    }
    Ok(())
}

unsafe fn readback_in_process() -> String {
    let mut opened = false;
    for _ in 0..5u32 {
        if winapi::um::winuser::OpenClipboard(std::ptr::null_mut()) != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    if !opened {
        return "进程内回读：OpenClipboard 失败".into();
    }
    let mut out = String::new();
    if winapi::um::winuser::IsClipboardFormatAvailable(winapi::um::winuser::CF_DIB) != 0 {
        let h = winapi::um::winuser::GetClipboardData(winapi::um::winuser::CF_DIB);
        if !h.is_null() {
            let p = winapi::um::winbase::GlobalLock(h);
            if !p.is_null() {
                let hdr = p as *const winapi::um::wingdi::BITMAPINFOHEADER;
                let w = (*hdr).biWidth;
                let hh = (*hdr).biHeight;
                let size = (*hdr).biSizeImage;
                out.push_str(&format!("进程内 CF_DIB 回读 OK: {}x{} (biHeight={}, biSizeImage={})\n", w, hh, hh, size));
                winapi::um::winbase::GlobalUnlock(h);
            } else {
                out.push_str("进程内 CF_DIB 回读：GlobalLock 失败\n");
            }
        } else {
            out.push_str("进程内 CF_DIB 回读：GetClipboardData 返回 NULL\n");
        }
    } else {
        out.push_str("进程内：剪贴板无 CF_DIB 格式\n");
    }
    let png_format = winapi::um::winuser::RegisterClipboardFormatA(b"PNG\0".as_ptr() as *const i8);
    if png_format != 0 && winapi::um::winuser::IsClipboardFormatAvailable(png_format) != 0 {
        let h = winapi::um::winuser::GetClipboardData(png_format);
        if !h.is_null() {
            let p = winapi::um::winbase::GlobalLock(h);
            if !p.is_null() {
                let len = winapi::um::winbase::GlobalSize(h);
                out.push_str(&format!("进程内 PNG 回读 OK: {} 字节\n", len));
                winapi::um::winbase::GlobalUnlock(h);
            } else {
                out.push_str("进程内 PNG 回读：GlobalLock 失败\n");
            }
        } else {
            out.push_str("进程内 PNG 回读：GetClipboardData 返回 NULL\n");
        }
    } else {
        out.push_str("进程内：剪贴板无 PNG 格式\n");
    }
    winapi::um::winuser::CloseClipboard();
    out
}

fn cross_process_check() -> String {
    // 模拟「在微信里 Ctrl+V」：powershell 跨进程读取剪贴板图片。
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-Clipboard -Format Image | ForEach-Object { \"$($_.Width)x$($_.Height)\" })",
        ])
        .output();
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if s.is_empty() {
                if e.is_empty() {
                    "跨进程(PowerShell)读回：空（剪贴板无图片，或目标进程未读到）".into()
                } else {
                    format!("跨进程(PowerShell)读回：空（stderr: {}）", e)
                }
            } else {
                format!("跨进程(PowerShell)读回 OK: {}", s)
            }
        }
        Err(e) => format!("跨进程检查失败（无法启动 powershell）: {}", e),
    }
}

fn main() {
    // 生成 400x300 测试图（红绿渐变 + 蓝框），明显区别于空白。
    let w = 400u32;
    let h = 300u32;
    let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let r = ((x as f32 / w as f32) * 255.0) as u8;
            let g = ((y as f32 / h as f32) * 255.0) as u8;
            let b = 128u8;
            img.put_pixel(x, y, Rgba([r, g, b, 255]));
        }
    }
    // 先编码 PNG（借 img），再取 raw（消费 img）
    let mut png_buf: Vec<u8> = Vec::new();
    {
        let mut cur = std::io::Cursor::new(&mut png_buf);
        img.write_to(&mut cur, image::ImageFormat::Png).unwrap();
    }
    let raw = img.into_raw();

    let png_format = unsafe { winapi::um::winuser::RegisterClipboardFormatA(b"PNG\0".as_ptr() as *const i8) };
    eprintln!("[测试] PNG 格式 ID = {}", png_format);

    let (h_dib, h_png) = unsafe { build_dib_and_png(&raw, w, h, &png_buf).expect("构建 DIB/PNG 失败") };
    unsafe { write_win32(h_dib, h_png, png_format).expect("写入剪贴板失败") };

    println!("=== 进程内回读 ===");
    println!("{}", unsafe { readback_in_process() });

    // 给系统一点时间稳定剪贴板，再做跨进程检查
    std::thread::sleep(std::time::Duration::from_millis(200));
    println!("=== 跨进程回读（模拟微信 Ctrl+V）===");
    println!("{}", cross_process_check());

    println!("\n提示：若跨进程读回 OK，说明算法正确、数据存活在系统剪贴板；");
    println!("此时若真实 App 里粘贴仍为空，则问题在 App 写入后「被本进程/WebView2 清空」或目标应用读取方式。");
}
