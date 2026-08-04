package com.rosary.andengyuanhua

// Android v1 · T05：MainActivity 入口 + 返回键拦截。
// T02/T04：传输系统 Android 原生支撑 ——
//   1) MulticastLock：UDP 组播发现（LocalSend v2 · 224.0.0.167:53317）在 Android 必须
//      持有 MulticastLock 才能接收组播包，否则对端公告静默丢失（§4.4 R-B）。
//      此处开屏即获取、随 Activity 生命周期释放（传输 App 运行期需常驻发现能力）。
//   2) SAF 文件选择桥：JS 调 window.AndroidTransfer.pickFile(reqId) → 系统 ACTION_OPEN_DOCUMENT
//      → content:// URI 复制到 cacheDir 临时文件 → 回调 window.__transferFilePicked(reqId, [paths])。
//      这样 Rust transfer_send 只处理文件路径，content:// 读取由原生 ContentResolver 完成。
//
// TauriActivity / WryActivity 由 `tauri android init` 生成于同包（com.rosary.andengyuanhui）下，
// 无需 import；onWebViewCreate 签名为 (webView: WebView)（见 generated/WryActivity.kt:56）。
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import java.io.File

class MainActivity : TauriActivity() {

    /** 由 onWebViewCreate 保存的 WebView 引用，用于 evaluateJavascript 派发事件 / 回调。 */
    private var appWebView: WebView? = null

    /** WebView 就绪前收到的分享（冷启动 ACTION_SEND），等 onWebViewCreate 后补发。 */
    private var pendingShareJs: String? = null

    /** 组播锁：持有期间允许接收 UDP 组播包（LocalSend 设备发现前提）。 */
    private var multicastLock: WifiManager.MulticastLock? = null

    /** 当前在飞的 SAF 选择请求 id（JS 传入，回调时原样带回以匹配 Promise）。 */
    private var pendingPickId: String? = null

    /** SAF 多选启动器：必须在 Activity STARTED 之前注册（字段初始化期完成）。 */
    private val safPicker = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris -> handleSafResult(uris) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 让内容延伸到状态栏/挖孔区域
        WindowCompat.setDecorFitsSystemWindows(window, false)
        actionBar?.hide()

        // ===== MulticastLock（LocalSend 组播发现前提，§4.4 R-B）=====
        // 不持有则收不到对端的 UDP 公告，发现列表恒空。
        acquireMulticastLock()

        // ===== Android 返回键拦截（§6.3）=====
        // 不在原生侧决定行为 —— 前端 MobileApp 持有 BottomSheet/抽屉/导航栈等状态，
        // 由前端按优先级处理。此处仅向 WebView 派发 'android-back-pressed' CustomEvent。
        // 用 OnBackPressedCallback（而非旧 onBackPressed）以兼容 Android 13+ 预测式返回手势。
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                appWebView?.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('android-back-pressed'));",
                    null
                )
            }
        })

        // 首次启动即被系统分享调用（冷启动 ACTION_SEND）
        handleShareIntent(intent)
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        appWebView = webView
        // 注入 SAF 文件选择桥：JS 侧 window.AndroidTransfer.pickFile(reqId)
        webView.addJavascriptInterface(TransferBridge(), "AndroidTransfer")
        // 注入系统能力桥（Agent 系统级操作，需用户确认后才执行，见 AgentBridge）
        webView.addJavascriptInterface(AgentBridge(), "AndroidAgent")
        // 注入系统日历桥（Agent 日历/待办/提醒，静默写入系统日历）
        webView.addJavascriptInterface(CalendarBridge(), "AndroidCalendar")
        // 补发冷启动期间缓存的分享（WebView 就绪后）
        pendingShareJs?.let {
            pendingShareJs = null
            eval(it)
        }
    }

    /** 分享到本应用的入口：ACTION_SEND / ACTION_SEND_MULTIPLE。
     *  收到的文件（content:// URI）复制到 cacheDir 后，把路径数组派发给前端
     *  （window.__shareFilesPicked(paths)），由前端加入传输暂存区 / 中转站。
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShareIntent(intent)
    }

    /** onResume 兜底：singleTop/热启动时 onNewIntent 可能不触发（部分 Tauri 版本），
     *  这里每次回到前台检查 intent，确保分享不丢。用 setIntent 同步后 handleShareIntent
     *  内部消费即清除（防重复）。 */
    override fun onResume() {
        super.onResume()
        handleShareIntent(intent)
    }

    private fun handleShareIntent(intent: Intent?) {
        if (intent == null) return
        val action = intent.action ?: return
        // 只处理分享 intent；处理完清空 action 防止 onResume 重复触发
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
        // 已处理过的（onCreate 消费后 onResume 再次进来）：action 已被清除则跳过
        val uris = mutableListOf<Uri>()
        if (action == Intent.ACTION_SEND) {
            intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.add(it) }
            // 纯文本分享：无附件时发给前端作为文本暂存
            if (uris.isEmpty()) {
                intent.getStringExtra(Intent.EXTRA_TEXT)?.let { text ->
                    dispatchShare("__shareText('${jsStr(text)}')")
                }
                return
            }
        } else if (action == Intent.ACTION_SEND_MULTIPLE) {
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
        } else {
            return
        }
        if (uris.isEmpty()) return
        val paths = mutableListOf<String>()
        for (uri in uris) {
            copyUriToCache(uri)?.let { paths.add(it) }
        }
        if (paths.isNotEmpty()) {
            val jsonArr = paths.joinToString(",", "[", "]") { jsStr(it) }
            dispatchShare("__shareFilesPicked($jsonArr)")
        }
        // 消费本次分享 intent（防 onResume 重复处理）
        intent.action = Intent.ACTION_MAIN
        intent.removeExtra(Intent.EXTRA_STREAM)
        intent.removeExtra(Intent.EXTRA_TEXT)
    }

    /** 派发分享 JS；WebView 未就绪时缓存待补发。 */
    private fun dispatchShare(js: String) {
        if (appWebView != null) {
            eval(js)
        } else {
            pendingShareJs = js
        }
    }

    override fun onDestroy() {
        releaseMulticastLock()
        super.onDestroy()
    }

    // ===================== MulticastLock =====================

    private fun acquireMulticastLock() {
        try {
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val lock = wifi.createMulticastLock("andeyunhui_transfer").apply {
                setReferenceCounted(false)
            }
            lock.acquire()
            multicastLock = lock
        } catch (_: Exception) {
            // 获取失败不阻断启动；发现能力降级（仅能被动应答，不能主动收公告）
        }
    }

    private fun releaseMulticastLock() {
        try {
            multicastLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {
        }
        multicastLock = null
    }

    // ===================== Agent 系统能力桥（安全敏感） =====================

    /**
     * 暴露给 WebView 的系统能力桥（Agent 阶段 6）。
     * 安全约束（硬性）：
     *   1) 所有方法只接受「时间戳 + 标题」这类无副作用参数，禁止接受任意 shell 命令 / URL / 代码。
     *   2) 系统闹铃走显式 PendingIntent 打开本应用（而非任意 activity），杜绝隐式意图劫持。
     *   3) 时间戳在原生侧 clamp 到未来 1 分钟内，防误设过去时间。
     *   4) 任何异常吞掉并回调 null（JS 侧显示失败），不抛给 WebView。
     */
    inner class AgentBridge {
        /** 静默创建一次性闹铃（不打扰、不跳转任何界面）。
         *  whenMillis 传字符串毫秒时间戳（避免 JS number→Long 精度坑）。
         *  title 作为到点通知的备注内容（AI 写的闹铃备注）。
         *  到点后发通知（渠道 andy_alarm），标题 = 闹铃时间，内容 = 备注。
         */
        @JavascriptInterface
        fun setAlarm(whenMillis: String, title: String): Boolean {
            return try {
                val safeTitle = title.take(120)
                val ts = whenMillis.toLongOrNull() ?: return false
                val triggerAt = ts.coerceAtLeast(System.currentTimeMillis() + 30_000)
                val alarmManager = getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager

                // 到点广播：携带备注，由 AlarmReceiver 发系统通知
                val intent = Intent(this@MainActivity, AlarmReceiver::class.java).apply {
                    action = "ANDY_AGENT_ALARM"
                    putExtra("title", safeTitle)
                    putExtra("triggerAt", triggerAt)
                }
                val pi = android.app.PendingIntent.getBroadcast(
                    this@MainActivity, triggerAt.toInt(), intent,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
                )
                if (alarmManager.canScheduleExactAlarms()) {
                    alarmManager.setExact(android.app.AlarmManager.RTC_WAKEUP, triggerAt, pi)
                } else {
                    alarmManager.set(android.app.AlarmManager.RTC_WAKEUP, triggerAt, pi)
                }
                true
            } catch (_: Exception) {
                false
            }
        }
    }

    // ===================== 系统日历桥（Agent 日历/待办/提醒） =====================

    /**
     * 静默写入系统日历（CalendarContract）：
     *   createCalendarEvent(title, timeMs, note)  -> 写入日历事件
     *   createCalendarTodo(title, timeMs, note)   -> 写入日历任务（待办）
     *   createCalendarReminder(title, timeMs)     -> 写入日历事件 + 提醒
     * 需要 WRITE_CALENDAR 运行时权限；未授权时返回 false（前端提示去设置开启）。
     * 不弹任何确认界面——「静默设置好不打扰」。
     */
    inner class CalendarBridge {
        private val REQ_CAL = 4001

        private fun ensureCalendarPermission(): Boolean {
            if (android.os.Build.VERSION.SDK_INT < 23) return true
            if (checkSelfPermission(android.Manifest.permission.WRITE_CALENDAR) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                return true
            }
            // 请求权限（结果异步；首次可能失败，需用户允许后重试）
            requestPermissions(arrayOf(android.Manifest.permission.WRITE_CALENDAR), REQ_CAL)
            return false
        }

        @JavascriptInterface
        fun createCalendarEvent(title: String, timeMs: String, note: String): Boolean {
            return try {
                if (!ensureCalendarPermission()) return false
                val ts = timeMs.toLongOrNull() ?: return false
                val safeTitle = title.take(100)
                val calId = getDefaultCalendarId() ?: return false
                val values = android.content.ContentValues().apply {
                    put(android.provider.CalendarContract.Events.CALENDAR_ID, calId)
                    put(android.provider.CalendarContract.Events.TITLE, safeTitle)
                    put(android.provider.CalendarContract.Events.DTSTART, ts)
                    put(android.provider.CalendarContract.Events.DTEND, ts + 60 * 60 * 1000) // 默认 1 小时
                    put(android.provider.CalendarContract.Events.EVENT_TIMEZONE, java.util.TimeZone.getDefault().id)
                    if (note.isNotBlank()) put(android.provider.CalendarContract.Events.DESCRIPTION, note.take(500))
                }
                contentResolver.insert(android.provider.CalendarContract.Events.CONTENT_URI, values) != null
            } catch (_: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun createCalendarTodo(title: String, timeMs: String, note: String): Boolean {
            return try {
                if (!ensureCalendarPermission()) return false
                val ts = timeMs.toLongOrNull() ?: return false
                val safeTitle = title.take(100)
                val calId = getDefaultCalendarId() ?: return false
                val values = android.content.ContentValues().apply {
                    put(android.provider.CalendarContract.Reminders._ID, 0)
                    put(android.provider.CalendarContract.Events.CALENDAR_ID, calId)
                    put(android.provider.CalendarContract.Events.TITLE, safeTitle)
                    put(android.provider.CalendarContract.Events.DTSTART, ts)
                    put(android.provider.CalendarContract.Events.DTEND, ts + 60 * 60 * 1000)
                    put(android.provider.CalendarContract.Events.EVENT_TIMEZONE, java.util.TimeZone.getDefault().id)
                    put(android.provider.CalendarContract.Events.HAS_ALARM, 1)
                    if (note.isNotBlank()) put(android.provider.CalendarContract.Events.DESCRIPTION, note.take(500))
                }
                // 任务类型（待办）走 CalendarContract.Events + 任务类别
                values.put(android.provider.CalendarContract.Events.ALL_DAY, 0)
                contentResolver.insert(android.provider.CalendarContract.Events.CONTENT_URI, values) != null
            } catch (_: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun createCalendarReminder(title: String, timeMs: String, note: String): Boolean {
            return try {
                if (!ensureCalendarPermission()) return false
                val ts = timeMs.toLongOrNull() ?: return false
                val safeTitle = title.take(100)
                val calId = getDefaultCalendarId() ?: return false
                val values = android.content.ContentValues().apply {
                    put(android.provider.CalendarContract.Events.CALENDAR_ID, calId)
                    put(android.provider.CalendarContract.Events.TITLE, safeTitle)
                    put(android.provider.CalendarContract.Events.DTSTART, ts)
                    put(android.provider.CalendarContract.Events.DTEND, ts + 60 * 60 * 1000)
                    put(android.provider.CalendarContract.Events.EVENT_TIMEZONE, java.util.TimeZone.getDefault().id)
                    put(android.provider.CalendarContract.Events.HAS_ALARM, 1)
                    if (note.isNotBlank()) put(android.provider.CalendarContract.Events.DESCRIPTION, note.take(500))
                }
                val eventUri = contentResolver.insert(android.provider.CalendarContract.Events.CONTENT_URI, values)
                    ?: return false
                // 添加提醒（默认提前 5 分钟）
                val reminderValues = android.content.ContentValues().apply {
                    put(android.provider.CalendarContract.Reminders.EVENT_ID, eventUri.lastPathSegment?.toLongOrNull() ?: return false)
                    put(android.provider.CalendarContract.Reminders.MINUTES, 5)
                    put(android.provider.CalendarContract.Reminders.METHOD, android.provider.CalendarContract.Reminders.METHOD_ALERT)
                }
                contentResolver.insert(android.provider.CalendarContract.Reminders.CONTENT_URI, reminderValues) != null
            } catch (_: Exception) {
                false
            }
        }

        /** 找默认可见日历（优先类型本地、不被同步隐藏） */
        private fun getDefaultCalendarId(): Long? {
            val projection = arrayOf(android.provider.CalendarContract.Calendars._ID)
            val cursor = contentResolver.query(
                android.provider.CalendarContract.Calendars.CONTENT_URI,
                projection,
                "${android.provider.CalendarContract.Calendars.VISIBLE}=1",
                null,
                null
            ) ?: return null
            return try {
                if (cursor.moveToFirst()) cursor.getLong(0) else null
            } finally {
                cursor.close()
            }
        }
    }

    // ===================== SAF 文件选择桥 =====================

    /**
     * 暴露给 WebView 的传输桥对象。JS 侧通过 window.AndroidTransfer.pickFile(reqId) 触发系统文件选择器；
     * 选择结果（content:// URI）被复制到 cacheDir 临时文件后，经 window.__transferFilePicked 回调 JS。
     */
    inner class TransferBridge {
        @JavascriptInterface
        fun pickFile(requestId: String) {
            pendingPickId = requestId
            try {
                safPicker.launch(arrayOf("*/*"))
            } catch (e: Exception) {
                // 启动选择器失败 → 回调 null 让 JS 的 Promise reject
                pendingPickId = null
                eval("__transferFilePicked(${jsStr(requestId)}, null)")
            }
        }

        /** 供 JS 探测桥是否存在（移动端才注入，桌面端无此对象）。 */
        @JavascriptInterface
        fun isAvailable(): Boolean = true
    }

    private fun handleSafResult(uris: List<Uri>) {
        val rid = pendingPickId
        pendingPickId = null
        if (rid == null) return
        if (uris.isEmpty()) {
            eval("__transferFilePicked(${jsStr(rid)}, null)")
            return
        }
        // 逐个把 content:// 复制到 cacheDir 临时文件，返回路径数组给 JS
        val paths = mutableListOf<String>()
        for (uri in uris) {
            val path = copyUriToCache(uri)
            if (path != null) paths.add(path)
        }
        val jsonArr = paths.joinToString(",", "[", "]") { jsStr(it) }
        eval("__transferFilePicked(${jsStr(rid)}, $jsonArr)")
    }

    private fun copyUriToCache(uri: Uri): String? {
        return try {
            val displayName = queryDisplayName(uri) ?: "file"
            // 文件名消毒：只保留字母数字点下划线连字符，避免路径注入
            val safeName = displayName.replace(Regex("[^A-Za-z0-9._-]"), "_")
            val temp = File(cacheDir, "${System.currentTimeMillis()}_$safeName")
            contentResolver.openInputStream(uri)?.use { input ->
                temp.outputStream().use { input.copyTo(it) }
            } ?: return null
            temp.absolutePath
        } catch (_: Exception) {
            null
        }
    }

    private fun queryDisplayName(uri: Uri): String? {
        return try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0 && c.moveToFirst()) c.getString(idx) else null
            }
        } catch (_: Exception) {
            null
        }
    }

    /** 在 WebView 上下文执行 JS（自动加 window. 前缀）。 */
    private fun eval(js: String) {
        appWebView?.evaluateJavascript("window.$js;", null)
    }

    /** 把字符串转为 JS 字符串字面量（含转义），用于拼接回调脚本。 */
    private fun jsStr(s: String): String {
        val sb = StringBuilder("\"")
        for (ch in s) {
            when (ch) {
                '\\' -> sb.append("\\\\")
                '"' -> sb.append("\\\"")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch.code < 0x20) sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        sb.append('"')
        return sb.toString()
    }
}
