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

REM ---- 1. Detect Android SDK ----
if not "%ANDROID_HOME%"=="" goto sdk_ok
if exist "%LOCALAPPDATA%\Android\Sdk" goto sdk_default
echo [ANDROID] [X] Android SDK not found. Set ANDROID_HOME or install to default path.
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
pause
exit /b 1

:guard_ok
set TAURI_ENV_PLATFORM=android
set TARGET=aarch64-linux-android

REM ---- 2. Configure ABI filter via gradle.properties ----
set GRADLE_PROPS=%CD%\src-tauri\gen\android\gradle.properties
set GRADLE_PROPS_BAK=%GRADLE_PROPS%.bak

if exist "%GRADLE_PROPS_BAK%" del "%GRADLE_PROPS_BAK%"
copy "%GRADLE_PROPS%" "%GRADLE_PROPS_BAK%" >nul

if /i "%ABI_MODE%"=="arm64" goto abi_arm64
goto abi_all

:abi_arm64
REM targetList/archList 控制 RustPlugin 实际编译的 target（buildSrc/RustPlugin.kt）：
REM   abiList 只影响 APK 打包过滤；targetList 才决定 cargo 编几个 ABI。
REM 单编 arm64：Rust 从 4 遍(约10min)降到 1 遍(约2.5min)。
findstr /v /c:"abiList=" /v /c:"targetList=" /v /c:"archList=" "%GRADLE_PROPS_BAK%" > "%GRADLE_PROPS%"
echo abiList=arm64-v8a >> "%GRADLE_PROPS%"
echo targetList=aarch64 >> "%GRADLE_PROPS%"
echo archList=arm64 >> "%GRADLE_PROPS%"
echo [ANDROID] ABI filter: arm64-v8a only (single-target compile)
goto abi_done

:abi_all
findstr /v /c:"abiList=" /v /c:"targetList=" /v /c:"archList=" "%GRADLE_PROPS_BAK%" > "%GRADLE_PROPS%"
echo [ANDROID] ABI filter: all ABIs (universal)

:abi_done

REM ---- 3. Run Tauri Android build ----
echo [ANDROID] [1/2] Running pnpm tauri android build %TAURI_ARGS% ...
echo [ANDROID]     log is written to build_android.log

call pnpm tauri android build %TAURI_ARGS% > "%CD%\build_android.log" 2>&1
set BUILD_EXIT=%ERRORLEVEL%
echo BUILD_EXIT=%BUILD_EXIT% >> "%CD%\build_android.log"

REM ---- 4. Restore gradle.properties ----
move /y "%GRADLE_PROPS_BAK%" "%GRADLE_PROPS%" >nul

if %BUILD_EXIT% EQU 0 goto report
echo.
echo [ANDROID] [X] Android build failed, exit %BUILD_EXIT%
echo [ANDROID] Full log: %CD%\build_android.log
echo.
pause
exit /b 1

:report
echo.
echo [ANDROID] ========================================
echo [ANDROID] [OK] Android APK build complete!
echo [ANDROID] Artifacts:
dir /s /b "%CD%\src-tauri\gen\android\app\build\outputs\apk\*.apk" 2>nul
echo [ANDROID] Log: %CD%\build_android.log
echo [ANDROID] ========================================
echo.
pause
