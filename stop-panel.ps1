# "Stop Kindle Panel" shortcut: end the scheduled task AND the node loop it started
# (ending the task alone leaves node running).
schtasks /end /tn "Kindle Agents Panel" | Out-Null
$pidFile = Join-Path $PSScriptRoot "panel.pid"   # written by run.js when the loop starts
if (Test-Path $pidFile) {
  $p = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq "node") { Stop-Process -Id $p.Id -Force }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}
