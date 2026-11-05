# Install Hearth on the Windows host as a logon scheduled task whose runner supervises the Bun
# process, plus a watchdog task that keeps the port's firewall rule and restarts Hearth if it stops
# answering. Run once from PowerShell (as admin, so the firewall rule lands) on the host:
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#
# If Docker Desktop publishes 3000-3010/5432/8080, a Windows-native Hearth uses 3011+
# (8302 is a safe alternative). Use .hearth for HEARTH_HOME if $env:USERPROFILE\.pi already
# holds an older pi-coding-agent tree.
param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$Home = "$env:USERPROFILE\.hearth",
  [int]$Port = 3011,
  [string]$Bun = "",
  [string]$GitBash = "C:\Program Files\Git"
)

$ErrorActionPreference = "Stop"
$TaskName = "Hearth"
$WatchdogName = "Hearth Watchdog"

if (-not $Bun) {
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($cmd) { $Bun = $cmd.Source }
}
if (-not $Bun -or -not (Test-Path $Bun)) {
  throw "bun not found. Install it (npm i -g bun) or pass -Bun <path to bun.exe>."
}
if (-not (Test-Path $Repo)) { throw "repo not found at $Repo" }

New-Item -ItemType Directory -Force -Path $Home | Out-Null

# The runner carries the environment (a scheduled task action cannot set env vars) and supervises:
# when bun exits - a crash, or 0.8's auto-reload after a `git pull` - it restarts after a pause, so
# a crash is a restart, not an outage. Git Bash goes on PATH so Hearth's bash tool resolves it.
$runner = Join-Path $Home "hearth-run.cmd"
@"
@echo off
setlocal
set "HEARTH_HOME=$Home"
set "HEARTH_PORT=$Port"
set "PATH=$GitBash\bin;$GitBash\usr\bin;%PATH%"
cd /d "$Repo"
:loop
"$Bun" run src/index.ts >> "$Home\hearth.log" 2>&1
echo [supervisor] hearth exited (%ERRORLEVEL%); restarting in 5s >> "$Home\hearth.log" 2>&1
timeout /t 5 /nobreak > nul
goto loop
"@ | Set-Content -Encoding ASCII -Path $runner

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$runner`"" -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

# The watchdog loops (re-checking every interval): it keeps the firewall rule the port needs and,
# if Hearth stops answering locally, restarts the task above. The firewall rule needs admin, so its
# principal runs at the highest privilege level.
$watchdog = Join-Path $PSScriptRoot "hearth-watchdog.ps1"
if (-not (Test-Path $watchdog)) { throw "hearth-watchdog.ps1 not found next to this script" }
$waction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument (
  "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`" " +
  "-Home `"$Home`" -Port $Port -TaskName `"$TaskName`""
)
$wtrigger = New-ScheduledTaskTrigger -AtLogOn
$wsettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$wprincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $WatchdogName -Action $waction -Trigger $wtrigger -Settings $wsettings `
  -Principal $wprincipal -Force | Out-Null
Start-ScheduledTask -TaskName $WatchdogName

# Firewall: Docker's published ports are already allowed; a native port is not.
if (-not (Get-NetFirewallRule -DisplayName "Hearth $Port" -ErrorAction SilentlyContinue)) {
  try {
    New-NetFirewallRule -DisplayName "Hearth $Port" -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $Port | Out-Null
    Write-Host "firewall rule added for TCP $Port"
  } catch {
    Write-Warning "could not add the firewall rule (run PowerShell as admin): $_"
  }
}

Start-Sleep -Seconds 3
$token = if (Test-Path "$Home\hearth.token") { (Get-Content "$Home\hearth.token" -Raw).Trim() } else { "" }
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5 | Out-Null
  Write-Host "hearth installed and healthy on http://127.0.0.1:$Port"
} catch {
  Write-Warning "installed, but not answering yet; see $Home\hearth.log"
}
Write-Host "token: $token"
Write-Host "reachable from other devices at http://<tailscale-ip>:$Port (needs the firewall rule)"
