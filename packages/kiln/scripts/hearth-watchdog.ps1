# Keep a Windows-native Hearth reachable and up. Installed as the looping "Hearth Watchdog" task by
# scripts/install-windows.ps1; safe to run by hand too. Every interval it:
#   1. re-asserts the inbound firewall rule for the port - a Windows update or a network-profile
#      change can drop it, which makes Hearth look down to other devices while it is running fine;
#   2. checks Hearth's local health, and restarts the scheduled task if it is not answering.
# The firewall rule needs admin, so run the task at the highest privilege level.
param(
  [string]$Home = "$env:USERPROFILE\.hearth",
  [int]$Port = 3011,
  [string]$TaskName = "Hearth",
  [int]$IntervalSeconds = 60
)

$log = Join-Path $Home "hearth-watchdog.log"
function Write-WatchdogLog([string]$Message) {
  try { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date).ToString("s"), $Message) } catch { }
}
function Test-Hearth {
  $token = ""
  $tokenFile = Join-Path $Home "hearth.token"
  if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" `
      -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5 | Out-Null
    return $true
  } catch { return $false }
}

Write-WatchdogLog "watchdog started (port $Port, task '$TaskName', every ${IntervalSeconds}s)"
while ($true) {
  if (-not (Get-NetFirewallRule -DisplayName "Hearth $Port" -ErrorAction SilentlyContinue)) {
    try {
      New-NetFirewallRule -DisplayName "Hearth $Port" -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port | Out-Null
      Write-WatchdogLog "re-added the 'Hearth $Port' firewall rule"
    } catch {
      Write-WatchdogLog "could not add the firewall rule (needs admin): $($_.Exception.Message)"
    }
  }

  # A restarting host needs a moment before it looks down; check twice before acting.
  $up = Test-Hearth
  if (-not $up) { Start-Sleep -Seconds 5; $up = Test-Hearth }
  if ($up) { Start-Sleep -Seconds $IntervalSeconds; continue }

  Write-WatchdogLog "hearth not answering on :$Port - restarting task '$TaskName'"
  try {
    Start-ScheduledTask -TaskName $TaskName
    Write-WatchdogLog "restart requested for '$TaskName'"
  } catch {
    Write-WatchdogLog "could not start '$TaskName': $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $IntervalSeconds
}
