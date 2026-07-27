// 黄金棋盘 · 局域网传输后端（LocalSend v2 兼容）
//
// 本模块依据 LocalSend 项目（Apache License 2.0, Copyright 2022-2025 Tien Do Nam）的
// 协议规范与 Rust core 逻辑，在 Tauri 2 + Rust 架构下*重新实现*了局域网文件传输：
//   - UDP 组播发现（224.0.0.167:53317）
//   - HTTP 文件传输服务端（/api/localsend/v2/* 路由）
//   - 向对等端发送文件（兼容官方 LocalSend 与本应用互通）
//
// 第三方许可证与署名见 third_party/localsend/（LICENSE + NOTICE）。本应用不使用
// 「LocalSend」名称/商标；该功能在产品内称为「黄金棋盘 · 传输」。
//
// 本文件为对 LocalSend 协议的独立重新实现（非直接复制其 Flutter/Dart 或 Rust 源码），
// 依 Apache-2.0 第 4(b) 条在此标注：2026-07-27 重新实现局域网传输后端并集成至胶囊浮窗。

use std::collections::HashMap;
use std::error::Error;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{ConnectInfo, Query, State};
use axum::response::{IntoResponse, Response, Json};
use axum::routing::{get, post};
use axum::Router;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::{oneshot, Notify};
use tokio::task::JoinHandle;
use uuid::Uuid;

use serde_json;
use crate::commands::import_to_dropzone;

// ===================== 协议常量与数据类型（LocalSend v2） =====================

pub const PROTOCOL_VERSION: &str = "2.1";
pub const DEFAULT_PORT: u16 = 53317;
const MULTICAST_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 167);
const MULTICAST_PORT: u16 = 53317;
const ANNOUNCE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3);

/// 组播发现报文（v2）：发送公告与应答共用，靠 announce 区分。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MulticastMessageV2 {
    pub alias: String,
    pub version: String,
    #[serde(default)]
    pub device_model: Option<String>,
    #[serde(default)]
    pub device_type: Option<String>,
    pub fingerprint: String,
    pub port: u16,
    pub protocol: String,
    #[serde(default)]
    pub download: bool,
    #[serde(default)]
    pub announce: bool,
    // 兼容旧客户端（legacy v1 用 announcement 字段）
    #[serde(default, rename = "announcement")]
    pub announcement: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InfoResponseDtoV2 {
    pub alias: String,
    pub version: String,
    #[serde(default)]
    pub device_model: Option<String>,
    #[serde(default)]
    pub device_type: Option<String>,
    pub fingerprint: String,
    #[serde(default)]
    pub download: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfoV2 {
    pub alias: String,
    #[serde(default)]
    pub device_model: Option<String>,
    #[serde(default)]
    pub device_type: Option<String>,
    pub fingerprint: String,
    pub version: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrepareUploadFileV2 {
    pub id: String,
    pub file_name: String,
    pub size: u64,
    pub file_type: String,
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default)]
    pub checksum: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrepareUploadRequestV2 {
    pub info: ClientInfoV2,
    pub files: HashMap<String, PrepareUploadFileV2>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrepareUploadResponseV2 {
    pub session_id: String,
    pub files: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadQuery {
    session_id: String,
    file_id: String,
    token: Option<String>,
}

// ===================== 对等端 / 会话（运行时状态） =====================

#[derive(Clone, Debug, Serialize)]
pub struct Peer {
    pub fingerprint: String,
    pub alias: String,
    #[serde(default)]
    pub device_type: Option<String>,
    #[serde(default)]
    pub device_model: Option<String>,
    pub ip: String,
    pub port: u16,
    pub protocol: String,
}

struct SessionFile {
    token: String,
    file_name: String,
    size: u64,
    path: PathBuf,
    received: u64,
    done: bool,
}

struct Session {
    sender: ClientInfoV2,
    files: HashMap<String, SessionFile>,
    _created: Instant,
}

/// 进度事件载荷（前端）
#[derive(Clone, Debug, Serialize)]
pub struct TransferProgress {
    pub direction: String, // "send" | "receive"
    pub session_id: String,
    pub file_id: String,
    pub file_name: String,
    pub received: u64,
    pub total: u64,
    pub done: bool,
    pub peer_alias: String,
}

// ===================== 管理器 =====================

pub struct TransferManager {
    alias: Mutex<String>,
    port: u16,
    fingerprint: String,
    peers: Mutex<HashMap<String, Peer>>,
    sessions: Mutex<HashMap<String, Session>>,
    /// 接收文件保存目录（可在设置中更改；默认 = 安装目录根目录下的 send 文件夹）
    save_dir: Mutex<PathBuf>,
    /// 暂存待发送的文件路径（持久化到 config.json）
    staged: Mutex<Vec<String>>,
    /// 接收时是否自动接受（true=LocalSend 原生体验，false=弹确认）
    auto_accept: Mutex<bool>,
    config_path: PathBuf,
    app: AppHandle,
    server_handle: Mutex<Option<JoinHandle<()>>>,
    discovery_handle: Mutex<Option<JoinHandle<()>>>,
    /// 待确认接收的 session_id → 确认通道
    pending_accepts: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    shutdown: Arc<Notify>,
}

#[derive(Serialize, Deserialize, Default)]
struct TransferConfig {
    #[serde(default)]
    alias: String,
    #[serde(default)]
    save_dir: String,
    #[serde(default)]
    staged: Vec<String>,
    #[serde(default)]
    auto_accept: bool,
}

static TRANSFER: OnceLock<TransferManager> = OnceLock::new();

/// 保存目录首次写入失败时的兜底提示去重：避免每个文件都给前端弹一次目录选择框。
/// 用户在前端选好新目录（transfer_set_save_dir 成功）后复位，下次失败再次提示。
static SAVE_FALLBACK_PENDING: AtomicBool = AtomicBool::new(false);

/// 在 Tauri setup 中调用一次，建立全局管理器。
pub fn init(app: AppHandle) {
    let _ = TRANSFER.set(TransferManager::new(app));
}

pub fn mgr() -> &'static TransferManager {
    TRANSFER.get().expect("transfer::init 未在 setup 中调用")
}

impl TransferManager {
    fn new(app: AppHandle) -> Self {
        // 加载持久化配置
        let config_path = app
            .path()
            .app_data_dir()
            .map(|p| p.join("transfer").join("config.json"))
            .unwrap_or_else(|_| PathBuf::from("transfer/config.json"));
        let cfg: TransferConfig = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        // 默认接收保存目录：安装目录根目录（exe 所在目录）下的 send 文件夹。
        // 安装时若未创建，下方 create_dir_all 与首次接收时的 create_dir_all 都会兜底创建。
        let install_root = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."));
        let default_save = install_root.join("send");

        let save_dir = if cfg.save_dir.is_empty() {
            default_save
        } else {
            PathBuf::from(cfg.save_dir)
        };
        let _ = std::fs::create_dir_all(&save_dir);

        let alias = if cfg.alias.is_empty() {
            "安得云荟".to_string()
        } else {
            cfg.alias
        };

        TransferManager {
            alias: Mutex::new(alias),
            save_dir: Mutex::new(save_dir),
            staged: Mutex::new(cfg.staged),
            auto_accept: Mutex::new(cfg.auto_accept),
            config_path,
            pending_accepts: Mutex::new(HashMap::new()),
            port: DEFAULT_PORT,
            fingerprint: Uuid::new_v4().to_string(),
            peers: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            app,
            server_handle: Mutex::new(None),
            discovery_handle: Mutex::new(None),
            shutdown: Arc::new(Notify::new()),
        }
    }

    pub fn alias(&self) -> String {
        self.alias.lock().unwrap().clone()
    }

    pub fn set_alias(&self, alias: String) {
        *self.alias.lock().unwrap() = alias;
        self.save_config();
    }

    /// 持久化当前配置到 config.json（alias / save_dir / staged / auto_accept）
    fn save_config(&self) {
        let cfg = TransferConfig {
            alias: self.alias.lock().unwrap().clone(),
            save_dir: self.save_dir.lock().unwrap().to_string_lossy().to_string(),
            staged: self.staged.lock().unwrap().clone(),
            auto_accept: *self.auto_accept.lock().unwrap(),
        };
        if let Ok(s) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::create_dir_all(self.config_path.parent().unwrap_or(&PathBuf::from(".")));
            let _ = std::fs::write(&self.config_path, s);
        }
    }

    pub fn save_dir(&self) -> PathBuf {
        self.save_dir.lock().unwrap().clone()
    }

    pub fn set_save_dir(&self, dir: String) -> Result<(), String> {
        let p = PathBuf::from(&dir);
        std::fs::create_dir_all(&p).map_err(|e| format!("创建目录失败：{}", e))?;
        *self.save_dir.lock().unwrap() = p;
        self.save_config();
        // 用户已成功选择新目录，解除兜底提示锁定，下次失败可再次提示
        SAVE_FALLBACK_PENDING.store(false, Ordering::Release);
        Ok(())
    }

    pub fn staged(&self) -> Vec<String> {
        self.staged.lock().unwrap().clone()
    }

    pub fn set_staged(&self, paths: Vec<String>) {
        *self.staged.lock().unwrap() = paths;
        self.save_config();
    }

    pub fn auto_accept(&self) -> bool {
        *self.auto_accept.lock().unwrap()
    }

    pub fn set_auto_accept(&self, v: bool) {
        *self.auto_accept.lock().unwrap() = v;
        self.save_config();
    }

    /// 用户在 UI 上接受后调用：唤醒 prepare_handler 阻塞
    pub fn accept_receive(&self, session_id: String) {
        if let Some(tx) = self.pending_accepts.lock().unwrap().remove(&session_id) {
            let _ = tx.send(true);
        }
    }

    pub fn decline_receive(&self, session_id: String) {
        if let Some(tx) = self.pending_accepts.lock().unwrap().remove(&session_id) {
            let _ = tx.send(false);
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn fingerprint(&self) -> String {
        self.fingerprint.clone()
    }

    fn emit(&self, event: &str, payload: impl Serialize + Clone) {
        let _ = self.app.emit(event, payload);
    }

    /// 保存目录无法创建/写入时，向前端抛出一次性兜底提示，引导用户用系统目录选择框换一个位置。
    /// 用 SAVE_FALLBACK_PENDING 去重：首次失败时提示一次，用户在前端选好新目录（set_save_dir 成功）
    /// 后复位，下次再失败才再次提示，避免海量文件时反复弹窗。
    fn notify_save_dir_invalid(&self, path: &PathBuf, reason: &str) {
        if SAVE_FALLBACK_PENDING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return; // 已经提示过，等用户处理
        }
        log::warn!("[传输] 保存目录不可用，触发兜底选择：{path:?} 原因：{reason}");
        let _ = self.app.emit(
            "transfer:save-dir-invalid",
            serde_json::json!({
                "path": path.to_string_lossy().to_string(),
                "reason": reason,
            }),
        );
    }

    fn self_multicast(&self) -> MulticastMessageV2 {
        MulticastMessageV2 {
            alias: self.alias(),
            version: PROTOCOL_VERSION.to_string(),
            device_model: Some(std::env::consts::OS.to_string()),
            device_type: Some("desktop".to_string()),
            fingerprint: self.fingerprint.clone(),
            port: self.port,
            protocol: "http".to_string(),
            download: false,
            announce: true,
            announcement: true,
        }
    }

    fn self_multicast_without_announce(&self) -> MulticastMessageV2 {
        let mut m = self.self_multicast();
        m.announce = false;
        m.announcement = false;
        m
    }

    // ---------- 启动 / 停止 ----------
    pub async fn start(&self) {
        if self.server_handle.lock().unwrap().is_some() {
            return;
        }
        self.start_server().await;
        self.start_discovery().await;
    }

    pub fn stop(&self) {
        self.shutdown.notify_waiters();
        if let Some(h) = self.server_handle.lock().unwrap().take() {
            h.abort();
        }
        if let Some(h) = self.discovery_handle.lock().unwrap().take() {
            h.abort();
        }
    }

    pub fn is_running(&self) -> bool {
        self.server_handle.lock().unwrap().is_some()
    }

    pub fn list_peers(&self) -> Vec<Peer> {
        self.peers.lock().unwrap().values().cloned().collect()
    }

    // ---------- HTTP 服务端 ----------
    async fn start_server(&self) {
        let port = self.port;
        let mgr: &'static TransferManager = mgr();
        let addr: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port));
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                log::warn!("[transfer] HTTP 服务端绑定 {addr} 失败: {e}");
                return;
            }
        };
        let state = ServerState { mgr };
        let app = Router::new()
            .route("/api/localsend/v2/info", get(info_handler))
            .route("/api/localsend/v2/register", post(register_handler))
            .route("/api/localsend/v2/prepare-upload", post(prepare_handler))
            .route("/api/localsend/v2/upload", post(upload_handler))
            .route("/api/localsend/v2/cancel", post(cancel_handler))
            .route("/api/localsend/v2/download", get(download_handler))
            .with_state(state);

        let shutdown = self.shutdown.clone();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(async move {
                    shutdown.notified().await;
                })
                .await;
        });
        *self.server_handle.lock().unwrap() = Some(handle);
        log::info!("[transfer] HTTP 服务端已启动 :{port}");
    }

    // ---------- UDP 组播发现 ----------
    async fn start_discovery(&self) {
        let group = MULTICAST_GROUP;
        let bind_addr: SocketAddr =
            SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, MULTICAST_PORT));
        let socket = match UdpSocket::bind(bind_addr).await {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[transfer] UDP 组播监听绑定 {bind_addr} 失败: {e}");
                return;
            }
        };
        let local = local_ip();
        if let Err(e) = socket.join_multicast_v4(group, local) {
            log::warn!("[transfer] 加入组播组失败 {group}/{local}: {e}");
        }

        let send_socket = match UdpSocket::bind("0.0.0.0:0").await {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[transfer] UDP 发送套接字绑定失败: {e}");
                return;
            }
        };
        let announce = self.self_multicast();
        let send_buf = match serde_json::to_vec(&announce) {
            Ok(b) => b,
            Err(_) => return,
        };
        let target = SocketAddr::V4(SocketAddrV4::new(group, MULTICAST_PORT));
        let _ = send_socket.send_to(&send_buf, target).await;

        let mgr: &'static TransferManager = mgr();
        let recv_task = tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            loop {
                tokio::select! {
                    r = socket.recv_from(&mut buf) => {
                        match r {
                            Ok((n, src)) => mgr.handle_discovery_packet(&buf[..n], src).await,
                            Err(_) => break,
                        }
                    }
                    _ = mgr.shutdown.notified() => break,
                }
            }
        });
        *self.discovery_handle.lock().unwrap() = Some(recv_task);

        // 定时公告：每次循环重新读当前 alias 并序列化，确保 transfer_set_alias
        // 后对端看到的是新名称（此前预序列化 send_buf 永远发送旧名称）。
        let send_socket2 = send_socket;
        let shutdown2 = self.shutdown.clone();
        let mgr_static: &'static TransferManager = mgr;
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(ANNOUNCE_INTERVAL) => {
                        let announce = mgr_static.self_multicast();
                        if let Ok(buf) = serde_json::to_vec(&announce) {
                            let _ = send_socket2.send_to(&buf, target).await;
                        }
                    }
                    _ = shutdown2.notified() => break,
                }
            }
        });
    }

    /// 立即向组播组发送公告（面板打开时调用）。
    /// 连发 3 次（间隔 300ms），大幅加快首次发现——对端收报到后立刻回 register。
    pub async fn announce_now(&self) {
        let send_socket = match UdpSocket::bind("0.0.0.0:0").await {
            Ok(s) => s,
            Err(_) => return,
        };
        let target = SocketAddr::V4(SocketAddrV4::new(MULTICAST_GROUP, MULTICAST_PORT));
        for i in 0..3 {
            let announce = self.self_multicast();
            if let Ok(buf) = serde_json::to_vec(&announce) {
                let _ = send_socket.send_to(&buf, target).await;
            }
            if i < 2 {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
        }
    }

    async fn handle_discovery_packet(&self, data: &[u8], src: SocketAddr) {
        let msg: MulticastMessageV2 = match serde_json::from_slice(data) {
            Ok(m) => m,
            Err(_) => return,
        };
        if msg.fingerprint == self.fingerprint {
            return; // 自身
        }
        let ip = match src {
            SocketAddr::V4(v4) => v4.ip().to_string(),
            SocketAddr::V6(v6) => v6.ip().to_string(),
        };
        let peer = Peer {
            fingerprint: msg.fingerprint.clone(),
            alias: msg.alias.clone(),
            device_type: msg.device_type.clone(),
            device_model: msg.device_model.clone(),
            ip,
            port: msg.port,
            protocol: msg.protocol.clone(),
        };
        let peer_event = peer.clone();
        let is_new = {
            let mut peers = self.peers.lock().unwrap();
            let existed = peers.contains_key(&peer.fingerprint);
            peers.insert(peer.fingerprint.clone(), peer);
            !existed
        };
        if is_new {
            self.emit("transfer-peer-found", &peer_event);
        }
        // 仅当对方是公告(announce/announcement=true)时才应答，避免回环
        if msg.announce || msg.announcement {
            self.reply_register(&peer_event).await;
        }
    }

    async fn reply_register(&self, peer: &Peer) {
        // 尊重对端公告的 protocol：优先用其声明方案，失败再回退另一种（http<->https），
        // 兼容官方 LocalSend 加密(https) 与「声明 https 实则 http」两种情况。
        let schemes: [&str; 2] = [
            if peer.protocol == "https" { "https" } else { "http" },
            if peer.protocol == "https" { "http" } else { "https" },
        ];
        let dto = self.self_multicast_without_announce();
        let body = match serde_json::to_string(&dto) {
            Ok(b) => b,
            Err(_) => return,
        };
        for scheme in schemes {
            let url = format!("{scheme}://{}:{}/api/localsend/v2/register", peer.ip, peer.port);
            let mut builder = reqwest::Client::builder().no_proxy();
            if scheme == "https" {
                builder = builder
                    .danger_accept_invalid_certs(true)
                    .danger_accept_invalid_hostnames(true);
            }
            let client = builder
                .build()
                .unwrap_or_else(|_| reqwest::Client::new());
            let _ = client
                .post(&url)
                .header("Content-Type", "application/json")
                .body(body.clone())
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await;
        }
    }

    // ---------- 会话管理 ----------
    fn create_session(&self, session_id: String, req: PrepareUploadRequestV2) -> PrepareUploadResponseV2 {
        let mut files = HashMap::new();
        let mut session_files = HashMap::new();
        let session_dir = self.save_dir().join(&session_id);
        if let Err(e) = std::fs::create_dir_all(&session_dir) {
            self.notify_save_dir_invalid(&session_dir, &e.to_string());
        }
        for (file_id, f) in req.files {
            let token = Uuid::new_v4().to_string();
            let safe_name = sanitize_filename(&f.file_name);
            let path = session_dir.join(&safe_name);
            files.insert(file_id.clone(), token.clone());
            session_files.insert(
                file_id,
                SessionFile {
                    token,
                    file_name: f.file_name,
                    size: f.size,
                    path,
                    received: 0,
                    done: false,
                },
            );
        }
        self.sessions.lock().unwrap().insert(
            session_id.clone(),
            Session {
                sender: req.info,
                files: session_files,
                _created: Instant::now(),
            },
        );
        PrepareUploadResponseV2 {
            session_id,
            files,
        }
    }

    fn cancel_session(&self, session_id: &str) {
        self.sessions.lock().unwrap().remove(session_id);
    }

    fn target_path(&self, session_id: &str, file_id: &str, token: &str) -> Option<PathBuf> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions.get(session_id)?;
        let f = s.files.get(file_id)?;
        if f.token != token {
            return None;
        }
        Some(f.path.clone())
    }

    fn mark_done(&self, session_id: &str, file_id: &str, _peer_alias: &str) {
        let progress = {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.get_mut(session_id) {
                if let Some(f) = s.files.get_mut(file_id) {
                    f.done = true;
                    f.received = f.size;
                    // 接收落盘同时把文件「复制」进「中转站」（dropzone），构建生态闭环。
                    // 用 move_source=false（复制语义）：保留 save_dir/<session_id>/ 下的「本地保存路径」存档，
                    // dropzone 仅作中转站副本——这样用户在「接收文件保存目录」设置里能直接找到文件（本地保存），
                    // 同时中转站仍可拖出 / OCR / 批量导出。删除中转站文件不影响本地存档。
                    let _ = import_to_dropzone(
                        self.app.clone(),
                        f.path.clone().to_string_lossy().to_string(),
                        None,
                        Some(false),
                    );
                    Some(TransferProgress {
                        direction: "receive".to_string(),
                        session_id: session_id.to_string(),
                        file_id: file_id.to_string(),
                        file_name: f.file_name.clone(),
                        received: f.size,
                        total: f.size,
                        done: true,
                        peer_alias: s.sender.alias.clone(),
                    })
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some(p) = progress {
            self.emit("transfer-progress", &p);
            self.emit("transfer-received", &p);
        }
    }

    fn emit_receive_progress(&self, session_id: &str, file_id: &str, received: u64, total: u64) {
        let info = {
            let sessions = self.sessions.lock().unwrap();
            sessions.get(session_id).and_then(|s| {
                s.files.get(file_id).map(|f| (f.file_name.clone(), s.sender.alias.clone()))
            })
        };
        if let Some((file_name, peer_alias)) = info {
            self.emit(
                "transfer-progress",
                TransferProgress {
                    direction: "receive".to_string(),
                    session_id: session_id.to_string(),
                    file_id: file_id.to_string(),
                    file_name,
                    received,
                    total,
                    done: false,
                    peer_alias,
                },
            );
        }
    }
}

#[derive(Clone, Copy)]
struct ServerState {
    mgr: &'static TransferManager,
}

// ===================== HTTP 路由处理函数 =====================

async fn info_handler(State(state): State<ServerState>) -> Json<InfoResponseDtoV2> {
    let m = state.mgr;
    Json(InfoResponseDtoV2 {
        alias: m.alias(),
        version: PROTOCOL_VERSION.to_string(),
        device_model: Some(std::env::consts::OS.to_string()),
        device_type: Some("desktop".to_string()),
        fingerprint: m.fingerprint(),
        download: false,
    })
}

async fn register_handler(
    State(state): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(msg): Json<MulticastMessageV2>,
) -> axum::http::StatusCode {
    if msg.fingerprint == state.mgr.fingerprint() {
        return axum::http::StatusCode::OK;
    }
    // 用对端真实连接 IP，避免被覆盖成 0.0.0.0 导致无法回发
    let ip = addr.ip().to_string();
    let peer = Peer {
        fingerprint: msg.fingerprint.clone(),
        alias: msg.alias.clone(),
        device_type: msg.device_type.clone(),
        device_model: msg.device_model.clone(),
        ip,
        port: msg.port,
        protocol: msg.protocol.clone(),
    };
    let mut peers = state.mgr.peers.lock().unwrap();
    peers.insert(peer.fingerprint.clone(), peer);
    axum::http::StatusCode::OK
}

async fn prepare_handler(
    State(state): State<ServerState>,
    Json(req): Json<PrepareUploadRequestV2>,
) -> Response {
    let auto_accept = state.mgr.auto_accept();
    let session_id = new_session_id();
    let sender_alias = req.info.alias.clone();
    let file_names: Vec<String> = req.files.values().map(|f| f.file_name.clone()).collect();

    if auto_accept {
        // 自动接受：直接创建 session + 通知前端（用作 UI 提示）
        state.mgr.emit("transfer-receive-request", &serde_json::json!({
            "session_id": session_id,
            "sender_alias": sender_alias,
            "file_count": file_names.len(),
            "file_names": file_names,
            "auto_accept": true,
        }));
        return Json(state.mgr.create_session(session_id, req)).into_response();
    }

    // 需要用户确认：oneshot 等待 30s 内前端 transfer_receive_accept/decline
    let (tx, rx) = oneshot::channel::<bool>();
    state.mgr.pending_accepts.lock().unwrap().insert(session_id.clone(), tx);
    state.mgr.emit("transfer-receive-request", &serde_json::json!({
        "session_id": session_id,
        "sender_alias": sender_alias,
        "file_count": file_names.len(),
        "file_names": file_names,
        "auto_accept": false,
    }));

    match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(true)) => Json(state.mgr.create_session(session_id, req)).into_response(),
        _ => {
            // 拒绝或超时：清理 pending 并返回 403
            state.mgr.pending_accepts.lock().unwrap().remove(&session_id);
            (axum::http::StatusCode::FORBIDDEN, "用户拒绝或超时未确认").into_response()
        }
    }
}

async fn upload_handler(
    State(state): State<ServerState>,
    Query(q): Query<UploadQuery>,
    body: Body,
) -> Response {
    let token = q.token.unwrap_or_default();
    let path = match state.mgr.target_path(&q.session_id, &q.file_id, &token) {
        Some(p) => p,
        None => return (axum::http::StatusCode::FORBIDDEN, "invalid session/token").into_response(),
    };
    let mut file = match tokio::fs::File::create(&path).await {
        Ok(f) => f,
        Err(_) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "create failed").into_response(),
    };
    let mut stream = body.into_data_stream();
    let mut total: u64 = 0;
    let session_id = q.session_id.clone();
    let file_id = q.file_id.clone();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                if let Err(e) = file.write_all(&bytes).await {
                    // 写入失败（常见于默认目录无写权限，如安装到 C:\Program Files\send 且以普通用户运行）：
                    // 触发一次性兜底，引导前端弹系统目录选择框换位置。
                    state
                        .mgr
                        .notify_save_dir_invalid(&state.mgr.save_dir().join(&session_id), &e.to_string());
                    return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "write failed").into_response();
                }
                total += bytes.len() as u64;
                state.mgr.emit_receive_progress(&session_id, &file_id, total, total);
            }
            Err(_) => {
                return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "read failed").into_response();
            }
        }
    }
    state.mgr.mark_done(&session_id, &file_id, "peer");
    axum::http::StatusCode::OK.into_response()
}

async fn cancel_handler(State(state): State<ServerState>, Query(q): Query<UploadQuery>) -> Response {
    state.mgr.cancel_session(&q.session_id);
    axum::http::StatusCode::OK.into_response()
}

async fn download_handler(State(state): State<ServerState>, Query(q): Query<UploadQuery>) -> Response {
    let token = q.token.unwrap_or_default();
    let path = match state.mgr.target_path(&q.session_id, &q.file_id, &token) {
        Some(p) => p,
        None => return (axum::http::StatusCode::FORBIDDEN, "invalid").into_response(),
    };
    let data = match tokio::fs::read(&path).await {
        Ok(d) => d,
        Err(_) => return (axum::http::StatusCode::NOT_FOUND, "not found").into_response(),
    };
    Response::builder()
        .body(Body::from(data))
        .unwrap_or_else(|_| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "stream").into_response())
}

// ===================== 客户端：发送文件 =====================

/// 向指定指纹的对等端发送一组本地文件。返回发送会话信息或错误。
pub async fn send_files(mgr: &TransferManager, fingerprint: &str, paths: Vec<String>) -> Result<String, String> {
    let peer = {
        let peers = mgr.peers.lock().unwrap();
        peers.get(fingerprint).cloned()
    };
    let peer = peer.ok_or_else(|| "未找到目标设备".to_string())?;

    let mut files = HashMap::new();
    let mut file_paths = Vec::new();
    for p in paths {
        let path = PathBuf::from(&p);
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        let file_name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());
        let size = meta.len();
        let file_type = guess_file_type(&path);
        let id = Uuid::new_v4().to_string();
        // 预读文件内容（原实现也是整文件读入内存，无回归）；协议回退时直接复用，不再重读大文件。
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|e| format!("读取文件失败：{e}"))?;
        files.insert(
            id.clone(),
            PrepareUploadFileV2 {
                id: id.clone(),
                file_name: file_name.clone(),
                size,
                file_type,
                preview: None,
                checksum: None,
            },
        );
        file_paths.push((id, path, file_name, size, bytes));
    }

    let req = PrepareUploadRequestV2 {
        info: ClientInfoV2 {
            alias: mgr.alias(),
            device_model: Some(std::env::consts::OS.to_string()),
            device_type: Some("desktop".to_string()),
            fingerprint: mgr.fingerprint(),
            version: PROTOCOL_VERSION.to_string(),
        },
        files,
    };
    // LocalSend v2 公告的 protocol 字段标明对端服务用 http 还是 https。
    // 尊重该字段；若首选方案在「传输层」失败（连接被拒 / TLS 不匹配），自动回退另一种方案，
    // 兼容「官方 LocalSend 开了加密(https)」与「部分设备声明 https 实则 http」两种情况。
    let primary_scheme = if peer.protocol == "https" { "https" } else { "http" };
    let schemes: [&str; 2] = [
        primary_scheme,
        if primary_scheme == "https" { "http" } else { "https" },
    ];

    // 单次 TCP 预检（与协议无关）：快速区分「网络不可达/防火墙」与「HTTP 层错误」。
    // 放在回退循环外只做一次，避免 http 失败回退 https 时再等 4s，最坏延迟从 8s 降到 4s。
    let probe_addr = format!("{}:{}", peer.ip, peer.port);
    match tokio::time::timeout(Duration::from_secs(4), tokio::net::TcpStream::connect(&probe_addr)).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            return Err(format!(
                "无法连接对方 {}:{}（TCP 连接失败：{}）。\n请确认：① 对方设备「文件传输」已开启；② 双方防火墙放行 {} 端口；③ 双方同网段。",
                peer.ip, peer.port, e, peer.port
            ));
        }
        Err(_) => {
            return Err(format!(
                "无法连接对方 {}:{}（4 秒内 TCP 无响应，疑似网络不可达或被防火墙拦截）。",
                peer.ip, peer.port
            ));
        }
    }

    let mut last_err = format!("发送失败：对端 {}:{} 无可用协议", peer.ip, peer.port);
    for &scheme in &schemes {
        match try_send(mgr, &peer, &req, &file_paths, scheme).await {
            Ok(sid) => return Ok(sid),
            Err((msg, true)) => {
                // 传输层错误：尝试另一种协议方案（http <-> https）
                last_err = msg;
                continue;
            }
            Err((msg, false)) => return Err(msg), // 非传输层（如被拒），不再回退
        }
    }
    Err(last_err)
}

/// 以指定 scheme（http/https）向对端发送整组文件。
/// 返回 Ok(session_id)；失败返回 (消息, 是否传输层错误) —— 传输层错误才值得回退协议。
async fn try_send(
    mgr: &TransferManager,
    peer: &Peer,
    req: &PrepareUploadRequestV2,
    file_paths: &[(String, PathBuf, String, u64, Vec<u8>)],
    scheme: &str,
) -> Result<String, (String, bool)> {
    let base = format!("{scheme}://{}:{}", peer.ip, peer.port);

    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(concat!("andeyunhui/", env!("CARGO_PKG_VERSION")));
    if scheme == "https" {
        // 局域网自签名证书：跳过证书/主机名校验，否则 TLS 握手直接失败
        builder = builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }
    let client = builder
        .build()
        .map_err(|e| (format!("构建请求客户端失败：{e}"), false))?;

    let prepare: PrepareUploadResponseV2 = client
        .post(format!("{base}/api/localsend/v2/prepare-upload"))
        .json(req)
        .send()
        .await
        .map_err(|e| (classify_send_error(&e, &peer.ip, peer.port, scheme), is_transport_err(&e)))?
        .json()
        .await
        .map_err(|e| (format!("解析对方响应失败（{scheme}）：{e}"), false))?;

    let session_id = prepare.session_id.clone();
    for (id, _path, file_name, size, bytes) in file_paths {
        let token = prepare
            .files
            .get(id)
            .cloned()
            .ok_or_else(|| ("缺少文件令牌".to_string(), false))?;
        // 复用 send_files 预读的字节，协议回退时不再重新读大文件
        let data = bytes.clone();
        client
            .post(format!(
                "{base}/api/localsend/v2/upload?sessionId={session_id}&fileId={id}&token={token}"
            ))
            .body(data)
            .send()
            .await
            .map_err(|e| (classify_send_error(&e, &peer.ip, peer.port, scheme), is_transport_err(&e)))?;
        mgr.emit(
            "transfer-progress",
            TransferProgress {
                direction: "send".to_string(),
                session_id: session_id.clone(),
                file_id: id.clone(),
                file_name: file_name.clone(),
                received: *size,
                total: *size,
                done: true,
                peer_alias: peer.alias.clone(),
            },
        );
    }
    Ok(session_id)
}

/// 传输层错误（连接被拒 / 超时 / 请求构造失败）才值得回退协议方案。
fn is_transport_err(e: &reqwest::Error) -> bool {
    e.is_connect() || e.is_timeout() || e.is_request()
}

// ===================== 工具 =====================

/// 把 reqwest 的发送错误分类成可读中文提示，并附上底层原因，便于区分「协议不匹配/连接被拒/超时」。
fn classify_send_error(e: &reqwest::Error, ip: &str, port: u16, scheme: &str) -> String {
    let kind = if e.is_connect() {
        "TCP 连接失败（对方服务未启动或被防火墙拦截）"
    } else if e.is_timeout() {
        "连接超时（对方无响应）"
    } else if e.is_request() {
        "请求构造/发送失败（多为协议不匹配：对方用 https 而本端发 http，或反之）"
    } else {
        "请求发送失败"
    };
    let mut s = format!("发送失败（{kind}）：{e}\n目标：{ip}:{port}（{scheme}）");
    if let Some(src) = e.source() {
        s.push_str(&format!("\n底层原因：{src}"));
    }
    s
}

fn local_ip() -> Ipv4Addr {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok();
    if let Some(s) = s {
        let _ = s.connect("8.8.8.8:80");
        if let Ok(addr) = s.local_addr() {
            if let SocketAddr::V4(v4) = addr {
                return *v4.ip();
            }
        }
    }
    Ipv4Addr::UNSPECIFIED
}

fn sanitize_filename(name: &str) -> String {
    let bad = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    name.chars()
        .map(|c| if bad.contains(&c) { '_' } else { c })
        .collect()
}

/// 接收会话/落盘文件夹名：用「接收时间」而非随机 UUID，方便用户在文件管理器里一眼看清。
/// 形如 2026-07-27_15-30-45_123_ab12（秒+毫秒+短随机后缀，避免同秒碰撞且 Windows 文件名合法）。
fn new_session_id() -> String {
    let t = chrono::Local::now();
    let stamp = t.format("%Y-%m-%d_%H-%M-%S").to_string();
    let ms = t.timestamp_subsec_millis();
    let suffix = &Uuid::new_v4().to_string()[..4];
    format!("{stamp}_{ms:03}_{suffix}")
}

fn guess_file_type(path: &PathBuf) -> String {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp") | Some("bmp") => {
            "image"
        }
        Some("mp4") | Some("mov") | Some("mkv") | Some("webm") | Some("avi") => "video",
        Some("pdf") => "pdf",
        Some("txt") | Some("md") | Some("rs") | Some("ts") | Some("tsx") | Some("js")
        | Some("json") => "text",
        _ => "other",
    }
    .to_string()
}

// ===================== Tauri 命令 =====================

#[tauri::command]
pub async fn transfer_start(_app: AppHandle) -> Result<(), String> {
    mgr().start().await;
    Ok(())
}

#[tauri::command]
pub fn transfer_stop() -> Result<(), String> {
    mgr().stop();
    Ok(())
}

#[tauri::command]
pub async fn transfer_announce() -> Result<(), String> {
    mgr().announce_now().await;
    Ok(())
}

#[tauri::command]
pub fn transfer_status() -> serde_json::Value {
    serde_json::json!({
        "running": mgr().is_running(),
        "port": mgr().port(),
        "alias": mgr().alias(),
        "fingerprint": mgr().fingerprint(),
    })
}

#[tauri::command]
pub fn transfer_set_alias(alias: String) -> Result<(), String> {
    mgr().set_alias(alias);
    Ok(())
}

#[tauri::command]
pub fn transfer_list_peers() -> Vec<Peer> {
    mgr().list_peers()
}

#[tauri::command]
pub fn transfer_get_save_dir() -> String {
    mgr().save_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn transfer_set_save_dir(dir: String) -> Result<(), String> {
    mgr().set_save_dir(dir)
}

#[tauri::command]
pub fn transfer_get_staged() -> Vec<String> {
    mgr().staged()
}

#[tauri::command]
pub fn transfer_set_staged(paths: Vec<String>) {
    mgr().set_staged(paths)
}

#[tauri::command]
pub fn transfer_get_auto_accept() -> bool {
    mgr().auto_accept()
}

#[tauri::command]
pub fn transfer_set_auto_accept(v: bool) {
    mgr().set_auto_accept(v)
}

#[tauri::command]
pub fn transfer_receive_accept(session_id: String) {
    mgr().accept_receive(session_id);
}

#[tauri::command]
pub fn transfer_receive_decline(session_id: String) {
    mgr().decline_receive(session_id);
}

#[tauri::command]
pub async fn transfer_send(fingerprint: String, paths: Vec<String>) -> Result<String, String> {
    send_files(mgr(), &fingerprint, paths).await
}
