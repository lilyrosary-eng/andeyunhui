//! 动态插桩（frida-gum FFI 接口占位）
//!
//! 对应逆向细化维度五：幽灵调试与内核级豁免的务实降级版。
//!
//! 替代原方案（桌面不可行）：
//! - ptrace/TracerPid 摘除（Linux 专属）→ 删除
//! - eBPF uprobe 内核态探针（Linux 专属）→ 删除
//! - DR0-DR3 硬件断点非对称部署 → 后续可接 Windows API（SetThreadContext）
//!
//! project_memory 硬约束："硬件 Trace 用 frida-gum 跨平台 FFI 或 Windows ETW"
//!
//! 动态插桩方案（跨平台）：
//! - frida-gum：跨平台 FFI，Windows/Linux/macOS 通用
//!   * Hook SSL_read/SSL_write 捕获明文流量
//!   * Hook strcmp/memcmp 捕获校验值
//!   * Hook encrypt/decrypt 捕获密钥
//! - Windows 专属：VEH（Vectored Exception Handler）替代 ptrace
//!
//! 接口占位：后续接入 frida-gum 或 Windows API

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Hook 目标函数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookTarget {
    /// 函数名（如 SSL_read / strcmp / encrypt）
    pub function_name: String,
    /// 模块名（如 libssl.so / ntdll.dll）
    pub module: String,
    /// Hook 类型
    pub hook_type: HookType,
}

/// Hook 类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum HookType {
    /// 入口 Hook（捕获参数）
    Entry,
    /// 出口 Hook（捕获返回值）
    Exit,
    /// 替换 Hook（替换函数实现）
    Replace,
    /// 调用 Hook（调用原函数前后注入逻辑）
    Inline,
}

/// Hook 捕获结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookCapture {
    /// 目标函数
    pub function: String,
    /// 参数（hex）
    pub args: Vec<String>,
    /// 返回值
    pub return_value: Option<u64>,
    /// 捕获时间戳
    pub timestamp: u64,
}

/// 动态插桩会话
pub struct DynamicSession {
    /// 目标进程 PID
    pub pid: u32,
    /// 目标二进制路径
    pub binary_path: PathBuf,
    /// 已安装的 Hook 列表
    pub hooks: Vec<HookTarget>,
    /// 捕获结果
    pub captures: Vec<HookCapture>,
}

impl DynamicSession {
    pub fn new(pid: u32, binary_path: PathBuf) -> Self {
        Self {
            pid,
            binary_path,
            hooks: Vec::new(),
            captures: Vec::new(),
        }
    }

    /// 安装 Hook（接口占位）
    ///
    /// 后续接入 frida-gum：
    /// 1. 加载 frida-gum 动态库
    /// 2. 附加到目标进程
    /// 3. 创建 Interceptor
    /// 4. 替换目标函数入口
    pub fn install_hook(&mut self, target: HookTarget) -> Result<(), String> {
        log::info!(
            "[reverse] 安装 Hook: {}::{} ({:?})",
            target.module,
            target.function_name,
            target.hook_type
        );
        // TODO: 接入 frida-gum FFI
        self.hooks.push(target);
        log::warn!("[reverse] frida-gum 接口未实现，Hook 仅记录未生效");
        Ok(())
    }

    /// 卸载所有 Hook
    pub fn uninstall_all(&mut self) {
        log::info!("[reverse] 卸载所有 Hook（{}个）", self.hooks.len());
        self.hooks.clear();
    }

    /// 查询捕获结果
    pub fn captures(&self) -> &[HookCapture] {
        &self.captures
    }

    /// 按函数名过滤捕获结果
    pub fn captures_by_function(&self, name: &str) -> Vec<&HookCapture> {
        self.captures
            .iter()
            .filter(|c| c.function == name)
            .collect()
    }
}

/// 常用 Hook 目标预设
pub fn preset_hooks() -> Vec<HookTarget> {
    vec![
        HookTarget {
            function_name: "SSL_read".to_string(),
            module: "libssl.so".to_string(),
            hook_type: HookType::Exit,
        },
        HookTarget {
            function_name: "SSL_write".to_string(),
            module: "libssl.so".to_string(),
            hook_type: HookType::Entry,
        },
        HookTarget {
            function_name: "strcmp".to_string(),
            module: "libc.so".to_string(),
            hook_type: HookType::Entry,
        },
        HookTarget {
            function_name: "memcmp".to_string(),
            module: "libc.so".to_string(),
            hook_type: HookType::Entry,
        },
    ]
}
