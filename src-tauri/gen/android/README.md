# Android 工程（Tauri v2 · `tauri android init` 生成 + T01 定制）

> ✅ 本目录为 `tauri android init` 生成的**完整 Android 工程**，已通过 T01 平台隔离骨架验收。
> 早期"手工起草占位骨架"阶段已结束——所有 Gradle/Maven/资源文件均由 Tauri CLI 生成，
> 仅 `app/build.gradle.kts` 与 `app/src/main/AndroidManifest.xml` 按 T01 决策叠加定制。

## T01 叠加的定制

| 文件 | 定制内容 | 原因 |
| --- | --- | --- |
| `app/build.gradle.kts` | `minSdk = 26`（用户拍板 Android v1 下限，API 8.0 Oreo） | 占位骨架沿用值，Tauri 默认 24 |
| `app/build.gradle.kts` | `targetSdk = 34`（用户拍板保守 runtime） | Tauri 默认 36，34→36 行为收紧对本应用无影响，留 T+ 升级 |
| `app/build.gradle.kts` | `compileSdk = 36`（不可降） | `:tauri-android` 库 compileSdk=36，app 依赖它须 ≥36 |
| `app/src/main/AndroidManifest.xml` | 5 项权限（ACCESS_WIFI_STATE / CHANGE_WIFI_MULTICAST_STATE / NEARBY_WIFI_DEVICES / FOREGROUND_SERVICE / FOREGROUND_SERVICE_DATA_SYNC） | 局域网组播发现 + 前台服务保活（§9.4.3 / §9.7.3） |
| `gradle.properties` | `kotlin.compiler.executionStrategy=in-process` | 规避 IDE sandbox 拦截 kotlin daemon 写 `%LOCALAPPDATA%\kotlin\daemon\` |
| `gradle.properties` | `android.aapt2.useDaemon=false`（占位，AGP 8.11 实测未生效，改用 `--no-daemon` 启动 gradle） | 规避 sandbox 进程隔离导致 AAPT2 daemon "Process unexpectedly exit" |

> 🔴 **ABI 拆分未用 `splits.abi`**：RustPlugin（`buildSrc`）在 apply 时创建 `universal/arm64/arm/x86/x86_64` productFlavors 并设 `ndk.abiFilters`，AGP 不允许 `splits.abi` 与 `ndk.abiFilters` 同存。体积优化（§9.7.3）改走 RustPlugin 原生开关：`gradle.properties` 设 `abiList=arm64-v8a` 或构建 `assembleArm64Debug`。

## 构建方式

### 前置工具链（本机已就绪）

- JDK 17（Temurin/OpenJDK，`JAVA_HOME` 指向它）—— Gradle 8.14.3 不支持 JDK 25（"Unsupported class file major version 69"）
- Android SDK（platforms 34/36、build-tools 35、ndk 25.2.9519653）
- Rust Android targets（`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`）

### 构建命令

```bash
# 关键：必须用 --no-daemon 启动 gradle，否则 AAPT2 daemon 在 IDE sandbox 下 "Process unexpectedly exit"
JAVA_HOME=<JDK17> ANDROID_HOME=<SDK> NDK_HOME=<NDK> \
  ./gradlew :app:assembleArm64Debug --no-daemon    # 单 arm64-v8a APK

# 或用 tauri CLI（内部调 gradlew，需确保 JAVA_HOME=JDK17 + 传 --no-daemon）
JAVA_HOME=<JDK17> npx tauri android build --debug
```

### IDE sandbox 限制清单（本机已知）

1. **Kotlin daemon**：写 `%LOCALAPPDATA%\kotlin\daemon\` 被拦 → `gradle.properties` 设 `kotlin.compiler.executionStrategy=in-process`
2. **AAPT2 daemon**：fork 的 aapt2.exe "Process unexpectedly exit" → gradle 加 `--no-daemon`（single-use daemon 进程模型不同）
3. **Gradle distribution 下载**：`services.gradle.org` 慢/超时 → `gradle-wrapper.properties` 的 `distributionUrl` 暂用 `file://` 指向本地缓存（**提交前需改回 https 可移植 URL**）

## 产物路径

- APK：`app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`
- Rust 共享库：`src-tauri/target/aarch64-linux-android/debug/libandeyunhui_lib.so` → 软链到 `app/src/main/jniLibs/arm64-v8a/`
