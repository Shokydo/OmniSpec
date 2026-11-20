# Disposable Windows CI check of the exact portable test-package layout.
# No real profile, Microsoft account or Minecraft files are used.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Launcher,
      [Parameter(Mandatory=$true)][string]$Starter,
      [Parameter(Mandatory=$true)][string]$Settings,
      [Parameter(Mandatory=$true)][string]$ExpectedSha256)
$ErrorActionPreference='Stop'
if (-not $env:CI -or -not $env:RUNNER_TEMP) { throw 'Run only on a disposable Windows CI runner.' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$utf8=[Text.UTF8Encoding]::new($false)
$root=Join-Path $env:RUNNER_TEMP ('omnispec portable '+[Guid]::NewGuid().ToString('N'))
$folder=Join-Path $root 'test folder with spaces'
$data=Join-Path $folder 'OmniSpecData'
$other=Join-Path $root 'other home'
New-Item -ItemType Directory -Force $data | Out-Null
$exe=Join-Path $folder 'OmniSpec.exe'
Copy-Item -LiteralPath (Resolve-Path $Launcher).Path -Destination $exe
Copy-Item -LiteralPath (Resolve-Path $Starter).Path -Destination (Join-Path $folder 'Start-OmniSpec-test.cmd')
Copy-Item -LiteralPath (Resolve-Path $Settings).Path -Destination (Join-Path $data 'settings.json')
[IO.File]::WriteAllBytes((Join-Path $folder 'portable.txt'),[byte[]]@())
$actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
if($actual -ne $ExpectedSha256.ToLowerInvariant()){throw "Unexpected test executable hash: $actual"}
$env:OMNISPEC_HOME=$other
$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $root 'webview-one'
$script:apps=@()
function WaitResult([scriptblock]$find,[string]$what,[int]$seconds=90) {
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) {
    try { $found=& $find; if($null -ne $found -and $found -ne $false){return $found} } catch { }
    Start-Sleep -Milliseconds 200
  }
  throw "Timed out waiting for $what"
}
function FindLauncher {
  foreach($p in (Get-Process -Name OmniSpec -ErrorAction SilentlyContinue)) {
    try { if($p.Path -eq $exe -and -not $p.HasExited){return $p} } catch { }
  }
  return $null
}
function WaitUi($app) {
  [void](WaitResult {$app.Refresh(); if($app.HasExited){throw 'Launcher exited'}; if($app.MainWindowHandle -ne [IntPtr]::Zero){return $true};return $null} 'native window' 120)
  $ui=[System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
  $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'btn-home')
  [void](WaitResult {$app.Refresh(); if($app.HasExited){throw 'Launcher exited'};return $ui.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)} 'home button' 120)
}
function CloseApp($app) {
  $app.Refresh()
  if(-not $app.HasExited) {
    # A process discovered after a .cmd detached it needs an open handle before
    # exit; otherwise .NET may report an unavailable (null) exit code.
    [void]$app.Handle
    [void]$app.CloseMainWindow()
    if(-not $app.WaitForExit(15000)){throw 'Launcher did not close'}
    if($null -eq $app.ExitCode){throw 'Normal close exit code unavailable'}
    if($app.ExitCode -ne 0){throw "Normal close returned $($app.ExitCode)"}
  }
}
try {
  [void](Start-Process -FilePath (Join-Path $folder 'Start-OmniSpec-test.cmd') -WorkingDirectory $folder -PassThru)
  $app=WaitResult {FindLauncher} 'launcher started from .cmd' 120
  $script:apps+=@($app)
  WaitUi $app
  [void](WaitResult {if(Test-Path -LiteralPath (Join-Path $data 'meta')){return $true};return $null} 'portable profile created')
  if(Test-Path -LiteralPath $other){throw '.cmd did not clear the inherited OMNISPEC_HOME'}
  $s=[IO.File]::ReadAllText((Join-Path $data 'settings.json')) | ConvertFrom-Json
  if($s.update_enabled -ne $false -or $s.update_auto -ne $false){throw 'Portable updater settings were not preserved'}
  if($env:OMNISPEC_HOME -ne $other){throw 'Starter unexpectedly changed the parent environment'}
  CloseApp $app
  Write-Host "WINDOWS_PORTABLE_STARTER_ISOLATION_PASSED exe-sha256=$actual updater-disabled=true"

  # Direct exe invocation deliberately honours the environment variable, as
  # documented. Use a second throwaway profile so this cannot touch user data.
  New-Item -ItemType Directory -Force $other | Out-Null
  [IO.File]::WriteAllText((Join-Path $other 'settings.json'),'{"update_enabled":false,"update_auto":false}',$utf8)
  $env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $root 'webview-two'
  $direct=Start-Process -FilePath $exe -WorkingDirectory $folder -PassThru
  $script:apps+=@($direct)
  WaitUi $direct
  [void](WaitResult {if(Test-Path -LiteralPath (Join-Path $other 'meta')){return $true};return $null} 'environment-selected profile created')
  CloseApp $direct
  Write-Host 'WINDOWS_PORTABLE_DIRECT_ENV_PRIORITY_PASSED'
} finally {
  foreach($app in $script:apps){try{$app.Refresh();if(-not $app.HasExited){$app.Kill();[void]$app.WaitForExit(10000)}}catch{}}
}
