# 手工起草占位骨架（详见 gen/android/README.md）。
# 默认不开启混淆（app/build.gradle.kts 中 isMinifyEnabled = false）。
# 如需 release 混淆，可在此追加规则。

# Android v1 · 传输系统：保护 JS 注入桥（@JavascriptInterface）不被混淆裁剪。
# MainActivity.TransferBridge 通过 webView.addJavascriptInterface 暴露给前端，
# proguard 若裁剪其方法，window.AndroidTransfer.pickFile 将调不到原生 → SAF 文件选择失效。
# 通用规则：保留所有 @JavascriptInterface 注解方法（含 wry/tauri 自身的 Ipc 桥）。
-keepclasseswithmembers class * {
  @android.webkit.JavascriptInterface <methods>;
}

# 显式 keep MainActivity 及其内部类 TransferBridge（AndroidTransfer 桥对象）。
-keep class com.rosary.andengyuanhua.MainActivity { *; }
-keep class com.rosary.andengyuanhua.MainActivity$TransferBridge { *; }
