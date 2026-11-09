//! 密码库服务层：文件生命周期、内存解锁状态、条目 CRUD、闲置自动锁定、审计。
//!
//! 分工：`vault_crypto` 只管字节层面的信封与槽位；这里只管「库在磁盘上怎么放、什么时候锁」。
//! 命令层（commands/vault_commands.rs）只做 async + spawn_blocking 包装。
//!
//! 落盘：`<app_data>/vault/vault.json`（原子写），每次**内容变更**前把旧文件复制到
//! `backups/vault-<ts>.json` 并滚动保留 5 份。备份目录刻意独立：不放任何会被缓存清理
//! 扫描的路径（历史事故：清理逻辑把密钥类文件当缓存删掉）。
//!
//! 解锁状态只存内存；锁定时连信封一起丢掉，下次命令重新从磁盘读，避免外部改动后内存陈旧。

use crate::services::ai_service::secret::machine_passphrase;
use crate::services::biometric;
use crate::services::vault_crypto::{self, Envelope, Kdf, SlotKind, Unlocked};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const DEFAULT_AUTO_LOCK_MIN: u32 = 5;
/// 主密码最短长度（统一 8 位，不做 debug/release 特例）。
/// 真安全性由 scrypt 与口令熵决定；这里只挡「随手一个 a」。
pub const MIN_MASTER_PASSWORD_CHARS: usize = 8;

fn min_master_password_chars() -> usize {
    MIN_MASTER_PASSWORD_CHARS
}
const MAX_BACKUPS: usize = 5;
const MAX_AUDIT: usize = 200;
const MAX_HISTORY: usize = 20;
const VAULT_FILENAME: &str = "vault.json";

// ===================== 数据模型（版本随 meta.schema 演进） =====================

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Login,
    ApiKey,
    SecureNote,
    SshKey,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomField {
    pub name: String,
    pub value: String,
    pub hidden: bool,
}

impl Default for CustomField {
    fn default() -> Self {
        Self { name: String::new(), value: String::new(), hidden: false }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ItemVersion {
    pub at_ms: u64,
    pub title: String,
    pub username: String,
    pub password: String,
}

impl Default for ItemVersion {
    fn default() -> Self {
        Self { at_ms: 0, title: String::new(), username: String::new(), password: String::new() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultItem {
    pub id: String,
    pub kind: ItemKind,
    pub title: String,
    pub username: String,
    pub password: String,
    pub urls: Vec<String>,
    pub fields: Vec<CustomField>,
    pub notes: String,
    /// base32 TOTP 种子；为空表示没绑定二次验证
    pub totp_secret: String,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_used_at_ms: u64,
    /// 非空 = 在回收站
    pub deleted_at_ms: Option<u64>,
    pub history: Vec<ItemVersion>,
}

impl Default for VaultItem {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: ItemKind::Login,
            title: String::new(),
            username: String::new(),
            password: String::new(),
            urls: Vec::new(),
            fields: Vec::new(),
            notes: String::new(),
            totp_secret: String::new(),
            tags: Vec::new(),
            favorite: false,
            created_at_ms: 0,
            updated_at_ms: 0,
            last_used_at_ms: 0,
            deleted_at_ms: None,
            history: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AuditEntry {
    pub at_ms: u64,
    pub action: String,
    /// 只放条目标题/ID，绝不写入密码或口令
    pub detail: String,
}

impl Default for AuditEntry {
    fn default() -> Self {
        Self { at_ms: 0, action: String::new(), detail: String::new() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultMeta {
    pub schema: u32,
    pub auto_lock_min: u32,
    pub created_at_ms: u64,
    pub last_unlock_ms: u64,
    pub last_password_change_ms: u64,
    pub audit: Vec<AuditEntry>,
}

impl Default for VaultMeta {
    fn default() -> Self {
        Self {
            schema: 1,
            auto_lock_min: DEFAULT_AUTO_LOCK_MIN,
            created_at_ms: 0,
            last_unlock_ms: 0,
            last_password_change_ms: 0,
            audit: Vec::new(),
        }
    }
}

// ===================== 对外视图 =====================

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
    pub item_count: usize,
    pub trashed_count: usize,
    pub has_device_slot: bool,
    pub recovery_slots: usize,
    pub auto_lock_min: u32,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    /// 当前构建的主密码下限（debug=6 / release=8），UI 必须以此为准
    pub min_password_chars: usize,
    /// 本机解锁是否强制经过生物识别（策略文件，锁定态也可读）
    pub biometric_required: bool,
    /// 进入锁屏后是否自动触发一次生物识别
    pub biometric_auto_prompt: bool,
    /// 当前平台是否支持系统生物识别
    pub biometric_supported: bool,
    /// 生物识别可用性说明（不可用时给出原因）
    pub biometric_detail: String,
}

/// 明文策略文件：只放「本机解锁是否要求生物识别」这类非机密开关。
/// 不放进 VaultMeta 是因为锁定态读不到 meta（meta 由 DK 解密），而门闸必须锁定态可判定。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultPolicy {
    pub biometric_required: bool,
    /// 进入锁屏后自动触发一次生物识别（无需用户再点按钮）
    pub biometric_auto_prompt: bool,
}

impl Default for VaultPolicy {
    fn default() -> Self {
        Self {
            biometric_required: false,
            biometric_auto_prompt: true,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateOutcome {
    /// 仅在创建时返回一次；库里只留包裹后的槽位，无法反推。
    pub recovery_codes: Vec<String>,
    pub status: VaultStatus,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RedeemOutcome {
    pub remaining_recovery_codes: usize,
    pub status: VaultStatus,
}

// ===================== 进程内状态 =====================

struct VaultMemory {
    envelope: Option<Envelope>,
    unlocked: Option<Unlocked>,
    last_activity: Instant,
    auto_lock_min: u32,
    policy: VaultPolicy,
}

impl VaultMemory {
    fn new() -> Self {
        Self {
            envelope: None,
            unlocked: None,
            last_activity: Instant::now(),
            auto_lock_min: DEFAULT_AUTO_LOCK_MIN,
            policy: VaultPolicy::default(),
        }
    }
}

fn memory() -> &'static Mutex<VaultMemory> {
    static MEM: OnceLock<Mutex<VaultMemory>> = OnceLock::new();
    MEM.get_or_init(|| Mutex::new(VaultMemory::new()))
}

fn lock_memory() -> MutexGuard<'static, VaultMemory> {
    memory().lock().unwrap_or_else(|e| e.into_inner())
}

// ===================== 文件路径与读写 =====================

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn vault_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败: {e}"))?
        .join("vault");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建密码库目录失败: {e}"))?;
    Ok(dir)
}

fn vault_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(vault_dir(app)?.join(VAULT_FILENAME))
}

fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(vault_dir(app)?.join("backups"))
}

fn prune_backups(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("vault-") && n.ends_with(".json"))
        .collect();
    names.sort();
    while names.len() > MAX_BACKUPS {
        let oldest = names.remove(0);
        let _ = std::fs::remove_file(dir.join(oldest));
    }
}

/// `backup=false` 用于纯审计/时间戳更新（如每次解锁），避免滚动备份被这些写入吃光。
fn write_envelope(app: &AppHandle, env: &Envelope, backup: bool) -> Result<(), String> {
    let path = vault_file(app)?;
    if backup && path.exists() {
        let dir = backup_dir(app)?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建密码库备份目录失败: {e}"))?;
        let _ = std::fs::copy(&path, dir.join(format!("vault-{}.json", now_ms())));
        prune_backups(&dir);
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, env.to_json()?).map_err(|e| format!("写入密码库失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换密码库文件失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn load_into_memory(app: &AppHandle, m: &mut VaultMemory) -> Result<(), String> {
    if m.envelope.is_some() {
        return Ok(());
    }
    let path = vault_file(app)?;
    if !path.exists() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取密码库失败: {e}"))?;
    m.envelope = Some(Envelope::from_json(&raw)?);
    m.policy = read_policy(app);
    Ok(())
}

// ===================== 策略文件（明文，非机密） =====================

fn policy_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(vault_dir(app)?.join("policy.json"))
}

fn read_policy(app: &AppHandle) -> VaultPolicy {
    let Ok(path) = policy_path(app) else {
        return VaultPolicy::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_policy(app: &AppHandle, policy: &VaultPolicy) -> Result<(), String> {
    let path = policy_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(policy).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| format!("写入策略失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换策略文件失败: {e}"))?;
    Ok(())
}

/// 生物识别可用性缓存：30 秒 TTL。
/// 用户在系统里注册/插入设备后，不需要重启应用，下一次状态轮询就会刷新。
fn availability_cached() -> biometric::BiometricAvailability {
    static CACHE: OnceLock<Mutex<(Instant, biometric::BiometricAvailability)>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new((Instant::now() - Duration::from_secs(60), biometric::availability())));
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if guard.0.elapsed() >= Duration::from_secs(30) {
        *guard = (Instant::now(), biometric::availability());
    }
    guard.1.clone()
}

// ===================== 锁定策略 =====================

fn check_auto_lock(m: &mut VaultMemory) {
    if m.unlocked.is_none() {
        return;
    }
    let limit = Duration::from_secs(u64::from(m.auto_lock_min.max(1)) * 60);
    if m.last_activity.elapsed() >= limit {
        m.unlocked = None;
    }
}

fn require_unlocked(m: &mut VaultMemory) -> Result<(), String> {
    check_auto_lock(m);
    if m.unlocked.is_none() {
        return Err("密码库已锁定".to_string());
    }
    m.last_activity = Instant::now();
    Ok(())
}

fn parse_items(unlocked: &Unlocked) -> Result<Vec<VaultItem>, String> {
    serde_json::from_slice(&unlocked.body).map_err(|e| format!("密码库正文解析失败: {e}"))
}

fn parse_meta(unlocked: &Unlocked) -> VaultMeta {
    serde_json::from_slice(&unlocked.meta).unwrap_or_default()
}

fn push_audit(meta: &mut VaultMeta, action: &str, detail: impl Into<String>) {
    meta.audit.push(AuditEntry {
        at_ms: now_ms(),
        action: action.to_string(),
        detail: detail.into(),
    });
    if meta.audit.len() > MAX_AUDIT {
        let drop_n = meta.audit.len() - MAX_AUDIT;
        meta.audit.drain(0..drop_n);
    }
}

/// 改动条目的统一入口：解析 → 变更 → 审计 → 重新封装 → 原子写 → 回填内存。
fn mutate<T>(
    app: &AppHandle,
    action: &str,
    audit_detail: impl Into<String>,
    backup: bool,
    f: impl FnOnce(&mut Vec<VaultItem>, &mut VaultMeta) -> Result<T, String>,
) -> Result<T, String> {
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    require_unlocked(&mut m)?;

    let unlocked = m.unlocked.take().ok_or_else(|| "密码库已锁定".to_string())?;
    let mut items = match parse_items(&unlocked) {
        Ok(v) => v,
        Err(e) => {
            m.unlocked = Some(unlocked);
            return Err(e);
        }
    };
    let mut meta = parse_meta(&unlocked);

    let value = match f(&mut items, &mut meta) {
        Ok(v) => v,
        Err(e) => {
            m.unlocked = Some(unlocked);
            return Err(e);
        }
    };
    push_audit(&mut meta, action, audit_detail);

    let body = serde_json::to_vec(&items).map_err(|e| format!("序列化条目失败: {e}"))?;
    let meta_bytes = serde_json::to_vec(&meta).map_err(|e| format!("序列化元信息失败: {e}"))?;
    let wrote = (|| -> Result<(), String> {
        let env = m.envelope.as_mut().ok_or_else(|| "密码库未加载".to_string())?;
        env.reseal(&unlocked.dk, &meta_bytes, &body)?;
        write_envelope(app, env, backup)
    })();
    if wrote.is_err() {
        m.unlocked = Some(unlocked);
        return wrote.map(|_| value);
    }

    m.auto_lock_min = meta.auto_lock_min.max(1);
    m.last_activity = Instant::now();
    m.unlocked = Some(Unlocked { dk: unlocked.dk, meta: meta_bytes, body });
    Ok(value)
}

fn status_from(m: &mut VaultMemory) -> VaultStatus {
    let (item_count, trashed_count) = match m.unlocked.as_ref() {
        Some(u) => match parse_items(u) {
            Ok(items) => {
                let trashed = items.iter().filter(|i| i.deleted_at_ms.is_some()).count();
                (items.len().saturating_sub(trashed), trashed)
            }
            Err(_) => (0, 0),
        },
        None => (0, 0),
    };
    match m.envelope.as_ref() {
        Some(env) => VaultStatus {
            exists: true,
            unlocked: m.unlocked.is_some(),
            item_count,
            trashed_count,
            has_device_slot: env.slot_count(SlotKind::Device) > 0,
            recovery_slots: env.slot_count(SlotKind::Recovery),
            auto_lock_min: m.auto_lock_min.max(1),
            created_at_ms: env.created_at_ms,
            updated_at_ms: env.updated_at_ms,
            min_password_chars: min_master_password_chars(),
            biometric_required: m.policy.biometric_required,
            biometric_auto_prompt: m.policy.biometric_auto_prompt,
            biometric_supported: availability_cached().supported,
            biometric_detail: availability_cached().detail.clone(),
        },
        None => VaultStatus {
            exists: false,
            unlocked: false,
            item_count: 0,
            trashed_count: 0,
            has_device_slot: false,
            recovery_slots: 0,
            auto_lock_min: DEFAULT_AUTO_LOCK_MIN,
            created_at_ms: 0,
            updated_at_ms: 0,
            min_password_chars: min_master_password_chars(),
            biometric_required: m.policy.biometric_required,
            biometric_auto_prompt: m.policy.biometric_auto_prompt,
            biometric_supported: availability_cached().supported,
            biometric_detail: availability_cached().detail.clone(),
        },
    }
}

fn refresh_unlock_after_meta_write(
    app: &AppHandle,
    m: &mut VaultMemory,
    mut unlocked: Unlocked,
    meta: VaultMeta,
    action: &str,
    detail: &str,
) -> Result<VaultStatus, String> {
    let mut meta = meta;
    meta.last_unlock_ms = now_ms();
    push_audit(&mut meta, action, detail);
    let meta_bytes = serde_json::to_vec(&meta).map_err(|e| format!("序列化元信息失败: {e}"))?;
    let env = m.envelope.as_mut().ok_or_else(|| "密码库未加载".to_string())?;
    env.reseal(&unlocked.dk, &meta_bytes, &unlocked.body)?;
    write_envelope(app, env, false)?;
    unlocked.meta = meta_bytes;
    m.auto_lock_min = meta.auto_lock_min.max(1);
    m.unlocked = Some(unlocked);
    m.last_activity = Instant::now();
    Ok(status_from(m))
}

// ===================== 生命周期命令实现 =====================

pub fn status(app: &AppHandle) -> Result<VaultStatus, String> {
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    check_auto_lock(&mut m);
    Ok(status_from(&mut m))
}

pub fn create(
    app: &AppHandle,
    password: &str,
    enable_device_unlock: bool,
    auto_lock_min: Option<u32>,
) -> Result<CreateOutcome, String> {
    let min_chars = min_master_password_chars();
    if password.chars().count() < min_chars {
        return Err(format!("主密码至少 {min_chars} 位"));
    }
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    if m.envelope.is_some() {
        return Err("密码库已存在；如需重建请先备份并手动删除 vault/vault.json".to_string());
    }

    let now = now_ms();
    let meta = VaultMeta {
        schema: 1,
        auto_lock_min: auto_lock_min.unwrap_or(DEFAULT_AUTO_LOCK_MIN).clamp(1, 120),
        created_at_ms: now,
        last_unlock_ms: now,
        last_password_change_ms: now,
        audit: vec![AuditEntry {
            at_ms: now,
            action: "vault.create".to_string(),
            detail: if enable_device_unlock { "创建密码库（启用本机免密解锁）" } else { "创建密码库" }
                .to_string(),
        }],
    };
    let meta_bytes = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    let body = b"[]".to_vec();

    let (mut env, dk) = Envelope::create(Kdf::default(), password, &meta_bytes, &body)?;
    if enable_device_unlock {
        env.add_slot(&dk, &machine_passphrase(), SlotKind::Device, Some("本机解锁".to_string()))?;
    }
    let codes = vault_crypto::generate_recovery_codes();
    vault_crypto::install_recovery_codes(&mut env, &dk, &codes)?;

    write_envelope(app, &env, false)?;
    m.auto_lock_min = meta.auto_lock_min;
    m.envelope = Some(env);
    m.unlocked = Some(Unlocked { dk, meta: meta_bytes, body });
    m.last_activity = Instant::now();
    let status = status_from(&mut m);
    Ok(CreateOutcome { recovery_codes: codes, status })
}

pub fn unlock(app: &AppHandle, password: &str) -> Result<VaultStatus, String> {
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    let env = m.envelope.as_ref().ok_or_else(|| "密码库不存在".to_string())?;
    let unlocked = env.unlock(password)?;
    let meta = parse_meta(&unlocked);
    refresh_unlock_after_meta_write(app, &mut m, unlocked, meta, "vault.unlock", "主密码解锁")
}

pub fn unlock_device(app: &AppHandle) -> Result<VaultStatus, String> {
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    if m.policy.biometric_required {
        return Err("本机解锁已设为必须通过生物识别，请使用 Windows Hello".to_string());
    }
    unlock_device_inner(app, &mut m, "本机免密解锁")
}

fn unlock_device_inner(
    app: &AppHandle,
    m: &mut VaultMemory,
    audit_detail: &str,
) -> Result<VaultStatus, String> {
    let env = m.envelope.as_ref().ok_or_else(|| "密码库不存在".to_string())?;
    let idx = env
        .slots
        .iter()
        .position(|s| s.kind == SlotKind::Device)
        .ok_or_else(|| "本机免密解锁未启用".to_string())?;
    let unlocked = env.unlock_with_slot(idx, &machine_passphrase())?;
    let meta = parse_meta(&unlocked);
    refresh_unlock_after_meta_write(app, m, unlocked, meta, "vault.unlock", audit_detail)
}

/// 把主窗口拉到前台并取 HWND：系统验证框以窗口为父，用户可直接按指纹；
/// 无窗口版的提示在桌面应用里可能被压在后面（实机踩过）。
fn main_window_hwnd(app: &AppHandle) -> isize {
    #[cfg(windows)]
    {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            if let Ok(h) = w.hwnd() {
                return h.0 as isize;
            }
        }
    }
    let _ = app;
    0
}

/// 生物识别解锁：先由 Rust 调系统验证，通过后才解 device 槽位。
/// 前端无法绕过：验证与解槽在同一个后端命令里。
pub fn unlock_biometric(app: &AppHandle) -> Result<VaultStatus, String> {
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    let env = m.envelope.as_ref().ok_or_else(|| "密码库不存在".to_string())?;
    if env.slot_count(SlotKind::Device) == 0 {
        return Err("本机免密解锁未启用，无法使用生物识别".to_string());
    }
    if !availability_cached().supported {
        return Err(availability_cached().detail.clone());
    }
    let verified = biometric::verify(main_window_hwnd(app), "解锁安得云荟密码库")?;
    if !verified {
        return Err("生物识别未通过，请重试或改用主密码".to_string());
    }
    unlock_device_inner(app, &mut m, "生物识别解锁")
}

/// 开关「本机解锁必须经过生物识别」。开启前先做一次真实验证，避免开了却用不了。
pub fn set_biometric_required(app: &AppHandle, required: bool) -> Result<VaultStatus, String> {
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    {
        let env = m.envelope.as_ref().ok_or_else(|| "密码库不存在".to_string())?;
        if required && env.slot_count(SlotKind::Device) == 0 {
            return Err("请先启用本机免密解锁，再要求生物识别".to_string());
        }
    }
    if required {
        if !availability_cached().supported {
            return Err(availability_cached().detail.clone());
        }
        let verified = biometric::verify(main_window_hwnd(app), "启用密码库生物识别解锁")?;
        if !verified {
            return Err("生物识别未通过，未开启".to_string());
        }
    }
    let mut policy = m.policy.clone();
    policy.biometric_required = required;
    write_policy(app, &policy)?;
    m.policy = policy;
    Ok(status_from(&mut m))
}

/// 开关「进入锁屏自动触发一次生物识别」。
pub fn set_biometric_auto_prompt(app: &AppHandle, enabled: bool) -> Result<VaultStatus, String> {
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    if m.envelope.is_none() {
        return Err("密码库不存在".to_string());
    }
    let mut policy = m.policy.clone();
    policy.biometric_auto_prompt = enabled;
    write_policy(app, &policy)?;
    m.policy = policy;
    Ok(status_from(&mut m))
}

pub fn lock(app: &AppHandle) -> Result<VaultStatus, String> {
    let mut m = lock_memory();
    // 连信封一起丢：下次从磁盘重读，外部改动不会被陈旧内存盖掉
    m.unlocked = None;
    m.envelope = None;
    m.last_activity = Instant::now();
    let mut fresh = VaultMemory::new();
    load_into_memory(app, &mut fresh)?;
    Ok(status_from(&mut fresh))
}

pub fn change_password(
    app: &AppHandle,
    current_password: &str,
    new_password: &str,
) -> Result<VaultStatus, String> {
    let min_chars = min_master_password_chars();
    if new_password.chars().count() < min_chars {
        return Err(format!("新主密码至少 {min_chars} 位"));
    }
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    require_unlocked(&mut m)?;

    // 已解锁也必须验证当前主密码：防止有人趁会话未锁直接改口令接管库。
    {
        let env = m.envelope.as_ref().ok_or_else(|| "密码库未加载".to_string())?;
        env.unlock(current_password)?;
    }

    let mut unlocked = m.unlocked.take().ok_or_else(|| "密码库已锁定".to_string())?;
    let mut meta = parse_meta(&unlocked);
    let result = (|| -> Result<(), String> {
        let env = m.envelope.as_mut().ok_or_else(|| "密码库未加载".to_string())?;
        env.rotate_password(&unlocked.dk, new_password)?;
        meta.last_password_change_ms = now_ms();
        push_audit(&mut meta, "vault.password_change", "修改主密码");
        let meta_bytes = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
        env.reseal(&unlocked.dk, &meta_bytes, &unlocked.body)?;
        write_envelope(app, env, true)?;
        unlocked.meta = meta_bytes;
        Ok(())
    })();
    if let Err(e) = result {
        m.unlocked = Some(unlocked);
        return Err(e);
    }
    m.auto_lock_min = meta.auto_lock_min.max(1);
    m.unlocked = Some(unlocked);
    m.last_activity = Instant::now();
    Ok(status_from(&mut m))
}

pub fn rotate_recovery_codes(app: &AppHandle) -> Result<Vec<String>, String> {
    let codes = vault_crypto::generate_recovery_codes();
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    require_unlocked(&mut m)?;

    let mut unlocked = m.unlocked.take().ok_or_else(|| "密码库已锁定".to_string())?;
    let mut meta = parse_meta(&unlocked);
    let install = (|| -> Result<(), String> {
        let env = m.envelope.as_mut().ok_or_else(|| "密码库未加载".to_string())?;
        vault_crypto::install_recovery_codes(env, &unlocked.dk, &codes)?;
        push_audit(&mut meta, "vault.recovery_rotate", "重新生成备用验证码");
        let meta_bytes = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
        env.reseal(&unlocked.dk, &meta_bytes, &unlocked.body)?;
        write_envelope(app, env, true)?;
        unlocked.meta = meta_bytes;
        Ok(())
    })();
    if let Err(e) = install {
        m.unlocked = Some(unlocked);
        return Err(e);
    }
    m.auto_lock_min = meta.auto_lock_min.max(1);
    m.last_activity = Instant::now();
    m.unlocked = Some(unlocked);
    Ok(codes)
}

pub fn redeem_recovery(
    app: &AppHandle,
    code: &str,
    new_password: &str,
) -> Result<RedeemOutcome, String> {
    let min_chars = min_master_password_chars();
    if new_password.chars().count() < min_chars {
        return Err(format!("新主密码至少 {min_chars} 位"));
    }
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;

    let env = m.envelope.as_mut().ok_or_else(|| "密码库不存在".to_string())?;
    let dk = env.consume_recovery(code)?;
    env.rotate_password(&dk, new_password)?;
    let mut unlocked = match env.open_with_dk(dk) {
        Ok(u) => u,
        Err(e) => {
            // 槽位已消耗但正文解不开：属于文件被改写，保留现场交给用户恢复备份。
            return Err(format!("备用码换开后无法解密正文: {e}"));
        }
    };
    let mut meta = parse_meta(&unlocked);
    meta.last_password_change_ms = now_ms();
    push_audit(&mut meta, "vault.recovery_redeem", "使用备用验证码重置主密码");
    let meta_bytes = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    env.reseal(&unlocked.dk, &meta_bytes, &unlocked.body)?;
    write_envelope(app, env, true)?;
    let env = m.envelope.as_ref().ok_or_else(|| "密码库未加载".to_string())?;
    let remaining = env.slot_count(SlotKind::Recovery);

    unlocked.meta = meta_bytes;
    m.auto_lock_min = meta.auto_lock_min.max(1);
    m.unlocked = Some(unlocked);
    m.last_activity = Instant::now();
    let status = status_from(&mut m);
    Ok(RedeemOutcome { remaining_recovery_codes: remaining, status })
}

// ===================== 条目 CRUD =====================

pub fn list(app: &AppHandle) -> Result<Vec<VaultItem>, String> {
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    require_unlocked(&mut m)?;
    let unlocked = m.unlocked.as_ref().ok_or_else(|| "密码库已锁定".to_string())?;
    parse_items(unlocked)
}

pub fn get_item(app: &AppHandle, id: &str) -> Result<VaultItem, String> {
    let items = list(app)?;
    items
        .into_iter()
        .find(|i| i.id == id)
        .ok_or_else(|| format!("条目不存在: {id}"))
}

pub fn save_item(app: &AppHandle, mut item: VaultItem) -> Result<VaultItem, String> {
    if item.title.trim().is_empty() && item.username.trim().is_empty() {
        return Err("条目标题与用户名不能同时为空".to_string());
    }
    let action = if item.id.is_empty() { "item.create" } else { "item.update" };
    let detail = if item.title.trim().is_empty() {
        item.username.clone()
    } else {
        item.title.clone()
    };
    let saved = mutate(app, action, detail, true, move |items, _meta| {
        let now = now_ms();
        item.updated_at_ms = now;
        if item.id.is_empty() {
            item.id = uuid::Uuid::new_v4().to_string();
            item.created_at_ms = now;
            items.push(item.clone());
            return Ok(item);
        }
        let pos = items
            .iter()
            .position(|i| i.id == item.id)
            .ok_or_else(|| format!("条目不存在: {}", item.id))?;
        let old = items[pos].clone();
        item.created_at_ms = old.created_at_ms;
        if item.history.is_empty() {
            item.history = old.history.clone();
        }
        if old.password != item.password || old.title != item.title {
            item.history.push(ItemVersion {
                at_ms: old.updated_at_ms,
                title: old.title,
                username: old.username,
                password: old.password,
            });
            if item.history.len() > MAX_HISTORY {
                let drop_n = item.history.len() - MAX_HISTORY;
                item.history.drain(0..drop_n);
            }
        }
        items[pos] = item.clone();
        Ok(item)
    })?;
    Ok(saved)
}

pub fn delete_item(app: &AppHandle, id: &str, hard: bool) -> Result<(), String> {
    let title = get_item(app, id)
        .map(|i| if i.title.trim().is_empty() { i.id } else { i.title })
        .unwrap_or_else(|_| id.to_string());
    let id_owned = id.to_string();
    mutate(
        app,
        if hard { "item.purge" } else { "item.trash" },
        format!("{}：{}", if hard { "永久删除" } else { "移入回收站" }, title),
        true,
        move |items, _meta| {
            if hard {
                let before = items.len();
                items.retain(|i| i.id != id_owned);
                if items.len() == before {
                    return Err("条目不存在".to_string());
                }
            } else {
                let it = items
                    .iter_mut()
                    .find(|i| i.id == id_owned)
                    .ok_or_else(|| "条目不存在".to_string())?;
                it.deleted_at_ms = Some(now_ms());
                it.updated_at_ms = now_ms();
            }
            Ok(())
        },
    )?;
    Ok(())
}

pub fn restore_item(app: &AppHandle, id: &str) -> Result<(), String> {
    let id_owned = id.to_string();
    mutate(app, "item.restore", "从回收站还原", true, move |items, _meta| {
        let it = items
            .iter_mut()
            .find(|i| i.id == id_owned)
            .ok_or_else(|| "条目不存在".to_string())?;
        it.deleted_at_ms = None;
        it.updated_at_ms = now_ms();
        Ok(())
    })?;
    Ok(())
}

pub fn empty_trash(app: &AppHandle) -> Result<usize, String> {
    mutate(app, "item.empty_trash", "清空回收站", true, |items, _meta| {
        let before = items.len();
        items.retain(|i| i.deleted_at_ms.is_none());
        Ok(before - items.len())
    })
}

/// 自动填充成功后调用。只更新时间戳，不产生备份。
pub fn mark_used(app: &AppHandle, id: &str) -> Result<(), String> {
    let id_owned = id.to_string();
    mutate(app, "item.used", "自动填充取用", false, move |items, _meta| {
        let it = items
            .iter_mut()
            .find(|i| i.id == id_owned)
            .ok_or_else(|| "条目不存在".to_string())?;
        it.last_used_at_ms = now_ms();
        Ok(())
    })?;
    Ok(())
}

pub fn set_auto_lock(app: &AppHandle, minutes: u32) -> Result<VaultStatus, String> {
    let minutes = minutes.clamp(1, 120);
    mutate(app, "vault.settings", format!("自动锁定改为 {minutes} 分钟"), false, move |_items, meta| {
        meta.auto_lock_min = minutes;
        Ok(())
    })?;
    status(app)
}

/// 整体移除密码库：校验主密码后删除 `vault.json` **与全部滚动备份**，并清空内存解锁态。
/// 必须验主密码：既防误删，也确保调用者确实持有库口令（未锁定时同样要求）。
pub fn destroy(app: &AppHandle, password: &str) -> Result<(), String> {
    if password.is_empty() {
        return Err("请输入主密码以确认移除".to_string());
    }
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    {
        let env = m.envelope.as_ref().ok_or_else(|| "密码库不存在".to_string())?;
        env.unlock(password)?;
    }

    // 先清解锁态，避免删除过程中仍有命令能读到内存数据
    m.unlocked = None;
    m.envelope = None;
    m.policy = VaultPolicy::default();

    let path = vault_file(app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除密码库文件失败: {e}"))?;
    }
    let backups = backup_dir(app)?;
    if backups.exists() {
        if let Ok(entries) = std::fs::read_dir(&backups) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().map(|e| e == "json").unwrap_or(false) {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }
    let policy = policy_path(app)?;
    if policy.exists() {
        let _ = std::fs::remove_file(&policy);
    }
    Ok(())
}

pub fn audit_log(app: &AppHandle, limit: usize) -> Result<Vec<AuditEntry>, String> {
    let mut m = lock_memory();
    load_into_memory(app, &mut m)?;
    require_unlocked(&mut m)?;
    let unlocked = m.unlocked.as_ref().ok_or_else(|| "密码库已锁定".to_string())?;
    let meta = parse_meta(unlocked);
    let limit = limit.clamp(1, MAX_AUDIT);
    let skip = meta.audit.len().saturating_sub(limit);
    Ok(meta.audit.into_iter().skip(skip).collect())
}

/// 明文 JSON 导出：用户显式触发，UI 必须提示「这就是明文」。
pub fn export_json(app: &AppHandle) -> Result<String, String> {
    let items = mutate(app, "vault.export", "导出明文 JSON", false, |items, _meta| {
        Ok(items.clone())
    })?;
    let payload = serde_json::json!({
        "format": "andey-vault-json",
        "schema": 1,
        "exportedAt": now_ms(),
        "items": items,
    });
    serde_json::to_string_pretty(&payload).map_err(|e| format!("导出失败: {e}"))
}

/// 导入条目（CSV 的字段映射在前端完成，后端只收已结构化的条目）。
/// `replace` 会清空现有条目（含回收站），仅用于「换库」；默认 merge。
pub fn import_items(app: &AppHandle, items: Vec<VaultItem>, mode: &str) -> Result<usize, String> {
    if items.is_empty() {
        return Err("没有解析到可导入的条目".to_string());
    }
    if items.len() > 5000 {
        return Err("单次最多导入 5000 条".to_string());
    }
    let replace = mode == "replace";
    let count = items.len();
    mutate(
        app,
        "vault.import",
        format!("导入 {count} 条（{}）", if replace { "覆盖" } else { "合并" }),
        true,
        move |existing, _meta| {
            if replace {
                existing.clear();
            }
            let now = now_ms();
            let mut added = 0usize;
            for mut item in items {
                item.id = uuid::Uuid::new_v4().to_string();
                if item.created_at_ms == 0 {
                    item.created_at_ms = now;
                }
                item.updated_at_ms = now;
                item.deleted_at_ms = None;
                item.history.clear();
                existing.push(item);
                added += 1;
            }
            Ok(added)
        },
    )
}
