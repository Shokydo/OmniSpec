# Проверяет настоящий установщик и сами .lnk; не трогает существующие ярлыки пользователя.
# Требуется PowerShell 7 (ProcessStartInfo.ArgumentList), Windows и изолированный CI runner.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Setup,
    [Parameter(Mandatory = $true)][string]$Launcher,
    [string]$ExpectedVersion = '',
    [switch]$LaunchProbe
)
$ErrorActionPreference = 'Stop'
$Setup = [IO.Path]::GetFullPath($Setup)
$Launcher = [IO.Path]::GetFullPath($Launcher)
if (-not (Test-Path -LiteralPath $Setup -PathType Leaf)) { throw "Missing installer: $Setup" }
if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) { throw "Missing payload: $Launcher" }

# WScript.Shell читает TargetPath через ANSI и может заменить Unicode на `?`.
# Поэтому проверяем фактический .lnk через тот же Unicode-интерфейс Shell,
# которым Windows пользуется для запуска ярлыка.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class OmniSpecShellLink {}

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOmniSpecShellLinkW {
    [PreserveSig] int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, IntPtr data, uint flags);
    [PreserveSig] int GetIDList(out IntPtr pidl);
    [PreserveSig] int SetIDList(IntPtr pidl);
    [PreserveSig] int GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int size);
    [PreserveSig] int SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
    [PreserveSig] int GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size);
    [PreserveSig] int SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
    [PreserveSig] int GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int size);
    [PreserveSig] int SetArguments([MarshalAs(UnmanagedType.LPWStr)] string text);
    [PreserveSig] int GetHotkey(out ushort hotkey);
    [PreserveSig] int SetHotkey(ushort hotkey);
    [PreserveSig] int GetShowCmd(out int show);
    [PreserveSig] int SetShowCmd(int show);
    [PreserveSig] int GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, out int index);
}

public static class OmniSpecShortcutReader {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetLongPathNameW(string input, StringBuilder output, uint size);
    public static string LongPath(string path) {
        var output = new StringBuilder(32768);
        uint size = GetLongPathNameW(path, output, (uint)output.Capacity);
        if (size == 0 || size >= output.Capacity)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return output.ToString();
    }
    public static string[] Read(string path) {
        var link = (IOmniSpecShellLinkW)new OmniSpecShellLink();
        try {
            ((IPersistFile)link).Load(path, 0);
            var target = new StringBuilder(32768);
            var work = new StringBuilder(32768);
            var icon = new StringBuilder(32768);
            var desc = new StringBuilder(1024);
            var args = new StringBuilder(1024);
            int index;
            Marshal.ThrowExceptionForHR(link.GetPath(target, target.Capacity, IntPtr.Zero, 4));
            Marshal.ThrowExceptionForHR(link.GetWorkingDirectory(work, work.Capacity));
            Marshal.ThrowExceptionForHR(link.GetIconLocation(icon, icon.Capacity, out index));
            Marshal.ThrowExceptionForHR(link.GetDescription(desc, desc.Capacity));
            Marshal.ThrowExceptionForHR(link.GetArguments(args, args.Capacity));
            return new[] { target.ToString(), work.ToString(), icon.ToString(), index.ToString(), desc.ToString(), args.ToString() };
        } finally {
            Marshal.FinalReleaseComObject(link);
        }
    }
}
'@

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
    # Shell вправе сохранить короткое 8.3-имя, эквивалентное длинному пути.
    $longActual = [OmniSpecShortcutReader]::LongPath($Actual)
    $longExpected = [OmniSpecShortcutReader]::LongPath($Expected)
    if (-not [String]::Equals($longActual, $longExpected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label mismatch: got [$Actual], expected [$Expected]"
    }
}
function Assert-Pair([string]$Destination) {
    $exe = Join-Path $Destination 'OmniSpec.exe'
    foreach ($file in @($desktopLink, $startLink)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing shortcut: $file" }
        $link = [OmniSpecShortcutReader]::Read($file)
        Assert-PathEqual $link[0] $exe 'TargetPath'
        if ($link[1]) {
            Assert-PathEqual $link[1] $Destination 'WorkingDirectory'
            if ($link[5]) { throw "Unexpected shortcut arguments: $file" }
        } else {
            # На томе без 8.3 для %ИМЯ% лаунчер сам устанавливает рабочую папку.
            if (($Destination.ToCharArray() | Where-Object { $_ -eq '%' } | Measure-Object).Count -lt 2 -or $link[5] -ne '--omnispec-shortcut-cwd') {
                throw "Unexpected empty shortcut working directory: $file"
            }
        }
        if ($link[2]) {
            Assert-PathEqual $link[2] $exe 'IconLocation'
        } elseif (($Destination.ToCharArray() | Where-Object { $_ -eq '%' } | Measure-Object).Count -lt 2) {
            throw "Unexpected empty shortcut icon: $file"
        } # Иначе Shell использует иконку самой цели через PIDL.
        if ($link[3] -ne '0' -or $link[4] -ne 'OmniSpec') { throw "Unexpected shortcut properties: $file" }
    }
}
function Assert-ShortcutLaunch([string]$Destination) {
    # Только для собственного безопасного тестового payload в CI. Проверяем
    # не только содержимое .lnk, но и фактическую работу Shell при открытии.
    $probe = Join-Path $Destination 'shortcut-probe.txt'
    foreach ($file in @($desktopLink, $startLink)) {
        if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force }
        $process = Start-Process -FilePath $file -PassThru
        if ($process -and -not $process.WaitForExit(15000)) {
            $process.Kill()
            throw "Shortcut target did not exit: $file"
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while (-not (Test-Path -LiteralPath $probe -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 100
        }
        if (-not (Test-Path -LiteralPath $probe -PathType Leaf)) { throw "Shortcut did not launch payload: $file" }
        $lines = @(Get-Content -LiteralPath $probe -Encoding utf8)
        if ($lines.Count -ne 2) { throw "Invalid shortcut launch probe: $file" }
        Assert-PathEqual $lines[0] (Join-Path $Destination 'OmniSpec.exe') 'Launched executable'
        Assert-PathEqual $lines[1] $Destination 'Launched working directory'
    }
    Remove-Item -LiteralPath $probe -Force
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

    # Контроль: системный рабочий стол доступен для записи на этом runner.
    $control = Join-Path $desktop ('omnispec-control-' + [Guid]::NewGuid().ToString('N') + '.lnk')
    try {
        $controlLink = (New-Object -ComObject WScript.Shell).CreateShortcut($control)
        $controlLink.TargetPath = $Launcher
        $controlLink.Save()
        if (-not (Test-Path -LiteralPath $control -PathType Leaf)) { throw 'Desktop COM control failed' }
    } finally {
        if (Test-Path -LiteralPath $control) { Remove-Item -LiteralPath $control -Force }
    }
    Write-Host 'WINDOWS_DESKTOP_COM_CONTROL_OK'

    # Quotes, $, &, %, comma, spaces and non-ASCII characters must remain data,
    # not become PowerShell/cmd expressions or disappear in an ANSI conversion.
    $special = Join-Path $root 'Сборка ''quote'' $(name) & 100% !name! (папка), test 🛠'
    $result = Invoke-Setup $Setup @('--yes', '--portable', '--dir', $special)
    Assert-Success $result 'Special-path install'
    Assert-Installation $special $true
    Write-Host 'WINDOWS_SHORTCUT_SPECIAL_PATH_OK: desktop and Start menu target, working directory, icon, description'
    if ($LaunchProbe) {
        Assert-ShortcutLaunch $special
        Write-Host 'WINDOWS_SHORTCUT_SHELL_LAUNCH_OK: both shortcuts start the expected executable in the expected directory'
    }

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

    # Удаление себя — отдельный отложенный процесс. В пути есть Unicode,
    # %, ! и &, которые не должны превращаться в команды или переменные.
    $result = Invoke-Setup $Setup @('--yes', '--portable', '--dir', $special)
    Assert-Success $result 'Restore special-path shortcuts'
    $specialData = Join-Path $special 'OmniSpecData'
    New-Item -ItemType Directory -Force -Path $specialData | Out-Null
    [IO.File]::WriteAllText((Join-Path $specialData 'keep.txt'), 'keep')
    $specialUninstall = Join-Path $special 'uninstall.exe'
    $result = Invoke-Setup $specialUninstall @('--uninstall', '--yes', '--dir', $special)
    Assert-Success $result 'Special-path uninstall'
    if ((Test-Path -LiteralPath $desktopLink) -or (Test-Path -LiteralPath $startLink)) { throw 'Special-path uninstall left shortcuts behind' }
    if (Test-Path -LiteralPath (Join-Path $special 'OmniSpec.exe')) { throw 'Special-path uninstall left launcher behind' }
    if (-not (Test-Path -LiteralPath (Join-Path $specialData 'keep.txt') -PathType Leaf)) { throw 'Special-path uninstall deleted user data' }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ((Test-Path -LiteralPath $specialUninstall) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 100
    }
    if (Test-Path -LiteralPath $specialUninstall) { throw 'Special-path uninstaller did not delete itself' }
    Write-Host 'WINDOWS_SPECIAL_UNINSTALL_OK: self-delete and shortcuts removed, user data preserved'

    # %PATH% в имени каталога Windows может подставить как переменную среды.
    # Проверяем установку и реальный запуск и на томах без коротких имён 8.3.
    $envPath = Join-Path $root 'Сборка 100%PATH% & !name! 🛠'
    $result = Invoke-Setup $Setup @('--yes', '--portable', '--dir', $envPath)
    Assert-Success $result 'Environment-like-path install'
    Assert-Installation $envPath $true
    if ($LaunchProbe) { Assert-ShortcutLaunch $envPath }
    $envLink = [OmniSpecShortcutReader]::Read($desktopLink)
    $mode = if ($envLink[1]) { 'safe short path' } else { 'launcher restores its working directory' }
    Write-Host "WINDOWS_ENV_PATH_OK: $mode"
    # Фактическое удаление себя тоже не должно разворачивать %PATH%.
    $envUninstall = Join-Path $envPath 'uninstall.exe'
    $result = Invoke-Setup $envUninstall @('--uninstall', '--yes', '--dir', $envPath)
    Assert-Success $result 'Environment-like-path uninstall'
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ((Test-Path -LiteralPath $envUninstall) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (Test-Path -LiteralPath $envUninstall) { throw 'Environment-like-path uninstaller did not delete itself' }
    if ((Test-Path -LiteralPath $desktopLink) -or (Test-Path -LiteralPath $startLink)) { throw 'Environment-like-path uninstall left shortcuts behind' }
    Write-Host 'WINDOWS_ENV_PATH_UNINSTALL_OK'

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
