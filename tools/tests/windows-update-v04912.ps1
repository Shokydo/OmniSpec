# One-off verification of the actual published Windows v0.49.11 -> v0.49.12 update.
# All files and settings live under a disposable RUNNER_TEMP directory.
param([switch]$Anonymous)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$root = Join-Path $env:RUNNER_TEMP ('OmniSpec Update ' + [Guid]::NewGuid().ToString('N'))
$app = Join-Path $root 'OmniSpec.exe'
$data = Join-Path $root 'data'
$instance = Join-Path $data 'instances\upgrade-fixture'
$env:OMNISPEC_HOME = $data
$env:USERPROFILE = Join-Path $root 'profile'
$env:APPDATA = Join-Path $root 'appdata'
$env:LOCALAPPDATA = Join-Path $root 'localappdata'
$script:ui = $null
$script:old = $null
$script:new = $null
$scope = [System.Windows.Automation.TreeScope]::Descendants
$oldHash = 'af31382ba6544fc19ab55bb63cb12393c76a95cf721e3d2d9efd8aeb4761ec11'
$newHash = $null
$base = 'https://github.com/Shokydo/OmniSpec/releases/download'

function WaitId([string]$id, [int]$seconds = 45) {
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try { $found = $script:ui.FindFirst($scope, $condition); if ($null -ne $found) { return $found } } catch {}
        Start-Sleep -Milliseconds 150
    }
    throw "Element not found: $id"
}
function WaitButton([string]$name, [bool]$exact = $true, [int]$seconds = 45) {
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            foreach ($node in $script:ui.FindAll($scope, $condition)) {
                try {
                    if (($exact -and $node.Current.Name -eq $name) -or (-not $exact -and $node.Current.Name -like "*$name*")) { return $node }
                } catch {}
            }
        } catch {}
        Start-Sleep -Milliseconds 150
    }
    throw "Button not found: $name"
}
function Click($node) {
    $pattern = $null
    if ($node.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); return }
    $node.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}

try {
    if ([string]::IsNullOrWhiteSpace($env:UPDATE_TOKEN)) { throw 'Missing authenticated GitHub token for the isolated test' }
    $headers = @{Authorization=('Bearer ' + $env:UPDATE_TOKEN);Accept='application/vnd.github+json';'User-Agent'='OmniSpec-update-preflight'}
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/Shokydo/OmniSpec/releases/tags/v0.49.12' -Headers $headers
    $latest = Invoke-RestMethod -Uri 'https://api.github.com/repos/Shokydo/OmniSpec/releases/latest' -Headers $headers
    if ($latest.tag_name -ne 'v0.49.12') { throw 'Unexpected latest release' }
    $asset = @($release.assets | Where-Object { $_.name -eq 'OmniSpec.exe' })
    if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:[0-9a-fA-F]{64}$') { throw 'Release executable digest missing' }
    $newHash = $asset[0].digest.Substring(7).ToLowerInvariant()
    New-Item -ItemType Directory -Force -Path $root, $data, $instance, $env:USERPROFILE, $env:APPDATA, $env:LOCALAPPDATA | Out-Null
    Invoke-WebRequest -Uri "$base/v0.49.11/OmniSpec.exe" -OutFile $app
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $app).Hash.ToLowerInvariant() -ne $oldHash) { throw 'Published v0.49.11 hash mismatch' }

    $utf8 = [Text.UTF8Encoding]::new($false)
    # Real old settings and skin files, including an already-persisted favorite.
    # A non-default trail avoids the previous version's one-time migration save.
    $skinDir = Join-Path $data 'meta\skins'
    New-Item -ItemType Directory -Force -Path $skinDir | Out-Null
    $skin = Join-Path $skinDir 'legacy.png'
    Copy-Item -LiteralPath 'tools/tests/fixtures/profile/one.png' -Destination $skin
    $skinHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $skin).Hash
    # The verifier needs a token for its own metadata queries. Test the app
    # both with a token and with the normal public/anonymous configuration.
    $appToken = if ($Anonymous) { $null } else { $env:UPDATE_TOKEN }
    $steam = Join-Path $root 'Synthetic Steam'
    $project = Join-Path $steam 'steamapps\workshop\content\431960\123456'
    New-Item -ItemType Directory -Force -Path $project | Out-Null
    Copy-Item -LiteralPath 'tools/tests/fixtures/profile/animated.mp4' -Destination (Join-Path $project 'movie.mp4')
    [IO.File]::WriteAllText((Join-Path $project 'project.json'), '{"title":"Synthetic update video","type":"video","file":"movie.mp4","workshopid":"123456"}', $utf8)
    Write-Host "WINDOWS_LAUNCHER_UPDATE_AUTH_MODE=$(if ($Anonymous) { 'anonymous' } else { 'token' })"
    $settings = @{onboarded=$true; update_repo='Shokydo/OmniSpec'; update_enabled=$true; update_auto=$true;
                  update_token=$appToken; discord_rpc=$false; sound_fx=$false; username='UpdateFixture'; memory_mb=65536;
                  trail_style='sparks'; wallpaper='workshop'; wallpaper_steam_path=$steam; wallpaper_workshop_project=$project;
                  skin_presets=@(@{id='legacy-upgrade';name='Legacy skin';path=$skin;variant='slim';angle=12});
                  skin_favorites=@(@{id='legacy-favorite';name='Legacy favorite';skinPath=$skin;skinDataUrl='';variant='slim';capeId='';futureField='preserved'})}
    [IO.File]::WriteAllText((Join-Path $data 'settings.json'), ($settings | ConvertTo-Json -Depth 5), $utf8)
    [IO.File]::WriteAllText((Join-Path $data 'keep.txt'), 'existing-user-data', $utf8)
    [IO.File]::WriteAllText((Join-Path $instance 'instance.json'), '{"id":"upgrade-fixture","name":"Windows Upgrade Fixture","mc_version":"1.21.1","loader":{"type":"vanilla"}}', $utf8)
    $fixture = Join-Path $instance 'minecraft\mods\renamed.jar.disabled'
    New-Item -ItemType Directory -Force -Path (Split-Path $fixture -Parent) | Out-Null
    [IO.File]::WriteAllBytes($fixture, [byte[]](0..255))
    $fixtureHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixture).Hash

    $script:old = Start-Process -FilePath $app -WorkingDirectory $root -PassThru
    Write-Host "STARTED_PUBLISHED_V04911_WINDOWS pid=$($script:old.Id)"
    $deadline = [DateTime]::UtcNow.AddSeconds(180)
    while ([DateTime]::UtcNow -lt $deadline) {
        $hash = ''
        try { $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $app).Hash.ToLowerInvariant() } catch {}
        if ($hash -eq $newHash) {
            $script:old.Refresh()
            $candidates = @(Get-CimInstance Win32_Process -Filter "Name='OmniSpec.exe'" | Where-Object {
                $_.ProcessId -ne $script:old.Id -and $_.ExecutablePath -and
                [String]::Equals($_.ExecutablePath, $app, [StringComparison]::OrdinalIgnoreCase)
            })
            foreach ($candidate in $candidates) {
                $probe = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
                if ($null -eq $probe) { continue }
                $probe.Refresh()
                if ($script:old.HasExited -and $probe.MainWindowHandle -ne [IntPtr]::Zero) { $script:new = $probe; break }
            }
            if ($null -ne $script:new) { break }
        }
        Start-Sleep -Seconds 1
    }
    if ($null -eq $script:new) { throw 'Published v0.49.11 did not replace itself and restart the v0.49.12 GUI within 180 seconds' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $app).Hash.ToLowerInvariant() -ne $newHash) { throw 'Updated file is not the published v0.49.12 launcher' }
    Write-Host "PUBLISHED_WINDOWS_AUTOUPDATE_REPLACED_AND_RESTARTED old=$($script:old.Id) new=$($script:new.Id)"

    if (([IO.File]::ReadAllText((Join-Path $data 'keep.txt'))) -ne 'existing-user-data') { throw 'Existing data changed' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $fixture).Hash -ne $fixtureHash) { throw 'Disabled mod file changed' }
    $saved = [IO.File]::ReadAllText((Join-Path $data 'settings.json')) | ConvertFrom-Json
    if ($saved.username -ne 'UpdateFixture' -or $saved.memory_mb -ne 65536) { throw 'Saved settings changed unexpectedly' }
    if ($saved.wallpaper -ne 'workshop' -or $saved.wallpaper_workshop_project -ne $project) { throw 'Saved Workshop selection changed unexpectedly' }
    Write-Host 'WINDOWS_UPGRADE_PRESERVES_SYNTHETIC_WORKSHOP_SELECTION'
    if (@($saved.skin_presets).Count -ne 1 -or @($saved.skin_presets)[0].id -ne 'legacy-upgrade' -or @($saved.skin_favorites).Count -ne 1 -or @($saved.skin_favorites)[0].futureField -ne 'preserved') { throw 'Legacy skin or persisted favorite was lost during upgrade' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $skin).Hash -ne $skinHash) { throw 'Legacy skin file changed during upgrade' }
    Write-Host 'WINDOWS_AUTOUPDATE_PRESERVED_SETTINGS_SKIN_FAVORITE_AND_INSTANCE_FILES'

    $script:ui = [System.Windows.Automation.AutomationElement]::FromHandle($script:new.MainWindowHandle)
    [void](WaitButton 'Windows Upgrade Fixture' $false 60)
    Click (WaitId 'btn-quick-settings')
    $updates = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('0J7QsdC90L7QstC70LXQvdC40Y8='))
    Click (WaitButton $updates)
    # WebView2 exposes this static <span> as text, not necessarily as an
    # element with an AutomationId. Wait for a real button in the Updates tab,
    # then look for the displayed version through names or the text pattern.
    [void](WaitId 'upd-check-now')
    $foundVersion = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline -and -not $foundVersion) {
        foreach ($node in $script:ui.FindAll($scope, [System.Windows.Automation.Condition]::TrueCondition)) {
            try {
                if ($node.Current.Name -like '*0.49.12*') { $foundVersion = $true; break }
                $textPattern = $null
                if ($node.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
                    if ($textPattern.DocumentRange.GetText(-1) -like '*0.49.12*') { $foundVersion = $true; break }
                }
            } catch {}
        }
        if (-not $foundVersion) { Start-Sleep -Milliseconds 200 }
    }
    if (-not $foundVersion) { throw 'Updated GUI did not expose version 0.49.12 as accessible text' }
    Write-Host 'RESTARTED_WINDOWS_GUI_REPORTS_VERSION_0_49_12'
    Click (WaitButton 'Профиль')
    [void](WaitButton 'Legacy favorite' $false 60)
    [void](WaitButton 'Legacy skin' $false 60)
    Write-Host 'RESTARTED_WINDOWS_GUI_SHOWS_LEGACY_SKIN_AND_FAVORITE'
    Write-Host 'REAL_WINDOWS_V04911_TO_V04912_AUTOUPDATE_OK'
} finally {
    # Never leave the GitHub token, helper or running test application behind.
    try {
        $procs = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
        })
        foreach ($proc in $procs) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch {}
    Start-Sleep -Seconds 2
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
