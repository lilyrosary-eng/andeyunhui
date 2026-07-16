@echo off
chcp 65001 >nul 2>&1
REM ============================================================
REM build_clean.bat - 精简版打包，不带插件和外部依赖
REM
REM 打包后只留空目录占位（.gitkeep），不含实际插件内容
REM 用户安装后可下载 .mufurong 插件或恢复 external-deps/ 到原位
REM
REM 原理：
REM 1. 设置 BUILD_CLEAN=1 环境变量
REM 2. deploy-plugins.mjs 检测此变量，跳过插件构建，只创建空目录
REM 3. 临时重命名 external-deps/（保留原目录结构占位）
REM 4. 执行 tauri build（beforeBuildCommand 会运行 deploy-plugins.mjs，但跳过插件）
REM 5. 恢复 external-deps/
REM ============================================================

cd /d "%~dp0"

echo [BUILD_CLEAN] 开始精简打包...
echo [BUILD_CLEAN] 工作目录: %CD%

REM 1. 设置 BUILD_CLEAN 环境变量，让 deploy-plugins.mjs 跳过插件构建
set BUILD_CLEAN=1

REM 2. 临时重命名 external-deps/（避免被打包进去，且非空！）
set "EXTERNAL_DIR=%CD%\external-deps"
set "EXTERNAL_BAK=%CD%\external-deps.bak"

if exist "%EXTERNAL_BAK%" (
  echo [BUILD_CLEAN] 清理旧备份...
  rmdir /s /q "%EXTERNAL_BAK%"
)

if exist "%EXTERNAL_DIR%" (
  echo [BUILD_CLEAN] 备份 external-deps/...
  ren "%EXTERNAL_DIR%" "external-deps.bak"
  if %ERRORLEVEL% neq 0 (
    echo [BUILD_CLEAN] [X] 备份 external-deps/ 失败（可能被占用）
    set BUILD_CLEAN=
    pause
    exit /b 1
  )
)

REM 3. 创建空 external-deps/ 目录结构（只放 .gitkeep 占位）
mkdir "%EXTERNAL_DIR%" 2>nul
mkdir "%EXTERNAL_DIR%\全局" 2>nul
echo. > "%EXTERNAL_DIR%\.gitkeep"
echo. > "%EXTERNAL_DIR%\全局\.gitkeep"
echo [BUILD_CLEAN] 已创建空 external-deps/ 占位

REM 4. 清理 bundled-plugins/ 中的旧产物（只保留 .gitkeep）
set "BUNDLED_DIR=%CD%\bundled-plugins"
if exist "%BUNDLED_DIR%" (
  echo [BUILD_CLEAN] 清理 bundled-plugins/ 旧产物...
  for /d %%D in ("%BUNDLED_DIR%\*") do (
    rmdir /s /q "%%D" 2>nul
  )
  del /q "%BUNDLED_DIR%\*.js" 2>nul
  del /q "%BUNDLED_DIR%\*.json" 2>nul
)

REM 5. 执行 Tauri 构建（beforeBuildCommand 会运行 deploy-plugins.mjs）
REM    检测到 BUILD_CLEAN=1 会跳过插件构建，只创建空目录占位
echo [BUILD_CLEAN] 开始 Tauri 构建（日志写入 build_clean.log）...
call pnpm tauri build > "%CD%\build_clean.log" 2>&1
set BUILD_EXIT=%ERRORLEVEL%
echo BUILD_EXIT=%BUILD_EXIT% >> "%CD%\build_clean.log"

REM 6. 恢复 external-deps/
echo [BUILD_CLEAN] 恢复 external-deps/...
if exist "%EXTERNAL_DIR%" rmdir /s /q "%EXTERNAL_DIR%"
if exist "%EXTERNAL_BAK%" ren "%EXTERNAL_BAK%" "external-deps"

REM 7. 清理环境变量
set BUILD_CLEAN=

if "%BUILD_EXIT%"=="0" (
  echo.
  echo [BUILD_CLEAN] ========================================
  echo [BUILD_CLEAN] [OK] 精简打包完成！
  echo [BUILD_CLEAN] 安装包不含插件，用户可下载 .mufurong 插件
  echo [BUILD_CLEAN] 日志: %CD%\build_clean.log
  echo [BUILD_CLEAN] ========================================
) else (
  echo.
  echo [BUILD_CLEAN] ========================================
  echo [BUILD_CLEAN] [X] 打包失败（错误码 %BUILD_EXIT%）
  echo [BUILD_CLEAN] 查看日志: %CD%\build_clean.log
  echo [BUILD_CLEAN] ========================================
)

echo.
echo [BUILD_CLEAN] 按任意键关闭...
pause >nul
