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
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        appWebView = webView
        // 注入 SAF 文件选择桥：JS 侧 window.AndroidTransfer.pickFile(reqId)
        webView.addJavascriptInterface(TransferBridge(), "AndroidTransfer")
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
