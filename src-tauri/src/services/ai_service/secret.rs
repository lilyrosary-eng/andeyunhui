// 敏感字段落盘加密（AES-256-GCM + scrypt，机器/用户绑定）
//
// 参考 deepseek-desktop 的 credentials-local（照抄思路并适配 Rust 后端）：
//  - 密钥不落盘、不随文件传播，由「机器身份 + 用户名」经 scrypt 派生 KDF；
//  - 每次写入使用随机 salt/IV，相同明文两次密文不同；GCM auth tag 防篡改；
//  - 落盘格式 `enc:v1:<base64(salt16|iv12|ciphertext||tag16)>`，对上层透明；
//    读取时非该前缀按「旧明文」原样放行，实现向后兼容与自动迁移；
//  - 纯 Rust（aes-gcm/scrypt/rand），跨平台，含 Android 交叉编译无额外原生依赖。

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rand::{rngs::OsRng, RngCore};
use scrypt::{scrypt, Params};

/// 密文的版本前缀（无此前缀视为旧明文）
pub const ENC_PREFIX: &str = "enc:v1:";
const KEY_BYTES: usize = 32; // AES-256
const SALT_BYTES: usize = 16;
const IV_BYTES: usize = 12;
/// aes-gcm `encrypt` 输出为 ciphertext || tag，tag 固定 16 字节。
/// （TAG_BYTES 用于最小长度校验，不必手动拼装。）
const TAG_BYTES: usize = 16;

/// 机器+用户绑定口令（不落盘、不随文件走）。把文件拷到别的机器/账户即无法解密。
fn machine_passphrase() -> String {
    let username = std::env::var("USERNAME")
        .ok()
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_else(|| "unknown".to_string());
    format!("{username}@{}#{}", hostname(), machine_id())
}

fn hostname() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "localhost".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOSTNAME")
            .or_else(|_| {
                std::fs::read_to_string("/proc/sys/kernel/hostname")
                    .map(|s| s.trim().to_string())
            })
            .unwrap_or_else(|_| "localhost".to_string())
    }
}

/// 稳定机器标识：Windows 取注册表 MachineGuid，其余取 /etc/machine-id；缺失回退空串
/// （仍由用户名+主机名兜底，保证口味唯一且不确定）。
#[cfg(target_os = "windows")]
fn machine_id() -> String {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    let wide = |s: &str| -> Vec<u16> {
        let mut v: Vec<u16> = OsStr::new(s).encode_wide().collect();
        v.push(0);
        v
    };
    let subkey = wide(r"SOFTWARE\Microsoft\Cryptography");
    let name = wide("MachineGuid");

    let mut buf = [0u16; 128];
    let mut cb: u32 = (buf.len() * 2) as u32;
    // Safety: 传入的宽字符串以 \0 结尾；buf 为可写栈缓冲区；pcbdata 指向有效 u32。
    unsafe {
        let res = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            windows::core::PCWSTR(subkey.as_ptr()),
            windows::core::PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut cb),
        );
        if res.is_ok() {
            let len = (cb as usize) / 2;
            if len > 0 {
                return String::from_utf16(&buf[..len]).unwrap_or_default().trim().to_string();
            }
        }
    }
    String::new()
}

#[cfg(not(target_os = "windows"))]
fn machine_id() -> String {
    std::fs::read_to_string("/etc/machine-id")
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// scrypt KDF：由口令 + 随机盐派生 32 字节 AES-256 密钥
fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; KEY_BYTES], String> {
    let params = Params::new(15, 8, 1, KEY_BYTES).map_err(|e| e.to_string())?;
    let mut key = [0u8; KEY_BYTES];
    scrypt(passphrase.as_bytes(), salt, &params, &mut key).map_err(|e| e.to_string())?;
    Ok(key)
}

/// 加密明文 → `enc:v1:base64` 字符串（不可变字段为空则原样返回空串，避免无意义密文）
pub fn encrypt_secret(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    let mut salt = [0u8; SALT_BYTES];
    let mut iv = [0u8; IV_BYTES];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut iv);
    let key = derive_key(&machine_passphrase(), &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    // aead 输出 = ciphertext || tag(GCM auth tag)
    let ct = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext.as_bytes())
        .map_err(|e| format!("加密失败: {e}"))?;

    let mut blob = Vec::with_capacity(SALT_BYTES + IV_BYTES + ct.len());
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&iv);
    blob.extend_from_slice(&ct);
    Ok(format!("{ENC_PREFIX}{}", B64.encode(&blob)))
}

/// 解密 `enc:v1:base64`；若不以该前缀开头则视为旧明文原样返回（向后兼容）
pub fn decrypt_secret(stored: &str) -> Result<String, String> {
    let Some(raw) = stored.strip_prefix(ENC_PREFIX) else {
        // 非加密前缀（含空串）→ 旧明文，原样返回
        return Ok(stored.to_string());
    };
    let blob = B64.decode(raw).map_err(|e| e.to_string())?;
    if blob.len() < SALT_BYTES + IV_BYTES + TAG_BYTES {
        return Err("密文长度非法".to_string());
    }
    let salt = &blob[..SALT_BYTES];
    let iv = &blob[SALT_BYTES..SALT_BYTES + IV_BYTES];
    let ct = &blob[SALT_BYTES + IV_BYTES..];

    let key = derive_key(&machine_passphrase(), salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let pt = cipher
        .decrypt(Nonce::from_slice(iv), ct)
        .map_err(|_| "解密失败（密钥不匹配或文件被篡改）".to_string())?;
    String::from_utf8(pt).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_legacy() {
        let plain = "sk-测试密钥-abc123";
        let enc = encrypt_secret(plain).unwrap();

        // 密文不含明文、带版本前缀、两次加密结果不同（随机 salt/IV）
        assert!(enc.starts_with(ENC_PREFIX));
        assert!(!enc.contains(plain));
        let enc2 = encrypt_secret(plain).unwrap();
        assert_ne!(enc, enc2);

        // 往返一致
        assert_eq!(decrypt_secret(&enc).unwrap(), plain);

        // 旧明文（无前缀）原样放行
        assert_eq!(decrypt_secret("legacy-plain").unwrap(), "legacy-plain");
        assert_eq!(decrypt_secret("").unwrap(), "");
    }

    #[test]
    fn tamper_detected() {
        let enc = encrypt_secret("sk-tamper").unwrap();
        // 篡改一个字节后解密必须失败
        let bytes = B64.decode(enc.strip_prefix(ENC_PREFIX).unwrap()).unwrap();
        let mut tampered = bytes;
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        let bad = format!("{ENC_PREFIX}{}", B64.encode(&tampered));
        assert!(decrypt_secret(&bad).is_err());
    }
}