# Real Windows Tauri launch/recovery of a locally compiled Java fixture.
# This is not Minecraft and uses only an isolated temporary profile.
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
public static class OmniJavaLaunchProbe {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int hgt,bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint data,UIntPtr extra);
  public static void Click(int x,int y) { SetCursorPos(x,y); mouse_event(2,0,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(60); mouse_event(4,0,0,0,UIntPtr.Zero); }
}
'@
$root=Join-Path $env:RUNNER_TEMP ('omnispec-java-launch-'+[Guid]::NewGuid().ToString('N'))
$data=Join-Path $root 'data'; $inst=Join-Path $data 'instances\fixture'
$game=Join-Path $inst 'minecraft'; $version=Join-Path $data 'meta\versions\fixture'
$journal=Join-Path $data 'running-sessions'; $diag=Join-Path 'diagnostic-java-launch' 'windows'
$utf8=[Text.UTF8Encoding]::new($false)
$scope=[System.Windows.Automation.TreeScope]::Descendants
$script:apps=@(); $script:javaProcess=$null
New-Item -ItemType Directory -Force $game,$version,$diag | Out-Null
$javac=(Get-Command javac.exe -ErrorAction Stop).Source
$bin=Split-Path -Parent $javac; $java=Join-Path $bin 'java.exe'; $jarTool=Join-Path $bin 'jar.exe'
if(-not (Test-Path $java) -or -not (Test-Path $jarTool)){throw 'A JDK 11+ is required for this test'}
$source=Join-Path $root 'FakeGame.java'
[IO.File]::WriteAllText($source,@'
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
public class FakeGame {
  public static void main(String[] args) throws Exception {
    Files.writeString(Path.of("fakegame.pid"), Long.toString(ProcessHandle.current().pid()), StandardCharsets.UTF_8);
    for (int i = 0; i < 600; i++) {
      Files.writeString(Path.of("fakegame.heartbeat"), Integer.toString(i), StandardCharsets.UTF_8);
      System.out.println("fake-game-stdout " + i);
      System.err.println("fake-game-stderr " + i);
      Thread.sleep(500);
    }
  }
}
'@,$utf8)
& $javac '-d' $root $source
if($LASTEXITCODE -ne 0){throw 'javac failed'}
$jar=Join-Path $version 'fixture.jar'
& $jarTool 'cf' $jar '-C' $root 'FakeGame.class'
if($LASTEXITCODE -ne 0){throw 'jar failed'}
$profile=[ordered]@{id='fixture';type='release';mainClass='FakeGame';javaVersion=@{majorVersion=11};
  downloads=@{client=@{url='http://127.0.0.1:1/not-used.jar';size=(Get-Item $jar).Length}};
  libraries=@();arguments=@{jvm=@('-cp','${classpath}');game=@('--fixture')}}
[IO.File]::WriteAllText((Join-Path $version 'fixture.json'),($profile | ConvertTo-Json -Depth 10),$utf8)
[IO.File]::WriteAllText((Join-Path $inst 'instance.json'),'{"id":"fixture","name":"Fixture Java","mc_version":"fixture","loader":{"type":"vanilla"},"playtime_secs":0}',$utf8)
$settings=[ordered]@{onboarded=$true;update_enabled=$false;discord_rpc=$false;ambient='off';click_fx='off';theme='dark';auto_java=$false;java_path=$java;memory_mb=512;jvm_args=''}
[IO.File]::WriteAllText((Join-Path $data 'settings.json'),($settings | ConvertTo-Json -Depth 4),$utf8)
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
  try { foreach($e in $app.Ui.FindAll($scope,$c)) { if($e.Current.Name -like '*Fixture Java*' -and $e.Current.IsEnabled){return $e} } } catch { }
  return $null
}
function Click($app,$node) {
  [void][OmniJavaLaunchProbe]::SetForegroundWindow($app.Proc.MainWindowHandle)
  $pattern=$null
  if($node.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {$pattern.Invoke();return}
  $r=$node.Current.BoundingRectangle
  if($r.Width -le 0 -or $r.Height -le 0){throw 'Element has no clickable rectangle'}
  [OmniJavaLaunchProbe]::Click([int](($r.Left+$r.Right)/2),[int](($r.Top+$r.Bottom)/2))
}
function StartLauncher([string]$label) {
  $env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $root ("webview-"+$label)
  $proc=Start-Process -FilePath (Resolve-Path $Launcher).Path -PassThru -RedirectStandardOutput (Join-Path $root "$label-stdout.log") -RedirectStandardError (Join-Path $root "$label-stderr.log")
  $app=[pscustomobject]@{Label=$label;Proc=$proc;Ui=$null;Closed=$false}
  $script:apps+=@($app)
  [void](WaitResult {$proc.Refresh();if($proc.MainWindowHandle -ne [IntPtr]::Zero){return $true};return $null} "window $label" 120)
  [void][OmniJavaLaunchProbe]::MoveWindow($proc.MainWindowHandle,0,0,1400,850,$true)
  $app.Ui=[System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  [void](WaitResult {FindId $app 'btn-home'} "UI $label" 120)
  return $app
}
function OpenFixture($app,[bool]$running) {
  $status=if($running){'запущена'}else{'остановлена'}
  if($running){[void](WaitResult {FindName $app 'ЗАПУЩЕННЫЕ'} "recovered sessions $($app.Label)" 90)}
  for($attempt=0;$attempt -lt 6;$attempt++) {
    if(FindName $app ("Fixture Java — "+$status)){return}
    $button=WaitResult {FixtureButton $app} "fixture $($app.Label)" 90
    $r=$button.Current.BoundingRectangle; $area=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $x=[int](($r.Left+$r.Right)/2);$y=[int](($r.Top+$r.Bottom)/2)
    if($r.Width -gt 0 -and $r.Height -gt 0 -and $x -ge $area.Left -and $x -lt $area.Right -and $y -ge $area.Top -and $y -lt $area.Bottom) {
      [void][OmniJavaLaunchProbe]::SetForegroundWindow($app.Proc.MainWindowHandle); [OmniJavaLaunchProbe]::Click($x,$y)
    } else { Click $app $button }
    try { [void](WaitResult {FindName $app ("Fixture Java — "+$status)} "fixture $status" 8);return } catch {CheckApps}
  }
  throw "Could not open fixture $status in $($app.Label)"
}
function CloseLauncher($app) {
  [void]$app.Proc.CloseMainWindow(); $app.Closed=$true
  if(-not $app.Proc.WaitForExit(15000)){throw "Window $($app.Label) did not close"}
  if($app.Proc.ExitCode -ne 0){throw "Normal close returned $($app.Proc.ExitCode)"}
}
function Meta { return [IO.File]::ReadAllText((Join-Path $inst 'instance.json')) | ConvertFrom-Json }
try {
  $one=StartLauncher 'one'; OpenFixture $one $false
  $play=WaitResult {$n=FindId $one 'btn-play';if($n -and $n.Current.IsEnabled){return $n};return $null} 'play button'
  Click $one $play
  $pidFile=Join-Path $game 'fakegame.pid'; $heartbeat=Join-Path $game 'fakegame.heartbeat'
  $childId=[int](WaitResult {if(Test-Path $pidFile){return [IO.File]::ReadAllText($pidFile)};return $null} 'launched Java pid' 90)
  $script:javaProcess=Get-Process -Id $childId -ErrorAction Stop
  [void]$script:javaProcess.Handle
  $file=WaitResult {$files=@(Get-ChildItem -LiteralPath $journal -Filter '*.json' -ErrorAction SilentlyContinue);if($files.Count -eq 1){return $files[0]};return $null} 'session journal'
  $record=[IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json
  if($record.process.pid -ne $childId -or $record.instance_id -ne 'fixture'){throw 'Journal does not identify the actual launched Java process'}
  [void](WaitResult {FindName $one 'Fixture Java — запущена'} 'running fixture UI')
  $beat=[int](WaitResult {if(Test-Path $heartbeat){return [IO.File]::ReadAllText($heartbeat)};return $null} 'Java heartbeat')
  Write-Host "WINDOWS_LAUNCH_JAVA_FIXTURE_STARTED_AND_REGISTERED pid=$childId"
  CloseLauncher $one
  $script:javaProcess.Refresh();if($script:javaProcess.HasExited){throw 'Closing launcher killed Java child'}
  [void](WaitResult {if((Test-Path $heartbeat) -and [int][IO.File]::ReadAllText($heartbeat) -gt ($beat+2)){return $true};return $null} 'Java heartbeat after launcher closed' 30)
  $script:javaProcess.Refresh();if($script:javaProcess.HasExited){throw 'Java child stopped after writing to closed pipes'}
  Write-Host 'WINDOWS_LAUNCH_JAVA_FIXTURE_SURVIVED_CLOSED_LAUNCHER'
  $two=StartLauncher 'two';OpenFixture $two $true
  $stop=WaitResult {$n=FindId $two 'btn-stop';if($n -and $n.Current.IsEnabled){return $n};return $null} 'stop button'
  Click $two $stop
  if(-not $script:javaProcess.WaitForExit(15000)){throw 'Recovered Java process was not stopped'}
  [void](WaitResult {if(-not (Test-Path -LiteralPath $file.FullName)){return $true};return $null} 'session finalized')
  [void](WaitResult {FindName $two 'Fixture Java — остановлена'} 'stopped UI')
  $seconds=[long](Meta).playtime_secs
  if($seconds -le 0 -or $seconds -gt ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-[long]$record.started_at+5)){throw "Unexpected accumulated time $seconds"}
  if((Meta)._omnispec_playtime_checkpoints){throw 'Final checkpoint marker was not cleared'}
  CloseLauncher $two
  $three=StartLauncher 'three';OpenFixture $three $false
  Start-Sleep -Seconds 2;CheckApps
  if((Meta).playtime_secs -ne $seconds -or (Test-Path -LiteralPath $file.FullName)){throw 'Restart double-counted or recreated a session'}
  CloseLauncher $three
  Write-Host "WINDOWS_LAUNCH_JAVA_FIXTURE_RECOVERED_STOPPED_AND_COUNTED_ONCE seconds=$seconds"
} catch {
  Write-Host "WINDOWS_LAUNCH_JAVA_FIXTURE_FAILED: $_"
  try {
    $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;$bmp=New-Object Drawing.Bitmap $b.Width,$b.Height;$g=[Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size);$bmp.Save((Join-Path (Resolve-Path $diag).Path 'failure.png'));$g.Dispose();$bmp.Dispose()
    Copy-Item (Join-Path $inst 'instance.json') $diag -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $journal '*.json') $diag -ErrorAction SilentlyContinue
  } catch { Write-Host "Diagnostics error: $_" }
  throw
} finally {
  foreach($app in $script:apps){try{$app.Proc.Refresh();if(-not $app.Proc.HasExited){$app.Proc.Kill();[void]$app.Proc.WaitForExit(10000)}}catch{}}
  if($script:javaProcess){try{$script:javaProcess.Refresh();if(-not $script:javaProcess.HasExited){$script:javaProcess.Kill();[void]$script:javaProcess.WaitForExit(10000)}}catch{}}
  try{Copy-Item (Join-Path $root '*.log') $diag -ErrorAction SilentlyContinue}catch{}
}
