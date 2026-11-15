<#
  uninstall.ps1 - remove the watchdog task, the bridge, C:\wb.js and the install dir.
  QQ itself is not touched.
#>
param([string]$Root = "", [switch]$KeepFiles)
$ErrorActionPreference = 'Continue'
if (-not $Root) { $Root = Split-Path $PSScriptRoot -Parent }
Write-Host "uninstalling WhaleBridge ($Root)"
schtasks /Delete /TN "WhaleBridge-supervise" /F 2>$null | Out-Null
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'bridge\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item 'C:\wb.js' -Force -ErrorAction SilentlyContinue
if (-not $KeepFiles -and (Test-Path $Root)) {
  $ans = Read-Host "delete install directory $Root ? (y/N)"
  if ($ans -match '^(y|Y)') { Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue; Write-Host "deleted" }
}
Write-Host "note: QQ is still running with the engine loaded; restart QQ to get back to a clean state"