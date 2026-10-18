$ErrorActionPreference = 'SilentlyContinue'
$out = 'C:\Users\Rosary\Desktop\andeyunhui\shots\perf\hw.txt'
Remove-Item $out -Force

function W($s) { $s | Out-File $out -Append -Encoding UTF8 }

W "=== DISKS ==="
Get-Disk | Select-Object Number, FriendlyName, @{n='SizeGB';e={[int]($_.Size/1GB)}}, PartitionStyle, BusType, HealthStatus, OperationalStatus, IsBoot, IsSystem |
  Format-Table -AutoSize | Out-String -Width 220 | ForEach-Object { W $_ }

W "=== PARTITIONS (all, including ones without drive letter) ==="
Get-Partition | Select-Object DiskNumber, PartitionNumber, DriveLetter, @{n='SizeGB';e={[math]::Round($_.Size/1GB,2)}}, Type, Offset |
  Sort-Object DiskNumber, PartitionNumber | Format-Table -AutoSize | Out-String -Width 220 | ForEach-Object { W $_ }

W "=== VOLUMES ==="
Get-Volume | Select-Object DriveLetter, FileSystemType, FileSystemLabel, @{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}}, @{n='FreeGB';e={[math]::Round($_.SizeRemaining/1GB,1)}}, HealthStatus |
  Format-Table -AutoSize | Out-String -Width 220 | ForEach-Object { W $_ }

W "=== PHYSICAL DISK RELIABILITY (SMART) ==="
foreach ($d in Get-PhysicalDisk) {
  $c = $d | Get-StorageReliabilityCounter
  if ($c) {
    W ("{0} [{1}]  Temp={2}C  Wear={3}  ReadErrCorr={4} ReadErrUncorr={5} WriteErrCorr={6} WriteErrUncorr={7}  PowerOnHours={8}  StartStop={9}" -f `
      $d.FriendlyName, $d.MediaType, $c.Temperature, $c.Wear, $c.ReadErrorsCorrected, $c.ReadErrorsUncorrected, $c.WriteErrorsCorrected, $c.WriteErrorsUncorrected, $c.PowerOnHours, $c.StartStopCycleCount)
  } else {
    W ("{0}: SmartData unavailable (needs admin?)" -f $d.FriendlyName)
  }
}

W ""
W "=== GPU ==="
Get-CimInstance Win32_VideoController | ForEach-Object {
  W ("{0} | Driver={1} | DriverDate={2} | Status={3} | State={4}" -f $_.Name, $_.DriverVersion, $_.DriverDate, $_.Status, $_.Availability)
}

W ""
W "=== MEMORY MODULES ==="
Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
  W ("{0} {1} | {2} GB | {3} MT/s | SN={4}" -f $_.Manufacturer, $_.PartNumber, [int]($_.Capacity/1GB), $_.ConfiguredClockSpeed, $_.SerialNumber)
}
W ("TotalVisibleMemory: {0} GB" -f [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB))

W ""
W "=== BATTERY / POWER ==="
$b = Get-CimInstance Win32_Battery
if ($b) { W ("Battery: {0} | Status={1} | DesignVoltage={2} mV" -f $b.Name, $b.BatteryStatus, $b.DesignVoltage) } else { W "No battery reported" }

W ""
W "=== CRASH DUMPS ==="
W ("C:\Windows\Minidump exists: {0}" -f (Test-Path 'C:\Windows\Minidump'))
if (Test-Path 'C:\Windows\Minidump') {
  Get-ChildItem 'C:\Windows\Minidump' | Sort-Object LastWriteTime -Descending |
    Select-Object -First 20 Name, @{n='KB';e={[int]($_.Length/1KB)}}, LastWriteTime |
    Format-Table -AutoSize | Out-String -Width 220 | ForEach-Object { W $_ }
}
W ("C:\Windows\MEMORY.DMP exists: {0}" -f (Test-Path 'C:\Windows\MEMORY.DMP'))
if (Test-Path 'C:\Windows\MEMORY.DMP') {
  $m = Get-Item 'C:\Windows\MEMORY.DMP'
  W ("MEMORY.DMP size={0} GB  LastWrite={1}" -f [math]::Round($m.Length/1GB,2), $m.LastWriteTime)
}

W ""
W "=== LIVEKERNEL REPORTS ==="
if (Test-Path 'C:\Windows\LiveKernelReports') {
  Get-ChildItem 'C:\Windows\LiveKernelReports' -Recurse -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 15 FullName, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}, LastWriteTime |
    Format-Table -AutoSize | Out-String -Width 220 | ForEach-Object { W $_ }
} else { W "none" }

W ""
W "=== FAST STARTUP / HIBERNATION ==="
$p = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power'
W ("HiberbootEnabled = {0}" -f $p.HiberbootEnabled)

Write-Output "done"
