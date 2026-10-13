param(
  [string]$ImagePath,
  [string]$Language = 'zh-Hans'
)
$ErrorActionPreference = 'Stop'

# Node consumes our piped stdout as UTF-8; PowerShell would otherwise emit
# the OEM codepage and mangle recognized Chinese text.
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

# Offline OCR through the Windows built-in WinRT engine. Runs under
# Windows PowerShell 5.1 (pwsh 7 dropped WinRT projections); the caller
# spawns one process per recognition and caches results.
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Storage.FileAccessMode,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapPixelFormat,Windows.Foundation,ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($Operation, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($Operation))
  try {
    $netTask.Wait(-1) | Out-Null
  } catch {
    $inner = $_.Exception.InnerException
    if ($inner) { throw $inner } else { throw }
  }
  $netTask.Result
}

if (-not (Test-Path $ImagePath)) { throw "Image not found: $ImagePath" }
# GetFileFromPathAsync rejects forward slashes; normalize to a full Win32 path.
$ImagePath = [System.IO.Path]::GetFullPath($ImagePath)

$engine = $null
try {
  $lang = New-Object Windows.Globalization.Language($Language)
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
} catch {}
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw 'No OCR language pack is installed on this system' }

# WinRT OCR rejects images larger than MaxImageDimension; the property may
# not project cleanly under PowerShell 5.1, so fall back to the documented
# limit. Small crops recognize better with a modest upscale.
$maxDimension = 4096
try {
  $projected = [int]$engine.MaxImageDimension
  if ($projected -gt 0) { $maxDimension = $projected }
} catch {}
$source = [System.Drawing.Bitmap]::FromFile($ImagePath)
$workingPath = $null
try {
  $longest = [Math]::Max($source.Width, $source.Height)
  $target = $longest
  if ($longest -gt $maxDimension) { $target = $maxDimension }
  elseif ($longest -lt 700) { $target = [Math]::Min($maxDimension, $longest * 2) }
  if ($target -ne $longest) {
    $scale = $target / [double]$longest
    $resized = New-Object System.Drawing.Bitmap([int]($source.Width * $scale), [int]($source.Height * $scale))
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($resized)
      try {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($source, 0, 0, $resized.Width, $resized.Height)
      } finally { $graphics.Dispose() }
      $workingPath = [System.IO.Path]::ChangeExtension([System.IO.Path]::GetTempFileName(), '.png')
      $resized.Save($workingPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $resized.Dispose() }
  }
} finally { $source.Dispose() }

try {
  $decodePath = if ($workingPath) { $workingPath } else { $ImagePath }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($decodePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  if ($bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8) {
    $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8)
  }
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $lines = @()
  $lineIndex = 0
  foreach ($line in $result.Lines) {
    $words = @()
    foreach ($word in $line.Words) {
      $words += ,@{
        text = $word.Text
        x = [Math]::Round($word.BoundingRect.X, 2)
        y = [Math]::Round($word.BoundingRect.Y, 2)
        w = [Math]::Round($word.BoundingRect.Width, 2)
        h = [Math]::Round($word.BoundingRect.Height, 2)
      }
    }
    if ($words.Count) {
      $lines += ,@{ lineIndex = $lineIndex; text = $line.Text; words = $words }
      $lineIndex++
    }
  }
  [Console]::Out.WriteLine((@{
    ok = $true
    language = $engine.RecognizerLanguage.LanguageTag
    width = [int]$bitmap.PixelWidth
    height = [int]$bitmap.PixelHeight
    text = $result.Text
    lines = $lines
  } | ConvertTo-Json -Compress -Depth 5))
} finally {
  if ($workingPath) { Remove-Item $workingPath -Force -ErrorAction SilentlyContinue }
}
