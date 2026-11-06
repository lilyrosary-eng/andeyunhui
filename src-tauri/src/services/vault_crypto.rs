//! 密码库加密内核：随机数据密钥 + 多槽位包裹信封（`vlt:v1`）
//!
//! 与 `ai_service/secret.rs` 的分工：
//!  - `secret.rs` 是「一把机器绑定钥匙」，开箱即用，适合 API Key 这类低摩擦凭据；
//!  - 密码库要能随文件走、要能改主密码、还要能在忘记密码时救回来。单钥模型做不到：
//!    改密码就得重加密全库，换机器/改用户名即永久打不开。
//!
//! 所以这里用业界通行的信封结构：正文只由随机 `DK` 加解密，`DK` 再被包进多个槽位。
//!  - Password：scrypt(主密码) 包裹 DK —— 真零知识，文件被拷走也没用；
//!  - Device：scrypt(机器+用户标识) 包裹 DK —— 本机免密解锁，口径与 secret.rs 一致；
//!  - Recovery：scrypt(一次性备用码) 包裹 DK —— 忘记主密码时直接换开 DK，只重包 Password 槽。
//!
//! 所有槽位的 AAD 都绑定了 `vault_id` + 槽位标识 + 自身 salt/iv：跨库搬槽、槽间混用
//! （把 meta 密文当 body 用）、改 KDF 参数重放，都会在 GCM 校验处失败。
//! 头部摘要只用于发现**意外损坏**（未加盐哈希，故意改写者可重算），恶意替换全槽位
//! 的解密会在正文处失败。
//!
//! 不落盘：DK、派生密钥、明文。DK 只在解锁期间留在内存，`Drop` 时擦除。

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rand::rngs::OsRng;
use rand::RngCore;
use scrypt::{scrypt, Params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

pub const ENVELOPE_VERSION: u8 = 1;
const FORMAT_TAG: &str = "vlt:v1";
const KEY_BYTES: usize = 32;
const SALT_BYTES: usize = 16;
const IV_BYTES: usize = 12;
const VAULT_ID_BYTES: usize = 16;

pub const RECOVERY_CODE_COUNT: usize = 10;
const RECOVERY_GROUPS: usize = 3;
const RECOVERY_GROUP_LEN: usize = 5;
/// 备用码字母表：去掉 I/L/O/0/1，手抄与口述时不会混淆（31 个字符 ≈ 73.5 bit/码）。
const RECOVERY_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const META_PURPOSE: &str = "meta";
const BODY_PURPOSE: &str = "body";

// ===================== KDF =====================

/// KDF 参数随库落盘：以后要换 argon2 或调难度，老库按各自参数解开，不用迁移密文。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Kdf {
    pub log_n: u8,
    pub r: u32,
    pub p: u32,
}

impl Default for Kdf {
    fn default() -> Self {
        // 与 ai_service/secret.rs 同档：scrypt(15,8,1) ≈ 32MB / 一次几十到百余毫秒。
        Self { log_n: 15, r: 8, p: 1 }
    }
}

impl Kdf {
    fn params(&self) -> Result<Params, String> {
        Params::new(self.log_n, self.r, self.p, KEY_BYTES)
            .map_err(|e| format!("KDF 参数非法: {e}"))
    }

    pub fn derive(&self, passphrase: &str, salt: &[u8]) -> Result<[u8; KEY_BYTES], String> {
        let mut out = [0u8; KEY_BYTES];
        scrypt(passphrase.as_bytes(), salt, &self.params()?, &mut out)
            .map_err(|e| format!("KDF 派生失败: {e}"))?;
        Ok(out)
    }
}

// ===================== 数据密钥 =====================

/// 包裹在槽位里的随机数据密钥。不可 Clone，离开作用域即擦除。
pub struct DataKey([u8; KEY_BYTES]);

impl DataKey {
    pub fn generate() -> Self {
        let mut k = [0u8; KEY_BYTES];
        OsRng.fill_bytes(&mut k);
        Self(k)
    }

    pub fn from_bytes(bytes: [u8; KEY_BYTES]) -> Self {
        Self(bytes)
    }

    fn cipher(&self) -> Result<Aes256Gcm, String> {
        Aes256Gcm::new_from_slice(&self.0).map_err(|e| e.to_string())
    }
}

impl Drop for DataKey {
    fn drop(&mut self) {
        for b in self.0.iter_mut() {
            // SAFETY: b 指向本结构体内有效字节；volatile 写防止被优化掉。
            unsafe { std::ptr::write_volatile(b as *mut u8, 0) };
        }
        std::hint::black_box(&self.0);
    }
}

impl std::fmt::Debug for DataKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DataKey(<redacted>)")
    }
}

fn wipe(buf: &mut [u8]) {
    for b in buf.iter_mut() {
        // SAFETY: 同上，写入调用方持有的有效缓冲区。
        unsafe { std::ptr::write_volatile(b as *mut u8, 0) };
    }
    std::hint::black_box(&buf);
}

// ===================== 信封数据结构 =====================

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SlotKind {
    Password,
    Device,
    Recovery,
}

impl SlotKind {
    fn as_str(&self) -> &'static str {
        match self {
            SlotKind::Password => "password",
            SlotKind::Device => "device",
            SlotKind::Recovery => "recovery",
        }
    }

    fn order(&self) -> u8 {
        match self {
            SlotKind::Password => 0,
            SlotKind::Device => 1,
            SlotKind::Recovery => 2,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Slot {
    pub kind: SlotKind,
    pub salt: String,
    pub iv: String,
    pub ct: String,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Blob {
    pub iv: String,
    pub ct: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Envelope {
    pub v: u8,
    pub vault_id: String,
    pub kdf: Kdf,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub slots: Vec<Slot>,
    /// 头部摘要（含槽位密文），只用于发现意外损坏，见模块头注释。
    pub header_digest: String,
    pub meta: Blob,
    pub body: Blob,
}

/// 一次成功解锁的结果：DK + 已解密的元信息 / 正文。
pub struct Unlocked {
    pub dk: DataKey,
    pub meta: Vec<u8>,
    pub body: Vec<u8>,
}

impl std::fmt::Debug for Unlocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Unlocked")
            .field("meta_len", &self.meta.len())
            .field("body_len", &self.body.len())
            .finish()
    }
}

// ===================== 工具 =====================

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn random_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    OsRng.fill_bytes(&mut buf);
    hex(&buf)
}

fn random_iv() -> ([u8; IV_BYTES], String) {
    let mut iv = [0u8; IV_BYTES];
    OsRng.fill_bytes(&mut iv);
    (iv, B64.encode(iv))
}

/// 槽位 AAD：库标识 + 槽位身份 + 自身 salt/iv。salt/iv 不在 GCM 密文内，
/// 必须进 AAD 才能防止「换 salt/iv 或跨槽位拼三段」的改写。
fn slot_aad(vault_id: &str, slot: &Slot) -> Vec<u8> {
    format!(
        "{FORMAT_TAG}|{vault_id}|slot|{}|{}|{}|{}",
        slot.kind.as_str(),
        slot.created_at_ms,
        slot.salt,
        slot.iv
    )
    .into_bytes()
}

fn blob_aad(vault_id: &str, purpose: &str, iv_b64: &str) -> Vec<u8> {
    format!("{FORMAT_TAG}|{vault_id}|blob|{purpose}|{iv_b64}").into_bytes()
}

// ===================== 槽位加解密 =====================

fn seal_slot(
    dk: &DataKey,
    vault_id: &str,
    kdf: Kdf,
    passphrase: &str,
    kind: SlotKind,
    label: Option<String>,
) -> Result<Slot, String> {
    if passphrase.is_empty() {
        return Err("口令不能为空".to_string());
    }
    let mut salt = [0u8; SALT_BYTES];
    OsRng.fill_bytes(&mut salt);
    let mut slot = Slot {
        kind,
        salt: B64.encode(salt),
        iv: String::new(),
        ct: String::new(),
        created_at_ms: now_ms(),
        label,
    };
    let (iv, iv_b64) = random_iv();
    slot.iv = iv_b64;

    let mut key = kdf.derive(passphrase, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string());
    wipe(&mut key);
    let cipher = cipher?;

    let aad = slot_aad(vault_id, &slot);
    let ct = cipher
        .encrypt(Nonce::from_slice(&iv), Payload { msg: &dk.0, aad: &aad })
        .map_err(|e| format!("包裹数据密钥失败: {e}"))?;
    slot.ct = B64.encode(ct);
    Ok(slot)
}

fn open_slot(vault_id: &str, kdf: Kdf, slot: &Slot, passphrase: &str) -> Result<DataKey, String> {
    let salt = B64.decode(&slot.salt).map_err(|_| "槽位 salt 损坏".to_string())?;
    let iv = B64.decode(&slot.iv).map_err(|_| "槽位 iv 损坏".to_string())?;
    let ct = B64.decode(&slot.ct).map_err(|_| "槽位密文损坏".to_string())?;
    if iv.len() != IV_BYTES {
        return Err("槽位 iv 长度非法".to_string());
    }

    let mut key = kdf.derive(passphrase, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string());
    wipe(&mut key);

    let aad = slot_aad(vault_id, slot);
    let mut pt = cipher?
        .decrypt(Nonce::from_slice(&iv), Payload { msg: &ct, aad: &aad })
        .map_err(|_| "口令错误，或密码库文件被篡改".to_string())?;
    if pt.len() != KEY_BYTES {
        wipe(&mut pt);
        return Err("槽位内容长度非法".to_string());
    }
    let mut dk = [0u8; KEY_BYTES];
    dk.copy_from_slice(&pt);
    wipe(&mut pt);
    Ok(DataKey(dk))
}

// ===================== 正文加解密 =====================

pub fn encrypt_blob(
    dk: &DataKey,
    vault_id: &str,
    purpose: &str,
    plaintext: &[u8],
) -> Result<Blob, String> {
    let (iv, iv_b64) = random_iv();
    let aad = blob_aad(vault_id, purpose, &iv_b64);
    let ct = dk
        .cipher()?
        .encrypt(Nonce::from_slice(&iv), Payload { msg: plaintext, aad: &aad })
        .map_err(|e| format!("加密失败: {e}"))?;
    Ok(Blob { iv: iv_b64, ct: B64.encode(ct) })
}

pub fn decrypt_blob(
    dk: &DataKey,
    vault_id: &str,
    purpose: &str,
    blob: &Blob,
) -> Result<Vec<u8>, String> {
    let iv = B64.decode(&blob.iv).map_err(|_| "密文 iv 损坏".to_string())?;
    let ct = B64.decode(&blob.ct).map_err(|_| "密文损坏".to_string())?;
    if iv.len() != IV_BYTES {
        return Err("密文 iv 长度非法".to_string());
    }
    let aad = blob_aad(vault_id, purpose, &blob.iv);
    dk.cipher()?
        .decrypt(Nonce::from_slice(&iv), Payload { msg: &ct, aad: &aad })
        .map_err(|_| "解密失败（密钥不匹配、用途不符或文件被篡改）".to_string())
}

// ===================== 信封操作 =====================

impl Envelope {
    /// 新建空库：只带一个 Password 槽；Device / Recovery 槽由调用方追加。
    pub fn create(
        kdf: Kdf,
        password: &str,
        meta: &[u8],
        body: &[u8],
    ) -> Result<(Self, DataKey), String> {
        let vault_id = random_hex(VAULT_ID_BYTES);
        let dk = DataKey::generate();
        let now = now_ms();
        let slot = seal_slot(&dk, &vault_id, kdf, password, SlotKind::Password, None)?;
        let mut env = Envelope {
            v: ENVELOPE_VERSION,
            vault_id: vault_id.clone(),
            kdf,
            created_at_ms: now,
            updated_at_ms: now,
            slots: vec![slot],
            header_digest: String::new(),
            meta: encrypt_blob(&dk, &vault_id, META_PURPOSE, meta)?,
            body: encrypt_blob(&dk, &vault_id, BODY_PURPOSE, body)?,
        };
        env.refresh_header_digest();
        Ok((env, dk))
    }

    fn canonical_header(&self) -> String {
        let mut s = format!(
            "{FORMAT_TAG}|{}|{}|{}|{}|{}|{}|{}",
            self.v, self.vault_id, self.kdf.log_n, self.kdf.r, self.kdf.p, self.meta.iv, self.body.iv
        );
        for slot in &self.slots {
            s.push_str(&format!(
                "|{}:{}:{}:{}:{}",
                slot.kind.as_str(),
                slot.created_at_ms,
                slot.salt,
                slot.iv,
                slot.ct
            ));
        }
        s
    }

    pub fn refresh_header_digest(&mut self) {
        self.header_digest = hex(&Sha256::digest(self.canonical_header().as_bytes()));
    }

    pub fn verify_header(&self) -> Result<(), String> {
        if self.v != ENVELOPE_VERSION {
            return Err(format!("密码库格式版本不支持: {}", self.v));
        }
        let expect = hex(&Sha256::digest(self.canonical_header().as_bytes()));
        if expect != self.header_digest {
            return Err("密码库文件已损坏或被改写（头部校验不一致）".to_string());
        }
        Ok(())
    }

    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| format!("序列化密码库失败: {e}"))
    }

    pub fn from_json(raw: &str) -> Result<Self, String> {
        let env: Envelope =
            serde_json::from_str(raw).map_err(|e| format!("密码库文件解析失败: {e}"))?;
        env.verify_header()?;
        Ok(env)
    }

    pub fn password_slot(&self) -> Option<&Slot> {
        self.slots.iter().find(|s| s.kind == SlotKind::Password)
    }

    pub fn slot_count(&self, kind: SlotKind) -> usize {
        self.slots.iter().filter(|s| s.kind == kind).count()
    }

    /// 用主密码解锁。
    pub fn unlock(&self, password: &str) -> Result<Unlocked, String> {
        self.verify_header()?;
        let slot = self
            .password_slot()
            .ok_or_else(|| "密码库内没有主密码槽位".to_string())?;
        let dk = open_slot(&self.vault_id, self.kdf, slot, password)?;
        self.open_with_key(dk)
    }

    /// 用任意槽位的口令解锁（Device / Recovery 走这里）。
    pub fn unlock_with_slot(&self, index: usize, passphrase: &str) -> Result<Unlocked, String> {
        self.verify_header()?;
        let slot = self
            .slots
            .get(index)
            .ok_or_else(|| "槽位不存在".to_string())?;
        let dk = open_slot(&self.vault_id, self.kdf, slot, passphrase)?;
        self.open_with_key(dk)
    }

    fn open_with_key(&self, dk: DataKey) -> Result<Unlocked, String> {
        let (meta, body) = (
            decrypt_blob(&dk, &self.vault_id, META_PURPOSE, &self.meta),
            decrypt_blob(&dk, &self.vault_id, BODY_PURPOSE, &self.body),
        );
        match (meta, body) {
            (Ok(meta), Ok(body)) => Ok(Unlocked { dk, meta, body }),
            (Err(e), _) | (_, Err(e)) => Err(e),
        }
    }

    /// 用已经换开的 DK 解密（备用码兑换 / 设备解锁后复用，避免再派生一次）。
    pub fn open_with_dk(&self, dk: DataKey) -> Result<Unlocked, String> {
        self.open_with_key(dk)
    }

    /// 用已解锁的 DK 重写正文/元信息。
    pub fn reseal(&mut self, dk: &DataKey, meta: &[u8], body: &[u8]) -> Result<(), String> {
        self.meta = encrypt_blob(dk, &self.vault_id, META_PURPOSE, meta)?;
        self.body = encrypt_blob(dk, &self.vault_id, BODY_PURPOSE, body)?;
        self.updated_at_ms = now_ms();
        self.refresh_header_digest();
        Ok(())
    }

    /// 追加一个非主密码槽位。Device 槽重复追加时先清旧槽（同一台机器只留一把）。
    pub fn add_slot(
        &mut self,
        dk: &DataKey,
        passphrase: &str,
        kind: SlotKind,
        label: Option<String>,
    ) -> Result<(), String> {
        if kind == SlotKind::Password {
            return Err("主密码槽位请用 rotate_password 维护".to_string());
        }
        if kind == SlotKind::Device {
            self.slots.retain(|s| s.kind != SlotKind::Device);
        }
        let slot = seal_slot(dk, &self.vault_id, self.kdf, passphrase, kind, label)?;
        self.slots.push(slot);
        self.sort_slots();
        self.updated_at_ms = now_ms();
        self.refresh_header_digest();
        Ok(())
    }

    pub fn remove_slots_of(&mut self, kind: SlotKind) {
        self.slots.retain(|s| s.kind != kind);
        self.updated_at_ms = now_ms();
        self.refresh_header_digest();
    }

    /// 改主密码：只重包 Password 槽，正文密文完全不动。
    pub fn rotate_password(&mut self, dk: &DataKey, new_password: &str) -> Result<(), String> {
        let label = self.password_slot().and_then(|s| s.label.clone());
        self.slots.retain(|s| s.kind != SlotKind::Password);
        let slot = seal_slot(dk, &self.vault_id, self.kdf, new_password, SlotKind::Password, label)?;
        self.slots.push(slot);
        self.sort_slots();
        self.updated_at_ms = now_ms();
        self.refresh_header_digest();
        Ok(())
    }

    /// 用备用码换开 DK 并消耗该槽。成功后调用方应立即 `rotate_password` + `reseal` 落盘。
    pub fn consume_recovery(&mut self, raw_code: &str) -> Result<DataKey, String> {
        self.verify_header()?;
        let code = normalize_recovery_code(raw_code)?;
        let mut hit: Option<(usize, DataKey)> = None;
        for (i, slot) in self.slots.iter().enumerate() {
            if slot.kind != SlotKind::Recovery {
                continue;
            }
            if let Ok(dk) = open_slot(&self.vault_id, self.kdf, slot, &code) {
                hit = Some((i, dk));
                break;
            }
        }
        let (index, dk) = hit.ok_or_else(|| "备用验证码无效或已被使用".to_string())?;
        self.slots.remove(index);
        self.updated_at_ms = now_ms();
        self.refresh_header_digest();
        Ok(dk)
    }

    fn sort_slots(&mut self) {
        self.slots.sort_by_key(|s| (s.kind.order(), s.created_at_ms));
    }
}

// ===================== 备用验证码 =====================

fn random_index(bound: usize) -> usize {
    debug_assert!(bound > 0);
    // 拒绝采样：避免 `随机数 % bound` 的取模偏差（31 不整除 2^32）。
    let bound32 = bound as u32;
    let zone = u32::MAX - (u32::MAX % bound32);
    loop {
        let mut b = [0u8; 4];
        OsRng.fill_bytes(&mut b);
        let v = u32::from_le_bytes(b);
        if v < zone {
            return (v % bound32) as usize;
        }
    }
}

pub fn generate_recovery_codes() -> Vec<String> {
    (0..RECOVERY_CODE_COUNT)
        .map(|_| {
            let mut out = String::with_capacity(
                RECOVERY_GROUPS * RECOVERY_GROUP_LEN + RECOVERY_GROUPS - 1,
            );
            for g in 0..RECOVERY_GROUPS {
                if g > 0 {
                    out.push('-');
                }
                for _ in 0..RECOVERY_GROUP_LEN {
                    out.push(RECOVERY_ALPHABET[random_index(RECOVERY_ALPHABET.len())] as char);
                }
            }
            out
        })
        .collect()
}

/// 归一化用户输入的备用码：去空白/连字符、转大写、校验字符集，再按 5 位一组重排。
pub fn normalize_recovery_code(raw: &str) -> Result<String, String> {
    let mut cleaned = String::with_capacity(raw.len());
    for c in raw.chars() {
        if c.is_whitespace() || c == '-' {
            continue;
        }
        let up = c.to_ascii_uppercase();
        if !up.is_ascii() || !RECOVERY_ALPHABET.contains(&(up as u8)) {
            return Err(format!("备用验证码含非法字符「{c}」"));
        }
        cleaned.push(up);
    }
    if cleaned.len() != RECOVERY_GROUPS * RECOVERY_GROUP_LEN {
        return Err(format!(
            "备用验证码应为 {} 位有效字符（当前 {} 位）",
            RECOVERY_GROUPS * RECOVERY_GROUP_LEN,
            cleaned.len()
        ));
    }
    let mut out = String::with_capacity(cleaned.len() + RECOVERY_GROUPS - 1);
    for (i, c) in cleaned.chars().enumerate() {
        if i > 0 && i % RECOVERY_GROUP_LEN == 0 {
            out.push('-');
        }
        out.push(c);
    }
    Ok(out)
}

/// 重置备用码：清掉全部旧 Recovery 槽，按新码逐个包裹 DK。
pub fn install_recovery_codes(
    env: &mut Envelope,
    dk: &DataKey,
    codes: &[String],
) -> Result<(), String> {
    env.slots.retain(|s| s.kind != SlotKind::Recovery);
    for (i, code) in codes.iter().enumerate() {
        let normalized = normalize_recovery_code(code)?;
        let slot = seal_slot(
            dk,
            &env.vault_id,
            env.kdf,
            &normalized,
            SlotKind::Recovery,
            Some(format!("备用码 {}", i + 1)),
        )?;
        env.slots.push(slot);
    }
    env.sort_slots();
    env.updated_at_ms = now_ms();
    env.refresh_header_digest();
    Ok(())
}

// ===================== 测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 单测把 scrypt 降到 log_n=10（≈1MB）换跑速；生产默认仍是 15。
    fn fast_kdf() -> Kdf {
        Kdf { log_n: 10, r: 8, p: 1 }
    }

    fn new_env(password: &str) -> (Envelope, DataKey) {
        Envelope::create(fast_kdf(), password, br#"{"autoLockMin":5}"#, br#"[]"#).unwrap()
    }

    #[test]
    fn roundtrip_and_wrong_password() {
        let (env, _dk) = new_env("correct horse");
        let unlocked = env.unlock("correct horse").unwrap();
        assert_eq!(unlocked.meta, br#"{"autoLockMin":5}"#);
        assert_eq!(unlocked.body, br#"[]"#);

        let err = env.unlock("wrong").unwrap_err();
        assert!(err.contains("口令错误"), "err = {err}");
    }

    #[test]
    fn body_tamper_detected() {
        let (mut env, _dk) = new_env("pw");
        let mut raw = B64.decode(&env.body.ct).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        env.body.ct = B64.encode(&raw);
        // 头部摘要不含 body.ct 的密文内部，所以篡改要在解密时被抓到
        let err = env.unlock("pw").unwrap_err();
        assert!(err.contains("解密失败"), "err = {err}");
    }

    #[test]
    fn purpose_confusion_rejected() {
        let (mut env, unlocked) = {
            let (env, dk) = new_env("pw");
            let unlocked = env.unlock("pw").unwrap();
            drop(dk);
            (env, unlocked)
        };
        // 把 meta 密文搬到 body：用途不同 → AAD 不同 → 必须失败
        env.body = env.meta.clone();
        let err = env.open_with_key(unlocked.dk).unwrap_err();
        assert!(err.contains("解密失败"), "err = {err}");
    }

    #[test]
    fn slot_aad_binds_vault_id() {
        let (env_a, _dk_a) = new_env("same-password");
        let (mut env_b, _dk_b) = new_env("same-password");
        env_b.slots = env_a.slots.clone();
        env_b.refresh_header_digest();
        let err = env_b.unlock("same-password").unwrap_err();
        assert!(err.contains("口令错误"), "err = {err}");
    }

    #[test]
    fn rotate_password_keeps_body() {
        let (mut env, unlocked) = {
            let (env, dk) = new_env("old-pass");
            let unlocked = env.unlock("old-pass").unwrap();
            drop(dk);
            (env, unlocked)
        };
        env.rotate_password(&unlocked.dk, "new-pass").unwrap();
        assert_eq!(env.slot_count(SlotKind::Password), 1);

        assert!(env.unlock("old-pass").is_err());
        let again = env.unlock("new-pass").unwrap();
        assert_eq!(again.body, unlocked.body);
    }

    #[test]
    fn device_slot_works_and_replaces() {
        let (mut env, unlocked) = {
            let (env, dk) = new_env("pw");
            let unlocked = env.unlock("pw").unwrap();
            drop(dk);
            (env, unlocked)
        };
        env.add_slot(&unlocked.dk, "user@host#machine", SlotKind::Device, None)
            .unwrap();
        env.add_slot(&unlocked.dk, "user@host#machine", SlotKind::Device, None)
            .unwrap();
        assert_eq!(env.slot_count(SlotKind::Device), 1, "Device 槽必须只留一把");

        let idx = env
            .slots
            .iter()
            .position(|s| s.kind == SlotKind::Device)
            .unwrap();
        let via_device = env.unlock_with_slot(idx, "user@host#machine").unwrap();
        assert_eq!(via_device.body, br#"[]"#);
        assert!(env.unlock_with_slot(idx, "other-machine").is_err());
    }

    #[test]
    fn recovery_code_is_single_use() {
        let (mut env, unlocked) = {
            let (env, dk) = new_env("forgot-me");
            let unlocked = env.unlock("forgot-me").unwrap();
            drop(dk);
            (env, unlocked)
        };
        let codes = generate_recovery_codes();
        install_recovery_codes(&mut env, &unlocked.dk, &codes).unwrap();
        assert_eq!(env.slot_count(SlotKind::Recovery), RECOVERY_CODE_COUNT);

        // 小写 + 空格 + 连字符都应能归一化命中
        let typed = format!(" {} ", codes[3].to_lowercase().replace('-', " "));
        let dk = env.consume_recovery(&typed).unwrap();
        assert_eq!(env.slot_count(SlotKind::Recovery), RECOVERY_CODE_COUNT - 1);

        // 同一码第二次必须失败
        assert!(env.consume_recovery(&codes[3]).is_err());
        // 其余码仍然可用
        assert!(env.consume_recovery(&codes[0]).is_ok());

        // 换开 DK 后重设主密码，正文仍可读
        env.rotate_password(&dk, "new-pass").unwrap();
        let again = env.unlock("new-pass").unwrap();
        assert_eq!(again.body, br#"[]"#);
    }

    #[test]
    fn recovery_code_shape_and_validation() {
        let codes = generate_recovery_codes();
        for code in &codes {
            let groups: Vec<&str> = code.split('-').collect();
            assert_eq!(groups.len(), RECOVERY_GROUPS);
            for g in groups {
                assert_eq!(g.len(), RECOVERY_GROUP_LEN);
                for ch in g.bytes() {
                    assert!(RECOVERY_ALPHABET.contains(&ch), "非法字符 {ch}");
                }
            }
            assert_eq!(normalize_recovery_code(code).unwrap(), *code);
        }
        assert!(normalize_recovery_code("ABCD-EFGH").is_err(), "长度不足应拒绝");
        assert!(normalize_recovery_code("ABCDE-FGHIJ-KLMN0").is_err(), "0 不在字母表");
    }

    #[test]
    fn header_digest_detects_edit() {
        let (mut env, _dk) = new_env("pw");
        env.slots[0].ct.push('A');
        assert!(env.verify_header().is_err());
        env.refresh_header_digest();
        assert!(env.verify_header().is_ok());
    }

    #[test]
    fn json_roundtrip() {
        let (env, _dk) = new_env("pw");
        let json = env.to_json().unwrap();
        let back = Envelope::from_json(&json).unwrap();
        assert_eq!(back.vault_id, env.vault_id);
        assert_eq!(back.body.ct, env.body.ct);
        assert!(back.unlock("pw").is_ok());
    }
}
