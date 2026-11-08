# "Stop Kindle Panel" shortcut: stops this account's panel (the start-panel.ps1 restart loop and the node loop it
# started). Other accounts' panels keep running.
$session = (Get-Process -Id $PID).SessionId
# the restart loop first, so it can't start node again
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
  Where-Object { $_.SessionId -eq $session -and $_.ProcessId -ne $PID -and $_.CommandLine -like "*start-panel.ps1*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$pidFile = Join-Path $PSScriptRoot "panel-$env:USERNAME.pid"   # written by run.js when the loop starts
if (Test-Path $pidFile) {
  $p = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq "node" -and $p.SessionId -eq $session) { Stop-Process -Id $p.Id -Force }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}
