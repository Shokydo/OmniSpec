# Only on a DISPOSABLE Windows CI runner: creates and trusts an ephemeral
# code-signing cert, signs a fake GUI window, then removes all certificates.
# This tests WGC + MJPEG, not the real Wallpaper Engine or its publisher.
param(
  [string]$Launcher = '',
  [switch]$SkipRustTest
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Run only on a disposable GitHub-hosted Windows runner.'
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'This isolated CI fixture requires an elevated disposable runner.'
}
$root = Join-Path $env:RUNNER_TEMP ('omnispec-wgc-' + [Guid]::NewGuid().ToString('N'))
$cert = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $exe = Join-Path $root 'wallpaper64.exe'
  Write-Host 'WINDOWS_WGC_FIXTURE_COMPILING'
  & rustc --edition 2021 -O 'tools/tests/windows-scene-window.rs' -o $exe
  if ($LASTEXITCODE -ne 0) { throw 'Cannot compile disposable GUI fixture.' }
  Write-Host 'WINDOWS_WGC_FIXTURE_CREATING_DISPOSABLE_CERTIFICATE'
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Skutta Software GmbH' -CertStoreLocation 'Cert:\CurrentUser\My'
  Write-Host 'WINDOWS_WGC_FIXTURE_TRUSTING_DISPOSABLE_CERTIFICATE'
  $public = Join-Path $root 'fixture.cer'
  Export-Certificate -Cert $cert -FilePath $public | Out-Null
  # CurrentUser\Root prompts interactively and blocks unattended CI. The
  # machine root store is used ONLY on this disposable hosted runner and the
  # exact freshly generated cert is removed in finally.
  Import-Certificate -FilePath $public -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
  Import-Certificate -FilePath $public -CertStoreLocation 'Cert:\CurrentUser\TrustedPublisher' | Out-Null
  Write-Host 'WINDOWS_WGC_FIXTURE_SIGNING'
  $signed = Set-AuthenticodeSignature -FilePath $exe -Certificate $cert -HashAlgorithm SHA256
  if ($signed.Status -ne 'Valid') { throw "Fixture signature is not trusted on the isolated runner: $($signed.Status)" }
  if (-not $SkipRustTest) {
    Write-Host 'WINDOWS_WGC_FIXTURE_TESTING'
    $env:OMNISPEC_TEST_SIGNED_ENGINE = $exe
    & cargo test -p omnispec-app --locked signed_fixture_capture_and_transaction -- --ignored --nocapture
    if ($LASTEXITCODE -ne 0) { throw "WGC fixture failed: $LASTEXITCODE" }
    Write-Host 'WINDOWS_WGC_FAKE_FIXTURE_AND_STREAM_OK (not a real Wallpaper Engine test)'
  }
  if ($Launcher) {
    & (Join-Path $PSScriptRoot 'windows-scene-ui-preflight.ps1') -Launcher $Launcher -SignedFixture $exe
    # Separate signed stub only logs arguments; the scene fixture paints frames.
    $probeDir = Join-Path $root 'probe'
    New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
    $probe = Join-Path $probeDir 'wallpaper64.exe'
    & rustc --edition 2021 -O 'tools/tests/windows-wallpaper-engine-probe.rs' -o $probe
    if ($LASTEXITCODE -ne 0) { throw 'Cannot compile disposable command probe.' }
    $signedProbe = Set-AuthenticodeSignature -FilePath $probe -Certificate $cert -HashAlgorithm SHA256
    if ($signedProbe.Status -ne 'Valid') { throw "Probe signature is not trusted: $($signedProbe.Status)" }
    & (Join-Path $PSScriptRoot 'windows-profile-preflight.ps1') -Launcher $Launcher -SignedEngine $probe
  }
} finally {
  Remove-Item Env:\OMNISPEC_TEST_SIGNED_ENGINE -ErrorAction SilentlyContinue
  if ($cert) {
    foreach ($store in @('My','TrustedPublisher')) {
      Remove-Item -LiteralPath ("Cert:\CurrentUser\$store\" + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue
    }
    # Remove only this run's unique test root, not any other certificate.
    if ($cert.Thumbprint -match '^[0-9A-Fa-f]{40}$') {
      Remove-Item -LiteralPath ("Cert:\LocalMachine\Root\" + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
