@echo off
REM ============================================================
REM  dev-env.bat - load Visual Studio build env for Tauri
REM ============================================================
REM  Called by the package.json "tauri" script:  dev-env.bat && tauri
REM  so that `pnpm tauri dev` and `pnpm tauri build` automatically
REM  carry the MSVC environment (INCLUDE / LIB / PATH).
REM
REM  Why: cargo native deps (vswhom-sys / cc) invoke cl.exe, which
REM  needs INCLUDE/LIB to find windows.h. Without them cl.exe fails
REM  and every C/C++ crate cascades into compile errors.
REM
REM  NOTE: keep this file ASCII-only + CRLF line endings.
REM  cmd.exe decodes .bat using the console codepage (GBK on zh-CN),
REM  so UTF-8 Chinese comments would become garbage commands.
REM ============================================================

set "VCVARS="

if not defined VCVARS if exist "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if not defined VCVARS (
  echo [dev-env] Visual Studio 2022 vcvars64.bat not found.
  echo [dev-env] Install the "Desktop development with C++" workload, or run
  echo [dev-env] pnpm tauri dev from "Developer Command Prompt for VS 2022".
  exit /b 1
)

call "%VCVARS%" >nul 2>&1
