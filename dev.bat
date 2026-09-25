@echo off
REM Convenience launcher: load VS build env, then start tauri dev.
REM Equivalent to `pnpm tauri dev` (package.json already loads the env).
REM Keep this file ASCII-only + CRLF.
call "%~dp0dev-env.bat" || exit /b 1
pnpm tauri dev
