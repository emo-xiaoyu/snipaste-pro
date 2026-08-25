$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class PastyWindowsBridge {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll", SetLastError = true)] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT point, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
  }

  public static object Foreground() {
    var handle = GetForegroundWindow();
    uint processId;
    GetWindowThreadProcessId(handle, out processId);
    var title = new StringBuilder(512);
    GetWindowText(handle, title, title.Capacity);
    string app = "";
    try { app = Process.GetProcessById((int)processId).ProcessName; } catch {}
    return new { handle = handle.ToInt64().ToString(), app = app, title = title.ToString() };
  }

  public static object ForegroundWithBounds() {
    var handle = GetForegroundWindow();
    uint processId;
    GetWindowThreadProcessId(handle, out processId);
    var title = new StringBuilder(512);
    GetWindowText(handle, title, title.Capacity);
    string app = "";
    try { app = Process.GetProcessById((int)processId).ProcessName; } catch {}
    RECT rect;
    object bounds = null;
    if (handle != IntPtr.Zero && GetWindowRect(handle, out rect)) {
      bounds = new { x = rect.Left, y = rect.Top, width = Math.Max(0, rect.Right - rect.Left), height = Math.Max(0, rect.Bottom - rect.Top) };
    }
    return new { handle = handle.ToInt64().ToString(), app = app, title = title.ToString(), bounds = bounds };
  }

  public static bool Paste(long targetHandle, int delayMs) {
    var target = new IntPtr(targetHandle);
    if (target != IntPtr.Zero) {
      ShowWindowAsync(target, 5);
      SetForegroundWindow(target);
    }
    if (delayMs > 0) System.Threading.Thread.Sleep(delayMs);
    keybd_event(0x11, 0, 0, UIntPtr.Zero);
    keybd_event(0x56, 0, 0, UIntPtr.Zero);
    keybd_event(0x56, 0, 2, UIntPtr.Zero);
    keybd_event(0x11, 0, 2, UIntPtr.Zero);
    return true;
  }

  public static object WindowBounds(long targetHandle) {
    var target = new IntPtr(targetHandle);
    RECT rect;
    if (target == IntPtr.Zero || !GetWindowRect(target, out rect)) return null;
    return new { x = rect.Left, y = rect.Top, width = Math.Max(0, rect.Right - rect.Left), height = Math.Max(0, rect.Bottom - rect.Top) };
  }

  public static object CaptureCursorDisplayBounds() {
    POINT cursor;
    if (!GetCursorPos(out cursor)) throw new InvalidOperationException("Could not read the cursor position");
    var monitor = MonitorFromPoint(cursor, 2);
    var info = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
    if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) {
      throw new InvalidOperationException("Could not resolve the active display");
    }
    var width = Math.Max(1, info.rcMonitor.Right - info.rcMonitor.Left);
    var height = Math.Max(1, info.rcMonitor.Bottom - info.rcMonitor.Top);
    return new {
      x = info.rcMonitor.Left,
      y = info.rcMonitor.Top,
      width = width,
      height = height,
      cursorX = cursor.X,
      cursorY = cursor.Y
    };
  }
}
'@

function Capture-CursorDisplay([string]$FilePath) {
  if ([string]::IsNullOrWhiteSpace($FilePath)) { throw 'Capture path is required' }
  $bounds = [PastyWindowsBridge]::CaptureCursorDisplayBounds()
  $directory = [System.IO.Path]::GetDirectoryName($FilePath)
  if (![string]::IsNullOrWhiteSpace($directory)) {
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  }
  $bitmap = [System.Drawing.Bitmap]::new(
    [int]$bounds.width,
    [int]$bounds.height,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen(
        [int]$bounds.x,
        [int]$bounds.y,
        0,
        0,
        [System.Drawing.Size]::new([int]$bounds.width, [int]$bounds.height),
        [System.Drawing.CopyPixelOperation]::SourceCopy
      )
    } finally {
      $graphics.Dispose()
    }
    $bitmap.Save($FilePath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bitmap.Dispose()
  }
  [pscustomobject]@{
    path = $FilePath
    x = [int]$bounds.x
    y = [int]$bounds.y
    width = [int]$bounds.width
    height = [int]$bounds.height
    cursorX = [int]$bounds.cursorX
    cursorY = [int]$bounds.cursorY
  }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $request = $line | ConvertFrom-Json
    $result = switch ($request.op) {
      'foreground' { [PastyWindowsBridge]::Foreground(); break }
      'foregroundWithBounds' { [PastyWindowsBridge]::ForegroundWithBounds(); break }
      'paste' {
        $target = if ([string]::IsNullOrWhiteSpace([string]$request.target)) { 0L } else { [Convert]::ToInt64([string]$request.target) }
        $delay = [Math]::Max(0, [Math]::Min(1200, [int]$request.delayMs))
        [PastyWindowsBridge]::Paste($target, $delay)
        break
      }
      'windowBounds' {
        $target = if ([string]::IsNullOrWhiteSpace([string]$request.target)) { 0L } else { [Convert]::ToInt64([string]$request.target) }
        [PastyWindowsBridge]::WindowBounds($target)
        break
      }
      'captureDisplay' {
        Capture-CursorDisplay ([string]$request.filePath)
        break
      }
      default { throw "Unsupported operation: $($request.op)" }
    }
    [Console]::Out.WriteLine((@{ id = $request.id; ok = $true; data = $result } | ConvertTo-Json -Compress -Depth 5))
  } catch {
    [Console]::Out.WriteLine((@{ id = $request.id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
  [Console]::Out.Flush()
}
