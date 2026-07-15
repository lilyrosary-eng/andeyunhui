@echo off
cd /d C:\Users\Rosary\Desktop\andengyuanhua
pnpm tauri build > C:\Users\Rosary\Desktop\andengyuanhua\build.log 2>&1
echo BUILD_EXIT=%ERRORLEVEL% >> C:\Users\Rosary\Desktop\andengyuanhua\build.log
