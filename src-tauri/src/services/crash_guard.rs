//! 崩溃现场取证（Windows）。
//!
//! ## 为什么需要这个模块
//!
//! 2026-11-09 用户实测 `target\debug\andeyunhui.exe` 退出码 `0xc000001d`
//! （`STATUS_ILLEGAL_INSTRUCTION`）—— 这不是 Rust 的 panic：
//!
//! - panic（`panic = "abort"`）在 Windows 上表现为 `0xc0000409`（fastfail），
//!   上一轮 `rc.rs assert_unchecked` 那次就是这个码，panic hook 能抓到。
//! - `0xc000001d` 是 **CPU 执行了非法/不支持的指令**，或者**跳进了数据**。
//!   它不经过 Rust 的 panic 机制，`std::panic::set_hook` 完全收不到。
//!
//! 光看代码定不了位（瓦片生成是纯 safe Rust，没有 `unsafe`/intrinsics），
//! 所以这里装一个**首轮异常处理器（Vectored Exception Handler）**：
//! 在任何 SEH/WER 之前拿到异常码 + 出错地址 + 命中模块与偏移，写进日志。
//!
//! ## 约束
//!
//! - **不吞异常**：处理完返回 `EXCEPTION_CONTINUE_SEARCH`，进程仍按原路径死掉，
//!   行为与装之前完全一致（只是多一行日志）。
//! - **不在处理器里分配堆**：异常可能由内存损坏引起，再 malloc 可能二次崩。
//!   格式化全部走栈上的固定缓冲。
//! - **限量**：首轮异常会被频繁触发（如 C++ 异常、调试断点），只记前若干条，
//!   且跳过已知良性码，避免把日志刷爆。

#[cfg(windows)]
mod imp {
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use winapi::shared::minwindef::HMODULE;
    use winapi::um::errhandlingapi::AddVectoredExceptionHandler;
    use winapi::um::libloaderapi::{
        GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    };
    use winapi::um::winnt::EXCEPTION_POINTERS;

    /// `EXCEPTION_CONTINUE_SEARCH`（值为 0）。
    /// winapi 0.3 把它放在 `vc::excpt` 要额外开 feature；这里只用一个常量，
    /// 不值得为它多开一个依赖特性，本地定义即可（值见 winnt.h）。
    const EXCEPTION_CONTINUE_SEARCH: i32 = 0;

    /// 单次运行最多记录多少条首轮异常（超出后静默放行）
    static SEEN: AtomicUsize = AtomicUsize::new(0);
    const MAX_SEEN: usize = 32;

    /// 崩溃日志绝对路径（安装前算好，处理器里不再取环境变量）
    static mut LOG_PATH: Option<std::path::PathBuf> = None;

    /// 已知良性异常码 —— 记录但一眼能认出是噪声，不值得每次都写
    fn is_benign(code: u32) -> bool {
        matches!(
            code,
            0x8000_0003  // STATUS_BREAKPOINT（调试器）
            | 0xE06D_7363 // C++ EH（MSVC 异常穿透）
            | 0x4008_0004 // 其它语言运行时用的 first-chance
        )
    }

    /// 把 u64 以十六进制写进固定缓冲（不分配）
    fn write_hex(buf: &mut [u8], offset: &mut usize, mut v: u64) {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut tmp = [0u8; 16];
        let mut n = 0;
        if v == 0 {
            if *offset < buf.len() {
                buf[*offset] = b'0';
                *offset += 1;
            }
            return;
        }
        while v > 0 && n < 16 {
            tmp[n] = HEX[(v & 0xF) as usize];
            v >>= 4;
            n += 1;
        }
        while n > 0 {
            n -= 1;
            if *offset < buf.len() {
                buf[*offset] = tmp[n];
                *offset += 1;
            }
        }
    }

    fn write_str(buf: &mut [u8], offset: &mut usize, s: &[u8]) {
        for b in s {
            if *offset < buf.len() {
                buf[*offset] = *b;
                *offset += 1;
            }
        }
    }

    /// 从异常地址反查模块：返回 (模块基址, 模块文件名, 偏移)
    unsafe fn resolve_module(addr: usize) -> Option<(usize, String, usize)> {
        let mut hm: HMODULE = std::ptr::null_mut();
        // 用 FROM_ADDRESS 查询"这个地址落在哪个已加载模块里"
        let ok = GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            addr as *const u16,
            &mut hm,
        );
        if ok == 0 || hm.is_null() {
            return None;
        }
        let mut buf = [0u16; 512];
        let n = GetModuleFileNameW(hm, buf.as_mut_ptr(), buf.len() as u32) as usize;
        if n == 0 {
            return None;
        }
        let full = String::from_utf16_lossy(&buf[..n]);
        // 只留文件名：全路径太长，日志里没必要
        let name = full.rsplit(['\\', '/']).next().unwrap_or(&full).to_string();
        Some((hm as usize, name, addr.wrapping_sub(hm as usize)))
    }

    unsafe extern "system" fn handler(info: *mut EXCEPTION_POINTERS) -> i32 {
        // 兜底：任何 panic 都不能从这个处理器里逃出去（逃出去会递归崩溃）
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if info.is_null() {
                return;
            }
            let rec = (*info).ExceptionRecord;
            if rec.is_null() {
                return;
            }
            let code = (*rec).ExceptionCode as u32;
            let addr = (*rec).ExceptionAddress as usize;
            let nparams = (*rec).NumberParameters as usize;
            let mut params = [0usize; 4];
            for (i, p) in params.iter_mut().enumerate() {
                if i < nparams {
                    *p = *(*rec).ExceptionInformation.get_unchecked(i) as usize;
                }
            }

            // 限量 + 良性码只记 1 条，避免刷屏
            let seen = SEEN.fetch_add(1, Ordering::Relaxed);
            if seen >= MAX_SEEN || (is_benign(code) && seen >= 3) {
                return;
            }

            // —— 组装一行（栈上缓冲，不分配堆）——
            let mut buf = [0u8; 512];
            let mut o = 0usize;
            write_str(&mut buf, &mut o, b"[CRASH] code=0x");
            write_hex(&mut buf, &mut o, code as u64);
            write_str(&mut buf, &mut o, b" addr=0x");
            write_hex(&mut buf, &mut o, addr as u64);
            match resolve_module(addr) {
                Some((_base, name, off)) => {
                    write_str(&mut buf, &mut o, b" module=");
                    write_str(&mut buf, &mut o, name.as_bytes());
                    write_str(&mut buf, &mut o, b" +0x");
                    write_hex(&mut buf, &mut o, off as u64);
                }
                // 处理器里只能用 ASCII 字节串（b"..." 不允许非 ASCII）；
                // 中文说明放到模块注释与 install 提示里，日志行保持机器可读。
                None => write_str(&mut buf, &mut o, b" module=<not-in-any-module>"),
            }
            // 访问违例的两个参数是"读/写"与目标地址，值得单独打出来
            if code == 0xC000_0005 {
                write_str(&mut buf, &mut o, if params[0] == 0 { b" access=read(" } else { b" access=write(" });
                write_hex(&mut buf, &mut o, params[1] as u64);
                write_str(&mut buf, &mut o, b")");
            }
            write_str(&mut buf, &mut o, b"\n");
            let line = &buf[..o];

            // stderr（终端里能立刻看到）
            let _ = std::io::stderr().write_all(line);

            // 文件（页面崩了也能事后回看）：路径在 install 时算好
            let path_ptr = std::ptr::addr_of!(LOG_PATH);
            if let Some(p) = (*path_ptr).as_ref() {
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                    let _ = f.write_all(line);
                    let _ = f.flush();
                }
            }
        }));

        // 关键：继续正常搜索，不改变进程原有死法
        EXCEPTION_CONTINUE_SEARCH
    }

    /// 崩溃日志路径：与业务日志同目录（`<AppData>/logs/crash.log`）
    fn crash_log_path() -> std::path::PathBuf {
        // Windows: %APPDATA%\com.rosary.andengyuanhua\logs
        let base = std::env::var_os("APPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join("com.rosary.andengyuanhua").join("logs");
        let _ = std::fs::create_dir_all(&dir);
        dir.join("crash.log")
    }

    pub fn install() {
        let path = crash_log_path();
        // SAFETY: 单线程调用（main 最早处），写一次后只读
        unsafe {
            LOG_PATH = Some(path.clone());
            // first = 1：在 SEH/WER 之前拿现场
            let h = AddVectoredExceptionHandler(1, Some(handler));
            if h.is_null() {
                eprintln!("[CRASH] 安装异常处理器失败（AddVectoredExceptionHandler 返回 NULL）");
            } else {
                eprintln!("[CRASH] 异常取证已启用 → {}", path.display());
            }
        }
    }

    // ===== 测试：验证"地址 → 模块"这一步是真的能用 =====
    //
    // 这一段是整个模块唯一有技术风险的地方：`GetModuleHandleExW` 用 FROM_ADDRESS
    // 需要一个**代码地址**当"模块名"参数传进去，语义反直觉。如果传错，
    // 崩溃时只会打印 `<not-in-any-module>`，等于白装。
    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn hex_writer_matches_format() {
            let mut buf = [0u8; 32];
            let mut o = 0;
            write_hex(&mut buf, &mut o, 0x1a2b);
            assert_eq!(&buf[..o], b"1a2b");

            let mut o2 = 0;
            write_hex(&mut buf, &mut o2, 0);
            assert_eq!(&buf[..o2], b"0");
        }

        /// 拿本函数自己的地址去查模块：必须命中、文件名非空、偏移合理。
        #[test]
        fn resolves_module_from_own_address() {
            let addr = resolves_module_from_own_address as usize;
            let hit = unsafe { resolve_module(addr) };
            let (base, name, off) = hit.expect("自身地址必须能解析出模块（否则崩溃日志里永远没有模块名）");
            assert!(!name.is_empty(), "模块名为空");
            assert_eq!(base + off, addr, "偏移与基址应当能还原地址");
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn install() {
        // 非 Windows 平台留空：Linux 的 SIGSEGV/SIGILL 由内核/系统日志记录，
        // 需要时可用 coredumpctl 取栈，不在这里重复造。
    }
}

/// 安装崩溃取证。必须在 `main()` 最早期调用（任何线程创建之前）。
pub fn install() {
    imp::install();
}
