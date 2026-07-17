@echo off
chcp 65001 >nul 2>&1
REM ============================================================
REM build.bat - Full build script (installer + DLC distribution)
REM
REM Outputs:
REM   1. Full installer (src-tauri/target/release/bundle/)
REM      - Contains all plugins (bundled-plugins/) and deps (external-deps/) as-is
REM      - Ready to use out of the box, no extra download needed
REM
REM   2. DLC distribution (dist-dlc/)
REM      - dist-dlc/plugins/         .mufurong plugins (renamed ZIP)
REM      - dist-dlc/external-deps/   .mujin deps (renamed ZIP, keeps parent folder layout)
REM      - For lite-installer users to download on demand into user_plugins/ / user_external_deps/
REM      - Auto-extract on Rust side: extract_mufurong_plugins / extract_mujin_deps
REM
REM Steps:
REM   1. build-external-deps.mjs (build IIFE index.js for codemirror/tiptap/univer)
REM   2. pnpm tauri build (beforeBuildCommand auto-builds bundled-plugins + vite build)
REM   3. pack-mufurong.mjs (auto-calls pack-mujin.mjs to pack deps into .mujin)
REM ============================================================

cd /d "%~dp0"

REM 0. Ensure placeholder folder scaffold (.gitkeep) so no directory is dropped by NSIS/git
echo [BUILD] [pre] Ensuring placeholder folders...
node scripts/ensure-placeholders.mjs

echo [BUILD] Starting full build...
echo [BUILD] Working dir: %CD%

REM 1. Build external-deps IIFE entry sources (codemirror/tiptap/univer index.js)
REM    These outputs are the dep sources packed into .mujin by pack-mujin.mjs, must build first
echo [BUILD] [1/3] Building external-deps IIFE entry sources...
node scripts/build-external-deps.mjs > "%CD%\build.log" 2>&1
set EXT_EXIT=%ERRORLEVEL%
if %EXT_EXIT% neq 0 (
  echo [BUILD] [!] external-deps build failed (exit %EXT_EXIT%, continue anyway)
  echo [BUILD]     .mujin may contain only stale index.js, see build.log
)

REM 2. Run Tauri build (beforeBuildCommand auto-runs: deploy-plugins + copy-waiting + vite build)
echo [BUILD] [2/3] Running pnpm tauri build (full installer)...
call pnpm tauri build -- --features gongfang,gongfang-reverse,gongfang-pentest,gongfang-automation,gongfang-gateway >> "%CD%\build.log" 2>&1
set BUILD_EXIT=%ERRORLEVEL%
echo BUILD_EXIT=%BUILD_EXIT% >> "%CD%\build.log"

if %BUILD_EXIT% neq 0 (
  echo.
  echo [BUILD] [X] Tauri build failed (exit %BUILD_EXIT%)
  echo [BUILD] Log: %CD%\build.log
  echo.
  echo [BUILD] Press any key to close...
  pause >nul
  exit /b 1
)

REM 3. Generate DLC distribution (.mufurong plugins + .mujin deps)
echo [BUILD] [3/3] Generating DLC distribution (.mufurong + .mujin)...
node scripts/pack-mufurong.mjs >> "%CD%\build.log" 2>&1
set PACK_EXIT=%ERRORLEVEL%

if "%PACK_EXIT%"=="0" (
  echo [BUILD] [OK] DLC distribution generated
) else (
  echo [BUILD] [!] DLC packing failed (exit %PACK_EXIT%, non-fatal, installer still usable)
  echo [BUILD]     See end of build.log for details
)

echo.
echo [BUILD] ========================================
echo [BUILD] [OK] Full build complete!
echo [BUILD] Artifacts:
echo [BUILD]   1. Full installer: src-tauri\target\release\bundle\
echo [BUILD]      Contains all plugins + deps (ready to use)
echo [BUILD]   2. DLC distribution: dist-dlc\
echo [BUILD]      - dist-dlc\plugins\        .mufurong plugins
echo [BUILD]      - dist-dlc\external-deps\  .mujin deps
echo [BUILD]    Log: %CD%\build.log
echo [BUILD] Distribution:
echo [BUILD]   - Full install: send installer directly
echo [BUILD]   - Lite install: use build_clean.bat, plus .mufurong/.mujin on demand
echo [BUILD] ========================================
echo.
echo [BUILD] Press any key to close...
pause >nul
