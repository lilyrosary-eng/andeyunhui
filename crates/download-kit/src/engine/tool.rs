//! 外部工具定位：配置路径 → 随包 external-deps → 可执行文件同级 → PATH。
//!
//! 刻意不把 aria2c / ffmpeg 打进 crate：二进制随包分发会牵涉许可与体积，
//! 这里只负责找到用户环境里已有的可执行文件。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

pub(crate) fn resolve(
    app: &AppHandle,
    configured: Option<&str>,
    names: &[&str],
) -> Option<PathBuf> {
    if let Some(raw) = configured {
        let path = PathBuf::from(raw.trim());
        if path.is_file() {
            return Some(path);
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(path) = find_in(&resource_dir.join("external-deps"), names) {
            return Some(path);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(path) = find_in(&dir.join("external-deps"), names) {
                return Some(path);
            }
            // 便携版：可执行文件旁边直接放工具
            if let Some(path) = find_in(dir, names) {
                return Some(path);
            }
        }
    }

    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if let Some(path) = find_in(&dir, names) {
                return Some(path);
            }
        }
    }

    // PATH 之外再扫一遍常见包管理器/安装目录（用户没配 PATH 时也能发现）。
    for dir in common_dirs() {
        if let Some(path) = find_in(&dir, names) {
            return Some(path);
        }
    }

    None
}

#[cfg(windows)]
fn common_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Microsoft").join("WinGet").join("Links"));
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        dirs.push(PathBuf::from(&home).join("scoop").join("shims"));
    }
    if let Some(program_data) = std::env::var_os("ProgramData") {
        dirs.push(PathBuf::from(program_data).join("chocolatey").join("bin"));
    }
    dirs.push(PathBuf::from(r"C:\Program Files\aria2"));
    dirs.push(PathBuf::from(r"C:\Program Files (x86)\aria2"));
    dirs.push(PathBuf::from(r"C:\Program Files\ffmpeg\bin"));
    dirs.push(PathBuf::from(r"C:\Program Files\Gopeed"));
    dirs
}

#[cfg(not(windows))]
fn common_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/snap/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local").join("bin"));
    }
    dirs
}

fn find_in(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .map(|name| dir.join(name))
        .find(|candidate| candidate.is_file())
}
