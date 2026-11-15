<#
  start.ps1 - bring the engine up.

  Idempotent: if the engine is already answering on its port, nothing is touched -
  QQ keeps running, the session keeps working. QQ is only restarted when the engine
  is not there, because injection has to land before QQ's module loader compiles
  the builtin sources.
#>
param(
  [string]$Root = "",
  [switch]$NoKill,
  [switch]$Force,
  [int]$WaitSeconds = 90
)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path $PSScriptRoot -Parent }
$cfgPath = Join-Path $Root 'config.json'
if (-not (Test-Path $cfgPath)) { throw "not installed: missing $cfgPath, run install first" }
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json

$exe = $cfg.qq_exe; $cwd = $cfg.qq_cwd
$port = if ($cfg.port) { [int]$cfg.port } else { 3902 }
$dll = Join-Path $Root 'bin\payload.dll'
$inj = Join-Path $Root 'bin\wbinj.exe'
$node = Join-Path $Root 'runtime\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }

function Test-Engine {
  param([int]$P)
  try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$P/health" -TimeoutSec 2; return [bool]$r.ok } catch { return $false }
}

function Start-Bridge {
  $bridgeDir = Join-Path $Root 'bridge'
  if (-not (Test-Path (Join-Path $bridgeDir 'src\bridge.js'))) { Write-Host "bridge not installed, skipping"; return }
  $br = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bridge\.js' })
  if ($br.Count -eq 0) {
    Start-Process -FilePath $node -ArgumentList 'src/bridge.js' -WorkingDirectory $bridgeDir -WindowStyle Hidden
    Write-Host "bridge started"
  } else {
    Write-Host "bridge already running (pid $($br[0].ProcessId))"
  }
}

# ----- 1. engine already up: touch nothing -----
if (-not $Force -and (Test-Engine -P $port)) {
  Write-Host "engine already running on 127.0.0.1:$port, leaving QQ alone" -ForegroundColor Green
  Start-Bridge
  Write-Host ""
  Write-Host "ready: engine http://127.0.0.1:$port | console http://127.0.0.1:3100/" -ForegroundColor Green
  return
}

# ----- 2. need a (re)inject -----
if (-not (Test-Path $exe)) { throw "QQ.exe not found: $exe" }
foreach ($f in @($dll,$inj,$node,'C:\wb.js')) { if (-not (Test-Path $f)) { throw "missing $f (run install first)" } }

$running = Get-Process QQ -ErrorAction SilentlyContinue
if ($running) {
  if ($NoKill) {
    throw "QQ is running (pid $($running.Id -join ',')) but the engine is not up. Recovering the engine needs one QQ restart - drop -NoKill, or close QQ yourself and run again."
  }
  Write-Host "engine is not up, restarting QQ once (pid $($running.Id -join ','))..."
  $running | Stop-Process -Force
  Start-Sleep -Seconds 4
}

$src = @"
using System;
using System.Runtime.InteropServices;
public class WBLaunch {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct SI {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PI { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  public static PI Start(string app, string cwd) {
    SI si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); PI pi;
    if (!CreateProcessW(app, null, IntPtr.Zero, IntPtr.Zero, false, 0x4, IntPtr.Zero, cwd, ref si, out pi))
      throw new Exception("CreateProcessW failed " + Marshal.GetLastWin32Error());
    return pi;
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
$pi = [WBLaunch]::Start($exe, $cwd)
Write-Host "QQ started pid=$($pi.dwProcessId) (suspended)"
Start-Sleep -Milliseconds 700
& $inj $pi.dwProcessId $dll | Out-Null
$rc = $LASTEXITCODE
Write-Host "inject rc=$rc"
[void][WBLaunch]::ResumeThread($pi.hThread)
[void][WBLaunch]::CloseHandle($pi.hThread); [void][WBLaunch]::CloseHandle($pi.hProcess)
if ($rc -ne 0) { throw "injection failed (rc=$rc); QQ is running without an engine, run start again" }

Write-Host "waiting for engine 127.0.0.1:$port ..."
$ok = $false
for ($i = 0; $i -lt $WaitSeconds; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Engine -P $port) { $ok = $true; break }
}
if (-not $ok) { Write-Host "WARN engine did not answer in $WaitSeconds s; check $Root\js\boot.log and engine.log" -ForegroundColor Yellow; return }

Start-Bridge
Start-Sleep -Seconds 4
Write-Host ""
Write-Host "ready: engine http://127.0.0.1:$port | console http://127.0.0.1:3100/" -ForegroundColor Green
