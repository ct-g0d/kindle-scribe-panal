# Started by the "Kindle Agents Panel" scheduled task at login (every account; see install-task.ps1).
# Keeps the panel loop alive: if node exits for any reason, wait 30s and start it again.
# Output goes to panel-<username>.log next to this script (trimmed when it passes 2 MB).
Set-Location $PSScriptRoot
$log = Join-Path $PSScriptRoot "panel-$env:USERNAME.log"
$node = (Get-Command node -ErrorAction Stop).Source

while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 2MB) {
    Get-Content $log -Tail 500 | Set-Content "$log.tmp" -Encoding utf8
    Move-Item "$log.tmp" $log -Force
  }
  "$(Get-Date -Format s)  starting panel" | Add-Content $log -Encoding ascii
  # via cmd so the log stays plain UTF-8 (PowerShell 5 redirection writes UTF-16)
  cmd /c "`"$node`" run.js >> `"$log`" 2>&1"
  "$(Get-Date -Format s)  panel exited ($LASTEXITCODE), restarting in 30s" | Add-Content $log -Encoding ascii
  Start-Sleep -Seconds 30
}
