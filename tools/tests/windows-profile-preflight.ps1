# Real Windows Tauri/WebView2 regression; all data and the fake engine are disposable.
# Uses Windows UI Automation and the real multi-file picker, not a mocked backend.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OmniProfileProbe {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd,int x,int y,int w,int h,bool repaint);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
    public static void ClickAt(int x,int y) { SetCursorPos(x,y); mouse_event(0x0002,0,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(60); mouse_event(0x0004,0,0,0,UIntPtr.Zero); }
}
'@

$root=Join-Path $env:RUNNER_TEMP ('omnispec-profile-'+[Guid]::NewGuid().ToString('N'))
$data=Join-Path $root 'data'
$steam=Join-Path $root 'Steam with spaces'
$library=Join-Path $root 'Library with spaces'
$fixture=(Resolve-Path 'tools/tests/fixtures/profile').Path
$engine=Join-Path $steam 'steamapps\common\wallpaper_engine'
$videoDir=Join-Path $library 'steamapps\workshop\content\431960\123'
$sceneDir=Join-Path $library 'steamapps\workshop\content\431960\456'
$webDir=Join-Path $library 'steamapps\workshop\content\431960\789'
$utf8=[Text.UTF8Encoding]::new($false)
$scope=[System.Windows.Automation.TreeScope]::Descendants
$all=[System.Windows.Automation.Condition]::TrueCondition
$script:ui=$null; $script:proc=$null; $script:dialog=$null
$reg='HKCU:\Software\Valve\Steam'
$regCreated=-not (Test-Path $reg); $regHad=$false; $regOld=$null
$env:OMNISPEC_HOME=$data
$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $root 'webview'
$env:OMNISPEC_TEST_WE_LOG=Join-Path $root 'engine-arguments.txt'

function WriteJson([string]$file,$value) {
  New-Item -ItemType Directory -Force -Path (Split-Path $file -Parent) | Out-Null
  [IO.File]::WriteAllText($file,($value | ConvertTo-Json -Depth 12),$utf8)
}
function ReadSettings {
  try { return [IO.File]::ReadAllText((Join-Path $data 'settings.json')) | ConvertFrom-Json }
  catch { return $null }
}
function ById([string]$id) {
  try {
    $cond=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$id)
    return $script:ui.FindFirst($scope,$cond)
  } catch { return $null }
}
function WaitId([string]$id,[int]$seconds=80) {
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) { $n=ById $id; if($null -ne $n){return $n}; Start-Sleep -Milliseconds 150 }
  throw "Element not found: $id"
}
function WaitButton([string]$name,[int]$seconds=80) {
  $cond=[System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name))
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) {
    try { $n=$script:ui.FindFirst($scope,$cond); if($null -ne $n){return $n} } catch {}
    Start-Sleep -Milliseconds 150
  }
  throw "Button not found: $name"
}
function Click($n) {
  $pattern=$null
  if($n.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){$pattern.Toggle();return}
  $pattern=$null
  if($n.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke();return}
  try {$n.SetFocus();[System.Windows.Forms.SendKeys]::SendWait(' ');return}catch{}
  $rect=$n.Current.BoundingRectangle
  if($rect.Width -le 0 -or $rect.Height -le 0){throw 'Cannot click an empty UI rectangle'}
  [OmniProfileProbe]::ClickAt([int](($rect.Left+$rect.Right)/2),[int](($rect.Top+$rect.Bottom)/2))
}
function SetText([string]$id,[string]$text) {
  $n=WaitId $id
  $pattern=$null
  if($n.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){$pattern.SetValue($text);return}
  $n.SetFocus();[System.Windows.Forms.SendKeys]::SendWait('^a');[System.Windows.Forms.SendKeys]::SendWait($text)
}
function WaitDialog([int]$seconds=40) {
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  $desktop=[System.Windows.Automation.AutomationElement]::RootElement
  while([DateTime]::UtcNow -lt $end) {
    foreach($n in $desktop.FindAll([System.Windows.Automation.TreeScope]::Children,$all)) {
      try {if($n.Current.Name -like '*один или несколько PNG-скинов*'){return $n}}catch{}
    }
    Start-Sleep -Milliseconds 200
  }
  throw 'Windows multi-file picker did not appear'
}
function SelectFilesInDialog($dialog,[string[]]$files) {
  $editCond=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)
  $edits=@($dialog.FindAll($scope,$editCond))
  # The modern Explorer picker also has a search edit at the top. The file
  # name edit is the lowest visible edit, nested inside combo box 1148.
  $visible=@($edits | Where-Object {try {$_.Current.BoundingRectangle.Height -gt 0}catch{$false}} |
    Sort-Object { $_.Current.BoundingRectangle.Top } -Descending)
  if(-not $visible.Count){throw 'File name field missing in native dialog'}
  $edit=$visible[0]
  Write-Host "FILE_PICKER_FIELD name=[$($edit.Current.Name)] id=[$($edit.Current.AutomationId)] rect=$($edit.Current.BoundingRectangle)"
  Screenshot 'windows-file-dialog.png'
  $names=($files | ForEach-Object { '"'+$_+'"' }) -join ' '
  $pattern=$null
  if($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) { $pattern.SetValue($names) }
  else { $edit.SetFocus();[System.Windows.Forms.SendKeys]::SendWait('^a');[System.Windows.Forms.SendKeys]::SendWait($names) }
  $buttonCond=[System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1'))
  $button=$dialog.FindFirst($scope,$buttonCond)
  if($null -eq $button) { $edit.SetFocus();[System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }
  else { Click $button }
}
function WaitSettings($predicate,[string]$description,[int]$seconds=90) {
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) {
    $value=ReadSettings
    if($null -ne $value -and (& $predicate $value)){return $value}
    Start-Sleep -Milliseconds 200
  }
  throw "Settings not updated: $description"
}
function Screenshot([string]$name) {
  try {
    New-Item -ItemType Directory -Force -Path 'diagnostic-profile' | Out-Null
    $bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp=New-Object Drawing.Bitmap $bounds.Width,$bounds.Height
    $g=[Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($bounds.Location,[Drawing.Point]::Empty,$bounds.Size)
    $bmp.Save((Join-Path (Resolve-Path 'diagnostic-profile').Path $name),[Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$bmp.Dispose()
  }catch{Write-Host "Screenshot failed: $($_.Exception.Message)"}
}
function AssertAnimated([string]$label) {
  # The empty sidebar is translucent over the solid red/blue test media.
  $red=$false; $blue=$false; $samples=@()
  for($i=0;$i -lt 28;$i++) {
    $bmp=New-Object Drawing.Bitmap 1,1
    $g=[Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen(220,380,0,0,[Drawing.Size]::new(1,1))
    $p=$bmp.GetPixel(0,0);$samples+=('{0},{1},{2}' -f $p.R,$p.G,$p.B)
    if(([int]$p.R-[int]$p.B) -gt 8){$red=$true}
    if(([int]$p.B-[int]$p.R) -gt 8){$blue=$true}
    $g.Dispose();$bmp.Dispose()
    if($red -and $blue){break}
    Start-Sleep -Milliseconds 200
  }
  if(-not ($red -and $blue)){throw "$label did not visibly advance: $($samples -join '; ')"}
  Write-Host "WINDOWS_${label}_VISIBLE_FRAMES_OK $($samples -join '; ')"
}
function StartLauncher {
  $script:proc=Start-Process -FilePath (Resolve-Path 'target/debug/omnispec-app.exe').Path -PassThru
  for($i=0;$i -lt 100;$i++) {
    Start-Sleep -Milliseconds 400;$script:proc.Refresh()
    if($script:proc.HasExited){throw "App exited: $($script:proc.ExitCode)"}
    if($script:proc.MainWindowHandle -ne [IntPtr]::Zero){break}
  }
  if($script:proc.MainWindowHandle -eq [IntPtr]::Zero){throw 'No launcher window'}
  [void][OmniProfileProbe]::MoveWindow($script:proc.MainWindowHandle,0,0,1080,720,$true)
  [void][OmniProfileProbe]::SetForegroundWindow($script:proc.MainWindowHandle)
  $script:ui=[System.Windows.Automation.AutomationElement]::FromHandle($script:proc.MainWindowHandle)
  [void](WaitId 'btn-quick-settings' 120)
}
function StopLauncher {
  if($script:proc){
    try {$script:proc.Refresh();if(-not $script:proc.HasExited){[void]$script:proc.CloseMainWindow();if(-not $script:proc.WaitForExit(5000)){Stop-Process -Id $script:proc.Id -Force -ErrorAction SilentlyContinue}}}catch{}
    $script:proc=$null;$script:ui=$null
  }
}
function OpenPrefs([string]$category) { Click (WaitId 'btn-quick-settings'); Click (WaitButton $category) }
function InvokeEngine([string]$title,[string]$dir) {
  $label="Открыть «$title» в Wallpaper Engine"
  Click (WaitButton $label)
  Click (WaitId 'confirm-ok')
  $end=[DateTime]::UtcNow.AddSeconds(30); $args=@()
  while([DateTime]::UtcNow -lt $end) {
    try {if(Test-Path $env:OMNISPEC_TEST_WE_LOG){$args=@([IO.File]::ReadAllLines($env:OMNISPEC_TEST_WE_LOG));if($args.Count -ge 10){break}}} catch {}
    Start-Sleep -Milliseconds 150
  }
  if($args.Count -lt 10){throw "Engine was not invoked for $title"}
  # A short, ordinary path must be in the compatible DOS form for Wallpaper Engine.
  if($args.Count -gt 3 -and $args[3].StartsWith('\\?\')){throw 'Engine received an unnecessary extended-length path prefix'}
  $expected=@('-control','openWallpaper','-file',(Join-Path $dir 'project.json'),'-playInWindow','OmniSpec Wallpaper','-width','1280','-height','720')
  if(($args -join '|') -ne ($expected -join '|')){throw "Wrong engine argument vector: $($args -join '|')"}
  Remove-Item $env:OMNISPEC_TEST_WE_LOG -Force
  Write-Host "WINDOWS_ENGINE_COMMAND_OK $title"
}

try {
  New-Item -ItemType Directory -Force -Path $data,$engine,$videoDir,$sceneDir,$webDir,(Join-Path $data 'wallpapers'),(Join-Path $data 'meta\skins') | Out-Null
  Copy-Item (Join-Path $fixture 'animated.gif') (Join-Path $data 'wallpapers\custom.gif')
  Copy-Item (Join-Path $fixture 'animated.mp4') (Join-Path $videoDir 'movie.mp4')
  Copy-Item (Join-Path $fixture 'animated.gif') (Join-Path $videoDir 'preview.gif')
  Copy-Item (Join-Path $fixture 'one.png') (Join-Path $data 'meta\skins\old.png')
  WriteJson (Join-Path $videoDir 'project.json') @{title='AAA Windows video';type='video';file='movie.mp4';preview='preview.gif';workshopid='123'}
  WriteJson (Join-Path $sceneDir 'project.json') @{title='BBB Windows scene';type='scene';file='scene.pkg';workshopid='456'}
  WriteJson (Join-Path $webDir 'project.json') @{title='CCC Windows web';type='web';file='index.html';workshopid='789'}
  $vdf='"libraryfolders" { "0" { "path" "'+$steam.Replace('\','\\')+'" } "1" { "path" "'+$library.Replace('\','\\')+'" } }'
  New-Item -ItemType Directory -Force -Path (Join-Path $steam 'steamapps') | Out-Null
  [IO.File]::WriteAllText((Join-Path $steam 'steamapps\libraryfolders.vdf'),$vdf,$utf8)
  New-Item -Path $reg -Force | Out-Null
  $item=Get-Item $reg; $regHad=$item.GetValueNames() -contains 'SteamPath'
  if($regHad){$regOld=$item.GetValue('SteamPath')}
  New-ItemProperty -Path $reg -Name SteamPath -Value $steam -PropertyType String -Force | Out-Null
  & rustc --edition 2021 -O 'tools/tests/windows-wallpaper-engine-probe.rs' -o (Join-Path $engine 'wallpaper64.exe')
  if($LASTEXITCODE -ne 0){throw 'Fake Wallpaper Engine probe did not compile'}
  $old=Join-Path $data 'meta\skins\old.png'
  WriteJson (Join-Path $data 'settings.json') @{
    onboarded=$true;update_enabled=$false;discord_rpc=$false;click_fx='off';ambient='off';trail=$false;sound_fx=$false;ui_scale=100
    wallpaper='custom';custom_wallpaper='custom.gif';wallpaper_fit='cover';wallpaper_dim=0;wallpaper_blur=0
    skin_presets=@(@{id='legacy';name='Old skin';path=$old;variant='slim';angle=12})
    skin_favorites=@(@{id='old-fav';name='Old favorite';skinPath=$old;skinDataUrl='';variant='slim';capeId='';futureField='preserved'})
  }
  StartLauncher
  Start-Sleep -Seconds 3
  AssertAnimated 'GIF'
  Screenshot 'windows-gif.png'

  OpenPrefs 'Профиль'
  $apply=WaitId 'skin-apply'
  if($apply.Current.IsEnabled){throw 'Offline account can incorrectly change its skin'}
  Click (WaitId 'skin-upload')
  $script:dialog=WaitDialog
  SelectFilesInDialog $script:dialog @((Join-Path $fixture 'one.png'),(Join-Path $fixture 'two.png'),(Join-Path $fixture 'bad.png'))
  Start-Sleep -Seconds 2
  try {$script:dialog=WaitDialog 3} catch {$script:dialog=$null}
  if($script:dialog){throw 'File picker did not close after selecting the PNG files'}
  $saved=WaitSettings {param($s) @($s.skin_presets).Count -eq 3} 'batch of two valid PNGs' 100
  $items=@($saved.skin_presets)
  if($items[0].id -ne 'legacy' -or @($saved.skin_favorites)[0].futureField -ne 'preserved'){throw 'Legacy skin or favorite was lost'}
  if($items[1].path -eq $items[2].path){throw 'Imported skins share one path'}
  if((Get-FileHash -LiteralPath $items[1].path).Hash -notin @((Get-FileHash (Join-Path $fixture 'one.png')).Hash,(Get-FileHash (Join-Path $fixture 'two.png')).Hash)){throw 'First imported PNG differs from source'}
  if((Get-FileHash -LiteralPath $items[2].path).Hash -notin @((Get-FileHash (Join-Path $fixture 'one.png')).Hash,(Get-FileHash (Join-Path $fixture 'two.png')).Hash)){throw 'Second imported PNG differs from source'}
  if(-not (Test-Path $old)){throw 'Legacy skin was deleted'}
  Screenshot 'windows-profile.png'
  Write-Host 'WINDOWS_REAL_MULTIFILE_IMPORT_AND_LEGACY_OK'

  Click (WaitButton 'Фон')
  Click (WaitButton 'Установить «AAA Windows video» как фон' 120)
  [void](WaitSettings {param($s) $s.wallpaper -eq 'workshop' -and $s.wallpaper_workshop_project -like '*123*'} 'Workshop video selected')
  Click (WaitId 'prefs-save')
  AssertAnimated 'MP4'
  Screenshot 'windows-mp4.png'
  StopLauncher
  StartLauncher
  Start-Sleep -Seconds 2
  AssertAnimated 'MP4_RESTART'
  Write-Host 'WINDOWS_REGISTRY_AND_SECOND_STEAM_LIBRARY_OK'

  OpenPrefs 'Фон'
  Click (WaitButton 'Открыть «BBB Windows scene» в Wallpaper Engine' 120)
  Click (WaitId 'confirm-cancel')
  Start-Sleep -Milliseconds 500
  if(Test-Path $env:OMNISPEC_TEST_WE_LOG){throw 'Wallpaper Engine launched after cancellation'}
  InvokeEngine 'BBB Windows scene' $sceneDir
  InvokeEngine 'CCC Windows web' $webDir
  Write-Host 'WINDOWS_WE_STUB_ONLY_NOT_REAL_ENGINE'

  SetText 'wall-link' 'https://upload.wikimedia.org/wikipedia/commons/2/2c/Rotating_earth_%28large%29.gif'
  Click (WaitId 'wall-link-add')
  $saved=WaitSettings {param($s) $s.wallpaper -eq 'custom' -and $s.custom_wallpaper -like '*.gif' -and $s.custom_wallpaper -ne 'custom.gif'} 'direct HTTPS GIF' 150
  $download=Join-Path (Join-Path $data 'wallpapers') $saved.custom_wallpaper
  $bytes=[IO.File]::ReadAllBytes($download)
  if($bytes.Length -lt 100000 -or [Text.Encoding]::ASCII.GetString($bytes,0,4) -ne 'GIF8'){throw 'Direct URL did not save a GIF'}
  if(@($saved.skin_presets).Count -ne 3 -or @($saved.skin_favorites)[0].futureField -ne 'preserved'){throw 'Settings changed after wallpaper download'}
  Write-Host 'WINDOWS_DIRECT_HTTPS_GIF_OK'
  Write-Host 'WINDOWS_PROFILE_WALLPAPER_PREFLIGHT_PASSED'
} catch {
  Screenshot 'windows-profile-failure.png'
  foreach($node in @($script:ui,$script:dialog)) {
    if($node){
      Write-Host 'ACCESSIBILITY_NODES:'
      foreach($n in $node.FindAll($scope,$all)) {
        try {if($n.Current.Name -or $n.Current.AutomationId){Write-Host ("type={0} name=[{1}] id=[{2}] enabled={3} rect={4}" -f $n.Current.ControlType.ProgrammaticName,$n.Current.Name,$n.Current.AutomationId,$n.Current.IsEnabled,$n.Current.BoundingRectangle)}}catch{}
      }
    }
  }
  throw
} finally {
  StopLauncher
  if($regCreated){Remove-Item -Path $reg -Recurse -Force -ErrorAction SilentlyContinue}
  elseif($regHad){New-ItemProperty -Path $reg -Name SteamPath -Value $regOld -PropertyType String -Force | Out-Null}
  else {Remove-ItemProperty -Path $reg -Name SteamPath -ErrorAction SilentlyContinue}
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
