use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

/// 计算路径的哈希值（用于缓存文件名）
fn path_hash(path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.to_lowercase().hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// 获取缓存目录
fn cache_dir(app_data: &Path) -> PathBuf {
    app_data.join("cache")
}

/// 保存缓存
pub fn save_cache<T: Serialize>(app_data: &Path, prefix: &str, root_path: &str, data: &T) -> Result<(), String> {
    let dir = cache_dir(app_data);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {}", e))?;

    let file_name = format!("{}_{}.json", prefix, path_hash(root_path));
    let file_path = dir.join(file_name);
    let json = serde_json::to_string(data).map_err(|e| format!("序列化缓存失败: {}", e))?;
    std::fs::write(&file_path, json).map_err(|e| format!("写入缓存失败: {}", e))?;

    eprintln!("[Cache] 缓存已保存: {}", file_path.display());
    Ok(())
}

/// 加载缓存，返回数据 + 缓存文件修改时间
pub fn load_cache<T: DeserializeOwned>(app_data: &Path, prefix: &str, root_path: &str) -> Option<(T, u64)> {
    let dir = cache_dir(app_data);
    let file_name = format!("{}_{}.json", prefix, path_hash(root_path));
    let file_path = dir.join(file_name);

    if !file_path.exists() {
        return None;
    }

    let mtime = std::fs::metadata(&file_path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();

    let json = std::fs::read_to_string(&file_path).ok()?;
    let data: T = serde_json::from_str(&json).ok()?;
    Some((data, mtime))
}

/// 删除缓存
pub fn delete_cache(app_data: &Path, prefix: &str, root_path: &str) -> Result<(), String> {
    let dir = cache_dir(app_data);
    let file_name = format!("{}_{}.json", prefix, path_hash(root_path));
    let file_path = dir.join(file_name);

    if file_path.exists() {
        std::fs::remove_file(&file_path).map_err(|e| format!("删除缓存失败: {}", e))?;
    }
    Ok(())
}

// ============ 文件级缓存（按完整文件路径 + 源文件 mtime 失效）============
//
// 与上面的"按根目录"缓存不同，文件级缓存用于缓存"单文件重解析结果"
// （如 open_book 解析整本大书）。键为文件完整路径，载荷内附带源文件 mtime，
// 命中后由调用方比对 mtime 判断是否仍有效，可安全复用于任意模块的重操作缓存。

#[derive(Serialize, Deserialize)]
struct FileCacheEnvelope<T> {
    mtime: u64,
    data: T,
}

fn file_cache_name(prefix: &str, file_path: &str) -> String {
    format!("{}_{}.json", prefix, path_hash(file_path))
}

/// 保存文件级缓存（附带源文件 mtime）
pub fn save_file_cache<T: Serialize>(
    app_data: &Path,
    prefix: &str,
    file_path: &str,
    data: &T,
    source_mtime: u64,
) -> Result<(), String> {
    let dir = cache_dir(app_data);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {}", e))?;

    let file_path_out = dir.join(file_cache_name(prefix, file_path));
    let env = FileCacheEnvelope { mtime: source_mtime, data };
    let json = serde_json::to_string(&env).map_err(|e| format!("序列化缓存失败: {}", e))?;
    std::fs::write(&file_path_out, json).map_err(|e| format!("写入缓存失败: {}", e))?;

    eprintln!("[Cache] 文件缓存已保存: {}", file_path_out.display());
    Ok(())
}

/// 加载文件级缓存，返回数据 + 源文件 mtime（由调用方比对失效）
pub fn load_file_cache<T: DeserializeOwned>(
    app_data: &Path,
    prefix: &str,
    file_path: &str,
) -> Option<(T, u64)> {
    let dir = cache_dir(app_data);
    let file_path_in = dir.join(file_cache_name(prefix, file_path));
    if !file_path_in.exists() {
        return None;
    }
    let json = std::fs::read_to_string(&file_path_in).ok()?;
    let env: FileCacheEnvelope<T> = serde_json::from_str(&json).ok()?;
    Some((env.data, env.mtime))
}