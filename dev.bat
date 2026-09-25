@echo off
REM 便捷启动器：自动加载 VS 构建环境后启动 tauri dev。
REM 等价于 `pnpm tauri dev`（package.json 已自动加载环境），此文件供双击/显式调用。
call "%~dp0dev-env.bat" || exit /b 1
pnpm tauri dev
