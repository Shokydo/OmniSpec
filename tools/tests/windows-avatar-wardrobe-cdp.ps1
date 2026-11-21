# Real WebView2 and offline backend with synthetic UI capes on a disposable hosted runner.
# The temporary per-executable debugging policy is always removed afterwards.
param([Parameter(Mandatory=$true)][string]$Launcher)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Run only on a disposable GitHub-hosted Windows runner.'
}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Disposable test requires an elevated runner' }
$exe=(Resolve-Path $Launcher).Path
$name=[IO.Path]::GetFileName($exe)
$reg='HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
$created=-not (Test-Path $reg)
if (-not $created -and (Get-Item $reg).GetValueNames() -contains $name) { throw 'Refusing to overwrite an existing WebView2 policy' }
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start(); $port=([Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()
try {
  New-Item -Path $reg -Force | Out-Null
  New-ItemProperty -Path $reg -Name $name -Value "--remote-debugging-port=$port" -PropertyType String -Force | Out-Null
  & node 'tools/tests/windows-avatar-wardrobe-cdp.cjs' $exe $port
  if ($LASTEXITCODE -ne 0) { throw "Windows WebView2 avatar wardrobe test failed: $LASTEXITCODE" }
} finally {
  Remove-ItemProperty -Path $reg -Name $name -ErrorAction SilentlyContinue
  if ($created) { Remove-Item -Path $reg -Force -ErrorAction SilentlyContinue }
}
