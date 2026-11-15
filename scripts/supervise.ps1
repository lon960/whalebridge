<#
  supervise.ps1 - watchdog.
  Rediscovers the DSH port; if it changed, rewrites the bridge config and restarts
  the bridge. Also restarts the bridge if it is not running.
  Invoked by the scheduled task WhaleBridge-supervise every 2 minutes.
#>
param([string]$Root = "")
$ErrorActionPreference = 'Continue'
if (-not $Root) { $Root = Split-Path $PSScriptRoot -Parent }
$cfgPath = Join-Path $Root 'bridge\config.json'
$logDir  = Join-Path $Root 'logs'
$log     = Join-Path $logDir 'supervise.log'
$node    = Join-Path $Root 'runtime\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
$probe   = Join-Path $Root 'bridge\scripts\probe-dsh-port.mjs'
$patch   = Join-Path $Root 'scripts\patch-config.mjs'
$port = 3902
try { $ec = Get-Content (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json; if ($ec.port) { $port = [int]$ec.port } } catch {}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
function Log($m) { Add-Content -Path $log -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 }

if (-not (Test-Path $probe)) { Log "missing $probe"; exit 0 }
$out = & $node $probe 2>$null
if (-not $out) { Log 'DSH not found, skipping this round'; exit 0 }
$dsh = ([string]$out).Trim()

$cur = ''
try {
  if (Test-Path $cfgPath) {
    $t = [System.IO.File]::ReadAllText($cfgPath)
    if ($t -match '"baseUrl"\s*:\s*"http://127\.0\.0\.1:(\d+)"') { $cur = $matches[1] }
  }
} catch {}
$needRestart = $false
if ($cur -ne $dsh) {
  Copy-Item $cfgPath "$cfgPath.bak-port-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force -ErrorAction SilentlyContinue
  & $node $patch $cfgPath $port $dsh '' '' | Out-Null
  Log "DSH port changed: $cur -> $dsh"
  $needRestart = $true
}

$br = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bridge\.js' })
if ($br.Count -eq 0) {
  Start-Process -FilePath $node -ArgumentList 'src/bridge.js' -WorkingDirectory (Join-Path $Root 'bridge') -WindowStyle Hidden
  Log 'bridge was not running, started it'
} elseif ($needRestart) {
  $old = ($br | ForEach-Object { $_.ProcessId }) -join ','
  $br | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Start-Process -FilePath $node -ArgumentList 'src/bridge.js' -WorkingDirectory (Join-Path $Root 'bridge') -WindowStyle Hidden
  Log "bridge restarted on new port (old pid $old)"
} else {
  Log "OK port $dsh, bridge running (pid $($br[0].ProcessId))"
}