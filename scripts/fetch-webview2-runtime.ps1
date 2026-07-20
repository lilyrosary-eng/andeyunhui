# 下载并展开 WebView2 固定版本运行时（fixedRuntime），用于根治 0x8007139F（运行时 150 回归）
# 背景：WebView2 运行时升到 150 后，同进程第二个及以后控制器必失败；锁一个已知好版本（148/149）即可根治，
#       且不影响任何现有浮窗代码（原生多 webview 架构保留）。详见 refactor_plan_portal_single_webview.md。
#
# 用法（在项目根目录执行，需能访问 msedgedl.blob.core.windows.net）：
#   pwsh scripts/fetch-webview2-runtime.ps1                 # 默认 149.0.4022.98
#   pwsh scripts/fetch-webview2-runtime.ps1 -Version 149.0.xxxx.x
#   pwsh scripts/fetch-webview2-runtime.ps1 -Version 148.0.xxxx.x
param(
  [string]$Version = "149.0.4022.98"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$targetDir = Join-Path $root "src-tauri\webview2-runtime"
$cabName = "Microsoft.WebView2.FixedVersionRuntime.$Version.x64.cab"
$cabUrl = "https://msedgedl.blob.core.windows.net/installers/$Version/$cabName"
$cabPath = Join-Path $env:TEMP "webview2-fixed-$Version.cab"

Write-Output "[1/4] 下载 $cabUrl"
try {
  Invoke-WebRequest -Uri $cabUrl -OutFile $cabPath -TimeoutSec 600
} catch {
  Write-Error "下载失败：$($_.Exception.Message)`n可能原因：1) 版本号 $Version 不存在——请到 https://learn.microsoft.com/zh-cn/deployedge/webview2-release-notes 查一个真实存在的 149.x 或 148.x 版本号并加 -Version 重试；2) 本机无法访问 msedgedl.blob.core.windows.net（需在能联网环境运行）。"
  exit 1
}

Write-Output "[2/4] 清空旧目录 $targetDir"
if (Test-Path $targetDir) { Remove-Item $targetDir -Recurse -Force }
New-Item -ItemType Directory -Path $targetDir | Out-Null

Write-Output "[3/4] 展开 cab -> $targetDir (cab 内以 x64/... 存储，展开后得 x64\msedgewebview2.exe)"
$expand = "$env:SystemRoot\System32\expand.exe"
& $expand $cabPath -F:* $targetDir | Out-Null

$exe = Join-Path $targetDir "x64\msedgewebview2.exe"
if (-not (Test-Path $exe)) {
  Write-Error "展开后未找到 x64\msedgewebview2.exe，目录结构不符合 Tauri fixedRuntime 期望。请检查 cab 内容。"
  exit 1
}

Write-Output "[4/4] 版本 $Version 已就绪于 $targetDir"
Write-Output ""
Write-Output "=== 下一步 ==="
Write-Output "开发模式验证（PowerShell，确认浮窗恢复）："
Write-Output "    `$env:WEBVIEW2_RUNTIME_PATH='$targetDir\x64'; `$env:ANDY_DIAG='1'; pnpm dev"
Write-Output "  若 [DIAG] 全部 scale_ok_500ms=true 即成功（次窗不再 0x8007139F）。"
Write-Output ""
Write-Output "打包发布：tauri.conf.json 已配 webviewInstallMode=fixedRuntime(path=./webview2-runtime)，"
Write-Output "          `pnpm tauri build` 会自动把该运行时打进安装包，用户安装后不再依赖系统 WebView2 版本。"
Remove-Item $cabPath -Force -ErrorAction SilentlyContinue
