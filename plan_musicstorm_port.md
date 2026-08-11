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
- ✅ 2.1（2026-08-11）：封面覆盖持久化 + 孤儿清理。新增 `track_cover_override` 表（file_path→cover_path，手动设封面的持久真源）；`music_set_cover_override` 写覆盖并同步 playlist_track/favorite 封面；前端 `coverOverrides` Map + `applyCoverOverrides` 在挂载/扫描后叠加到内存 track；`music_clean_cover_cache(keep)` 删除 music_covers 中未被引用的孤儿文件（封面文件名已是「路径哈希_内容哈希」天然去重，故沿用文件存储而非 SQLite blob，避免重构封面数据流——这是相对原计划的简化取舍，符合「最简单最高效」）。
- ✅ 2.2（2026-08-11）：手动设封面 `music_set_cover`（base64 解码→写 music_covers/<pathhash>_manual_<md5>→写 override 表，返回路径）；重扫元数据 `music_rescan_metadata`（重抽内嵌封面+标签，更新 playlist_track/favorite，覆盖保留 override）。前端 TrackList 右键菜单加「手动设封面」(选图→base64) 与「重扫元数据」。
- ✅ 2.3（2026-08-11）：元数据写回标签 `music_edit_track`（lofty 写回 title/artist/album/track_number 并 save_to_path，同步 playlist_track/favorite）。前端 TrackList 菜单「编辑信息」用 prompt 逐字段收集并写回。7 语言 i18n 补 setCover/rescan/editInfo 等键。
- 风险：低-中。验收：完全重启后，手动设封面/重扫/编辑信息立即生效并落库，重启仍保留。

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
- ✅ Phase 1.1（2026-08-11）：`src-tauri/src/services/music_db.rs` 创建，SQLite schema + 歌单 CRUD/收藏/播放状态命令；经 `commands.rs` 薄封装注册，cargo check 通过。
- ✅ Phase 1.2（2026-08-11）：前端铃兰自建歌单生命周期对接 SQLite（创建/删除/重命名/增删曲目/移动/复制），新增 `music_replace_playlist_tracks` 命令；挂载期从 SQLite 加载歌单；localStorage 保留为兜底镜像。cargo check 通过，铃兰插件独立构建+部署成功。
- ✅ Phase 1.3（2026-08-11）：前端新增收藏功能。TrackList 每行、PlayerBar 加红心按钮；`favorites` 集合内存态 + localStorage 兜底镜像 + SQLite `music_set_favorite`/`music_list_favorites` 真源；自动生成「我的收藏」虚拟歌单（`__favorite__`，由 favorites 表驱动，不独立落库）；挂载期从 SQLite 恢复收藏。7 语言 i18n 补 `music.favoritePlaylist`/`music.favoriteToggle`。
- ✅ Phase 1.4（2026-08-11）：播放状态持久化接入。`music_save_player_state`/`music_get_player_state` 在切歌、音量、模式变化时落 SQLite；挂载期恢复 volume + play_mode（SQLite 优先于 localStorage）。注：精确播放进度（position）续播留待引入 timeUpdate 周期保存，本次仅存 track_id/playlist_id/volume/play_mode。
- ✅ Phase 1.5（2026-08-11）：听歌统计落库。新增 `music_record_play_session`/`music_get_listen_stats` 命令（listen_daily 每日聚合 + listen_day_track 去重曲目计数）；切歌时 fire-and-forget 记录（PlayMode 为 list 的「上一首/下一首」切歌均触发 trackChange，统计自然按实际播放计数）。
- ✅ 全 Phase 1（2026-08-11）：数据层持久化闭环。cargo check 通过；tsc --noEmit 无错误。需完全重启 `pnpm tauri dev` 验证。
- ⏳ Phase 2~5：待 Phase 1 重启验证后推进。

## 执行顺序与节奏
Phase 1 → 2 → 3 → 4 → 5，每 Phase 内自底向上（Rust 数据/命令先就位，再改前端）。每个 Phase 完成后完全重启验证再进下一 Phase。本次先推进 Phase 1（1.1~1.5）。
