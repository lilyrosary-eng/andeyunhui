@echo off
REM ============================================================
REM  dev-env.bat — 为 Tauri 的 cargo build 加载 VS 构建环境
REM ============================================================
REM  被 package.json 的 "tauri" 脚本调用（dev-env.bat && tauri），
REM  让 `pnpm tauri dev` / `pnpm tauri build` 自带 MSVC 环境变量，
REM  无需手动打开 “Developer Command Prompt for VS 2022”。
REM
REM  根因：cargo 的原生依赖（vswhom-sys / cc）需要 INCLUDE / LIB / PATH
REM  才能调用 cl.exe 编译。普通终端缺少这些变量时，cl.exe 找不到
REM  windows.h，导致 vswhom-sys 等连环编译失败（”大量报错”）。
REM ============================================================

set "VSWHERE=C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
set "VCVARS="

REM 1) vswhere 动态定位 VS2022 的 vcvars64.bat（对 VS 升级也鲁棒）
if exist "%VSWHERE%" (
  for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
    if exist "%%i\VC\Auxiliary\Build\vcvars64.bat" (
      set "VCVARS=%%i\VC\Auxiliary\Build\vcvars64.bat"
    )
  )
)

REM 2) 兜底：常见固定路径（企业版 / 社区版 / 专业版）
if not defined VCVARS if exist "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"

if not defined VCVARS (
  echo [dev-env] 未找到 Visual Studio 2022 的 vcvars64.bat。
  echo [dev-env] 请安装「使用 C++ 的桌面开发」工作负载，或改用
  echo [dev-env] "Developer Command Prompt for VS 2022" 运行 pnpm tauri dev。
  exit /b 1
)

call "%VCVARS%" >nul 2>&1
