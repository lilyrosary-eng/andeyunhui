# 移植计划：MusicStorm → 铃兰音乐模块

用户确认 MusicStorm 为 MIT 许可，可大胆借鉴代码。目标：把 MusicStorm 的成熟实现逐步移植到 andeyunhui 的铃兰（music）模块。范围：**全量照搬（本地增强 + 完整网易云在线集成）**；**原生音频引擎（rodio/cpal/symphonia）本期不做**，保持 HTML5 audio，作为后续独立阶段。

原则：MIT 可抄，但按我们项目惯例做低风险适配（依赖已具备：rusqlite/lofty/reqwest/sha2/base64/image/uuid）；所有 Rust 改动需完全重启 `pnpm tauri dev` 生效；新 `#[tauri::command]` 必须登记 `generate_handler!`。

## Phase 0 — 基线（已完成）
- 封面提取改为「路径哈希_内嵌图内容哈希」，替换封面后自动重新生成（对照 MusicStorm 内容 MD5 思路）。✓ 已落地
- 自建歌单挂载期独立恢复 + 扫描期不再覆盖（localStorage 方案下已修恢复 bug）。✓ 已落地

## Phase 1 — 数据层持久化（本地，根治丢歌单）
目标：把歌单/收藏/上次播放状态从 localStorage 迁到 SQLite，与扫描解耦、落库即持久。
- 1.1 新增 `src-tauri/src/services/music_db.rs`：SQLite schema（带版本迁移：playlist / playlist_track / favorites / play_session / listen_daily / app_setting 等，参照 MusicStorm db.rs），`MusicDbState(Mutex<Connection>)`，`app_data_dir()/music/music.db`。在 main.rs setup 初始化并注册 State。
- 1.2 歌单 CRUD 命令：`music_create_playlist` / `music_rename_playlist` / `music_delete_playlist` / `music_add_track_to_playlist` / `music_remove_track_from_playlist` / `music_reorder_playlist_track` / `music_list_playlists` / `music_list_playlist_tracks`。
- 1.3 收藏/喜欢命令：`music_set_favorite` / `music_list_favorites`。
- 1.4 上次播放持久化：`music_save_player_state`（当前歌单 id / track / position / volume / playmode）→ 启动时恢复（替代当前 localStorage 恢复逻辑）。
- 1.5 前端迁移：铃兰 `index.tsx` 歌单读写从 localStorage 改为调用上述命令；过渡期可双写，最终切到 SQLite。收藏、上次播放同理。
- 风险：中（多文件、前端状态层改造）。验收：完全重启后，自建歌单/收藏/上次播放在关闭重开后稳定保留，且不依赖音乐文件夹是否配置。

## Phase 2 — 封面缓存双层结构 + 元数据重扫/编辑
- 2.1 封面缓存改为 blob 去重 + 引用计数 + 定期清理（借鉴 MusicStorm cover_cache.rs：album_cover_blob 按内容 MD5 去重、album_cover_file 文件缓存、clean_cover_cache 按 keep_hashes 回收）。
- 2.2 手动设封面命令 `music_set_cover`（写回 SQLite + 重生成缓存）；重扫元数据命令 `music_rescan_metadata`（按文件 mtime/content_hash 判是否重抽）。
- 2.3 元数据编辑写回标签：`music_edit_track`（标题/歌手/专辑/曲目号用 lofty 写回文件）。
- 风险：低-中。验收：换封面立即刷新；重扫元数据可刷新；编辑专辑信息落盘。

## Phase 3 — 网易云集成基建
- 3.1 Rust 代理命令 `netease_http_post`：域名 allowlist（music.163.com / interface*.music.163.com）+ real_ip 头 + 8MB 响应上限（照搬 netease_proxy.rs，reqwest 改异步或加 blocking feature）。
- 3.2 前端加密模块 `src/lib/netease/crypto.ts`：aes-128 weapi/eapi + md5（照搬 MusicStorm），请求封装 `neteaseRequest`。
- 3.3 登录态持久化：cookie 存 SQLite `app_setting(netease_cookie)` + 账户信息；`netease_login`/`netease_logout` 命令。
- 风险：中（加密算法需逐字节对齐网易云，否则登录失败）。验收：能拿到加密请求并打通一次登录。

## Phase 4 — 网易云功能
- 4.1 登录 UI：手机号 + 二维码（phone/qr login，照搬前端逻辑）。
- 4.2 搜索：歌曲/专辑/歌手/歌单/MV。
- 4.3 浏览：推荐 / 个人歌单 / 收藏 / 电台。
- 4.4 在线播放 + 歌词（在线音源走现有 HTML5 audio，URL 经代理/直链获取）。
- 4.5 本地补全：从网易云匹配补全本地缺失封面/歌词（复用 2.1 封面缓存）。
- 风险：高（依赖网易云私有接口稳定性）。验收：登录后可搜索、播放在线歌曲、补全本地缺失封面。

## Phase 5 — 播放统计 + 启动恢复会话
- 5.1 听歌统计页（歌曲/歌手/收听趋势，listen_daily / play_session 聚合）。
- 5.2 启动恢复上次会话（接 1.4）。
- 风险：低。

## Phase 6（后续独立，本期不做）
- 原生音频引擎替换 HTML5 audio（rodio/cpal/symphonia）、淡入淡出、ncm 解密、跨曲交叉淡入、macOS CoreAudio。用户已明确延后。

## 执行进度
- ✅ Phase 1.1（2026-08-11）：`src-tauri/src/services/music_db.rs` 创建，SQLite schema（playlist/playlist_track/favorite/player_state/play_session/listen_daily/listen_day_track）+ 歌单 CRUD/收藏/播放状态命令；经 `commands.rs` 薄封装注册并 `cargo check` 通过。前端尚未调用，旧 localStorage 路径保留，无回退。
- ⏳ Phase 1.2~1.5：前端铃兰 `index.tsx` 歌单状态层（79+ 引用）从 localStorage 迁到新命令；需把内联 `Playlist.tracks` 模型映射到 playlist_track 行。下一切入点。
- ⏳ Phase 2~5：待 Phase 1 前端闭环后推进。

## 执行顺序与节奏
Phase 1 → 2 → 3 → 4 → 5，每 Phase 内自底向上（Rust 数据/命令先就位，再改前端）。每个 Phase 完成后完全重启验证再进下一 Phase。本次先推进 Phase 1（1.1~1.5）。
