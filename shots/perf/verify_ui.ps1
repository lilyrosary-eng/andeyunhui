param(
  [string]$Action = 'shot',
  [string]$Out = 'C:\Users\Rosary\Desktop\andeyunhui\shots\perf\ui.png',
  [string]$Name = ''
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -Namespace W32 -Name N -MemberDefinition @'
public delegate bool EnumProc(IntPtr h, IntPtr p);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
public static IntPtr Top() { return new IntPtr(-1); }
public static IntPtr NotTop() { return new IntPtr(-2); }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

[void][W32.N]::SetProcessDPIAware()

$script:found = @()

function Collect-Windows {
  $script:found = @()
  $procs = Get-Process -Name andeyunhui -ErrorAction SilentlyContinue
  $pids = @()
  foreach ($q in $procs) { $pids += [uint32]$q.Id }
  if ($pids.Count -eq 0) { return }
  $cb = [W32.N+EnumProc]{
    param($h, $l)
    $pid2 = [uint32]0
    [void][W32.N]::GetWindowThreadProcessId($h, [ref]$pid2)
    if ($pids -contains $pid2) {
      if ([W32.N]::IsWindowVisible($h)) {
        $len = [W32.N]::GetWindowTextLength($h)
        $sb = New-Object System.Text.StringBuilder ($len + 2)
        [void][W32.N]::GetWindowText($h, $sb, $sb.Capacity)
        $r = New-Object W32.N+RECT
        [void][W32.N]::GetWindowRect($h, [ref]$r)
        $script:found += [pscustomobject]@{
          Hwnd = $h
          Title = $sb.ToString()
          Left = $r.Left; Top = $r.Top
          W = ($r.Right - $r.Left); H = ($r.Bottom - $r.Top)
          Area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
        }
      }
    }
    return $true
  }
  [void][W32.N]::EnumWindows($cb, [IntPtr]::Zero)
}

function Get-MainWin {
  Collect-Windows
  $best = $null
  foreach ($w in $script:found) {
    if ($best -eq $null -or $w.Area -gt $best.Area) { $best = $w }
  }
  return $best
}

function Save-Shot($win, $path) {
  # AppActivate / SetForegroundWindow / SetWindowPos(HWND_TOPMOST) 在本机 PS5.1 下均不可靠
  # （IntPtr 返回值与负句柄被当空值）。最小化→还原这一对只用 int 参数，且还原动作本身
  # 就会把窗口带到前台，实测可行。
  [void][W32.N]::ShowWindow($win.Hwnd, 6)   # SW_MINIMIZE
  Start-Sleep -Milliseconds 400
  [void][W32.N]::ShowWindow($win.Hwnd, 9)   # SW_RESTORE
  Start-Sleep -Milliseconds 1400
  $r = New-Object W32.N+RECT
  [void][W32.N]::GetWindowRect($win.Hwnd, [ref]$r)
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { Write-Output "bad rect $w x $h"; return }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Output ("saved $path ($w x $h) title=[" + $win.Title + "]")
}

function Get-Buttons {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $ct = [System.Windows.Automation.ControlType]::Button
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $out = @()
  foreach ($b in $all) {
    $n = ''
    try { $n = $b.Current.Name } catch { $n = '' }
    if ($n -and $n.Trim().Length -gt 0) { $out += , $b }
  }
  return $out
}

Collect-Windows
Write-Output ("windows of andeyunhui: " + $script:found.Count)
foreach ($w in $script:found) { Write-Output ("  hwnd=" + $w.Hwnd + " " + $w.W + "x" + $w.H + " title=[" + $w.Title + "]") }

$win = Get-MainWin
if ($win -eq $null) { Write-Output 'no visible window'; exit 1 }
Write-Output ("main hwnd=$($win.Hwnd) $($win.W)x$($win.H) title=[" + $win.Title + "]")

if ($Action -eq 'list') {
  $btns = Get-Buttons
  Write-Output ("button count: $($btns.Count)")
  foreach ($b in $btns) { Write-Output ("  [" + $b.Current.Name + "]") }
}
elseif ($Action -eq 'shot') {
  Save-Shot $win $Out
}
elseif ($Action -eq 'click') {
  $btns = Get-Buttons
  $hit = $null
  foreach ($b in $btns) {
    $n = $b.Current.Name
    if ($n -and $n.Contains($Name)) { $hit = $b; break }
  }
  if ($hit -eq $null) {
    Write-Output ("no button containing " + $Name)
    foreach ($b in $btns) { Write-Output ("  [" + $b.Current.Name + "]") }
    exit 2
  }
  Write-Output ("click [" + $hit.Current.Name + "]")
  $pat = $hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pat.Invoke()
  Start-Sleep -Seconds 2
  if ($Out) { Save-Shot $win $Out }
}
