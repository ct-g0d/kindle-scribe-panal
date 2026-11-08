# Registers the "Kindle Agents Panel" scheduled task for every account: whoever signs in gets their own copy of
# start-panel.ps1, in their own session, with no window (headless conhost, so Windows Terminal never takes it over
# and nobody can close it by accident). Only the session on screen pushes to the Kindle (session-active.ps1).
# Run it from your normal account; it asks for admin (UAC) to register the task, then starts your copy.
param([switch]$Register)  # internal: the elevated half
$ErrorActionPreference = "Stop"
$name = "Kindle Agents Panel"
$start = Join-Path $PSScriptRoot "start-panel.ps1"

if ($Register) {
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
    -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$start`"" -WorkingDirectory $PSScriptRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn   # no -User: any account signing in
  $principal = New-ScheduledTaskPrincipal -GroupId "S-1-5-32-545" -RunLevel Limited   # BUILTIN\Users, as themselves
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances Parallel -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  return
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) {
  & $PSCommandPath -Register
} else {
  $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Register"
  if ($p.ExitCode -ne 0) { throw "registering the task failed (exit $($p.ExitCode))" }
}
Write-Host "Registered '$name' for all accounts."

# Start this account's copy now (otherwise it starts at the next sign-in). From an elevated shell it would run
# elevated, which stop-panel.ps1 can't stop, so leave that to the next sign-in.
$session = (Get-Process -Id $PID).SessionId
$running = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
  Where-Object { $_.SessionId -eq $session -and $_.CommandLine -like "*start-panel.ps1*" }
if ($running) { Write-Host "Your panel is already running." }
elseif ($admin) { Write-Host "Sign out and back in (or run this from a non-admin shell) to start your panel." }
else {
  Start-Process "$env:SystemRoot\System32\conhost.exe" -WorkingDirectory $PSScriptRoot `
    -ArgumentList "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$start`""
  Write-Host "Started your panel; log: $(Join-Path $PSScriptRoot "panel-$env:USERNAME.log")"
}
