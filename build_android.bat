chcp 65001 >nul 2>&1
@echo off
REM ============================================================
REM build_android.bat - Build Android APK (Tauri v2)
REM
REM Usage:
REM   build_android.bat        release + arm64-v8a only (default)
REM   build_android.bat debug  debug + arm64-v8a
REM   build_android.bat all    release + all ABIs (universal, larger)
REM
REM NDK policy:
REM   Verified: NDK 25.x works fine for this project (cargo check on
REM   aarch64-linux-android passes with NDK 25.2.9519653). This script
REM   uses the already-installed NDK if present (25.x preferred, 21.x as
REM   fallback). Only if NO NDK is installed does it auto-install NDK 21.4
REM   via sdkmanager, then continue.
REM
REM Output:
REM   src-tauri\gen\android\app\build\outputs\apk\release\*.apk
REM   src-tauri\gen\android\app\build\outputs\apk\debug\*.apk
REM ============================================================

cd /d "%~dp0"

REM ---- 0. Parse args ----
REM 用 pnpm tauri android build 驱动（必须）：RustPlugin 的 rustBuild task 内部调
REM tauri android android-studio-script，需连回 Tauri CLI 主进程的 WebSocket 拿配置，
REM 直接跑 gradlew 会 ConnectionRefused（实测）。Tauri CLI 固定编译 4 个 ABI，但配合
REM before-build.mjs 的前端复用（dist 不变 -> Rust 增量），第二次起 4 ABI 增量编译
REM 仅秒级，总耗时约等于 Gradle 打包（1-2 分钟）。
REM 注意：REM 注释里严禁出现尖括号，会被 cmd 当作重定向符导致闪退。
set BUILD_MODE=release
set ABI_MODE=arm64
set TAURI_ARGS=
if /i "%~1"=="debug" set BUILD_MODE=debug
if /i "%~1"=="debug" set ABI_MODE=arm64
if /i "%~1"=="debug" set TAURI_ARGS=--debug
if /i "%~1"=="all" set ABI_MODE=all
if /i "%~1"=="all" set BUILD_MODE=release
if /i "%~1"=="all" set TAURI_ARGS=

echo [ANDROID] ========================================
echo [ANDROID] Android APK build script
echo [ANDROID] mode=%BUILD_MODE%  abi=%ABI_MODE%
echo [ANDROID] Working dir: %CD%
echo [ANDROID] ========================================

REM ---- 0b. Re-entry guard（防止同时开两个打包窗口互相抢 cargo 文件锁）----
set LOCK_FILE=%CD%\build_android.lock
if not exist "%LOCK_FILE%" goto lock_ok
REM 锁存在：检查是否有 gradle/java 构建进程。
REM 无 java 进程（视为上次 Ctrl+C 残留的锁）：自动清除后继续；
REM 有 java 进程（可能确实有别的打包窗口在跑）：提示用户处理。
tasklist /FI "IMAGENAME eq java.exe" /FO CSV /NH 2>nul | find /i "java.exe" >nul
if errorlevel 1 goto lock_stale
echo [ANDROID] [X] 检测到 java/gradle 进程在运行，可能已有其他打包窗口。
type "%LOCK_FILE%"
echo [ANDROID]     若确认没有其他打包窗口，请删除 build_android.lock 后重试。
echo [ANDROID]     （Ctrl+C 中断导致残留锁时，删除该文件即可。）
pause
exit /b 1

:lock_stale
echo [ANDROID] 检测到残留锁文件（无构建进程在运行），已自动清除。
del "%LOCK_FILE%" >nul 2>&1

:lock_ok
echo 开始于 %date% %time% >> "%LOCK_FILE%"

REM ---- 1. Detect Android SDK ----
if not "%ANDROID_HOME%"=="" goto sdk_ok
if exist "%LOCALAPPDATA%\Android\Sdk" goto sdk_default
echo [ANDROID] [X] Android SDK not found. Set ANDROID_HOME or install to default path.
if exist "%LOCK_FILE%" del "%LOCK_FILE%" >nul 2>&1
pause
exit /b 1

:sdk_default
set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk

:sdk_ok
echo [ANDROID] ANDROID_HOME=%ANDROID_HOME%

REM ---- 1b. Detect NDK; use installed one (25.x preferred), auto-install 21.x only if none ----
if not "%NDK_HOME%"=="" goto ndk_ok
if exist "%ANDROID_HOME%\ndk\25.2.9519653" goto ndk_252
if exist "%ANDROID_HOME%\ndk\25.1.8937393" goto ndk_251
if exist "%ANDROID_HOME%\ndk\21.4.7075529" goto ndk_214
if exist "%ANDROID_HOME%\ndk\21.3.6528147" goto ndk_213
if exist "%ANDROID_HOME%\ndk\21.1.6352462" goto ndk_211

echo [ANDROID] [!] No usable NDK found under %ANDROID_HOME%\ndk
echo [ANDROID]     Current NDKs:
if exist "%ANDROID_HOME%\ndk" dir /b /ad "%ANDROID_HOME%\ndk"
echo [ANDROID]     Auto-installing NDK 21.4.7075529 via sdkmanager (download may take a while)...

set SDKMAN=%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat
if not exist "%SDKMAN%" goto no_sdkman

call "%SDKMAN%" "ndk;21.4.7075529"
if errorlevel 1 goto sdkman_failed

if exist "%ANDROID_HOME%\ndk\25.2.9519653" goto ndk_252
if exist "%ANDROID_HOME%\ndk\21.4.7075529" goto ndk_214
if exist "%ANDROID_HOME%\ndk\21.3.6528147" goto ndk_213
if exist "%ANDROID_HOME%\ndk\21.1.6352462" goto ndk_211
echo [ANDROID] [X] sdkmanager finished but no NDK appeared.
goto ndk_fail

:no_sdkman
echo [ANDROID] [X] sdkmanager not found at %SDKMAN%
goto ndk_fail

:sdkman_failed
echo [ANDROID] [X] sdkmanager failed to install NDK (check JAVA/network).
goto ndk_fail

:ndk_fail
echo [ANDROID] [X] No NDK available. Manual options:
echo [ANDROID]       1. Android Studio -^> SDK Manager -^> SDK Tools -^> install an NDK
echo [ANDROID]       2. Run:  %SDKMAN% "ndk;21.4.7075529"
echo [ANDROID]       3. Or set NDK_HOME manually to an installed NDK path.
if exist "%LOCK_FILE%" del "%LOCK_FILE%" >nul 2>&1
pause
exit /b 1

:ndk_252
set NDK_HOME=%ANDROID_HOME%\ndk\25.2.9519653
goto ndk_ok

:ndk_251
set NDK_HOME=%ANDROID_HOME%\ndk\25.1.8937393
goto ndk_ok

:ndk_214
set NDK_HOME=%ANDROID_HOME%\ndk\21.4.7075529
goto ndk_ok

:ndk_213
set NDK_HOME=%ANDROID_HOME%\ndk\21.3.6528147
goto ndk_ok

:ndk_211
set NDK_HOME=%ANDROID_HOME%\ndk\21.1.6352462

:ndk_ok
echo [ANDROID] NDK_HOME=%NDK_HOME%

set PATH=%NDK_HOME%\toolchains\llvm\prebuilt\windows-x86_64\bin;%PATH%

REM ---- 1c. Hard guard: lock to Android build ----
if exist "%CD%\src-tauri\gen\android" goto guard_ok
echo [ANDROID] [X] Android project not found: src-tauri\gen\android
echo [ANDROID]     Run 'pnpm tauri android init' first.
if exist "%LOCK_FILE%" del "%LOCK_FILE%" >nul 2>&1
pause
exit /b 1

:guard_ok
set TAURI_ENV_PLATFORM=android
set TARGET=aarch64-linux-android

REM ---- 2. Ensure clean ABI settings in gradle.properties ----
REM ABI 由 GRADLE_TASK（assembleArm64Release / assembleUniversalRelease）精确控制：
REM   assemble 任务只依赖对应 flavor 的 Rust 编译任务，天然只编 1 个 ABI。
REM 实测 targetList/archList 注入会破坏 gradle 任务图（报 merge task not found），
REM 故此处只清除历史残留注入，不再追加。
set GRADLE_PROPS=%CD%\src-tauri\gen\android\gradle.properties
set GRADLE_PROPS_BAK=%GRADLE_PROPS%.bak

if exist "%GRADLE_PROPS_BAK%" del "%GRADLE_PROPS_BAK%"
copy "%GRADLE_PROPS%" "%GRADLE_PROPS_BAK%" >nul
findstr /v /c:"abiList=" /v /c:"targetList=" /v /c:"archList=" "%GRADLE_PROPS_BAK%" > "%GRADLE_PROPS%"
echo [ANDROID] 已清除 gradle.properties 残留 ABI 属性（Tauri 驱动，4 ABI 增量编译）

REM ---- 3. Run Tauri Android build ----
echo [ANDROID] [1/2] beforeBuildCommand（前端复用检查）...
node scripts/before-build.mjs
if errorlevel 1 goto before_fail

echo [ANDROID] [2/2] Running pnpm tauri android build %TAURI_ARGS% ...
call pnpm tauri android build %TAURI_ARGS% > "%~dp0build_android.log" 2>&1
set BUILD_EXIT=%ERRORLEVEL%
echo BUILD_EXIT=%BUILD_EXIT% >> "%~dp0build_android.log"

REM ---- 4. Restore gradle.properties ----
move /y "%GRADLE_PROPS_BAK%" "%GRADLE_PROPS%" >nul

REM 正常路径直接跳到构建结果检查（跳过 before_fail 处理段）
goto build_check

:before_fail
if exist "%GRADLE_PROPS_BAK%" move /y "%GRADLE_PROPS_BAK%" "%GRADLE_PROPS%" >nul
echo.
echo [ANDROID] [X] beforeBuildCommand failed（前端构建/占位脚本出错）
if exist "%LOCK_FILE%" del "%LOCK_FILE%" >nul 2>&1
pause
exit /b 1

:build_check
if %BUILD_EXIT% EQU 0 goto report
echo.
echo [ANDROID] [X] Android build failed, exit %BUILD_EXIT%
echo [ANDROID] Full log: %CD%\build_android.log
echo.
if exist "%LOCK_FILE%" del "%LOCK_FILE%" >nul 2>&1
pause
exit /b 1

:report
if exist "%LOCK_FILE%" del "%LOCK_FILE%" >nul 2>&1
echo.
echo [ANDROID] ========================================
echo [ANDROID] [OK] Android APK build complete!
echo [ANDROID] Artifacts:
dir /s /b "%CD%\src-tauri\gen\android\app\build\outputs\apk\*.apk" 2>nul
echo [ANDROID] Log: %CD%\build_android.log
echo [ANDROID] ========================================
echo.
pause
