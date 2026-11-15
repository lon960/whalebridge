<#
  install.ps1 - WhaleBridge installer (engine + injector + optional qq-bridge)

  Usage:
    .\scripts\install.ps1                          # install to %LOCALAPPDATA%\WhaleBridge
    .\scripts\install.ps1 -QQ "D:\QQ\QQ.exe" -Port 3902
    .\scripts\install.ps1 -SkipBridge              # engine only, no persona layer

  Touches: %LOCALAPPDATA%\WhaleBridge and C:\wb.js. Never the QQ install directory.
#>
param(
  [string]$InstallDir = "",
  [string]$QQ = "",
  [int]$Port = 3902,
  [string]$DataDir = "",
  [string]$SelfUin = "",
  [string]$BridgeSource = "",
  [switch]$Force,
  [switch]$NoTask,
  [switch]$NoBootStub,
  [switch]$SkipBridge
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path $PSScriptRoot -Parent
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'WhaleBridge' }
$enc = New-Object System.Text.UTF8Encoding($false)

Write-Host "=== WhaleBridge install ===" -ForegroundColor Cyan
Write-Host "repo   : $Repo"
Write-Host "target : $InstallDir"

# ----- 1. sanity -----
$need = @('src\engine\engine.cjs', 'src\engine\wb-template.js', 'scripts\start.ps1')
foreach ($n in $need) {
  if (-not (Test-Path (Join-Path $Repo $n))) { throw "incomplete repo, missing $n" }
}

# ----- 2. binaries -----
# Prebuilt DLL + injector are NOT in git (see .gitignore). Either build them
# (see README "Build the injector") or drop them into bin\ before installing.
$dll = Join-Path $Repo 'bin\payload.dll'
$inj = Join-Path $Repo 'bin\wbinj.exe'
if (-not (Test-Path $dll) -or -not (Test-Path $inj)) {
  throw "missing bin\payload.dll or bin\wbinj.exe. Build them first (README: Build the injector), or use a release archive."
}

# ----- 3. locate QQ -----
function Find-QQ {
  $c = @()
  foreach ($k in @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
                   'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                   'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    try { $c += (Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'QQ(?!浏览器)' } | ForEach-Object { $_.InstallLocation }) } catch {}
  }
  foreach ($p in @("$env:ProgramFiles\Tencent\QQNT\QQ.exe", "${env:ProgramFiles(x86)}\Tencent\QQNT\QQ.exe",
                   "D:\QQ\QQ.exe", "C:\QQ\QQ.exe", "$env:LOCALAPPDATA\Programs\QQ\QQ.exe")) { $c += $p }
  foreach ($d in ($c | Where-Object { $_ })) {
    $e = if ($d -like '*QQ.exe') { $d } else { Join-Path $d 'QQ.exe' }
    if (Test-Path $e) { return (Resolve-Path $e).Path }
  }
  return ''
}
if (-not $QQ) { $QQ = Find-QQ }
if (-not $QQ -or -not (Test-Path $QQ)) { throw "QQ.exe not found; pass -QQ `"D:\QQ\QQ.exe`"" }
$QQ = (Resolve-Path $QQ).Path
$QQDir = Split-Path $QQ -Parent
Write-Host "QQ     : $QQ"

# ----- 4. account number / data dir -----
function Find-Uin($qqDir) {
  $roots = @((Join-Path $qqDir 'Tencent Files'), (Join-Path $env:USERPROFILE 'Documents\Tencent Files'))
  $best = ''; $bestT = [datetime]'1990-01-01'
  foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    Get-ChildItem $r -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^\d{5,12}$' -and (Test-Path (Join-Path $_.FullName 'nt_qq')) } |
      ForEach-Object { if ($_.LastWriteTime -gt $bestT) { $bestT = $_.LastWriteTime; $best = $_.Name } }
  }
  return $best
}
if (-not $SelfUin) { $SelfUin = Find-Uin $QQDir }
if ($SelfUin) { Write-Host "account: $SelfUin" } else { Write-Host "account: (auto-detect failed; set self_uin in config.json later)" -ForegroundColor Yellow }
if (-not $DataDir) {
  foreach ($r in @((Join-Path $QQDir "Tencent Files\$SelfUin"), (Join-Path $env:USERPROFILE "Documents\Tencent Files\$SelfUin"))) {
    if ($SelfUin -and (Test-Path $r)) { $DataDir = $r; break }
  }
}
if ($DataDir) { Write-Host "data   : $DataDir" }

# ----- 5. copy -----
$sub = @('js', 'bin', 'logs', 'scripts') + $(if ($SkipBridge) { @() } else { @('bridge') })
New-Item -ItemType Directory -Force -Path (@($InstallDir) + ($sub | ForEach-Object { Join-Path $InstallDir $_ })) | Out-Null

Copy-Item (Join-Path $Repo 'src\engine\engine.cjs')     (Join-Path $InstallDir 'js\engine.cjs')     -Force
Copy-Item (Join-Path $Repo 'src\engine\wb-template.js') (Join-Path $InstallDir 'js\wb-template.js') -Force
Copy-Item $dll (Join-Path $InstallDir 'bin\payload.dll') -Force
Copy-Item $inj (Join-Path $InstallDir 'bin\wbinj.exe')   -Force
foreach ($s in @('start.ps1', 'supervise.ps1', 'uninstall.ps1', 'patch-config.mjs')) {
  $src = Join-Path $Repo "scripts\$s"
  if (Test-Path $src) { Copy-Item $src (Join-Path $InstallDir "scripts\$s") -Force }
}

# qq-bridge is a separate MIT project (github.com/Derpyu520/qq-bridge); we only
# copy it in if the user points us at a checkout.
if (-not $SkipBridge) {
  $bsrc = if ($BridgeSource) { $BridgeSource } else { Join-Path $Repo 'bridge' }
  if (Test-Path (Join-Path $bsrc 'src\bridge.js')) {
    robocopy $bsrc (Join-Path $InstallDir 'bridge') /E /NFL /NDL /NJH /NJS /NP /XD state logs node_modules | Out-Null
    if (Test-Path (Join-Path $bsrc 'node_modules')) {
      Copy-Item (Join-Path $bsrc 'node_modules') (Join-Path $InstallDir 'bridge\node_modules') -Recurse -Force
    }
    Write-Host "bridge : copied from $bsrc"
  } else {
    Write-Host "bridge : not found (skipped). Engine alone still gives you OneBot on :$Port" -ForegroundColor Yellow
    $SkipBridge = $true
  }
}

# ----- 6. engine config -----
$tok = -join (1..32 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
[System.IO.File]::WriteAllText((Join-Path $InstallDir 'js\ws_token.txt'), $tok, $enc)

$engineCfg = [ordered]@{
  port     = $Port
  qq_exe   = $QQ
  qq_cwd   = $QQDir
  self_uin = if ($SelfUin) { [int64]$SelfUin } else { 0 }
  data_dir = if ($DataDir) { $DataDir } else { '' }
  ws_token = ''
}
[System.IO.File]::WriteAllText((Join-Path $InstallDir 'config.json'), ($engineCfg | ConvertTo-Json), $enc)

# ----- 7. C:\wb.js bootstrap (payload.c hardcodes this path) -----
$tpl  = [System.IO.File]::ReadAllText((Join-Path $InstallDir 'js\wb-template.js'))
$code = $tpl.Replace('__PKG__', $InstallDir.Replace('\', '/'))
if ($NoBootStub) {
  Write-Host 'skipped C:\wb.js (-NoBootStub)' -ForegroundColor Yellow
} else {
  # Writing to C:\ needs admin. Fail early with a readable message instead of
  # a raw "Access to the path 'C:\wb.js' is denied." mid-way through the install.
  $canWrite = $false
  try {
    if (Test-Path 'C:\wb.js') {
      $fs = [System.IO.File]::Open('C:\wb.js', 'Open', 'Write', 'None'); $fs.Close(); $canWrite = $true
    } else {
      $probe = 'C:\~wb-writetest.tmp'
      [System.IO.File]::WriteAllText($probe, 'x'); Remove-Item $probe -Force; $canWrite = $true
    }
  } catch { $canWrite = $false }
  if (-not $canWrite) {
    Write-Host ''
    Write-Host 'This install needs administrator rights (it writes C:\wb.js).' -ForegroundColor Red
    Write-Host 'Right-click install.cmd -> Run as administrator, then try again.' -ForegroundColor Yellow
    Write-Host 'Or re-run with -NoBootStub to install everything except that file.' -ForegroundColor Yellow
    throw 'administrator rights required to write C:\wb.js'
  }
  [System.IO.File]::WriteAllText('C:\wb.js', $code, $enc)
}
[System.IO.File]::WriteAllText((Join-Path $InstallDir 'js\reload.flag'), '0', $enc)

# ----- 8. bridge config -----
if (-not $SkipBridge) {
  $bcfg = Join-Path $InstallDir 'bridge\config.json'
  $node = Join-Path $InstallDir 'runtime\node.exe'
  if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }

  if (Test-Path $bcfg) {
    $bt = [System.IO.File]::ReadAllText($bcfg)
    $bt = [regex]::Replace($bt, '"accessToken"\s*:\s*"[^"]*"', '"accessToken": "' + $tok + '"')
    $bt = [regex]::Replace($bt, '"homeDir"\s*:\s*"[^"]*"', '"homeDir": ""')
    [System.IO.File]::WriteAllText($bcfg, $bt, $enc)

    $dshPort = ''
    $probe = Join-Path $InstallDir 'bridge\scripts\probe-dsh-port.mjs'
    if ($node -and (Test-Path $probe)) {
      try { $out = & $node $probe 2>$null; if ($LASTEXITCODE -eq 0 -and $out) { $dshPort = ([string]$out).Trim() } } catch {}
    }
    if ($node -and (Test-Path (Join-Path $InstallDir 'scripts\patch-config.mjs'))) {
      & $node (Join-Path $InstallDir 'scripts\patch-config.mjs') $bcfg $Port $dshPort | Write-Host
    }
    if ($dshPort) { Write-Host "DSH    : 127.0.0.1:$dshPort" -ForegroundColor Green }

    # persona card: state\current-role.json is not shipped (state is per-machine)
    $roleName = ''
    try { $roleName = [string](Get-Content $bcfg -Raw -Encoding UTF8 | ConvertFrom-Json).roleCard } catch {}
    if ($roleName) {
      New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'bridge\state') | Out-Null
      $roleJson = "{\n  `"role`": `"$roleName`",\n  `"mode`": `"active`"\n}\n"
      [System.IO.File]::WriteAllText((Join-Path $InstallDir 'bridge\state\current-role.json'), $roleJson, $enc)
      Write-Host "persona: $roleName"
    }
  }
}

# ----- 9. watchdog -----
if (-not $NoTask -and -not $SkipBridge) {
  $sup = Join-Path $InstallDir 'scripts\supervise.ps1'
  if (Test-Path $sup) {
    $cmd = "& '$sup' -Root '$InstallDir'"
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd))
    $action = New-ScheduledTaskAction -Execute 'powershell' -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + $b64)
    $t1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
    $t2 = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName 'WhaleBridge-supervise' -Action $action -Trigger $t1,$t2 -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "watchdog: WhaleBridge-supervise (every 2 min)" -ForegroundColor Green
  }
}

$startCmd = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\scripts\start.ps1`" -Root `"$InstallDir`"`r`npause`r`n"
[System.IO.File]::WriteAllText((Join-Path $InstallDir 'start.cmd'), $startCmd, (New-Object System.Text.ASCIIEncoding))
$unCmd = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\scripts\uninstall.ps1`" -Root `"$InstallDir`"`r`npause`r`n"
[System.IO.File]::WriteAllText((Join-Path $InstallDir 'uninstall.cmd'), $unCmd, (New-Object System.Text.ASCIIEncoding))

Write-Host ""
Write-Host "done. next: start.cmd" -ForegroundColor Cyan
Write-Host "  engine  : http://127.0.0.1:$Port/health"
if (-not $SkipBridge) { Write-Host "  console : http://127.0.0.1:3100/" }
