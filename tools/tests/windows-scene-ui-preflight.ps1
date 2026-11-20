# Disposable Windows GitHub runner ONLY. Uses a fake signed window and the real
# release Tauri/WebView2 application: WGC -> MJPEG -> visible changing pixels.
# This is NOT a test of the commercial Wallpaper Engine application.
param(
  [Parameter(Mandatory=$true)][string]$Launcher,
  [Parameter(Mandatory=$true)][string]$SignedFixture
)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Run only on a disposable GitHub-hosted Windows runner.'
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OmniSceneUiProbe {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd,int x,int y,int w,int h,bool repaint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
  public static void ClickAt(int x,int y) { SetCursorPos(x,y); mouse_event(0x0002,0,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(60); mouse_event(0x0004,0,0,0,UIntPtr.Zero); }
}
'@
$root=Join-Path $env:RUNNER_TEMP ('omnispec-scene-ui-'+[Guid]::NewGuid().ToString('N'))
$data=Join-Path $root 'data'
$steam=Join-Path $root 'Steam with spaces'
$engine=Join-Path $steam 'steamapps\common\wallpaper_engine\wallpaper64.exe'
$project=Join-Path $steam 'steamapps\workshop\content\431960\123456'
$utf8=[Text.UTF8Encoding]::new($false)
$scope=[System.Windows.Automation.TreeScope]::Descendants
$all=[System.Windows.Automation.Condition]::TrueCondition
$script:proc=$null; $script:ui=$null
$env:OMNISPEC_HOME=$data
$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $root 'webview'
$launcherPath=(Resolve-Path $Launcher).Path
$fixturePath=(Resolve-Path $SignedFixture).Path

function WriteJson([string]$file,$value) {
  New-Item -ItemType Directory -Force -Path (Split-Path $file -Parent) | Out-Null
  [IO.File]::WriteAllText($file,($value | ConvertTo-Json -Depth 12),$utf8)
}
function ById([string]$id) {
  try {
    $cond=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$id)
    return $script:ui.FindFirst($scope,$cond)
  } catch { return $null }
}
function WaitId([string]$id,[int]$seconds=60) {
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) { $node=ById $id; if($null -ne $node){return $node}; Start-Sleep -Milliseconds 150 }
  throw "Element not found: $id"
}
function WaitButton([string]$name,[int]$seconds=60) {
  $cond=[System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name))
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) {
    try { $node=$script:ui.FindFirst($scope,$cond); if($null -ne $node){return $node} } catch {}
    Start-Sleep -Milliseconds 150
  }
  throw "Button not found: $name"
}
function HasText([string]$part) {
  try {
    foreach($node in $script:ui.FindAll($scope,$all)) {
      try {if($node.Current.Name -like "*$part*"){return $true}} catch {}
    }
  } catch {}
  return $false
}
function WaitText([string]$part,[int]$seconds=30) {
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) {if(HasText $part){return};Start-Sleep -Milliseconds 200}
  throw "Text not found: $part"
}
function WaitWallpaper($expected,[int]$seconds=40) {
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) {
    try {
      $s=[IO.File]::ReadAllText((Join-Path $data 'settings.json')) | ConvertFrom-Json
      if($s.wallpaper -eq $expected){return}
    } catch {}
    Start-Sleep -Milliseconds 150
  }
  throw "Wallpaper was not saved as '$expected'"
}
function Click($node) {
  $pattern=$null
  if($node.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern,[ref]$pattern)){try{$pattern.ScrollIntoView()}catch{}}
  $pattern=$null
  if($node.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke();return}
  try {$node.SetFocus();[System.Windows.Forms.SendKeys]::SendWait(' ');return}catch{}
  $rect=$node.Current.BoundingRectangle
  if($rect.Width -le 0 -or $rect.Height -le 0){throw 'Cannot click an empty UI rectangle'}
  [OmniSceneUiProbe]::ClickAt([int](($rect.Left+$rect.Right)/2),[int](($rect.Top+$rect.Bottom)/2))
}
function Screenshot([string]$name) {
  try {
    New-Item -ItemType Directory -Force -Path 'diagnostic-scene-ui' | Out-Null
    $bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp=New-Object Drawing.Bitmap $bounds.Width,$bounds.Height
    $g=[Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($bounds.Location,[Drawing.Point]::Empty,$bounds.Size)
    $bmp.Save((Join-Path (Resolve-Path 'diagnostic-scene-ui').Path $name),[Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$bmp.Dispose()
  } catch {Write-Host "Screenshot failed: $($_.Exception.Message)"}
}
function AssertAnimated([string]$label,[int]$seconds=50) {
  # The sidebar is translucent over the red/blue fixture. Sample the actual
  # desktop, not the source window or the Rust stream, to include WebView2.
  $red=$false; $blue=$false; $samples=@(); $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) {
    $bmp=New-Object Drawing.Bitmap 1,1; $g=[Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen(220,380,0,0,[Drawing.Size]::new(1,1))
    $p=$bmp.GetPixel(0,0);$samples+=('{0},{1},{2}' -f $p.R,$p.G,$p.B)
    if(([int]$p.R-[int]$p.B) -gt 8){$red=$true}
    if(([int]$p.B-[int]$p.R) -gt 8){$blue=$true}
    $g.Dispose();$bmp.Dispose()
    if($red -and $blue){break}
    Start-Sleep -Milliseconds 200
  }
  if(-not ($red -and $blue)){throw "$label did not visibly advance in WebView2: $($samples -join '; ')"}
  Write-Host "WINDOWS_SCENE_UI_${label}_PIXELS_OK $($samples -join '; ')"
}
function StartLauncher {
  $script:proc=Start-Process -FilePath $launcherPath -PassThru
  for($i=0;$i -lt 120;$i++) {
    Start-Sleep -Milliseconds 400; $script:proc.Refresh()
    if($script:proc.HasExited){throw "App exited: $($script:proc.ExitCode)"}
    if($script:proc.MainWindowHandle -ne [IntPtr]::Zero){break}
  }
  if($script:proc.MainWindowHandle -eq [IntPtr]::Zero){throw 'No launcher window'}
  [void][OmniSceneUiProbe]::MoveWindow($script:proc.MainWindowHandle,0,0,1080,720,$true)
  [void][OmniSceneUiProbe]::SetForegroundWindow($script:proc.MainWindowHandle)
  $script:ui=[System.Windows.Automation.AutomationElement]::FromHandle($script:proc.MainWindowHandle)
  [void](WaitId 'btn-quick-settings' 120)
}
function StopLauncher {
  if($script:proc){
    try {$script:proc.Refresh();if(-not $script:proc.HasExited){[void]$script:proc.CloseMainWindow();if(-not $script:proc.WaitForExit(5000)){Stop-Process -Id $script:proc.Id -Force -ErrorAction SilentlyContinue}}}catch{}
    $script:proc=$null; $script:ui=$null
  }
}
function StopOnlyFixture {
  $full=[IO.Path]::GetFullPath($engine)
  foreach($process in (Get-CimInstance Win32_Process -Filter "Name='wallpaper64.exe'")) {
    if($process.ExecutablePath -and [IO.Path]::GetFullPath($process.ExecutablePath) -eq $full){
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}
try {
  New-Item -ItemType Directory -Force -Path $data,(Split-Path $engine -Parent),$project | Out-Null
  Copy-Item -LiteralPath $fixturePath -Destination $engine
  $signature=Get-AuthenticodeSignature -LiteralPath $engine
  if($signature.Status -ne 'Valid'){throw 'Fixture must be signed and trusted by the disposable parent preflight'}
  WriteJson (Join-Path $project 'project.json') @{title='Signed fake scene';type='scene';file='scene.pkg';workshopid='123456'}
  # Intentionally store an ordinary DOS path rather than \\?\ form: both must
  # restore correctly, including paths with spaces.
  WriteJson (Join-Path $data 'settings.json') @{
    onboarded=$true;update_enabled=$false;discord_rpc=$false;click_fx='off';ambient='off';trail=$false;sound_fx=$false;ui_scale=100
    wallpaper='workshop';wallpaper_steam_path=$steam;wallpaper_workshop_project=$project;wallpaper_fit='cover';wallpaper_dim=0;wallpaper_blur=0
  }
  StartLauncher
  AssertAnimated 'FIRST_RESTORE'
  Screenshot 'scene-first.png'

  # Kill only the fake fixture, not any real process. The app must report a
  # stopped capture and allow retry without losing the selected project.
  StopOnlyFixture
  Click (WaitId 'btn-quick-settings')
  Click (WaitButton 'Фон')
  [void](WaitId 'we-retry' 60)
  WaitText 'Поток сцены остановлен' 30
  Write-Host 'WINDOWS_SCENE_UI_STOP_DETECTED'
  Click (WaitId 'we-retry')
  WaitText 'Обои восстановлены' 50
  Click (WaitId 'prefs-save')
  AssertAnimated 'AFTER_RETRY'
  Screenshot 'scene-retry.png'

  # Exercise actual selection, not just the persisted-startup path. Turning
  # the background off must finish cleanup before this scene is selected again.
  Click (WaitId 'btn-quick-settings')
  Click (WaitButton 'Фон')
  Click (WaitButton 'Убрать фон')
  WaitWallpaper $null
  Click (WaitButton 'Установить «Signed fake scene» как фон' 90)
  Click (WaitId 'confirm-ok')
  WaitWallpaper 'workshop' 60
  WaitText 'Сцена «Signed fake scene» выбрана как фон' 60
  Click (WaitId 'prefs-save')
  AssertAnimated 'AFTER_RESELECT'
  Write-Host 'WINDOWS_SCENE_UI_SWITCH_AND_RESELECT_OK'

  StopLauncher
  StartLauncher
  AssertAnimated 'RESTART'
  Screenshot 'scene-restart.png'
  Write-Host 'WINDOWS_SCENE_UI_FAKE_FIXTURE_WEBVIEW2_PASSED (not real Wallpaper Engine)'
} catch {
  $originalError=$_
  Write-Host "SCENE_UI_FAILURE $($originalError.Exception.Message)"
  Write-Host $originalError.ScriptStackTrace
  Screenshot 'scene-failure.png'
  throw $originalError
} finally {
  StopLauncher
  StopOnlyFixture
  Remove-Item Env:\OMNISPEC_HOME -ErrorAction SilentlyContinue
  Remove-Item Env:\WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
