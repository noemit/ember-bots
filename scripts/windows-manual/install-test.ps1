$ErrorActionPreference = 'Stop'
$install = Join-Path $env:RUNNER_TEMP ('ember-manual-install-' + [guid]::NewGuid().ToString('N'))
$receipt = Join-Path $env:RUNNER_TEMP 'ember-installed-profile-receipt.json'
$report = Join-Path $env:PRODUCT_ROOT 'release/installed-validation.txt'
$setup = @(Get-ChildItem (Join-Path $env:PRODUCT_ROOT 'release/*-windows-x64-setup.exe'))
if ($setup.Count -ne 1) { throw 'Expected exactly one NSIS installer' }
function Wait-BoundedProcess($process, $label) {
  if (-not $process.WaitForExit(90000)) { $process.Kill(); throw "$label exceeded 90 seconds" }
  if ($process.ExitCode -ne 0) { throw "$label exited with $($process.ExitCode)" }
}
function Owned-InstallProcesses {
  @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($install + '\', [StringComparison]::OrdinalIgnoreCase) })
}
$profile = $null
try {
  if ((Get-AuthenticodeSignature $setup[0].FullName).Status -ne 'NotSigned') { throw 'Expected the explicitly authorized unsigned installer' }
  Wait-BoundedProcess (Start-Process -FilePath $setup[0].FullName -ArgumentList ('/S /D=' + $install) -PassThru) 'NSIS installation'
  $exe = Join-Path $install 'Ember.exe'
  $uninstall = Join-Path $install 'Uninstall Ember.exe'
  if (!(Test-Path $exe) -or !(Test-Path $uninstall)) { throw 'NSIS installation did not produce the expected app and uninstaller' }
  foreach ($relative in @('resources/app.asar', 'resources/kiln.exe', 'Ember.exe')) {
    $original = Join-Path $env:PRODUCT_ROOT ('release/win-unpacked/' + $relative)
    if ((Get-FileHash (Join-Path $install $relative) -Algorithm SHA256).Hash -ne (Get-FileHash $original -Algorithm SHA256).Hash) { throw "Installed bytes differ: $relative" }
  }
  if ((Owned-InstallProcesses).Count -ne 0) { throw 'Silent installation unexpectedly launched an application' }
  $env:EMBER_PACKAGED_EXECUTABLE = $exe
  $env:EMBER_PACKAGED_PROFILE_RECEIPT = $receipt
  Push-Location $env:PRODUCT_ROOT
  try {
    & bunx playwright test --config playwright.packaged.config.ts
    if ($LASTEXITCODE -ne 0) { throw 'Installed native application test failed' }
  } finally { Pop-Location }
  if (!(Test-Path $receipt)) { throw 'Installed test did not leave its isolated profile receipt' }
  $state = Get-Content $receipt -Raw | ConvertFrom-Json
  $profile = $state.profile
  $settings = Join-Path $profile 'settings.json'
  if (!(Test-Path $settings)) { throw 'Installed launch did not retain its settings' }
  if ((Get-Content $settings -Raw | ConvertFrom-Json).theme -ne 'graphite') { throw 'Synthetic setting did not survive installed app reload' }
  $settingsHash = (Get-FileHash $settings -Algorithm SHA256).Hash
  if ($state.pid -and (Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) { throw 'Owned Kiln is still running after installed app quit' }
  if ((Owned-InstallProcesses).Count -ne 0) { throw 'Installed application processes remained after quit' }
  Wait-BoundedProcess (Start-Process -FilePath $uninstall -ArgumentList '/S' -PassThru) 'NSIS uninstallation'
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ((Test-Path $exe) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Test-Path $exe) { throw 'NSIS uninstallation left Ember.exe installed' }
  if ((Owned-InstallProcesses).Count -ne 0) { throw 'Installed application processes remained after uninstall' }
  if (!(Test-Path $settings) -or (Get-FileHash $settings -Algorithm SHA256).Hash -ne $settingsHash) { throw 'Uninstallation changed or deleted retained synthetic user data' }
  'PASS: native silent NSIS install, actual installed launch, isolated workspace persistence, app quit, owned Kiln stopped, silent uninstall, no installed processes, and unchanged synthetic user settings.' | Set-Content $report
} finally {
  Remove-Item Env:EMBER_PACKAGED_PROFILE_RECEIPT -ErrorAction SilentlyContinue
  # Process cleanup is restricted to executables inside this disposable install directory.
  foreach ($owned in (Owned-InstallProcesses)) { Stop-Process -Id $owned.ProcessId -Force -ErrorAction SilentlyContinue }
  if (Test-Path $receipt) {
    $state = Get-Content $receipt -Raw | ConvertFrom-Json
    if ($state.profile -and $state.profile.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) { Remove-Item $state.profile -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item $install -Recurse -Force -ErrorAction SilentlyContinue
}
