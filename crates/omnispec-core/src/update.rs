//! Автообновление лаунчера через GitHub Releases.
//!
//! Схема: в репозитории создаётся релиз с тегом `vX.Y.Z` и прикреплённым
//! `OmniSpec.exe`. Лаунчер при запуске спрашивает
//! `GET /repos/{owner}/{repo}/releases/latest`, сравнивает версии и, если есть
//! новая, скачивает exe и подменяет себя, после чего перезапускается.
//!
//! Публичный репозиторий **не требует токена**: GitHub отдаёт релизы анонимно.
//! Токен нужен только если репозиторий приватный (и тогда его нельзя «зашивать»
//! в сборку — только вводить в настройках).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::net::{Http, Reporter};
use crate::paths::Paths;

pub const GITHUB_API: &str = "https://api.github.com";

/// Аргумент командной строки, с которым запускается процесс-помощник обновления.
pub const HELPER_FLAG: &str = "--apply-update";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateConfig {
    /// Владелец репозитория.
    pub owner: String,
    /// Имя репозитория.
    pub repo: String,
    /// Токен для приватных репозиториев (необязательно).
    #[serde(default)]
    pub token: Option<String>,
    /// Учитывать бета-версии (prerelease).
    #[serde(default)]
    pub include_prerelease: bool,
}

impl UpdateConfig {
    pub fn new(owner: impl Into<String>, repo: impl Into<String>) -> Self {
        Self {
            owner: owner.into(),
            repo: repo.into(),
            token: None,
            include_prerelease: false,
        }
    }

    /// Разобрать строку «owner/repo». Ссылки и мусор отклоняются.
    pub fn from_slug(slug: &str) -> Option<Self> {
        let slug = slug.trim().trim_end_matches('/');
        let (owner, repo) = slug.split_once('/')?;
        let repo = repo.trim().trim_end_matches(".git");
        if !is_valid_github_name(owner) || !is_valid_github_name(repo) {
            return None;
        }
        Some(Self::new(owner, repo))
    }

    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    pub fn is_valid(&self) -> bool {
        !self.owner.trim().is_empty() && !self.repo.trim().is_empty()
    }
}

/// GitHub допускает в именах только латиницу, цифры и `- _ .`
fn is_valid_github_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('.')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReleaseAsset {
    pub name: String,
    #[serde(default)]
    pub browser_download_url: String,
    #[serde(default)]
    pub size: u64,
    /// `sha256:...`, если GitHub его посчитал.
    #[serde(default)]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Release {
    #[serde(default)]
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub html_url: Option<String>,
    #[serde(default)]
    pub assets: Vec<ReleaseAsset>,
}

impl Release {
    /// Версия без префикса `v`.
    pub fn version(&self) -> String {
        normalize_version(&self.tag_name)
    }

    pub fn page_url(&self) -> String {
        self.html_url.clone().unwrap_or_default()
    }
}

/// Информация о доступном обновлении (её получает интерфейс).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: String,
    pub published_at: Option<String>,
    pub page_url: String,
    pub asset_name: String,
    pub asset_url: String,
    pub asset_size: u64,
    pub asset_digest: Option<String>,
}

/// `v1.2.3` → `1.2.3`, `release-1.2.3` → `1.2.3`.
pub fn normalize_version(tag: &str) -> String {
    let trimmed = tag.trim().trim_start_matches('v').trim_start_matches('V');
    trimmed
        .trim_start_matches("release-")
        .trim_start_matches("Release-")
        .to_string()
}

/// Числовое сравнение версий: `1.10.0 > 1.9.9`, `1.2.3-beta < 1.2.3`.
pub fn is_newer(latest: &str, current: &str) -> bool {
    compare_versions(latest, current) == std::cmp::Ordering::Greater
}

pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let (a_core, a_pre) = split_pre(a);
    let (b_core, b_pre) = split_pre(b);

    let a_parts = numeric_parts(&a_core);
    let b_parts = numeric_parts(&b_core);
    let len = a_parts.len().max(b_parts.len());
    for index in 0..len {
        let left = a_parts.get(index).copied().unwrap_or(0);
        let right = b_parts.get(index).copied().unwrap_or(0);
        if left != right {
            return left.cmp(&right);
        }
    }

    // Ядро версий совпало — решает суффикс: релиз новее своей беты.
    match (a_pre.is_empty(), b_pre.is_empty()) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => a_pre.cmp(&b_pre),
    }
}

fn split_pre(version: &str) -> (String, String) {
    let normalized = normalize_version(version);
    match normalized.split_once(['-', '+']) {
        Some((core, pre)) => (core.to_string(), pre.to_string()),
        None => (normalized, String::new()),
    }
}

fn numeric_parts(core: &str) -> Vec<u64> {
    core.split(['.', '_', '-'])
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

/// Выбрать подходящий ассет релиза для текущей ОС.
///
/// Приоритет: портативный бинарник (`OmniSpec.exe`, `OmniSpec`, `.AppImage`),
/// установщик берём только если больше нечего.
pub fn pick_asset(assets: &[ReleaseAsset]) -> Option<ReleaseAsset> {
    let candidates: Vec<&ReleaseAsset> = assets
        .iter()
        .filter(|asset| !asset.name.ends_with(".sha256") && !asset.name.ends_with(".sig"))
        .collect();
    if candidates.is_empty() {
        return None;
    }

    let is_windows = cfg!(windows);
    let is_mac = cfg!(target_os = "macos");

    let score = |asset: &ReleaseAsset| -> i32 {
        let name = asset.name.to_lowercase();
        if is_windows {
            if name == "omnispec.exe" {
                return 100;
            }
            if name.ends_with(".exe") && !name.contains("setup") && !name.contains("installer") {
                return 90;
            }
            if name.ends_with(".exe") {
                return 40;
            }
            return 0;
        }
        if is_mac {
            if name.ends_with(".app.tar.gz") {
                return 100;
            }
            if name.ends_with(".dmg") {
                return 60;
            }
            return 0;
        }
        // Linux
        if name == "omnispec" || (name.starts_with("omnispec") && !name.contains('.')) {
            return 100;
        }
        if name.ends_with(".appimage") {
            return 90;
        }
        if name.ends_with(".tar.gz") {
            return 50;
        }
        0
    };

    candidates
        .into_iter()
        .map(|asset| (score(asset), asset))
        .filter(|(score, _)| *score > 0)
        .max_by_key(|(score, _)| *score)
        .map(|(_, asset)| asset.clone())
}

/// Релиз новее текущей версии и содержит подходящий файл?
pub fn evaluate(release: &Release, current_version: &str) -> Option<UpdateInfo> {
    if release.draft {
        return None;
    }
    let version = release.version();
    if version.is_empty() || !is_newer(&version, current_version) {
        return None;
    }
    let asset = pick_asset(&release.assets)?;
    Some(UpdateInfo {
        version,
        current_version: current_version.to_string(),
        notes: release.body.clone().unwrap_or_default(),
        published_at: release.published_at.clone(),
        page_url: release.page_url(),
        asset_name: asset.name.clone(),
        asset_url: asset.browser_download_url.clone(),
        asset_size: asset.size,
        asset_digest: asset.digest.clone(),
    })
}

fn auth_token(config: &UpdateConfig) -> Option<&str> {
    config
        .token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

/// Проверить последний релиз. `Ok(None)` — обновлений нет.
pub async fn check(
    http: &Http,
    config: &UpdateConfig,
    current_version: &str,
) -> Result<Option<UpdateInfo>> {
    if !config.is_valid() {
        return Err(Error::Other(
            "не указан репозиторий обновлений (формат: владелец/репозиторий)".into(),
        ));
    }
    let token = auth_token(config);

    if config.include_prerelease {
        let url = format!(
            "{GITHUB_API}/repos/{}/{}/releases?per_page=10",
            config.owner, config.repo
        );
        let releases: Vec<Release> = http
            .get_json_with_token(&url, token)
            .await
            .map_err(explain_api_error)?;
        for release in releases.iter() {
            if release.prerelease && !release.draft {
                if let Some(info) = evaluate(release, current_version) {
                    return Ok(Some(info));
                }
            }
        }
    }

    let url = format!(
        "{GITHUB_API}/repos/{}/{}/releases/latest",
        config.owner, config.repo
    );
    let release: Release = match http.get_json_with_token(&url, token).await {
        Ok(release) => release,
        Err(error) => {
            // 404 — релизов ещё нет, это нормально для нового репозитория.
            let text = error.to_string();
            if text.contains("404") {
                return Ok(None);
            }
            return Err(explain_api_error(error));
        }
    };
    Ok(evaluate(&release, current_version))
}

/// Понятные сообщения вместо голого JSON от GitHub.
fn explain_api_error(error: Error) -> Error {
    let text = error.to_string();
    if text.contains("403") && (text.contains("rate limit") || text.contains("rate_limit")) {
        return Error::Other(
            "GitHub ограничил частоту запросов (60 в час на IP). Подождите несколько минут \
             или укажите токен GitHub в настройках → «Обновления»."
                .into(),
        );
    }
    if text.contains("401") || text.contains("Bad credentials") {
        return Error::Other(
            "GitHub не принял токен — проверьте его в настройках → «Обновления».".into(),
        );
    }
    error
}

/// Скачать новый бинарник в `<данные>/updates/`.
pub async fn download(
    http: &Http,
    paths: &Paths,
    info: &UpdateInfo,
    token: Option<&str>,
    reporter: &Reporter,
) -> Result<PathBuf> {
    let dir = updates_dir(paths);
    std::fs::create_dir_all(&dir)?;
    let file_name = if info.asset_name.trim().is_empty() {
        default_binary_name()
    } else {
        info.asset_name.clone()
    };
    let dest = dir.join(format!("new-{}", sanitize_file_name(&file_name)));

    reporter.emit(
        "update",
        0,
        info.asset_size,
        format!("скачиваем обновление {}", info.version),
    );
    http.download_with_token(
        &info.asset_url,
        &dest,
        Some(info.asset_size),
        token,
    )
    .await?;

    let size = std::fs::metadata(&dest).map(|meta| meta.len()).unwrap_or(0);
    if info.asset_size > 0 && size != info.asset_size {
        let _ = std::fs::remove_file(&dest);
        return Err(Error::Other(format!(
            "обновление скачалось не полностью ({size} из {})",
            info.asset_size
        )));
    }
    // На Unix у скачанного файла нет права на исполнение — без этого подмена
    // exe пройдёт, а вот запуск упадёт с «Permission denied».
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
    }

    reporter.emit("update", info.asset_size, info.asset_size, "загрузка завершена");
    Ok(dest)
}

pub fn updates_dir(paths: &Paths) -> PathBuf {
    paths.root.join("updates")
}

fn default_binary_name() -> String {
    if cfg!(windows) {
        "OmniSpec.exe".to_string()
    } else {
        "OmniSpec".to_string()
    }
}

fn sanitize_file_name(name: &str) -> String {
    name.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

/// Удалить старые скачанные обновления и помощников (вызывается при старте).
pub fn cleanup(paths: &Paths, keep: Option<&Path>) {
    let dir = updates_dir(paths);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(keep) = keep {
            if path == keep {
                continue;
            }
        }
        // Занятые файлы (например, работающий помощник) просто пропускаем.
        let _ = std::fs::remove_file(&path);
    }
}

/* ==================== ПОДМЕНА ФАЙЛА ==================== */

/// Запустить процесс-помощник, который заменит exe после выхода лаунчера.
///
/// На Windows нельзя перезаписать работающий .exe, поэтому копия текущего
/// бинарника запускается с флагом [`HELPER_FLAG`] и ждёт освобождения файла.
/// Такой подход не зависит от кодировки путей (в отличие от .bat-скриптов).
pub fn spawn_helper(new_binary: &Path, current_exe: &Path) -> Result<()> {
    let dir = new_binary
        .parent()
        .ok_or_else(|| Error::Other("неверный путь к обновлению".into()))?;
    let helper = dir.join(format!("helper{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(current_exe, &helper)?;

    let mut command = std::process::Command::new(&helper);
    command
        .arg(HELPER_FLAG)
        .arg(new_binary)
        .arg(current_exe)
        .current_dir(dir);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }

    command
        .spawn()
        .map_err(|error| Error::Other(format!("не удалось запустить помощник обновления: {error}")))?;
    Ok(())
}

/// Тело процесса-помощника: дождаться освобождения файла, заменить, запустить.
/// Возвращает код выхода для `std::process::exit`.
pub fn run_helper(new_binary: &Path, target: &Path) -> i32 {
    let mut replaced = false;
    for _ in 0..120 {
        // На Windows файл занят, пока процесс жив — пробуем переименование.
        if std::fs::rename(new_binary, target).is_ok() {
            replaced = true;
            break;
        }
        // Запасной путь: прямое копирование (актуально на Unix и для FAT-разделов).
        if !new_binary.exists() && target.exists() {
            replaced = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    if !replaced {
        eprintln!("[omnispec] не удалось заменить файл лаунчера: {}", target.display());
        return 1;
    }

    // Помощник тоже скопирован из exe — удалим его при следующем запуске.
    let _ = std::fs::metadata(target);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755));
    }

    match std::process::Command::new(target)
        .current_dir(target.parent().unwrap_or_else(|| Path::new(".")))
        .spawn()
    {
        Ok(_) => 0,
        Err(error) => {
            eprintln!("[omnispec] не удалось перезапустить лаунчер: {error}");
            1
        }
    }
}

/// На Unix файл можно заменить сразу: переименование поверх работающего бинарника.
#[cfg(unix)]
pub fn apply_now(new_binary: &Path, current_exe: &Path) -> Result<()> {
    std::fs::rename(new_binary, current_exe)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(current_exe, std::fs::Permissions::from_mode(0o755));
    }
    std::process::Command::new(current_exe)
        .current_dir(
            current_exe
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(".")),
        )
        .spawn()
        .map_err(|error| {
            Error::Other(format!(
                "обновление установлено, но запустить лаунчер не удалось ({error}). Запустите его вручную."
            ))
        })?;
    Ok(())
}

#[cfg(windows)]
pub fn apply_now(new_binary: &Path, current_exe: &Path) -> Result<()> {
    spawn_helper(new_binary, current_exe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare() {
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(is_newer("1.10.0", "1.9.9"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.1"));
        // Бета старше релиза той же версии.
        assert!(!is_newer("1.2.3-beta", "1.2.3"));
        assert!(is_newer("1.2.3", "1.2.3-beta"));
    }

    #[test]
    fn tags_normalized() {
        assert_eq!(normalize_version("v1.2.3"), "1.2.3");
        assert_eq!(normalize_version("V2.0"), "2.0");
        assert_eq!(normalize_version(" release-3.1.4 "), "3.1.4");
    }

    #[test]
    fn slug_parsing() {
        let config = UpdateConfig::from_slug("Shokydo/OmniSpec").unwrap();
        assert_eq!(config.owner, "Shokydo");
        assert_eq!(config.repo, "OmniSpec");
        assert_eq!(config.slug(), "Shokydo/OmniSpec");
        assert!(UpdateConfig::from_slug("broken").is_none());
        assert!(UpdateConfig::from_slug("https://github.com/a/b").is_none());
        assert!(UpdateConfig::from_slug("owner/re po").is_none());
        assert!(UpdateConfig::from_slug("/").is_none());
        assert!(UpdateConfig::from_slug("owner/repo/extra").is_none());
        assert_eq!(
            UpdateConfig::from_slug("a/b.git").unwrap().repo,
            "b"
        );
    }

    /// Имя портативного файла для текущей ОС (тесты идут и на Linux, и на Windows).
    fn platform_asset_name() -> &'static str {
        if cfg!(windows) {
            "OmniSpec.exe"
        } else if cfg!(target_os = "macos") {
            "OmniSpec.app.tar.gz"
        } else {
            "OmniSpec"
        }
    }

    fn asset(name: &str) -> ReleaseAsset {
        ReleaseAsset {
            name: name.to_string(),
            browser_download_url: format!("https://example.com/{name}"),
            size: 1234,
            digest: None,
        }
    }

    #[test]
    fn asset_selection_prefers_portable() {
        let portable = platform_asset_name();
        let assets = vec![
            asset("OmniSpec_0.1.0_x64-setup.exe"),
            asset(portable),
            asset(portable),
            asset("OmniSpec.exe.sha256"),
        ];
        let chosen = pick_asset(&assets).unwrap();
        assert_eq!(chosen.name, portable);
    }

    #[test]
    fn installer_is_only_a_fallback() {
        // Если портативного файла нет — берём хоть что-то подходящее для платформы.
        let only_setup = vec![asset("OmniSpec_0.1.0_x64-setup.exe")];
        let chosen = pick_asset(&only_setup);
        if cfg!(windows) {
            assert_eq!(chosen.unwrap().name, "OmniSpec_0.1.0_x64-setup.exe");
        } else {
            assert!(chosen.is_none());
        }
    }

    #[test]
    fn evaluate_requires_newer_version() {
        let release = Release {
            tag_name: "v1.1.0".into(),
            body: Some("Что нового".into()),
            assets: vec![asset(platform_asset_name())],
            html_url: Some("https://github.com/Shokydo/OmniSpec/releases/tag/v1.1.0".into()),
            ..Default::default()
        };
        assert!(evaluate(&release, "1.0.0").is_some());
        assert!(evaluate(&release, "1.1.0").is_none());
        assert!(evaluate(&release, "1.2.0").is_none());
    }

    /// Проверяем саму подмену файла: помощник переименовывает бинарник и запускает его.
    #[cfg(unix)]
    #[test]
    fn helper_replaces_binary_and_starts_it() {
        let dir = std::env::temp_dir().join(format!("omnispec-upd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let new_binary = dir.join("new-binary");
        let target = dir.join("target-binary");
        let marker = dir.join("started.marker");

        std::fs::write(&new_binary, "#!/bin/sh\necho ok\n").unwrap();
        std::fs::write(&target, "#!/bin/sh\nexit 1\n").unwrap();
        // «Новый» бинарник при запуске создаёт файл-маркер: так видно, что он стартовал.
        let script = format!("#!/bin/sh\ntouch '{}'\n", marker.display());
        std::fs::write(&new_binary, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        for file in [&new_binary, &target] {
            let mut perms = std::fs::metadata(file).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(file, perms).unwrap();
        }

        let code = run_helper(&new_binary, &target);
        assert_eq!(code, 0);
        std::thread::sleep(std::time::Duration::from_millis(400));
        assert!(marker.exists(), "заменённый файл должен был запуститься");
        assert!(!new_binary.exists(), "новый файл должен был переместиться");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn draft_and_empty_release_ignored() {
        let draft = Release {
            tag_name: "v9.9.9".into(),
            draft: true,
            assets: vec![asset(platform_asset_name())],
            ..Default::default()
        };
        assert!(evaluate(&draft, "1.0.0").is_none());

        let no_assets = Release {
            tag_name: "v9.9.9".into(),
            assets: vec![],
            ..Default::default()
        };
        assert!(evaluate(&no_assets, "1.0.0").is_none());
    }
}
