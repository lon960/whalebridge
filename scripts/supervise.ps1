<#
  supervise.ps1 - watchdog.
  Runs every 2 minutes from the scheduled task WhaleBridge-supervise.

  Three jobs, in order:
    1. engine health - the engine lives inside QQ, so if QQ is gone the engine is
       gone too. Restart only when QQ is gone as well; if QQ is running we leave it
       alone (restarting would interrupt whoever is using that session) and just
       say so in the log.
    2. DSH port rediscovery - rewrite the bridge config if the port moved.
    3. bridge liveness - start it if it is not running, restart it if the DSH port
       changed.
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
$autoRestart = $false
try {
  $ec = Get-Content (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($ec.port) { $port = [int]$ec.port }
  if ($ec.auto_restart_qq) { $autoRestart = [bool]$ec.auto_restart_qq }
} catch {}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
function Log($m) { Add-Content -Path $log -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 }

# ----- 1. engine health -----
$engineUp = $false
try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3; $engineUp = [bool]$r.ok } catch { $engineUp = $false }
if (-not $engineUp) {
  $qq = @(Get-Process QQ -ErrorAction SilentlyContinue)
  if ($qq.Count -eq 0) {
    Log "engine is down and QQ is gone, starting both"
    try { & (Join-Path $Root 'scripts\start.ps1') -Root $Root | Out-Null } catch { Log ("start.ps1 failed: " + $_) }
  } elseif ($autoRestart) {
    Log "engine is down, QQ is running, auto_restart_qq is on - restarting QQ"
    try { & (Join-Path $Root 'scripts\start.ps1') -Root $Root -Force | Out-Null } catch { Log ("start.ps1 -Force failed: " + $_) }
  } else {
    Log "engine is down but QQ is running (pid $($qq[0].Id)) - not restarting, that would interrupt the current session. Run start.cmd to recover."
  }
  exit 0
}

# ----- 2. DSH port -----
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

# ----- 3. bridge -----
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
