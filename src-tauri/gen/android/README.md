# Android 脚手架说明（手工起草占位骨架）

> ⚠️ **本目录为手工起草的占位骨架（T1 交付物），并非 `cargo tauri android init` 生成的完整工程。**
> 本机当前**缺少 JDK / Android SDK / NDK**，无法运行 `tauri android init` 或 `tauri android build`，
> 因此这里只建立与 Tauri v2 生成的目录结构对齐的最小骨架，并把用户拍板的 **minSdk = 26** 写死在
> `app/build.gradle.kts` 中，便于后续安装工具链后一键生成完整工程。

## 现状（Spike 结论：NO-GO，运行时验证被环境阻断）

- `cargo tauri android init` 已尝试：在解析完 `Cargo.toml` 后于 **JDK 检测**阶段失败
  （`Java not found in PATH ... Please install Java before proceeding`）。
- 本机确认缺失项：JDK、Android SDK（cmdline-tools）、Android NDK、`ANDROID_HOME`、
  cargo 交叉目标 `aarch64-linux-android`、可用的模拟器或真机。

## 本骨架包含（供 T2+ 参考结构，不可直接构建）

| 文件 | 说明 |
| --- | --- |
| `settings.gradle.kts` | Gradle 工程包含 `:app`，与 Tauri v2 生成结构一致 |
| `build.gradle.kts` | 根工程，引入 `app.tauri.tauri_plugin` |
| `gradle.properties` | AndroidX / JVM 参数 |
| `app/build.gradle.kts` | **minSdk = 26 / compileSdk = 34 / targetSdk = 34**（用户拍板值） |
| `app/src/main/AndroidManifest.xml` | 权限与 `MainActivity` 入口 |
| `app/src/main/java/com/rosary/andengyuanhua/MainActivity.kt` | 继承 `TauriActivity` 的最小入口 |
| `app/src/main/res/...` | 占位字符串 / 主题 / FileProvider 路径 |

## 安装工具链后如何生成完整工程

```bash
# 1) 安装 JDK 17（如 Eclipse Temurin 17）并设 JAVA_HOME
# 2) 安装 Android SDK cmdline-tools + NDK + 平台（API 26/34）
#    sdkmanager "platform-tools" "platforms;android-34" "ndk;25.2.9519653" "build-tools;34.0.0"
# 3) 设 ANDROID_HOME / ANDROID_SDK_ROOT
# 4) 安装 cargo 交叉目标
rustup target add aarch64-linux-android
# 5) 生成完整 Android 工程（会覆盖本占位骨架中由工具生成的文件）
cargo tauri android init
# 6) 构建 / 运行
cargo tauri android build        # 产出 APK/AAB
cargo tauri android dev          # 连真机/模拟器运行
```

> 注意：完整工程还需要 `gradle/wrapper/gradle-wrapper.jar`（二进制，由 `tauri android init` 提供）
> 以及 `plugins/` 下的 Tauri 插件子工程（`app.tauri.core` 等），这些**不包含在本手工骨架内**，
> 需由第 5 步的 `tauri android init` 生成。
