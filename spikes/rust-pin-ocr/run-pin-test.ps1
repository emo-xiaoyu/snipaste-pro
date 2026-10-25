$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$exe = "$root\target\debug\pin-spike.exe"
$native = "$root\target\debug\native-spike.exe"
$out = "$root\out"
New-Item -ItemType Directory -Force $out | Out-Null

Add-Type -AssemblyName System.Windows.Forms
# keep the cursor out of the compared rect
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(8, 1400)

$proc = Start-Process -FilePath $exe -PassThru `
    -RedirectStandardOutput "$out\pin-spike.log" -RedirectStandardError "$out\pin-spike.err.log"
Start-Sleep -Seconds 7
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(8, 1400)
& $native capture "$out\shot.bmp"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
Write-Host '--- pin-spike stdout ---'
Get-Content "$out\pin-spike.log"
Write-Host '--- pin-spike stderr ---'
Get-Content "$out\pin-spike.err.log"
Write-Host '--- compare (inset 6 to skip DWM border/corners) ---'
& $native compare "$root\assets\pattern.png" "$out\shot.bmp" 300 200 6
exit $LASTEXITCODE
