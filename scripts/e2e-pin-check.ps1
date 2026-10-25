# E2E: quick-pin fidelity (Phase 6 regression gate).
# Launches the release Tauri build, triggers Alt+Shift+P at a known cursor
# position, then verifies:
#   1. the pin window lands exactly at the preselection region (physical px)
#   2. the pin's on-screen pixels match the stored PNG (interior, tolerance)
# Usage: powershell -File scripts/e2e-pin-check.ps1 [-Exe <path>]
param(
  [string]$Exe = (Join-Path $PSScriptRoot '..\src-tauri\target\release\pasty.exe')
)
$ErrorActionPreference = 'Stop'
# The check must be per-monitor DPI aware: cursor placement, window rects, and
# screen capture otherwise operate in virtualized coordinates.
Add-Type @'
using System; using System.Runtime.InteropServices;
public class DpiAware { [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value); }
'@
[DpiAware]::SetThreadDpiAwarenessContext([IntPtr]-4) | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class E2EWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  public struct R { public int L, T, Rt, B; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  public static void Cursor(int x, int y) { SetCursorPos(x, y); }
  public static string FindVisible(uint target, string title) {
    string result = "";
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == target && IsWindowVisible(h)) {
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        if (t.ToString() == title) { R r; GetWindowRect(h, out r); result = r.L + "," + r.T + "," + (r.Rt - r.L) + "," + (r.B - r.T); }
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$appData = Join-Path $env:TEMP ("pasty-e2e-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $appData | Out-Null
$env:APPDATA = $appData

Get-Process pasty -ErrorAction SilentlyContinue | Stop-Process -Force
[E2EWin]::Cursor(1300, 700)
Start-Sleep -Milliseconds 300

$proc = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds 5
if ($proc.HasExited) { throw "pasty exited during startup" }

# Alt+Shift+P quick capture-and-pin
[System.Windows.Forms.SendKeys]::SendWait('%+p')
Start-Sleep -Seconds 3
# Park the cursor outside the pin so the pointer graphic and the hover close
# button never end up inside the sampled pixels.
[E2EWin]::Cursor(50, 1400)
Start-Sleep -Milliseconds 400

$rectText = [E2EWin]::FindVisible($proc.Id, 'Pasty 贴图')
if (-not $rectText) { Stop-Process -Id $proc.Id -Force; throw "no visible pin window found" }
$parts = $rectText.Split(',') | ForEach-Object { [int]$_ }
$pin = @{ X = $parts[0]; Y = $parts[1]; W = $parts[2]; H = $parts[3] }
Write-Host ("pin rect: ({0},{1}) {2}x{3}" -f $pin.X, $pin.Y, $pin.W, $pin.H)

# Expected preselection: 520x320 logical centered on the cursor, converted
# with the live DPI (125% on this machine -> 650x400 physical).
$dpiScale = [System.Drawing.Graphics]::FromHwnd(0).DpiX / 96.0
$expected = @{
  X = [int](1300 - (520 * $dpiScale) / 2); Y = [int](700 - (320 * $dpiScale) / 2)
  W = [int](520 * $dpiScale); H = [int](320 * $dpiScale)
}
Write-Host ("dpi scale: {0}" -f $dpiScale)
$rectOk = [Math]::Abs($pin.X - $expected.X) -le 2 -and [Math]::Abs($pin.Y - $expected.Y) -le 2 -and
  [Math]::Abs($pin.W - $expected.W) -le 2 -and [Math]::Abs($pin.H - $expected.H) -le 2
Write-Host ("rect check: {0}" -f ($(if ($rectOk) { 'PASS' } else { 'FAIL' })))

# Pixel comparison: screen at the pin rect vs the stored PNG.
$imagesDir = Join-Path $appData 'Pasty\images'
$png = Get-ChildItem $imagesDir -Filter *.png | Select-Object -First 1
if (-not $png) { Stop-Process -Id $proc.Id -Force; throw "no stored capture PNG found" }
$stored = [System.Drawing.Image]::FromFile($png.FullName)
$inset = 18
$screenW = $pin.W - $inset * 2
$screenH = $pin.H - $inset * 2
$bmp = New-Object System.Drawing.Bitmap($screenW, $screenH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($pin.X + $inset, $pin.Y + $inset, 0, 0, (New-Object System.Drawing.Size($screenW, $screenH)))
$g.Dispose()

$mismatch = 0; $total = 0; $tol = 12
for ($y = 0; $y -lt $screenH; $y += 2) {
  for ($x = 0; $x -lt $screenW; $x += 2) {
    $a = $bmp.GetPixel($x, $y)
    $sx = [int](($x + $inset) * $stored.Width / $pin.W)
    $sy = [int](($y + $inset) * $stored.Height / $pin.H)
    $b = $stored.GetPixel([Math]::Min($sx, $stored.Width - 1), [Math]::Min($sy, $stored.Height - 1))
    $total++
    if ([Math]::Abs($a.R - $b.R) -gt $tol -or [Math]::Abs($a.G - $b.G) -gt $tol -or [Math]::Abs($a.B - $b.B) -gt $tol) { $mismatch++ }
  }
}
$bmp.Dispose(); $stored.Dispose()
$ratio = 100.0 * $mismatch / [Math]::Max($total, 1)
$pixelsOk = $ratio -le 1.0
Write-Host ("pixel check: {0} ({1:N3}% mismatch of {2} sampled)" -f ($(if ($pixelsOk) { 'PASS' } else { 'FAIL' })), $ratio, $total)

Stop-Process -Id $proc.Id -Force
Remove-Item -Recurse -Force $appData -ErrorAction SilentlyContinue
if (-not ($rectOk -and $pixelsOk)) { exit 3 }
Write-Host 'E2E PIN CHECK: PASS'
