@echo off
chcp 65001 >nul 2>&1
REM ============================================================
REM build_dlc.bat - DLC 插件包打包脚本，把所有插件打包到 dist-dlc/ 方便分发
REM
REM 输出 dist-dlc/ 目录：
REM   - dist-dlc/plugins/         各插件 .mufurong 文件
REM   - dist-dlc/external-deps/   外部依赖（ffmpeg、markitdown 等）
REM   - dist-dlc/使用说明.txt
REM
REM .mufurong = ZIP 的后缀，用户拖到 user_plugins/ 自动解压
REM 大型模块保留的母文件夹：niaoluo/ai.mufurong, 全局/markitdown.mufurong
REM
REM 不执行 tauri build，只生成分发文件
REM ============================================================

cd /d "%~dp0"

echo [BUILD_DLC] 开始打包 DLC 插件包...
echo [BUILD_DLC] 工作目录: %CD%

REM 1. 确保 bundled-plugins/ 已构建（deploy-plugins.mjs 把 plugins/ -> bundled-plugins/）
echo [BUILD_DLC] 构建 bundled-plugins/...
call pnpm run predev
if %ERRORLEVEL% neq 0 (
  echo [BUILD_DLC] [X] predev 失败（错误码 %ERRORLEVEL%），请检查 pnpm 和 node 是否在 PATH 中
  pause
  exit /b 1
)

REM 2. 运行 pack-mufurong.mjs 打包
echo [BUILD_DLC] 打包 .mufurong 文件...
node scripts/pack-mufurong.mjs
set PACK_EXIT=%ERRORLEVEL%

if "%PACK_EXIT%"=="0" (
  echo.
  echo [BUILD_DLC] ========================================
  echo [BUILD_DLC] [OK] DLC 打包完成！
  echo [BUILD_DLC] 输出目录: %CD%\dist-dlc
  echo [BUILD_DLC]   - dist-dlc\plugins\        .mufurong 插件文件
  echo [BUILD_DLC]   - dist-dlc\external-deps\  外部依赖
  echo [BUILD_DLC]   - dist-dlc\使用说明.txt
  echo [BUILD_DLC] 分发方式：把 .mufurong 文件给用户，用户拖到 user_plugins/ 即可
  echo [BUILD_DLC] ========================================
) else (
  echo.
  echo [BUILD_DLC] [X] 打包失败（错误码 %PACK_EXIT%）
)

echo.
echo [BUILD_DLC] 按任意键关闭...
pause >nul
