Add-Type -AssemblyName System.Drawing

# --- OCR text image: clear Chinese + Latin + digits, black on white ---
$bmp = New-Object System.Drawing.Bitmap 900, 300
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$font = New-Object System.Drawing.Font('Microsoft YaHei', 40)
$g.DrawString('滑动质量 Paste123 摘要测试', $font, [System.Drawing.Brushes]::Black, 20, 90)
$g.Dispose()
$bmp.Save("$PSScriptRoot\ocr-text.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# --- Pin pattern 600x400: hard-edged shapes for pixel-exact comparison ---
$bmp = New-Object System.Drawing.Bitmap 600, 400
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 2)
$g.DrawRectangle($pen, 1, 1, 597, 397)
$g.FillRectangle([System.Drawing.Brushes]::Red, 30, 30, 40, 40)
$g.FillRectangle([System.Drawing.Brushes]::Blue, 530, 330, 40, 40)
$g.DrawLine($pen, 70, 370, 530, 30)
$font2 = New-Object System.Drawing.Font('Arial', 24)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
$g.DrawString('PIN-TEST 600x400', $font2, [System.Drawing.Brushes]::Black, 180, 180)
$g.Dispose()
$bmp.Save("$PSScriptRoot\pattern.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host 'assets written'
