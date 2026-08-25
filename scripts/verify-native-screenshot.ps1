$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PastyNativeProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError = true)] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  public static object Bounds(IntPtr handle, bool client) {
    RECT rect;
    if (client) {
      if (!GetClientRect(handle, out rect)) return null;
      var point = new POINT { X = 0, Y = 0 };
      if (!ClientToScreen(handle, ref point)) return null;
      return new { x = point.X, y = point.Y, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top };
    }
    if (!GetWindowRect(handle, out rect)) return null;
    return new { x = rect.Left, y = rect.Top, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top };
  }

  public static object[] Find(string exactTitle) {
    var found = new List<object>();
    EnumWindows((handle, state) => {
      if (!IsWindowVisible(handle)) return true;
      var title = new StringBuilder(256);
      GetWindowText(handle, title, title.Capacity);
      if (!String.Equals(title.ToString(), exactTitle, StringComparison.Ordinal)) return true;
      uint processId;
      GetWindowThreadProcessId(handle, out processId);
      found.Add(new { handle = handle.ToInt64(), processId = processId, bounds = Bounds(handle, false), clientBounds = Bounds(handle, true) });
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }

  public static void SendAltX() {
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(20);
    keybd_event(0x58, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(20);
    keybd_event(0x58, 0, 2, UIntPtr.Zero);
    System.Threading.Thread.Sleep(20);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
  }

  public static void SendF4() {
    keybd_event(0x73, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(20);
    keybd_event(0x73, 0, 2, UIntPtr.Zero);
  }

  public static void WheelAt(long handle, int delta) {
    RECT rect;
    if (!GetWindowRect(new IntPtr(handle), out rect)) return;
    SetCursorPos((rect.Left + rect.Right) / 2, (rect.Top + rect.Bottom) / 2);
    mouse_event(0x0800, 0, 0, delta, UIntPtr.Zero);
  }

  public static void Close(long handle) {
    PostMessage(new IntPtr(handle), 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
}
'@

$storePath = Join-Path $env:APPDATA 'pasty-clipboard\clipboard-store.json'
$beforeStore = Get-Content -Raw $storePath | ConvertFrom-Json
$beforeCount = @($beforeStore.entries | Where-Object { $_.origin -eq 'screenshot' }).Count
$beforeEntryIds = @($beforeStore.entries | ForEach-Object { $_.id })
$beforePinHandles = @([PastyNativeProbe]::Find('Pasty 贴图') | ForEach-Object { $_.handle })

$captureWatch = [Diagnostics.Stopwatch]::StartNew()
[PastyNativeProbe]::SendAltX()
$editors = @()
do {
  Start-Sleep -Milliseconds 25
  $editors = @([PastyNativeProbe]::Find('Pasty 截图'))
} while ($editors.Count -ne 1 -and $captureWatch.ElapsedMilliseconds -lt 2500)
$captureWatch.Stop()
if ($editors.Count -ne 1) { throw "Expected one visible Pasty screenshot editor, found $($editors.Count)" }

$pinWatch = [Diagnostics.Stopwatch]::StartNew()
[PastyNativeProbe]::SendF4()
$newPins = @()
do {
  Start-Sleep -Milliseconds 25
  $newPins = @([PastyNativeProbe]::Find('Pasty 贴图') | Where-Object { $_.handle -notin $beforePinHandles })
} while ($newPins.Count -ne 1 -and $pinWatch.ElapsedMilliseconds -lt 3000)
$pinWatch.Stop()
$persistWatch = [Diagnostics.Stopwatch]::StartNew()
do {
  Start-Sleep -Milliseconds 25
  $afterStore = Get-Content -Raw $storePath | ConvertFrom-Json
  $afterCount = @($afterStore.entries | Where-Object { $_.origin -eq 'screenshot' }).Count
} while ($afterCount -le $beforeCount -and $persistWatch.ElapsedMilliseconds -lt 3000)
$persistWatch.Stop()
$newEntryIds = @($afterStore.entries | Where-Object { $_.id -notin $beforeEntryIds } | ForEach-Object { $_.id })

if ($afterCount -le $beforeCount) { throw 'F4 did not add a screenshot history entry' }
if ($newPins.Count -ne 1) { throw "Expected one new Pasty pin window, found $($newPins.Count)" }

$beforeZoom = $newPins[0].clientBounds
[PastyNativeProbe]::WheelAt([long]$newPins[0].handle, 120)
Start-Sleep -Milliseconds 500
$zoomedPin = @([PastyNativeProbe]::Find('Pasty 贴图') | Where-Object { $_.handle -eq $newPins[0].handle })[0]
if (-not $zoomedPin) { throw 'Pin disappeared during wheel zoom verification' }
if ($zoomedPin.clientBounds.width -le $beforeZoom.width -or $zoomedPin.clientBounds.height -le $beforeZoom.height) {
  [PastyNativeProbe]::Close([long]$newPins[0].handle)
  throw "Mouse wheel did not enlarge the pin: $($beforeZoom.width)x$($beforeZoom.height) -> $($zoomedPin.clientBounds.width)x$($zoomedPin.clientBounds.height)"
}

$result = [pscustomobject]@{
  captureShortcut = $beforeStore.screenshotShortcuts.capture
  captureVisibleMs = $captureWatch.ElapsedMilliseconds
  f4PinVisibleMs = $pinWatch.ElapsedMilliseconds
  historyPersistAfterPinMs = $persistWatch.ElapsedMilliseconds
  editorVisible = $true
  screenshotEntriesAdded = $afterCount - $beforeCount
  screenshotEntryIds = $newEntryIds
  pinWindowBounds = $newPins[0].bounds
  pinContentBounds = $newPins[0].clientBounds
  wheelZoomedContentBounds = $zoomedPin.clientBounds
}
$result | ConvertTo-Json -Depth 5

[PastyNativeProbe]::Close([long]$newPins[0].handle)
