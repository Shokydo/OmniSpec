# Disposable Windows CI test of real Tauri/WebView2 install paths using live
# Modrinth or CurseForge. Never uses a real launcher profile or Minecraft data.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Launcher,
  [ValidateSet('existing','create','inside')][string]$Scenario='existing',
  [ValidateSet('modrinth','curseforge')][string]$Source='modrinth'
)
$ErrorActionPreference='Stop'
if (-not $env:CI -or -not $env:RUNNER_TEMP) { throw 'Run only on a disposable Windows CI runner.' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OmniModProbe {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int hgt,bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint data,UIntPtr extra);
  public static void Click(int x,int y) { SetCursorPos(x,y); mouse_event(2,0,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(60); mouse_event(4,0,0,0,UIntPtr.Zero); }
}
'@
$root=Join-Path $env:RUNNER_TEMP ('omnispec-mod-install-'+[Guid]::NewGuid().ToString('N'))
$data=Join-Path $root 'data'; $inst=Join-Path $data 'instances\fixture'
$diagnostics=Join-Path 'diagnostic-mod-install' ("$Scenario-$Source")
$projectId=if($Source -eq 'curseforge'){'306612'}else{'P7dR8mSH'}
$utf8=[Text.UTF8Encoding]::new($false)
New-Item -ItemType Directory -Force (Join-Path $inst 'minecraft') | Out-Null
[IO.File]::WriteAllText((Join-Path $inst 'instance.json'),('{"id":"fixture","name":"Fixture Fabric","mc_version":"1.21.1","loader":{"type":"fabric","version":"0.16.10"}}'),$utf8)
[IO.File]::WriteAllText((Join-Path $data 'settings.json'),('{"onboarded":true,"ambient":"off","click_fx":"off","update_enabled":false,"discord_rpc":false,"feed_grid":1,"theme":"dark"}'),$utf8)
$env:OMNISPEC_HOME=$data
$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $root 'webview'
$scope=[System.Windows.Automation.TreeScope]::Descendants
$script:proc=$null; $script:ui=$null
function CheckAlive {
  $script:proc.Refresh()
  if($script:proc.HasExited) {
    $signed=[int]$script:proc.ExitCode; $unsigned=[uint32]([long]$signed -band 0xffffffffL)
    throw ('LAUNCHER_CLOSED_EXIT {0} (0x{1:X8})' -f $signed,$unsigned)
  }
}
function FindId($id) {
  $c=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$id)
  try{return $script:ui.FindFirst($scope,$c)}catch{return $null}
}
function FindName($name,$type=$null,$root=$script:ui) {
  $n=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name)
  if($type){$t=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,$type);$n=[System.Windows.Automation.AndCondition]::new($n,$t)}
  try{return $root.FindFirst($scope,$n)}catch{return $null}
}
function WaitElement([scriptblock]$find,[string]$what,[int]$seconds=90) {
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end){ CheckAlive; $el=& $find; if($null -ne $el){return $el}; Start-Sleep -Milliseconds 200 }
  throw "Timed out waiting for $what"
}
function WaitId($id,$seconds=90) { return WaitElement {FindId $id} "id=$id" $seconds }
function Click($n) {
  $pattern=$null
  if($n.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) {$pattern.Select();return}
  $pattern=$null
  if($n.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {$pattern.Invoke();return}
  $r=$n.Current.BoundingRectangle
  if($r.Width -gt 0 -and $r.Height -gt 0){[OmniModProbe]::Click([int](($r.Left+$r.Right)/2),[int](($r.Top+$r.Bottom)/2));return}
  $n.SetFocus();[System.Windows.Forms.SendKeys]::SendWait(' ')
}
function Screenshot($name) {
  try { New-Item -ItemType Directory -Force $diagnostics | Out-Null; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object Drawing.Bitmap $b.Width,$b.Height; $g=[Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size);$bmp.Save((Join-Path (Resolve-Path $diagnostics).Path $name));$g.Dispose();$bmp.Dispose() } catch { Write-Host "Screenshot error: $_" }
}
function SearchFabric($id) {
  # The source/type switch may replace this WebView2 input. Reacquire until it
  # has a real on-screen rectangle rather than focusing a stale UIA element.
  # WebView2 doesn't expose ValuePattern here on all runners, so type normally.
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  while([DateTime]::UtcNow -lt $deadline) {
    CheckAlive
    try {
      $input=FindId $id
      if($input -and $input.Current.IsEnabled) {
        $r=$input.Current.BoundingRectangle
        if($r.Width -gt 0 -and $r.Height -gt 0) {
          [void][OmniModProbe]::SetForegroundWindow($script:proc.MainWindowHandle)
          [OmniModProbe]::Click([int](($r.Left+$r.Right)/2),[int](($r.Top+$r.Bottom)/2))
          [System.Windows.Forms.SendKeys]::SendWait('^a')
          [System.Windows.Forms.SendKeys]::SendWait('Fabric API')
          Start-Sleep -Milliseconds 500
          return
        }
      }
    } catch { }
    Start-Sleep -Milliseconds 200
  }
  throw "Search input $id did not become clickable"
}
function FixtureButton {
  $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
  foreach($element in $script:ui.FindAll($scope,$condition)) {
    if($element.Current.Name -like '*Fixture Fabric*' -and $element.Current.IsEnabled) { return $element }
  }
  return $null
}
function SelectComboOption([string]$id,[string]$name) {
  $combo=WaitElement {$element=FindId $id; if($element -and $element.Current.IsEnabled){return $element}; return $null} "enabled combo $id" 120
  $expand=$null
  if($combo.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$expand)) {
    $expand.Expand()
    Start-Sleep -Milliseconds 200
  } else {
    $combo.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait('%{DOWN}')
    Start-Sleep -Milliseconds 200
  }
  $choice=WaitElement {
    $current=FindId $id
    $option=if($current){FindName $name $null $current}else{$null}
    if(-not $option){$option=FindName $name}
    return $option
  } "option $name in $id" 30
  Click $choice
  Write-Host "WINDOWS_MOD_OPTION_SELECTED id=$id value=$name"
}
function ActivateCurseForge([string]$scopeName) {
  # Hosted runners can have a 1024 px display while OmniSpec's window is
  # 1400 px wide. Unlike ordinary buttons, aria-pressed buttons may expose
  # neither Invoke nor SelectionItem, so a mouse click would be clamped at
  # the right edge. Move the window temporarily to put the actual source
  # control on screen, then restore it before typing into the search field.
  for($attempt=0;$attempt -lt 3;$attempt++) {
    $target=WaitId "$scopeName-source-curseforge"
    $bounds=$target.Current.BoundingRectangle
    $area=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $centerX=($bounds.Left+$bounds.Right)/2
    $shift=0
    if($centerX -gt ($area.Right-30)) {$shift=[int](($area.Right-80)-$centerX)}
    if($centerX -lt ($area.Left+30)) {$shift=[int](($area.Left+80)-$centerX)}
    Write-Host "WINDOWS_MOD_SOURCE_CLICK scope=$scopeName attempt=$attempt center=$centerX screenRight=$($area.Right) shift=$shift"
    if($shift -ne 0) {
      [void][OmniModProbe]::MoveWindow($script:proc.MainWindowHandle,$shift,0,1400,850,$true)
      Start-Sleep -Milliseconds 400
      $target=WaitId "$scopeName-source-curseforge"
      $bounds=$target.Current.BoundingRectangle
    }
    try {
      [void][OmniModProbe]::SetForegroundWindow($script:proc.MainWindowHandle)
      $x=[int](($bounds.Left+$bounds.Right)/2); $y=[int](($bounds.Top+$bounds.Bottom)/2)
      if($x -lt $area.Left -or $x -ge $area.Right -or $y -lt $area.Top -or $y -ge $area.Bottom) {throw "Source button remains outside screen at $x,$y"}
      [OmniModProbe]::Click($x,$y)
      Start-Sleep -Milliseconds 300
    } finally {
      if($shift -ne 0) {
        [void][OmniModProbe]::MoveWindow($script:proc.MainWindowHandle,0,0,1400,850,$true)
        Start-Sleep -Milliseconds 300
      }
    }
    try {
      if($scopeName -eq 'dl') { [void](WaitId 'cf-type' 20) }
      else { [void](WaitElement {FindName 'Just Enough Items (JEI)' ([System.Windows.Automation.ControlType]::Group)} 'CurseForge popular result' 20) }
      Write-Host "WINDOWS_MOD_SOURCE_CONFIRMED scope=$scopeName source=curseforge"
      return
    } catch { CheckAlive }
  }
  throw 'CurseForge source did not become active'
}
try {
  $launcherPath=(Resolve-Path $Launcher).Path
  $script:proc=Start-Process -FilePath $launcherPath -PassThru -RedirectStandardOutput (Join-Path $root 'stdout.log') -RedirectStandardError (Join-Path $root 'stderr.log')
  for($i=0;$i -lt 150;$i++){Start-Sleep -Milliseconds 300;CheckAlive;if($script:proc.MainWindowHandle -ne [IntPtr]::Zero){break}}
  if($script:proc.MainWindowHandle -eq [IntPtr]::Zero){throw 'No launcher window'}
  [void][OmniModProbe]::MoveWindow($script:proc.MainWindowHandle,0,0,1400,850,$true)
  [void][OmniModProbe]::SetForegroundWindow($script:proc.MainWindowHandle)
  $script:ui=[System.Windows.Automation.AutomationElement]::FromHandle($script:proc.MainWindowHandle)
  [void](WaitId 'dv-query' 120)
  Write-Host "WINDOWS_MOD_UI_STARTED scenario=$Scenario source=$Source"
  $buttonType=[System.Windows.Automation.ControlType]::Button
  if($Scenario -eq 'inside') {
    Click (WaitElement {FixtureButton} 'existing fixture button')
    Click (WaitElement {FindName 'Загрузить' $buttonType} 'instance download tab')
    if($Source -eq 'curseforge'){ActivateCurseForge 'dl'}
    SearchFabric 'dl-query'
  } else {
    Click (WaitElement {FindName 'Моды' $buttonType} 'home Mods button')
    [void](WaitElement {$e=FindId 'dv-query'; if($e -and $e.Current.Name -eq 'Поиск модов'){return $e}; return $null} 'home mod search')
    if($Source -eq 'curseforge'){ActivateCurseForge 'dv'}
    SearchFabric 'dv-query'
  }
  $groupType=[System.Windows.Automation.ControlType]::Group
  $download=WaitElement {
    $group=FindName 'Fabric API' $groupType
    if($group){return FindName 'Скачать' $buttonType $group}; return $null
  } 'Fabric API download button' 120
  Click $download
  if($Scenario -ne 'inside') {
    [void](WaitId 'modal-mod-target')
    # Compatibility checking re-renders the entire dialog. Wait until that
    # finishes before clicking a radio or the create button, otherwise UIA
    # can invoke a detached button without changing the visible dialog.
    $radioType=[System.Windows.Automation.ControlType]::RadioButton
    $radio=WaitElement {
      $body=FindId 'modal-mod-target'; if(-not $body){return $null}
      $c=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,$radioType)
      $r=$body.FindFirst($scope,$c); if($r -and $r.Current.IsEnabled){return $r}; return $null
    } 'compatible Fabric instance' 120
    if($Scenario -eq 'create') {
      Click (WaitId 'mod-target-create')
      [void](WaitId 'mod-target-name' 30)
      # Loader versions load asynchronously and replace the controls. Wait for
      # the initial render to settle before opening the native options list.
      [void](WaitElement {$el=FindId 'mod-target-submit'; if($el -and $el.Current.IsEnabled){return $el}; return $null} 'initial new-instance options' 150)
      # Exercise the same Minecraft/Fabric combination as the reported issue,
      # not merely whichever newest game happens to be the default today.
      SelectComboOption 'mod-target-mc' '1.21.1'
    } else {
      Click $radio
    }
    $submit=WaitElement {$el=FindId 'mod-target-submit';if($el -and $el.Current.IsEnabled){return $el};return $null} 'enabled install button' 150
    Write-Host "WINDOWS_MOD_COMPATIBILITY_CONFIRMED scenario=$Scenario source=$Source"
    Click $submit
  }
  # Wait for the actual on-disk content record (the JAR alone can appear
  # slightly before the command completes). A new instance gets a new ID.
  $deadline=[DateTime]::UtcNow.AddSeconds(240); $file=$null; $stored=$null
  while([DateTime]::UtcNow -lt $deadline){
    CheckAlive
    $candidates=if($Scenario -eq 'create'){
      Get-ChildItem -LiteralPath (Join-Path $data 'instances') -Filter 'content.json' -File -Recurse -ErrorAction SilentlyContinue
    } else { Get-Item -LiteralPath (Join-Path $inst 'content.json') -ErrorAction SilentlyContinue }
    foreach($manifest in $candidates){
      try {
        if($Scenario -eq 'create' -and $manifest.Directory.Name -eq 'fixture'){continue}
        $record=[IO.File]::ReadAllText($manifest.FullName) | ConvertFrom-Json
        $match=$record.files.PSObject.Properties | Where-Object {$_.Value.project_id -eq $projectId -and $_.Value.source -eq $Source} | Select-Object -First 1
        if(-not $match){continue}
        $candidate=Get-Item -LiteralPath (Join-Path $manifest.Directory.FullName ('minecraft\mods\' + $match.Value.filename)) -ErrorAction SilentlyContinue
        if($candidate){$file=$candidate;$stored=$match;break}
      } catch { }
    }
    if($file){break}; Start-Sleep -Milliseconds 250
  }
  if(-not $file -or -not $stored){throw 'Mod JAR and content record not installed before timeout'}
  Start-Sleep -Seconds 3;CheckAlive
  $meta=[IO.File]::ReadAllText((Join-Path $manifest.Directory.FullName 'instance.json')) | ConvertFrom-Json
  if($meta.mc_version -ne '1.21.1' -or $meta.loader.type -ne 'fabric') {throw "Wrong target instance: MC=$($meta.mc_version) loader=$($meta.loader.type)"}
  if($file.Length -lt 100000){throw "Unexpectedly small downloaded JAR: $($file.Length)"}
  $sha=(Get-FileHash -Algorithm SHA1 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
  if(-not $stored.Value.sha1 -or $stored.Value.sha1.ToLowerInvariant() -ne $sha){throw "Downloaded JAR SHA1 did not match recorded $Source metadata"}
  Write-Host "WINDOWS_REAL_MOD_INSTALL_PASSED scenario=$Scenario source=$Source mc=$($meta.mc_version) loader=$($meta.loader.type) file=$($file.Name) bytes=$($file.Length) sha1=$sha process-alive=true"
} catch {
  Write-Host "WINDOWS_MOD_INSTALL_FAILED: $_"
  Screenshot 'failure.png'
  if($script:ui){
    try {
      $all=$script:ui.FindAll($scope,[System.Windows.Automation.Condition]::TrueCondition); $lines=@()
      foreach($n in $all){$c=$n.Current; $lines+=('{0} | {1} | {2} | enabled={3}' -f $c.ControlType.ProgrammaticName,$c.AutomationId,$c.Name,$c.IsEnabled)}
      $lines | Set-Content (Join-Path $diagnostics 'uia.txt') -Encoding UTF8
    }catch{}
  }
  throw
} finally {
  if($script:proc){try{$script:proc.Refresh();if(-not $script:proc.HasExited){[void]$script:proc.CloseMainWindow();if(-not $script:proc.WaitForExit(5000)){Stop-Process -Id $script:proc.Id -Force -ErrorAction SilentlyContinue}}}catch{}}
  try {New-Item -ItemType Directory -Force $diagnostics | Out-Null; Copy-Item (Join-Path $root '*.log') $diagnostics -ErrorAction SilentlyContinue}catch{}
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
