// v7：原生 Wayland 下把 安得云荟 的**指定浮窗**钉到固定位置并置顶（只认配置里列出的），
//     并额外暴露一条 D-Bus 通道 `org.andeyunhui.Pin` 供应用**拖动**浮窗。
//
// 为什么拖动必须绕到合成器这边：tao 0.35 的 `drag_window()` 调
// `begin_move_drag(1, x, y, 0)`（`tao/src/platform_impl/linux/event_loop.rs:343`）——
// 时间戳恒 0；Wayland 的 `xdg_toplevel.move(seat, serial)` 必须带**当前输入事件的 serial**，
// 于是 `startDragging()` 和 `data-tauri-drag-region` 在原生 Wayland 上**都不可能生效**。
// 合成器（也就是本扩展）才有权移动窗口，所以：前端用指针捕获算位移 → Rust 调 MoveTo →
// 这里 `move_frame`。被用户拖过的窗口进 `released` 集合，本次会话不再钉住（否则一拖就被拉回）。
//
// 为什么需要扩展：xdg-shell 没有「客户端指定位置」和「always-on-top」，普通应用做不到；
// 但扩展跑在 shell（合成器）进程里，可以直接操作 Meta.Window（实测 move_frame 生效）。
//
// 位置规则从**配置文件**读（改配置 1s 内生效，不用注销；改本文件则必须注销重登）：
//   ~/.config/andeyunhui-pin.json
//   {
//     "浮岛": {"mode": "top-center", "y": 6},
//     "桌宠": {"mode": "bottom-right", "margin": 24}
//   }
//   mode: top-center | bottom-right | bottom-left | top-left | skip | none(只置顶)
//   monitor: "primary"（默认，与应用假设一致：前端用 window.screen/availWidth 算 x）| "current"
//
// v6 改动（修复"所有窗口被强制置顶"）：
//   原实现只要标题以「安得云荟 · 」开头、或标题是 Tauri 默认的 "Tauri App"，就对它
//   make_above() —— 于是**主窗口「安得云荟 · 笔记」和笔记浮窗（标题 Tauri App）全被钉到最上层**。
//   现在改为：**只处理配置里有规则且 mode != skip 的窗口**，其余（主窗、笔记浮窗、未知浮窗）
//   一概不碰；并给 make_above 也加日志，便于下次取证。
//
// v5 改动：
//   1) monitor 选项，默认跟随**主屏**。应用是按主屏算坐标的（Capsule.tsx 用 window.screen），
//      之前扩展按「窗口当前所在屏」算 ⇒ 副屏会错位。
//   2) size-changed 改为**节流 120ms**：原先每次尺寸变化立刻 move_frame，浮岛展开动画期间
//      会连续移动，实测日志里 1 秒内多次 move（11:56 前后），容易看出抖动。
//
// 观察：journalctl --user -f | grep andy-pin
// 卸载：gnome-extensions disable andeyunhui-pin@rosary

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TAG = '[andy-pin]';
const CONFIG_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'andeyunhui-pin.json']);
const RESIZE_DEBOUNCE_MS = 120;

// 拖动通道：应用（Rust/zbus 客户端）→ 扩展（合成器）
const PIN_PATH = '/org/andeyunhui/Pin';
const PIN_XML = `
<node>
  <interface name="org.andeyunhui.Pin">
    <method name="BeginDrag">
      <arg type="s" direction="in" name="title"/>
      <arg type="b" direction="out" name="handled"/>
    </method>
    <method name="MoveTo">
      <arg type="s" direction="in" name="title"/>
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
    </method>
    <method name="EndDrag">
      <arg type="s" direction="in" name="title"/>
    </method>
    <method name="Near">
      <arg type="s" direction="in" name="title"/>
      <arg type="i" direction="in" name="w"/>
      <arg type="i" direction="in" name="h"/>
      <arg type="b" direction="out" name="near"/>
    </method>
    <method name="Rect">
      <arg type="s" direction="in" name="title"/>
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
      <arg type="i" direction="out" name="w"/>
      <arg type="i" direction="out" name="h"/>
    </method>
    <method name="Pointer">
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
    </method>
    <method name="Place">
      <arg type="s" direction="in" name="title"/>
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
    </method>
    <method name="Shot">
      <arg type="b" direction="in" name="includeCursor"/>
      <arg type="s" direction="in" name="path"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
  </interface>
</node>`;

const DEFAULT_CONFIG = {
    浮岛: {mode: 'top-center', y: 6, monitor: 'primary'},
    桌宠: {mode: 'bottom-right', margin: 24, monitor: 'primary'},
    笔记: {mode: 'skip'},
};

function listWindows() {
    let actors = [];
    try {
        actors = global.compositor?.get_window_actors?.() ?? [];
    } catch (_e) {
        actors = [];
    }
    if (!actors || actors.length === 0)
        actors = global.get_window_actors?.() ?? [];

    const out = [];
    for (const a of actors) {
        const w = a.meta_window ?? (a.get_meta_window ? a.get_meta_window() : null);
        if (w) out.push(w);
    }
    return out;
}

function readConfig() {
    try {
        const [ok, bytes] = GLib.file_get_contents(CONFIG_PATH);
        if (ok) {
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            if (parsed && typeof parsed === 'object')
                return parsed;
        }
    } catch (e) {
        console.log(`${TAG} config parse failed, using defaults: ${e}`);
    }
    return DEFAULT_CONFIG;
}

function writeDefaultConfigIfMissing() {
    try {
        if (GLib.file_test(CONFIG_PATH, GLib.FileTest.EXISTS))
            return;
        GLib.mkdir_with_parents(GLib.path_get_dirname(CONFIG_PATH), 0o755);
        GLib.file_set_contents(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
        console.log(`${TAG} wrote default config: ${CONFIG_PATH}`);
    } catch (e) {
        console.log(`${TAG} write config failed: ${e}`);
    }
}

export default class AndeyunhuiPinExtension extends Extension {
    enable() {
        this._last = new Map();      // 窗口 -> 上次稳定状态（抑制日志）
        this._sig = new Map();       // 窗口 -> size-changed handler id
        this._debounce = new Map();  // 窗口 -> 待触发的 source id
        this._released = new Set();  // 被用户拖动过的窗口标题（本次会话不再钉住）
        this._exportDbus();
        writeDefaultConfigIfMissing();
        this._log('enabled (v5, config-driven + primary-monitor + resize debounce)');
        this._scan('enable');
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._scan('tick');
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        for (const id of this._debounce.values())
            GLib.source_remove(id);
        this._debounce.clear();
        for (const [w, id] of this._sig) {
            try {
                w.disconnect(id);
            } catch (_e) {
                /* 已销毁 */
            }
        }
        this._stopDragTick();
        this._drag = null;
        this._sig.clear();
        this._last.clear();
        try {
            if (this._nameId) {
                Gio.bus_unown_name(this._nameId);
                this._nameId = 0;
            }
            this._dbus?.unexport();
        } catch (_e) { /* 已卸载 */ }
        this._dbus = null;
        this._log('disabled');
    }

    _log(msg) {
        console.log(`${TAG} ${msg}`);
    }

    _exportDbus() {
        try {
            this._dbus = Gio.DBusExportedObject.wrapJSObject(PIN_XML, this);
            this._dbus.export(Gio.DBus.session, PIN_PATH);
            // 只 export 是绑在 gnome-shell 的 unique name 上的，外部无法用固定名寻址 ⇒ 必须自己占名
            this._nameId = Gio.bus_own_name(
                Gio.BusType.SESSION,
                'org.andeyunhui.Pin',
                Gio.BusNameOwnerFlags.NONE,
                null,
                () => this._log('总线名 org.andeyunhui.Pin 已就绪'),
                () => this._log('总线名 org.andeyunhui.Pin 丢失')
            );
            this._log(`D-Bus 已导出: org.andeyunhui.Pin ${PIN_PATH}`);
        } catch (e) {
            this._log(`D-Bus 导出失败（拖动将不可用）: ${e}`);
        }
    }

    // ---- D-Bus 方法（被 Rust 侧调用）----
    BeginDrag(title) {
        this._released.add(title);
        const w = this._findByTitle(title);
        if (!w) {
            this._log(`BeginDrag "${title}" 未找到窗口`);
            return false;
        }
        this._stopDragTick();
        const [px, py] = global.get_pointer();
        this._drag = {
            title,
            win: w,
            px,
            py,
            rect: w.get_frame_rect(),
        };
        // 由扩展自己按 16ms 轮询指针位移并 move_frame。
        // 为什么不用 begin_grab_op：那个抓取在 mutter 侧结束不掉 —— 用户实测
        // "松开鼠标后窗口还在吸附光标"（2026-10-24）。自己轮询才能确定地停。
        this._dragTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => this._dragTick());
        this._log(`BeginDrag "${title}" -> 指针轮询开始`);
        return true; // 前端不需要自己算位移
    }

    _dragTick() {
        const d = this._drag;
        if (!d) return GLib.SOURCE_REMOVE;
        const [px, py, mask] = global.get_pointer();
        // Clutter 的 BUTTON1 = 1 << 8；松开就结束，杜绝"松手还在跟"
        if (!(mask & 0x100)) {
            this._finishDrag('指针已松开');
            return GLib.SOURCE_REMOVE;
        }
        const dx = px - d.px;
        const dy = py - d.py;
        d.win.move_frame(true, d.rect.x + dx, d.rect.y + dy);
        return GLib.SOURCE_CONTINUE;
    }

    _stopDragTick() {
        if (this._dragTickId) {
            GLib.source_remove(this._dragTickId);
            this._dragTickId = 0;
        }
    }

    _finishDrag(reason) {
        this._stopDragTick();
        if (this._drag) {
            this._log(`拖动结束（${reason}）: "${this._drag.title}"`);
            this._drag = null;
        }
    }

    MoveTo(title, x, y) {
        const w = this._findByTitle(title);
        if (!w) {
            return;
        }
        w.move_frame(true, x, y);
    }

    // 应用问"光标是否贴近这个窗"（±40 / 下 70，与 Windows 侧判定逐字一致）。
    // 为什么不让应用自己算：Wayland 下 `outerPosition()` 拿不到可靠值，
    // 应用按它算出来的矩形会整体偏移（用户实测：触发区跑到屏幕左半边）。
    // w/h <= 0 表示用窗口当前矩形；否则用调用方给的宽高 + 窗口左上角。
    // 为什么需要参数：收缩态时窗口实际尺寸可能仍是展开态（前端只是换了内容），
    // 按当前 rect 判定会把触发区放大到整个展开面板（2026-10-25 用户实测）。
    Near(title, w, h) {
        const win = this._findByTitle(title);
        if (!win)
            return false;
        const [px, py] = global.get_pointer();
        const r = win.get_frame_rect();
        const cw = (w && w > 0) ? w : r.width;
        const ch = (h && h > 0) ? h : r.height;
        // 容差收窄：原先 ±40/±70 是照 Windows 侧"宽容区"搬过来的，但浮岛贴在顶栏下沿，
        // 40px 的横向宽容会让左右两侧大片空白也触发（用户实测"收缩态识别范围还是有点大"）。
        const PAD_X = 16;
        const PAD_Y = 24;
        return px >= r.x - PAD_X && px <= r.x + cw + PAD_X
            && py >= r.y - PAD_Y && py <= r.y + ch + PAD_Y;
    }

    // 截屏：Wayland 下应用拿不到屏幕内容（X11 根窗口不是画面），xdg-desktop-portal 又会弹
    // GNOME 自己的窗口（实测 `Failed to associate portal window with parent window ''`），
    // 而 `org.gnome.Shell.Screenshot` 对外是 **Access denied**。
    // 扩展跑在 shell 进程内，由它代劳调用同一个接口，就不会被那条权限拦住。
    // 用异步 call：同步会阻塞合成器（整机卡一下），截图虽快也不能那么干。
    Shot(includeCursor, path, invocation) {
        try {
            Gio.DBus.session.call(
                'org.gnome.Shell.Screenshot',
                '/org/gnome/Shell/Screenshot',
                'org.gnome.Shell.Screenshot',
                'Screenshot',
                new GLib.Variant('(bbs)', [includeCursor, false, path]),
                new GLib.VariantType('(b)'),
                Gio.DBusCallFlags.NONE,
                8000,
                null,
                (conn, res) => {
                    let ok = false;
                    try {
                        ok = conn.call_finish(res).deepUnpack()[0];
                    } catch (e) {
                        this._log(`Shot 失败: ${e.message}`);
                    }
                    invocation.return_value(new GLib.Variant('(b)', [ok]));
                }
            );
        } catch (e) {
            this._log(`Shot 调用异常: ${e.message}`);
            invocation.return_value(new GLib.Variant('(b)', [false]));
        }
    }

    // 取窗口真实矩形（应用在 Wayland 下读 outerPosition() 拿到的是 0,0，不可用）
    Rect(title) {
        const win = this._findByTitle(title);
        if (!win)
            return [0, 0, 0, 0];
        const r = win.get_frame_rect();
        return [r.x, r.y, r.width, r.height];
    }

    // 供应用做"悬停展开"判定：Wayland 下客户端拿不到全局光标坐标，只能问合成器
    Pointer() {
        const [x, y] = global.get_pointer();
        return [x, y];
    }

    // 由应用在启动时调用：放到用户上次拖到的位置，并记为"已释放"（不要再钉回原位）
    Place(title, x, y) {
        this._released.add(title);
        const w = this._findByTitle(title);
        if (w) {
            w.move_frame(true, x, y);
            this._log(`Place "${title}" -> ${x},${y}`);
        }
    }

    EndDrag(title) {
        // 前端松手时也会调；保持 released（拖完就停在那儿）
        this._finishDrag(`EndDrag "${title}"`);
    }

    _findByTitle(title) {
        for (const w of listWindows()) {
            if ((w.get_title() ?? '') === title)
                return w;
        }
        return null;
    }

    _keyOf(title) {
        const i = title.indexOf('· ');
        // 没有「安得云荟 · 」前缀时（如歌词窗标题就是「歌词」），直接用整标题做键，
        // 这样也能给它配置"只置顶不搬位置"的规则。
        return i >= 0 ? title.slice(i + 2).trim() : title.trim();
    }

    _geom(w, rule) {
        const mon = rule?.monitor === 'current'
            ? w.get_monitor()
            : global.display.get_primary_monitor();
        return global.display.get_monitor_geometry(mon);
    }

    _target(title, r, w, cfg) {
        let rule = cfg[this._keyOf(title)];
        // 兼容旧构建（标题 "Tauri App"）：按尺寸猜
        if (!rule && title === 'Tauri App')
            rule = r.width > 500 ? {mode: 'top-center', y: 6} : {mode: 'bottom-right', margin: 24};

        if (!rule || rule.mode === 'skip' || rule.mode === 'none')
            return null;

        const g = this._geom(w, rule);
        const margin = rule.margin ?? 24;
        switch (rule.mode) {
        case 'top-center': {
            // belowPanel：贴到顶栏**下面**（否则 y=6 会被状态栏遮住一半 —— 2026-10-24 用户实测）
            const topOffset = (rule.belowPanel ? Main.panel.height : 0) + (rule.y ?? 6);
            return {x: g.x + Math.round((g.width - r.width) / 2), y: g.y + topOffset};
        }
        case 'bottom-right':
            return {x: g.x + g.width - r.width - margin, y: g.y + g.height - r.height - margin};
        case 'bottom-left':
            return {x: g.x + margin, y: g.y + g.height - r.height - margin};
        case 'top-left':
            return {x: g.x + margin, y: g.y + (rule.y ?? 6)};
        default:
            return null;
        }
    }

    _scan(reason) {
        const cfg = readConfig();
        for (const w of listWindows()) {
            const cls = (w.get_wm_class() ?? '').toLowerCase();
            if (!cls.includes('andeyunhui'))
                continue;

            const title = w.get_title() ?? '';
            // 只认配置里明确列出的身份（后缀匹配）。没有规则 = 完全不碰。
            const rule = cfg[this._keyOf(title)];
            if (!rule || rule.mode === 'skip')
                continue;
            if (this._released?.has(title))
                continue; // 用户手动拖过：本次会话不再干预

            if (!this._sig.has(w)) {
                // 尺寸变化只做「登记」，120ms 后统一应用一次：避免展开动画期间逐帧移动
                const id = w.connect('size-changed', () => this._schedule(w));
                this._sig.set(w, id);
            }

            if (!w.is_above()) {
                w.make_above();
                this._log(`"${title}" make_above()`);
            }

            if (rule.mode === 'none')
                continue; // 只置顶，不移动

            this._apply(w, cfg, reason);
        }
    }

    _schedule(w) {
        const prev = this._debounce.get(w);
        if (prev)
            GLib.source_remove(prev);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESIZE_DEBOUNCE_MS, () => {
            this._debounce.delete(w);
            this._apply(w, readConfig(), 'resize');
            return GLib.SOURCE_REMOVE;
        });
        this._debounce.set(w, id);
    }

    _apply(w, cfg, reason = 'tick') {
        if (!w) return;
        const title = w.get_title() ?? '';
        const r = w.get_frame_rect();
        const want = this._target(title, r, w, cfg);
        if (!want)
            return;

        if (Math.abs(r.x - want.x) > 1 || Math.abs(r.y - want.y) > 1) {
            w.move_frame(true, want.x, want.y);
            const after = w.get_frame_rect();
            this._log(`"${title}" ${r.width}x${r.height} move ${r.x},${r.y} -> ${want.x},${want.y}` +
                ` ; after ${after.x},${after.y} (${reason})`);
        } else {
            const key = `${r.x},${r.y},${r.width}x${r.height}`;
            if (this._last.get(w) !== key) {
                this._last.set(w, key);
                this._log(`"${title}" ${r.width}x${r.height} stable at ${r.x},${r.y} above=${w.is_above()}`);
            }
        }
    }
}
