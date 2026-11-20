# Disposable Windows CI test: real Tauri/WebView2 session recovery and
# concurrent observation of synthetic processes, NOT Minecraft itself.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Launcher)
$ErrorActionPreference='Stop'
if (-not $env:CI -or -not $env:RUNNER_TEMP) { throw 'Run only on a disposable Windows CI runner.' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OmniSessionProbe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int hgt,bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint data,UIntPtr extra);
  public static void Click(int x,int y) { SetCursorPos(x,y); mouse_event(2,0,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(60); mouse_event(4,0,0,0,UIntPtr.Zero); }
}
'@
$root=Join-Path $env:RUNNER_TEMP ('omnispec-sessions-'+[Guid]::NewGuid().ToString('N'))
$data=Join-Path $root 'data'; $inst=Join-Path $data 'instances\fixture'
$game=Join-Path $inst 'minecraft'; $journal=Join-Path $data 'running-sessions'
$diag=Join-Path 'diagnostic-session-recovery' 'windows'
$utf8=[Text.UTF8Encoding]::new($false)
$scope=[System.Windows.Automation.TreeScope]::Descendants
$script:apps=@(); $script:children=@()
New-Item -ItemType Directory -Force $game,$journal,$diag | Out-Null
[IO.File]::WriteAllText((Join-Path $inst 'instance.json'),('{"id":"fixture","name":"Fixture Fabric","mc_version":"1.21.1","loader":{"type":"fabric","version":"0.16.10"},"playtime_secs":0}'),$utf8)
[IO.File]::WriteAllText((Join-Path $data 'settings.json'),('{"onboarded":true,"update_enabled":false,"discord_rpc":false,"ambient":"off","click_fx":"off","theme":"dark"}'),$utf8)
$env:OMNISPEC_HOME=$data

function CheckApps {
  foreach($app in $script:apps) {
    if($app.Closed){continue}
    $app.Proc.Refresh()
    if($app.Proc.HasExited){throw "Launcher $($app.Label) exited unexpectedly with $($app.Proc.ExitCode)"}
  }
}
function WaitResult([scriptblock]$find,[string]$what,[int]$seconds=90) {
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) {
    CheckApps
    try { $value=& $find; if($null -ne $value -and $value -ne $false){return $value} } catch { }
    Start-Sleep -Milliseconds 200
  }
  throw "Timed out waiting for $what"
}
function FindId($app,[string]$id) {
  $c=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$id)
  try{return $app.Ui.FindFirst($scope,$c)}catch{return $null}
}
function FindName($app,[string]$name) {
  $c=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name)
  try{return $app.Ui.FindFirst($scope,$c)}catch{return $null}
}
function FixtureButton($app) {
  $c=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
  try { foreach($element in $app.Ui.FindAll($scope,$c)) { if($element.Current.Name -like '*Fixture Fabric*' -and $element.Current.IsEnabled){return $element} } } catch { }
  return $null
}
function Click($app,$node) {
  [void][OmniSessionProbe]::SetForegroundWindow($app.Proc.MainWindowHandle)
  $pattern=$null
  if($node.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {$pattern.Invoke();return}
  $pattern=$null
  if($node.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) {$pattern.Select();return}
  $r=$node.Current.BoundingRectangle
  if($r.Width -le 0 -or $r.Height -le 0){throw 'Element has no clickable rectangle'}
  [OmniSessionProbe]::Click([int](($r.Left+$r.Right)/2),[int](($r.Top+$r.Bottom)/2))
}
function StartLauncher([string]$label) {
  $env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $root ("webview-"+$label)
  $proc=Start-Process -FilePath (Resolve-Path $Launcher).Path -PassThru -RedirectStandardOutput (Join-Path $root "$label-stdout.log") -RedirectStandardError (Join-Path $root "$label-stderr.log")
  $app=[pscustomobject]@{Label=$label;Proc=$proc;Ui=$null;Closed=$false}
  $script:apps+=@($app)
  [void](WaitResult {$proc.Refresh();if($proc.MainWindowHandle -ne [IntPtr]::Zero){return $true};return $null} "window $label" 120)
  [void][OmniSessionProbe]::MoveWindow($proc.MainWindowHandle,0,0,1400,850,$true)
  $app.Ui=[System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  [void](WaitResult {FindId $app 'btn-home'} "UI $label" 120)
  return $app
}
function OpenFixture($app,[bool]$running) {
  $status=if($running){'запущена'}else{'остановлена'}
  if($running){[void](WaitResult {FindName $app 'ЗАПУЩЕННЫЕ'} "recovered sessions in $($app.Label)" 90)}
  for($attempt=0;$attempt -lt 6;$attempt++) {
    if(FindName $app ("Fixture Fabric — "+$status)){return}
    $button=FixtureButton $app
    if(-not $button) {
      Click $app (WaitResult {FindId $app 'btn-home'} "home $($app.Label)")
      $button=WaitResult {FixtureButton $app} "fixture $($app.Label)"
    }
    # Use a real pointer for the home card; an Invoke on an element replaced
    # during the asynchronous initial render may return without a click.
    $r=$button.Current.BoundingRectangle; $area=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $x=[int](($r.Left+$r.Right)/2);$y=[int](($r.Top+$r.Bottom)/2)
    if($r.Width -gt 0 -and $r.Height -gt 0 -and $x -ge $area.Left -and $x -lt $area.Right -and $y -ge $area.Top -and $y -lt $area.Bottom) {
      [void][OmniSessionProbe]::SetForegroundWindow($app.Proc.MainWindowHandle); [OmniSessionProbe]::Click($x,$y)
    } else { Click $app $button }
    try {
      [void](WaitResult {FindName $app ("Fixture Fabric — "+$status)} "fixture $status in $($app.Label)" 8)
      return
    } catch { CheckApps }
  }
  throw "Could not open fixture $status in $($app.Label)"
}
function CloseLauncher($app,[bool]$normal) {
  if($normal) {
    [void]$app.Proc.CloseMainWindow()
    $app.Closed=$true
    if(-not $app.Proc.WaitForExit(15000)){throw "Window $($app.Label) did not close"}
    if($app.Proc.ExitCode -ne 0){throw "Normal close returned $($app.Proc.ExitCode)"}
  } else {
    $app.Closed=$true
    $app.Proc.Kill(); [void]$app.Proc.WaitForExit(10000)
  }
}
function ReadMeta { return [IO.File]::ReadAllText((Join-Path $inst 'instance.json')) | ConvertFrom-Json }
function HasJournal([string]$id) { return Test-Path -LiteralPath (Join-Path $journal ($id+'.json')) }
function CheckChild($p) { $p.Refresh(); if($p.HasExited){throw "Synthetic game $($p.Id) exited unexpectedly"} }

try {
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); $starts=@(($now-12),($now-8)); $nonces=@(('a'*32),('b'*32))
  $ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  for($i=0;$i -lt 2;$i++) {
    $child=Start-Process -FilePath $ps -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command','Start-Sleep -Seconds 240') -PassThru
    $script:children+=@($child)
    CheckChild $child
    [long]$created=0; [long]$exited=0; [long]$kernel=0; [long]$user=0
    if(-not [OmniSessionProbe]::GetProcessTimes($child.Handle,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user)){throw "GetProcessTimes failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"}
    $id=$nonces[$i]
    $entry=[ordered]@{run_id="fixture#$id";instance_id='fixture';account='Fixture';game_dir=$game;started_at=$starts[$i];checkpoint_at=$starts[$i];process=@{pid=$child.Id;start=$created;boot=''}}
    [IO.File]::WriteAllText((Join-Path $journal ($id+'.json')),($entry | ConvertTo-Json -Depth 6),$utf8)
  }
  $one=StartLauncher 'one'; OpenFixture $one $true
  $two=StartLauncher 'two'; OpenFixture $two $true
  [void](WaitResult {FindName $one '2 окна'} 'two sessions in the first UI' 90)
  [void](WaitResult {FindName $two '2 окна'} 'two sessions in the second UI' 90)
  [void](WaitResult {
    $a=[IO.File]::ReadAllText((Join-Path $journal ($nonces[0]+'.json'))) | ConvertFrom-Json
    $b=[IO.File]::ReadAllText((Join-Path $journal ($nonces[1]+'.json'))) | ConvertFrom-Json
    $meta=ReadMeta
    if($a.checkpoint_at -gt $starts[0] -and $b.checkpoint_at -gt $starts[1] -and $meta._omnispec_playtime_checkpoints){return $true};return $null
  } 'both journals and playtime checkpoints' 90)
  Write-Host 'WINDOWS_SESSION_TWO_LAUNCHERS_TWO_LIVE_PROCESSES'

  $script:children[1].Kill(); [void]$script:children[1].WaitForExit(10000)
  $endedB=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  [void](WaitResult {if(-not (HasJournal $nonces[1])){return $true};return $null} 'second session finalized' 90)
  [void](WaitResult {if(-not (FindName $one '2 окна')){return $true};return $null} 'first UI observed the exit' 90)
  [void](WaitResult {if(-not (FindName $two '2 окна')){return $true};return $null} 'second UI observed the exit' 90)
  Start-Sleep -Seconds 2; CheckApps; CheckChild $script:children[0]
  if(HasJournal $nonces[1]){throw 'Second session journal was resurrected'}
  CloseLauncher $one $true
  CheckChild $script:children[0]
  CloseLauncher $two $false
  CheckChild $script:children[0]
  Write-Host 'WINDOWS_SESSION_CONCURRENT_EXIT_AND_CLOSE_OK'

  $three=StartLauncher 'three'; OpenFixture $three $true
  $stop=WaitResult { $n=FindId $three 'btn-stop';if($n -and $n.Current.IsEnabled){return $n};return $null } 'stop button' 90
  Click $three $stop
  if(-not $script:children[0].WaitForExit(15000)){throw 'Recovered synthetic process was not stopped'}
  $endedA=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  [void](WaitResult {if(-not (HasJournal $nonces[0])){return $true};return $null} 'first session finalized' 90)
  [void](WaitResult {FindName $three 'Fixture Fabric — остановлена'} 'stopped UI' 90)
  $meta=ReadMeta; $actual=[long]$meta.playtime_secs
  $expected=($endedA-$starts[0])+($endedB-$starts[1])
  if([Math]::Abs($actual-$expected) -gt 5){throw "Playtime mismatch: actual=$actual expected=$expected"}
  if($meta._omnispec_playtime_checkpoints){throw 'Final checkpoint markers were not cleared'}
  CloseLauncher $three $true
  $four=StartLauncher 'four'; OpenFixture $four $false
  Start-Sleep -Seconds 2; CheckApps
  if((ReadMeta).playtime_secs -ne $actual -or (HasJournal $nonces[0]) -or (HasJournal $nonces[1])){throw 'Restart double-counted or recreated a session'}
  Write-Host "WINDOWS_SESSION_RECOVERY_AND_NO_DOUBLE_COUNT_PASSED seconds=$actual expected=$expected"
} catch {
  Write-Host "WINDOWS_SESSION_RECOVERY_FAILED: $_"
  try {
    $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object Drawing.Bitmap $b.Width,$b.Height; $g=[Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size);$bmp.Save((Join-Path (Resolve-Path $diag).Path 'failure.png'));$g.Dispose();$bmp.Dispose()
    Copy-Item (Join-Path $inst 'instance.json') (Join-Path $diag 'instance.json') -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $journal '*.json') $diag -ErrorAction SilentlyContinue
    foreach($app in $script:apps) {
      if(-not $app.Ui -or $app.Closed){continue}
      $all=$app.Ui.FindAll($scope,[System.Windows.Automation.Condition]::TrueCondition);$lines=@()
      foreach($n in $all){$c=$n.Current;$lines+=('{0} | {1} | {2} | enabled={3}' -f $c.ControlType.ProgrammaticName,$c.AutomationId,$c.Name,$c.IsEnabled)}
      $lines | Set-Content (Join-Path $diag ($app.Label+'-uia.txt')) -Encoding UTF8
    }
  } catch { Write-Host "Diagnostics error: $_" }
  throw
} finally {
  foreach($app in $script:apps){try{$app.Proc.Refresh();if(-not $app.Proc.HasExited){$app.Proc.Kill();[void]$app.Proc.WaitForExit(10000)}}catch{}}
  foreach($child in $script:children){try{$child.Refresh();if(-not $child.HasExited){$child.Kill();[void]$child.WaitForExit(10000)}}catch{}}
  try {Copy-Item (Join-Path $root '*.log') $diag -ErrorAction SilentlyContinue}catch{}
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
