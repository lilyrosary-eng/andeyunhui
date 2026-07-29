package com.rosary.andengyuanhua

// 手工起草占位骨架（详见 gen/android/README.md）。
// 完整工程由 `cargo tauri android init` 生成；此处仅给出与 Tauri v2 对齐的最小入口。
import android.os.Bundle
import android.view.View
import androidx.core.view.WindowCompat
import app.tauri.TauriActivity

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 让内容延伸到状态栏/挖孔区域
        WindowCompat.setDecorFitsSystemWindows(window, false)
        actionBar?.hide()
    }

    override fun onWebViewCreate(root: View) {
        super.onWebViewCreate(root)
    }
}
