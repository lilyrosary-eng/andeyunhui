@echo off
chcp 65001 >nul 2>&1
REM ============================================================
REM build_dlc.bat - DLC distribution build (ships .mufurong/.mujin separately)
REM
REM Used for:
REM   - Distributing .mufurong/.mujin to lite-installer (build_clean.bat) users
REM   - Packaging plugins/deps into private format, no installer build
REM
REM Output dist-dlc/ dir:
REM   - dist-dlc/plugins/         per-plugin .mufurong files
REM   - dist-dlc/external-deps/   per-dep .mujin files (keeps parent folder layout)
REM   - dist-dlc/README.txt
REM   - dist-dlc/external-deps/README.txt
REM
REM .mufurong = renamed ZIP, users drag into user_plugins/ for auto-extract
REM .mujin    = renamed ZIP, users drag into user_external_deps/ for auto-extract
REM Large modules keep their parent folder:
REM   - plugins:  茑萝/ai.mufurong, global/markitdown.mufurong
REM   - deps:     茑萝/ide/codemirror.mujin, global/markitdown.mujin
REM
REM Does NOT run tauri build, only generates distribution files
REM ============================================================

cd /d "%~dp0"

echo [BUILD_DLC] Packing DLC plugins and deps...
echo [BUILD_DLC] Working dir: %CD%

REM 1. Build external-deps IIFE entry sources (codemirror/tiptap/univer index.js)
REM    pack-mujin.mjs needs these outputs as the .mujin content source
echo [BUILD_DLC] [1/3] Building external-deps IIFE entry sources...
node scripts/build-external-deps.mjs > "%CD%\build_dlc.log" 2>&1
set EXT_EXIT=%ERRORLEVEL%
if %EXT_EXIT% neq 0 (
  echo [BUILD_DLC] [!] external-deps build failed (exit %EXT_EXIT%, continue anyway)
  echo [BUILD_DLC]     .mujin may contain only stale index.js, see build_dlc.log
)

REM 2. Deploy plugins into bundled-plugins/ (deploy-plugins.mjs builds and copies plugins/*)
REM    pack-mufurong.mjs reads plugin dirs from bundled-plugins/
echo [BUILD_DLC] [2/3] Deploying plugins into bundled-plugins/...
node scripts/deploy-plugins.mjs >> "%CD%\build_dlc.log" 2>&1
set DEPLOY_EXIT=%ERRORLEVEL%
if %DEPLOY_EXIT% neq 0 (
  echo [BUILD_DLC] [X] deploy-plugins failed (exit %DEPLOY_EXIT%)
  echo [BUILD_DLC] Log: %CD%\build_dlc.log
  echo.
  echo [BUILD_DLC] Press any key to close...
  pause >nul
  exit /b 1
)

REM 3. Run pack-mufurong.mjs (auto-calls pack-mujin.mjs internally to pack deps)
echo [BUILD_DLC] [3/3] Packing .mufurong plugins + .mujin deps...
node scripts/pack-mufurong.mjs >> "%CD%\build_dlc.log" 2>&1
set PACK_EXIT=%ERRORLEVEL%

if "%PACK_EXIT%"=="0" (
  echo.
  echo [BUILD_DLC] ========================================
  echo [BUILD_DLC] [OK] DLC build complete!
  echo [BUILD_DLC] Output dir: %CD%\dist-dlc
  echo [BUILD_DLC]   - dist-dlc\plugins\        .mufurong plugin files
  echo [BUILD_DLC]   - dist-dlc\external-deps\  .mujin dep files
  echo [BUILD_DLC]   - dist-dlc\README.txt
  echo [BUILD_DLC] Distribution:
  echo [BUILD_DLC]   - plugins: drag .mufurong into user_plugins\
  echo [BUILD_DLC]   - deps:    drag .mujin     into user_external_deps\
  echo [BUILD_DLC] Log: %CD%\build_dlc.log
  echo [BUILD_DLC] ========================================
) else (
  echo.
  echo [BUILD_DLC] [X] Packing failed (exit %PACK_EXIT%)
  echo [BUILD_DLC] Log: %CD%\build_dlc.log
)

echo.
echo [BUILD_DLC] Press any key to close...
pause >nul
