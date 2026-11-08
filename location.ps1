# Prints "lat,lon" from Windows location (Wi-Fi positioning, so a VPN doesn't move it), or nothing if it's off or
# can't tell within 10 s. extras.js asks this every 30 minutes so the weather follows the PC around.
Add-Type -AssemblyName System.Device
$w = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::Default)
if (-not $w.TryStart($false, [TimeSpan]::FromSeconds(10))) { return }
for ($i = 0; $i -lt 20 -and $w.Position.Location.IsUnknown; $i++) { Start-Sleep -Milliseconds 500 }
$l = $w.Position.Location
$w.Stop()
if (-not $l.IsUnknown) { "{0},{1}" -f $l.Latitude.ToString([cultureinfo]::InvariantCulture), $l.Longitude.ToString([cultureinfo]::InvariantCulture) }
