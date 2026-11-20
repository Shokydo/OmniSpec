# Locks only the disposable test settings file so atomic replacement fails.
param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Run only on a disposable GitHub-hosted Windows runner.'
}
$file=[System.IO.File]::Open($Path,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None)
try {
  Write-Output 'SETTINGS_LOCKED'
  while($true) { Start-Sleep -Seconds 1 }
} finally { $file.Dispose() }
