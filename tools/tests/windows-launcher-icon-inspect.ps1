# Reads the actual HICONs of a disposable test window. Does not change them.
param([Parameter(Mandatory=$true)][int]$ProcessId,
      [Parameter(Mandatory=$true)][string]$ExpectedImage)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Run only on a disposable GitHub-hosted Windows runner.'
}
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LauncherIconProbe {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessageW(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")]
  public static extern uint GetGuiResources(IntPtr process, uint flags);
}
'@
$proc=Get-Process -Id $ProcessId
$proc.Refresh()
$hwnd=$proc.MainWindowHandle
if($hwnd -eq [IntPtr]::Zero){throw 'No main HWND'}
# WM_GETICON(ICON_BIG) is the icon Explorer uses for the running taskbar button.
$small=[LauncherIconProbe]::SendMessageW($hwnd,0x007f,[IntPtr]::Zero,[IntPtr]::Zero)
$big=[LauncherIconProbe]::SendMessageW($hwnd,0x007f,[IntPtr]::new(1),[IntPtr]::Zero)
if($small -eq [IntPtr]::Zero -or $big -eq [IntPtr]::Zero){throw 'Missing small or taskbar icon'}
$source=[System.Drawing.Bitmap]::FromFile((Resolve-Path $ExpectedImage).Path)
try {
  $results=@()
  foreach($handle in @($small,$big)) {
    $icon=[System.Drawing.Icon]::FromHandle($handle)
    $got=$icon.ToBitmap()
    $want=[System.Drawing.Bitmap]::new($got.Width,$got.Height,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics=[System.Drawing.Graphics]::FromImage($want)
    try {
      $graphics.CompositingMode=[System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($source,0,0,$got.Width,$got.Height)
    } finally {$graphics.Dispose()}
    try {
      $sum=0.0;$count=0
      $sx=[Math]::Max(1,[int][Math]::Floor($got.Width/64));$sy=[Math]::Max(1,[int][Math]::Floor($got.Height/64))
      for($y=0;$y -lt $got.Height;$y+=$sy) { for($x=0;$x -lt $got.Width;$x+=$sx) {
        $a=$got.GetPixel($x,$y);$b=$want.GetPixel($x,$y)
        $aa=$a.A/255.0;$ba=$b.A/255.0
        $sum += [Math]::Abs($a.R*$aa-$b.R*$ba)+[Math]::Abs($a.G*$aa-$b.G*$ba)+[Math]::Abs($a.B*$aa-$b.B*$ba)
        $count++
      }}
      $distance=$sum/($count*3)
      if($distance -gt 14){throw "Windows HICON differs from expected image: $distance ($($got.Width)x$($got.Height))"}
      $results+=@{width=$got.Width;height=$got.Height;distance=[Math]::Round($distance,3)}
    } finally { $want.Dispose();$got.Dispose() }
  }
  @{small=$results[0];big=$results[1];userObjects=[LauncherIconProbe]::GetGuiResources($proc.Handle,1)} | ConvertTo-Json -Compress -Depth 4
} finally { $source.Dispose();$proc.Dispose() }
