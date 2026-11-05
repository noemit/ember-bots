# Install the daily Hearth age-out job as a Windows scheduled task.
#
# Runs at 03:00 local time, every day. The hour is deliberate: the prune stops
# Hearth for a few seconds and rewrites the database file, which is disruptive
# in the middle of the day and harmless at 3am.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-prune-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-prune-task.ps1 -Hour 4 -DryRun
#   powershell -ExecutionPolicy Bypass -File scripts\install-prune-task.ps1 -Uninstall
#
# Needs no elevation: the task runs as the current user at Limited run level,
# matching the 'Hearth' task it has to stop and start.

param(
  [string]$HearthHome = "$env:USERPROFILE\.hearth",
  [int]$Port = 3011,
  [string]$TaskName = "Hearth",
  [string]$PruneTaskName = "Hearth Prune",
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [int]$Hour = 3,
  [int]$Minute = 0,
  [int]$ImageDays = 7,
  [int]$ArchiveDays = 7,
  [int]$KeepBackups = 5,
  [switch]$DryRun,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $PruneTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $PruneTaskName -Confirm:$false
    Write-Output "removed scheduled task '$PruneTaskName'"
  } else {
    Write-Output "no scheduled task '$PruneTaskName' to remove"
  }
  return
}

$script = Join-Path $Repo "scripts\hearth-prune.ps1"
if (-not (Test-Path $script)) { throw "missing prune script: $script" }

$args = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" " +
        "-HearthHome `"$HearthHome`" -Port $Port -TaskName `"$TaskName`" -Repo `"$Repo`" " +
        "-ImageDays $ImageDays -ArchiveDays $ArchiveDays -KeepBackups $KeepBackups"
if ($DryRun) { $args += " -DryRun" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $args
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours($Hour).AddMinutes($Minute))

# StartWhenAvailable: a laptop asleep at 3am still gets its prune once it wakes,
# rather than skipping the day entirely.
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -MultipleInstances IgnoreNew

# Match the 'Hearth' task's own principal: it runs as the current user at
# RunLevel Limited, and a user-level task can start/stop another user-level task,
# so Highest privilege is not needed (and needs admin to register).
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $PruneTaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $PruneTaskName -Confirm:$false
  Write-Output "replaced existing task '$PruneTaskName'"
}

Register-ScheduledTask -TaskName $PruneTaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description "Daily Hearth age-out: drop image payloads and archive conversations older than $ImageDays days." | Out-Null

Write-Output "installed '$PruneTaskName' - daily at $('{0:D2}:{1:D2}' -f $Hour, $Minute)"
Write-Output "  script : $script"
Write-Output "  home   : $HearthHome"
Write-Output "  policy : images > $ImageDays days, conversations idle > $ArchiveDays days, keep $KeepBackups backups"
if ($DryRun) { Write-Output "  mode   : DRY RUN (reports only)" }
Write-Output ""
Write-Output "run it now : Start-ScheduledTask -TaskName '$PruneTaskName'"
Write-Output "see output : Get-Content '$HearthHome\hearth-prune.log' -Tail 40"
Write-Output "remove it  : powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Uninstall"
