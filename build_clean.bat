@echo off
chcp 65001 >nul 2>&1
REM ============================================================
REM build_clean.bat - Lite build, no bundled plugins or external deps
REM
REM Under the new bundled-dlc architecture the flow is minimal:
REM   1. Set BUILD_CLEAN=1
REM   2. pnpm tauri build
REM      - deploy-plugins.mjs in beforeBuildCommand detects BUILD_CLEAN=1
REM        and skips plugin build, only creates empty placeholder dirs
REM      - prepare-bundled-dlc.mjs detects BUILD_CLEAN=1 and creates empty bundled-dlc/
REM        (only .gitkeep), embedded via tauri.conf.json bundle.resources
REM   3. Clear the env var
REM
REM Output:
REM   Lite installer (src-tauri/target/release/bundle/)
REM     - Contains no plugins/deps
REM     - Users can later download .mufurong/.mujin (from build_dlc.bat),
REM       drag into user_plugins/ and user_external_deps/ for auto-extract
REM ============================================================

cd /d "%~dp0"

REM 0. Ensure placeholder folder scaffold (.gitkeep) so no directory is dropped by NSIS/git
echo [BUILD_CLEAN] [pre] Ensuring placeholder folders...
node scripts/ensure-placeholders.mjs

echo [BUILD_CLEAN] Starting lite build...
echo [BUILD_CLEAN] Working dir: %CD%

REM 1. Set BUILD_CLEAN env var
REM    - deploy-plugins.mjs detects it and skips plugin build
REM    - prepare-bundled-dlc.mjs detects it and creates empty bundled-dlc/ placeholder
set BUILD_CLEAN=1

REM 2. Run Tauri build (beforeBuildCommand handles the BUILD_CLEAN branch)
REM    gongfang is a plugin module (plugins/茑萝/gongfang). The clean installer does
REM    NOT bundle the gongfang plugin or its heavy external deps - they are distributed
REM    independently as DLC via build_dlc.bat (.mufurong plugin + .mujin deps). However,
REM    the gongfang backend (Rust Tauri commands) must be compiled into the binary so
REM    that the imported gongfang plugin works fully, so we keep all gongfang features.
echo [BUILD_CLEAN] Running pnpm tauri build --features gongfang,... (log -> build_clean.log)...
call pnpm tauri build -- --features gongfang,gongfang-reverse,gongfang-pentest,gongfang-automation,gongfang-gateway > "%CD%\build_clean.log" 2>&1
set BUILD_EXIT=%ERRORLEVEL%
echo BUILD_EXIT=%BUILD_EXIT% >> "%CD%\build_clean.log"

REM 3. Clear the env var
set BUILD_CLEAN=

if "%BUILD_EXIT%"=="0" (
  echo.
  echo [BUILD_CLEAN] ========================================
  echo [BUILD_CLEAN] [OK] Lite build complete!
  echo [BUILD_CLEAN] Installer has no plugins, users download .mufurong/.mujin
  echo [BUILD_CLEAN]   - drag .mufurong into user_plugins\
  echo [BUILD_CLEAN]   - drag .mujin     into user_external_deps\
  echo [BUILD_CLEAN] Log: %CD%\build_clean.log
  echo [BUILD_CLEAN] ========================================
) else (
  echo.
  echo [BUILD_CLEAN] ========================================
  echo [BUILD_CLEAN] [X] Build failed (exit %BUILD_EXIT%)
  echo [BUILD_CLEAN] Log: %CD%\build_clean.log
  echo [BUILD_CLEAN] ========================================
)

echo.
echo [BUILD_CLEAN] Press any key to close...
pause >nul
