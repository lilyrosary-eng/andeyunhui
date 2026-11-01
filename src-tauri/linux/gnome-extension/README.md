# GNOME Shell 扩展：`andeyunhui-pin@rosary`

**用途**：在原生 Wayland 会话里，让合成器替我们搬窗口。

## 为什么必须有它

Wayland 的 `xdg_toplevel.move` 要求带「当前输入事件的 serial」，而 tao 0.35 的
`drag_window()` 传的是 `0`（见 `src-tauri/src/pal/overlay_drag.rs` 头注释）。
合成器会直接忽略这种请求 ⇒ 应用**无权移动自己的窗口**。

于是浮岛 / 桌宠 / 歌词窗的这三件事只能交给合成器：

| 能力 | Rust 侧入口 | 扩展侧实现 |
| :- | :- | :- |
| 拖动 | `overlay_drag_begin/move/end` | `begin_grab_op(MOVING)` 或 `move_frame` |
| 定位 | `overlay_place` | `move_frame(x, y)` |
| 读取真实矩形 | `overlay_rect` | `get_frame_rect()` |
| 指针位置/贴近判定 | `overlay_pointer` / `overlay_near` | `global.get_pointer()` |

拿不到扩展时：`overlay_*` 全部返回失败，前端回退到 `startDragging()`
（X11 下有效，**原生 Wayland 下无效**）⇒ 表现为「窗口拖不动」。

## 安装

deb 包会自动装到：

```
/usr/share/gnome-shell/extensions/andeyunhui-pin@rosary/
```

**AppImage 不会**——它不写系统目录。AppImage 用户需要手动复制：

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/andeyunhui-pin@rosary
cp extension.js metadata.json ~/.local/share/gnome-shell/extensions/andeyunhui-pin@rosary/
```

## 启用

```bash
# 查看是否可见（刚装完可能看不到，见下方说明）
gnome-extensions list | grep andeyunhui

# 启用
gnome-extensions enable andeyunhui-pin@rosary
```

⚠ **GNOME 50 实测：新装扩展不会热加载**，扩展列表是会话级快照
（用最小扩展 `zz-test@local` 验证过）。装完必须**注销重新登录**（或重启）才会出现。

## 能力边界（如实降级，不要当成 bug）

- 只对 **GNOME** 有效。KDE / Hyprland / sway 上没有等价通道：
  浮窗拖不动、位置不记忆、悬停不展开 —— 这些是 Wayland 协议限制，不是本扩展的缺陷。
- 扩展只做「搬窗口」，不参与渲染，也不读取窗口内容。

## 维护注意

- `metadata.json` 的 `shell-version` 目前是 `["48", "49", "50"]`，升 GNOME 大版本时要复核 API
  （用的是 `Meta.Window.move_frame` / `global.get_pointer`，属于较稳定的接口）。
- `uuid` 带着早期开发者的用户名后缀（`@rosary`）。**发布前若要改名**，必须同时：
  1) 改 `uuid` 与安装目录；2) Rust 侧只依赖 D-Bus 名 `org.andeyunhui.Pin`（与 uuid 无关），
  所以代码不用改；3) 提醒用户删掉旧目录，否则两个扩展会抢同一个 D-Bus 名。
