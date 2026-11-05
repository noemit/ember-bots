# Daily Hearth age-out job. Installed as the "Hearth Prune" scheduled task by
# scripts/install-prune-task.ps1; safe to run by hand too.
#
# What it does, in order:
#   1. stops Hearth (a turn mid-write must not race row moves);
#   2. runs hearth-prune.py --apply (drops image payloads > 7 days, archives
#      conversations idle > 7 days, VACUUMs, trims backups);
#   3. starts Hearth again, and reports whether it came back.
#
# It always restarts Hearth, even if the prune failed: leaving the service down
# because a maintenance step errored is worse than a stale database.
#
# Everything it prints goes to <Home>\hearth-prune.log, so a silent 3am failure
# is still diagnosable the next morning.
param(
  [string]$HearthHome = "$env:USERPROFILE\.hearth",
  [int]$Port = 3011,
  [string]$TaskName = "Hearth",
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [int]$ImageDays = 7,
  [int]$ArchiveDays = 7,
  [int]$KeepBackups = 5,
  [switch]$DryRun
)

$ErrorActionPreference = "Continue"
$log = Join-Path $HearthHome "hearth-prune.log"

function Write-PruneLog([string]$Message) {
  $line = "{0} {1}" -f (Get-Date).ToString("s"), $Message
  Write-Output $line
  try { Add-Content -Path $log -Value $line } catch { }
}

Write-PruneLog ("prune started (image_days={0} archive_days={1} dry={2})" -f $ImageDays, $ArchiveDays, [bool]$DryRun)

# 1. stop Hearth -------------------------------------------------------------
try {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Write-PruneLog "hearth task '$TaskName' stopped"
} catch {
  Write-PruneLog "could not stop task '$TaskName': $($_.Exception.Message)"
}
# The task stopping does not guarantee the bun child exited; give it a moment and
# check the port is actually free before touching the DB. Get-NetTCPConnection
# throws rather than returning empty when nothing matches, so guard on the result
# instead of relying on -ErrorAction alone.
$stillListening = $null
for ($i = 0; $i -lt 20; $i++) {
  try {
    $stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
  } catch {
    $stillListening = $null
  }
  if (-not $stillListening) { break }
  Start-Sleep -Seconds 1
}
if ($stillListening) {
  Write-PruneLog "WARNING: port $Port still listening after 20s; prune may race an active writer"
}

# 2. run the prune -----------------------------------------------------------
$python = (Get-Command python3 -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command python -ErrorAction SilentlyContinue).Source }
if (-not $python) {
  Write-PruneLog "ERROR: no python on PATH; cannot prune"
} else {
  $script = Join-Path $Repo "scripts\hearth-prune.py"
  if (-not (Test-Path $script)) {
    Write-PruneLog "ERROR: missing $script"
  } else {
    $argv = @($script, "--home", $HearthHome, "--image-days", $ImageDays,
              "--archive-days", $ArchiveDays, "--keep-backups", $KeepBackups)
    if (-not $DryRun) { $argv += "--apply" }
    try {
      $out = & $python @argv 2>&1
      foreach ($line in $out) { Write-PruneLog ("  " + $line) }
      Write-PruneLog ("prune exit code: {0}" -f $LASTEXITCODE)
    } catch {
      Write-PruneLog "ERROR running prune: $($_.Exception.Message)"
    }
  }
}

# 3. always bring Hearth back -----------------------------------------------
if (-not $DryRun) {
  try {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-PruneLog "hearth task '$TaskName' started"
  } catch {
    Write-PruneLog "ERROR restarting task '$TaskName': $($_.Exception.Message)"
  }
} else {
  Write-PruneLog "dry run: restarting hearth anyway (it was stopped for the run)"
  try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch {
    Write-PruneLog "could not start task '$TaskName': $($_.Exception.Message)"
  }
}

# Confirm it is actually answering, so a failed restart is not silent.
$tokenFile = Join-Path $HearthHome "hearth.token"
$token = ""
if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" `
      -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 3 | Out-Null
    $healthy = $true; break
  } catch { Start-Sleep -Seconds 2 }
}
Write-PruneLog ("prune finished; hearth healthy on :{0} = {1}" -f $Port, $healthy)
if (-not $healthy) { exit 1 }
