@echo off
cd /d C:\Users\Rosary\Desktop\tauri-best
pnpm tauri build > C:\Users\Rosary\Desktop\tauri-best\build.log 2>&1
echo BUILD_EXIT=%ERRORLEVEL% >> C:\Users\Rosary\Desktop\tauri-best\build.log
