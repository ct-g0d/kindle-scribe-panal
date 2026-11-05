# Prints what Windows is playing right now (any app that shows in the volume flyout) as one JSON line.
# Output: {"title":..,"artist":..,"app":..,"status":"Playing|Paused|..."} or {} when nothing is open.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

# prefer a session that is actually playing, else the one Windows considers current
$sessions = @($mgr.GetSessions())
$s = $sessions | Where-Object { "$($_.GetPlaybackInfo().PlaybackStatus)" -eq 'Playing' } | Select-Object -First 1
if (-not $s) { $s = $mgr.GetCurrentSession() }
if (-not $s) { '{}'; exit }

$p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
[pscustomobject]@{
  title  = $p.Title
  artist = $p.Artist
  app    = $s.SourceAppUserModelId
  status = "$($s.GetPlaybackInfo().PlaybackStatus)"
} | ConvertTo-Json -Compress
