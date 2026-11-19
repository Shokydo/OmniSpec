# Проверяет настоящий установщик и сами .lnk; не трогает существующие ярлыки пользователя.
# Требуется PowerShell 7 (ProcessStartInfo.ArgumentList), Windows и изолированный CI runner.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Setup,
    [Parameter(Mandatory = $true)][string]$Launcher,
    [string]$ExpectedVersion = ''
)
$ErrorActionPreference = 'Stop'
$Setup = [IO.Path]::GetFullPath($Setup)
$Launcher = [IO.Path]::GetFullPath($Launcher)
if (-not (Test-Path -LiteralPath $Setup -PathType Leaf)) { throw "Missing installer: $Setup" }
if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) { throw "Missing payload: $Launcher" }

$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$root = Join-Path $temp ('omnispec-setup-smoke-' + [Guid]::NewGuid().ToString('N'))
$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory, [Environment+SpecialFolderOption]::DoNotVerify)
$programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs, [Environment+SpecialFolderOption]::DoNotVerify)
if (-not $desktop -or -not $programs) { throw 'Could not locate Windows known folders' }
$startFolder = Join-Path $programs 'OmniSpec'
$desktopLink = Join-Path $desktop 'OmniSpec.lnk'
$startLink = Join-Path $startFolder 'OmniSpec.lnk'
$owned = $false
$createdStartFolder = -not (Test-Path -LiteralPath $startFolder)
$marker = Join-Path $startFolder ('other-user-file-' + [Guid]::NewGuid().ToString('N') + '.txt')

function Invoke-Setup([string]$Executable, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    # Запоминаемый путь из теста не должен менять настоящий профиль пользователя.
    $info.Environment['LOCALAPPDATA'] = Join-Path $root 'LocalAppData'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'Cannot start installer' }
    $out = $process.StandardOutput.ReadToEndAsync()
    $err = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(90000)) {
        $process.Kill()
        throw 'Installer timed out'
    }
    $result = [PSCustomObject]@{
        ExitCode = $process.ExitCode
        Stdout = $out.GetAwaiter().GetResult()
        Stderr = $err.GetAwaiter().GetResult()
    }
    $process.Dispose()
    return $result
}

function Assert-Success($Result, [string]$Label) {
    if ($Result.ExitCode -ne 0) { throw "$Label exited $($Result.ExitCode): $($Result.Stderr)" }
}
function Assert-PathEqual([string]$Actual, [string]$Expected, [string]$Label) {
    if (-not [String]::Equals($Actual, $Expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label mismatch: got [$Actual], expected [$Expected]"
    }
}
function Assert-Pair([string]$Destination) {
    $exe = Join-Path $Destination 'OmniSpec.exe'
    $shell = New-Object -ComObject WScript.Shell
    foreach ($file in @($desktopLink, $startLink)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing shortcut: $file" }
        $link = $shell.CreateShortcut($file)
        Assert-PathEqual $link.TargetPath $exe 'TargetPath'
        Assert-PathEqual $link.WorkingDirectory $Destination 'WorkingDirectory'
        Assert-PathEqual $link.IconLocation "$exe,0" 'IconLocation'
        if ($link.Description -ne 'OmniSpec' -or $link.Arguments -ne '') { throw "Unexpected shortcut properties: $file" }
    }
}
function Assert-Installation([string]$Destination, [bool]$Portable) {
    $exe = Join-Path $Destination 'OmniSpec.exe'
    $uninstall = Join-Path $Destination 'uninstall.exe'
    if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $Launcher -Algorithm SHA256).Hash) { throw 'Installed launcher differs from payload' }
    if ((Get-FileHash -LiteralPath $uninstall -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $Setup -Algorithm SHA256).Hash) { throw 'Uninstaller differs from setup' }
    if ((Test-Path -LiteralPath (Join-Path $Destination 'portable.txt')) -ne $Portable) { throw 'Wrong portable marker' }
    $info = Get-Content -LiteralPath (Join-Path $Destination 'install-info.txt') -Encoding utf8
    if ($ExpectedVersion -and $info -notcontains "version=$ExpectedVersion") { throw "Wrong installation version: $ExpectedVersion" }
    $mode = if ($Portable) { 'true' } else { 'false' }
    if ($info -notcontains "portable=$mode") { throw "Wrong portable setting: $mode" }
    Assert-Pair $Destination
}

try {
    foreach ($file in @($desktopLink, $startLink)) {
        if (Test-Path -LiteralPath $file) { throw "Refusing to overwrite an existing shortcut: $file" }
    }
    $owned = $true
    New-Item -ItemType Directory -Force -Path $root, $desktop, $programs, (Join-Path $root 'LocalAppData') | Out-Null

    # Quotes, $, &, %, comma, spaces and non-ASCII characters must remain data,
    # not become PowerShell/cmd expressions or disappear in an ANSI conversion.
    $special = Join-Path $root 'Сборка ''quote'' $(name) & 100%PATH% (папка), test 🛠'
    $result = Invoke-Setup $Setup @('--yes', '--portable', '--dir', $special)
    Assert-Success $result 'Special-path install'
    Assert-Installation $special $true
    Write-Host 'WINDOWS_SHORTCUT_SPECIAL_PATH_OK: desktop and Start menu target, working directory, icon, description'

    $result = Invoke-Setup $Setup @('--yes', '--portable', '--dir', $special)
    Assert-Success $result 'Reinstall'
    Assert-Installation $special $true
    Write-Host 'WINDOWS_SHORTCUT_REINSTALL_OK'

    # Делать вид, что всё готово, если ярлык невозможно сохранить, нельзя.
    Remove-Item -LiteralPath $desktopLink -Force
    New-Item -ItemType Directory -Path $desktopLink | Out-Null
    $result = Invoke-Setup $Setup @('--yes', '--portable', '--dir', $special)
    if ($result.ExitCode -eq 0 -or $result.Stderr -notmatch 'OmniSpec\.lnk') {
        throw "Desktop shortcut error was not reported: exit=$($result.ExitCode), stderr=[$($result.Stderr)]"
    }
    Remove-Item -LiteralPath $desktopLink -Force
    Remove-Item -LiteralPath $startLink -Force
    New-Item -ItemType Directory -Path $startLink | Out-Null
    $result = Invoke-Setup $Setup @('--yes', '--portable', '--dir', $special)
    if ($result.ExitCode -eq 0 -or $result.Stderr -notmatch 'OmniSpec\.lnk') {
        throw "Start-menu shortcut error was not reported: exit=$($result.ExitCode), stderr=[$($result.Stderr)]"
    }
    Remove-Item -LiteralPath $startLink -Force
    Write-Host 'WINDOWS_SHORTCUT_FAILURES_OK: both errors return nonzero and name the shortcut'

    # Проверяем удаление на обычном пути; пользовательские файлы в меню и данные
    # сборок должны остаться. Удаление себя — отдельный отложенный процесс.
    $plain = Join-Path $root 'Installed'
    $result = Invoke-Setup $Setup @('--yes', '--shared', '--dir', $plain)
    Assert-Success $result 'Shared install'
    Assert-Installation $plain $false
    $result = Invoke-Setup $Setup @('--yes', '--portable', '--dir', $plain)
    Assert-Success $result 'Portable reinstall'
    Assert-Installation $plain $true
    [IO.File]::WriteAllText($marker, 'keep')
    $data = Join-Path $plain 'OmniSpecData'
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    [IO.File]::WriteAllText((Join-Path $data 'keep.txt'), 'keep')
    $result = Invoke-Setup (Join-Path $plain 'uninstall.exe') @('--uninstall', '--yes', '--dir', $plain)
    Assert-Success $result 'Uninstall'
    if ((Test-Path -LiteralPath $desktopLink) -or (Test-Path -LiteralPath $startLink)) { throw 'Uninstall left shortcuts behind' }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'Uninstall deleted another Start menu file' }
    if (-not (Test-Path -LiteralPath (Join-Path $data 'keep.txt') -PathType Leaf)) { throw 'Uninstall deleted user data without --purge' }
    if (Test-Path -LiteralPath (Join-Path $plain 'OmniSpec.exe')) { throw 'Uninstall left the launcher behind' }
    Write-Host 'WINDOWS_UNINSTALL_SHORTCUTS_OK: shortcuts removed, user data and unrelated menu file preserved'
} finally {
    if ($owned) {
        foreach ($file in @($desktopLink, $startLink, $marker)) {
            if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Recurse -Force -ErrorAction SilentlyContinue }
        }
        if ($createdStartFolder -and (Test-Path -LiteralPath $startFolder)) {
            # Без -Recurse: вдруг появился чей-то файл, не удаляем его.
            Remove-Item -LiteralPath $startFolder -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}
