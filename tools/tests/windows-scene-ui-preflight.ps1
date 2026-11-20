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
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr FindWindow(string className,string windowName);
  // PowerShell converts $null to an empty string for a typed argument. Pass a
  // true null class from C# so FindWindow matches any class by window title.
  public static IntPtr FindByTitle(string title) { return FindWindow(null,title); }
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd,int x,int y,int w,int h,bool repaint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
  public static void ClickAt(int x,int y) { SetCursorPos(x,y); mouse_event(0x0002,0,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(60); mouse_event(0x0004,0,0,0,UIntPtr.Zero); }
  public static void Wheel(int delta) { mouse_event(0x0800,0,0,unchecked((uint)delta),UIntPtr.Zero); }
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
$fixtureLog=Join-Path $root 'scene-opens.log'
# The fake WE opens its window later than it receives the command. This is
# deliberately slow to exercise cancellation before the HWND exists.
$env:OMNISPEC_SCENE_FIXTURE_LOG=$fixtureLog
$env:OMNISPEC_SCENE_FIXTURE_DELAY_MS='8000'
$launcherPath=(Resolve-Path $Launcher).Path
$fixturePath=(Resolve-Path $SignedFixture).Path
$script:sentinel=$null

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
function WaitCondition([string]$description,[scriptblock]$check,[int]$seconds=30) {
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) { if(& $check){return}; Start-Sleep -Milliseconds 150 }
  throw "$description was not observed"
}
function WaitIntegration([bool]$expected,[int]$seconds=30) {
  WaitCondition "WE integration $expected" {
    try {
      $s=[IO.File]::ReadAllText((Join-Path $data 'settings.json')) | ConvertFrom-Json
      return $s.wallpaper_engine_enabled -eq $expected
    } catch {return $false}
  } $seconds
}
function SceneOpens {
  if(-not (Test-Path $fixtureLog)){return @()}
  try {return @(Get-Content -LiteralPath $fixtureLog | Where-Object {$_ -like 'open:OmniSpec Scene *'})} catch {return @()}
}
function WaitSceneOpen([int]$previous,[int]$seconds=30) {
  WaitCondition 'scene open command' { @(SceneOpens).Count -gt $previous } $seconds
  $opens=@(SceneOpens)
  return $opens[-1].Substring(5)
}
function WaitReadyId([string]$id,[int]$seconds=30) {
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) {
    try { $node=ById $id; if($null -ne $node -and $node.Current.IsEnabled){return $node} } catch {}
    Start-Sleep -Milliseconds 150
  }
  throw "Enabled element not found: $id"
}
function Click($node) {
  $pattern=$null
  if($node.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern,[ref]$pattern)){try{$pattern.ScrollIntoView()}catch{}}
  $pattern=$null
  if($node.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){$pattern.Toggle();return}
  $pattern=$null
  if($node.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke();return}
  try {$node.SetFocus();[System.Windows.Forms.SendKeys]::SendWait(' ');return}catch{}
  $rect=$node.Current.BoundingRectangle
  if($rect.Width -le 0 -or $rect.Height -le 0){throw 'Cannot click an empty UI rectangle'}
  [OmniSceneUiProbe]::ClickAt([int](($rect.Left+$rect.Right)/2),[int](($rect.Top+$rect.Bottom)/2))
}
# WebView2's off-screen elements can lack Invoke/ScrollItem patterns. Scroll
# the actual settings viewport as a user would before targeting its controls.
function ScrollPrefs([bool]$down) {
  [void][OmniSceneUiProbe]::SetForegroundWindow($script:proc.MainWindowHandle)
  [void][OmniSceneUiProbe]::SetCursorPos(500,300)
  $delta=if($down){-1200}else{1200}
  for($i=0;$i -lt 4;$i++){[OmniSceneUiProbe]::Wheel($delta);Start-Sleep -Milliseconds 100}
  Start-Sleep -Milliseconds 250
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
    wallpaper_engine_enabled=$false;wallpaper_workshop_audio=$false
  }
  # A separate fake window stands in for an unrelated desktop wallpaper. It
  # must survive every address-specific close made for OmniSpec's window.
  # A single token avoids depending on Start-Process command-line quoting; the
  # actual OmniSpec scene titles still exercise spaced names.
  $sentinelTitle='OmniSpec-unrelated-desktop-sentinel'
  $env:OMNISPEC_SCENE_FIXTURE_DELAY_MS='0'
  $script:sentinel=Start-Process -FilePath $engine -ArgumentList @('-control','openWallpaper','-playInWindow',$sentinelTitle) -PassThru
  WaitCondition 'unrelated fake desktop window' { [OmniSceneUiProbe]::FindByTitle($sentinelTitle) -ne [IntPtr]::Zero } 15
  $env:OMNISPEC_SCENE_FIXTURE_DELAY_MS='8000'
  StartLauncher
  Start-Sleep -Seconds 2
  if(@(SceneOpens).Count -ne 0){throw 'A disabled integration opened a scene at startup'}
  Click (WaitId 'btn-quick-settings')
  Click (WaitButton 'Фон')
  [void](WaitReadyId 'we-enabled')

  # Start restoration, then switch off after openWallpaper was sent but before
  # the delayed HWND exists. A late-created window must still get closed.
  $count=@(SceneOpens).Count
  Click (WaitReadyId 'we-enabled')
  WaitIntegration $true
  $script:cancelledTitle=WaitSceneOpen $count
  if([OmniSceneUiProbe]::FindByTitle($script:cancelledTitle) -ne [IntPtr]::Zero){throw 'Cancellation test was too slow: fixture window already exists'}
  Click (WaitReadyId 'we-enabled')
  WaitIntegration $false
  WaitCondition 'late fake window creation' {
    try {return @(Get-Content -LiteralPath $fixtureLog) -contains ('created:'+$script:cancelledTitle)} catch {return $false}
  } 20
  WaitCondition 'late fake window cleanup' { [OmniSceneUiProbe]::FindByTitle($script:cancelledTitle) -eq [IntPtr]::Zero } 15
  Start-Sleep -Seconds 1
  if([OmniSceneUiProbe]::FindByTitle($script:cancelledTitle) -ne [IntPtr]::Zero){throw 'Cancelled scene window survived'}
  if([OmniSceneUiProbe]::FindByTitle($sentinelTitle) -eq [IntPtr]::Zero){throw 'An unrelated desktop window was closed'}
  $saved=[IO.File]::ReadAllText((Join-Path $data 'settings.json')) | ConvertFrom-Json
  if($saved.wallpaper -ne 'workshop' -or $saved.wallpaper_workshop_project -ne $project){throw 'Disabling lost the selected project'}
  Write-Host 'WINDOWS_SCENE_UI_LATE_CANCELLATION_AND_SENTINEL_OK (fake WE)'

  # Re-enable, verify actual changing WebView2 pixels, and then stop the active
  # scene while leaving the unrelated window and the selection intact.
  $count=@(SceneOpens).Count
  Click (WaitReadyId 'we-enabled')
  WaitIntegration $true
  $script:activeTitle=WaitSceneOpen $count
  Click (WaitId 'prefs-save')
  AssertAnimated 'FIRST_RESTORE'
  Screenshot 'scene-first.png'
  Click (WaitId 'btn-quick-settings')
  Click (WaitButton 'Фон')
  Click (WaitReadyId 'we-enabled')
  WaitIntegration $false
  WaitCondition 'active scene cleanup' { [OmniSceneUiProbe]::FindByTitle($script:activeTitle) -eq [IntPtr]::Zero } 15
  if([OmniSceneUiProbe]::FindByTitle($sentinelTitle) -eq [IntPtr]::Zero){throw 'An unrelated desktop window was closed on active stop'}
  Click (WaitReadyId 'we-audio')
  WaitCondition 'saved video audio preference' {
    try {return ([IO.File]::ReadAllText((Join-Path $data 'settings.json')) | ConvertFrom-Json).wallpaper_workshop_audio -eq $true} catch {return $false}
  } 15
  $bad=@(Get-Content -LiteralPath $fixtureLog | Where-Object {$_ -eq 'close:<all>' -or $_ -eq ('close:'+$sentinelTitle) -or $_ -like 'global-audio-command:*'})
  if($bad.Count){throw "An unsafe global/foreign command was sent: $($bad -join ', ')"}
  Write-Host 'WINDOWS_SCENE_UI_ACTIVE_DISABLE_ISOLATION_OK (fake WE)'

  # Disabled state and the saved project survive restarting the actual Tauri
  # application, which must not send a scene command until explicitly enabled.
  $count=@(SceneOpens).Count
  StopLauncher
  StartLauncher
  Start-Sleep -Seconds 3
  if(@(SceneOpens).Count -ne $count){throw 'Restart reopened a disabled scene'}
  $saved=[IO.File]::ReadAllText((Join-Path $data 'settings.json')) | ConvertFrom-Json
  if($saved.wallpaper_engine_enabled -ne $false -or $saved.wallpaper_workshop_audio -ne $true -or $saved.wallpaper_workshop_project -ne $project){throw 'Preferences or selection were not retained across restart'}
  if([OmniSceneUiProbe]::FindByTitle($sentinelTitle) -eq [IntPtr]::Zero){throw 'An unrelated desktop window was closed on restart'}
  Click (WaitId 'btn-quick-settings')
  Click (WaitButton 'Фон')
  Click (WaitReadyId 'we-enabled')
  WaitIntegration $true
  Click (WaitId 'prefs-save')
  AssertAnimated 'RESTORED_AFTER_RESTART'
  Write-Host 'WINDOWS_SCENE_UI_DISABLED_RESTART_AND_REENABLE_OK (fake WE)'

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
  ScrollPrefs $false
  Click (WaitButton 'Убрать фон')
  WaitWallpaper $null
  ScrollPrefs $true
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
  if(Test-Path -LiteralPath $fixtureLog){Write-Host "SCENE_FIXTURE_EVENTS`n$([IO.File]::ReadAllText($fixtureLog))"}
  if($script:sentinel){try {$script:sentinel.Refresh();Write-Host "SCENE_SENTINEL_EXITED $($script:sentinel.HasExited)"} catch {}}
  Screenshot 'scene-failure.png'
  throw $originalError
} finally {
  StopLauncher
  StopOnlyFixture
  Remove-Item Env:\OMNISPEC_HOME -ErrorAction SilentlyContinue
  Remove-Item Env:\WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
  Remove-Item Env:\OMNISPEC_SCENE_FIXTURE_LOG -ErrorAction SilentlyContinue
  Remove-Item Env:\OMNISPEC_SCENE_FIXTURE_DELAY_MS -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
