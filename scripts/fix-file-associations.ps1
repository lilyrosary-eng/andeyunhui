# 修复安得云荟抢占的文件关联（一次性工具）
#
# 背景：安装器用了 Tauri 的 fileAssociations，而 installMode = perMachine，
# 注册表写在 HKLM，影响全机器所有用户。结果 png/jpg/mp4/mp3/txt/docx 等扩展名的
# 默认程序被改成安得云荟，文件图标和资源管理器「类型」列也跟着变。
#
# 这个脚本把默认程序还回去，但保留右键打开方式里的入口：
#   1. 如果 HKLM\Software\Classes\.<ext> 的默认值是我们（image/video/audio/document），删掉它；
#   2. 写入 .<ext>\OpenWithProgids\<progid>（空值）—— 这是「这个程序也能打开它」的标准登记，
#      不改默认程序、不改图标，右键「打开方式」里仍然能选到安得云荟。
#
# 安全：只动「默认值恰好等于我们 ProgID」的项，绝不碰别人的关联。
# 需要管理员权限（改 HKLM）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\fix-file-associations.ps1 -Preview
#   powershell -ExecutionPolicy Bypass -File scripts\fix-file-associations.ps1

param(
    [switch]$Preview
)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ((-not $isAdmin) -and (-not $Preview)) {
    Write-Host 'NEED ADMIN: this script modifies HKLM. Run PowerShell as Administrator.' -ForegroundColor Red
    Write-Host 'To only preview what would change, add -Preview (no admin needed).' -ForegroundColor Yellow
    exit 1
}

$ours = @('image', 'video', 'audio', 'document')

# 与本仓库 src-tauri/tauri.conf.json 的 fileAssociations 保持一致。
# 用 [progid, ext] 数组而不是哈希表：PowerShell 5.1 对多行 @{} 的解析在
# 无 BOM 文件里容易出问题，数组字面量最稳。
$entries = @(
    @('image', 'png'),
    @('image', 'jpg'),
    @('image', 'jpeg'),
    @('image', 'gif'),
    @('image', 'webp'),
    @('image', 'bmp'),
    @('image', 'tiff'),
    @('video', 'mp4'),
    @('video', 'mkv'),
    @('video', 'mov'),
    @('video', 'avi'),
    @('video', 'webm'),
    @('video', 'flv'),
    @('audio', 'mp3'),
    @('audio', 'flac'),
    @('audio', 'wav'),
    @('audio', 'ogg'),
    @('audio', 'm4a'),
    @('audio', 'aac'),
    @('document', 'pdf'),
    @('document', 'epub'),
    @('document', 'txt'),
    @('document', 'md'),
    @('document', 'docx'),
    @('document', 'pptx'),
    @('document', 'xlsx'),
    @('document', 'csv')
)

$fixed = 0
$skipped = 0

foreach ($item in $entries) {
    $progid = $item[0]
    $ext = $item[1]
    $clsPath = 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\.' + $ext
    if (-not (Test-Path $clsPath)) { continue }

    $cur = (Get-ItemProperty $clsPath -ErrorAction SilentlyContinue).'(default)'
    if ($ours -notcontains $cur) {
        $skipped++
        continue
    }

    Write-Host ('.{0,-5} default was [{1}] -> restore + register to OpenWith' -f $ext, $cur)
    if (-not $Preview) {
        # 删掉抢占的默认值。之后双击由用户自己选的程序（UserChoice）决定；
        # 没有 UserChoice 时 Windows 会正常弹出「选择打开方式」。
        Remove-ItemProperty -Path $clsPath -Name '(default)' -ErrorAction SilentlyContinue
        New-Item -Path ($clsPath + '\OpenWithProgids') -Force | Out-Null
        New-ItemProperty -Path ($clsPath + '\OpenWithProgids') -Name $progid -Value '' -PropertyType String -Force | Out-Null
    }
    $fixed++
}

Write-Host ''
if ($Preview) {
    Write-Host ('DRY RUN: would fix ' + $fixed + ' extensions, skip ' + $skipped + ' (not ours).')
    Write-Host 'Run without -Preview as Administrator to apply.'
} else {
    Write-Host ('DONE: fixed ' + $fixed + ' extensions, skipped ' + $skipped + '.') -ForegroundColor Green
    if ($fixed -gt 0) {
        Write-Host 'Explorer may cache old icons. Restart explorer or sign out/in to refresh.'
    }
}
