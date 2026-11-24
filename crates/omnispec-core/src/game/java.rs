//! Поиск Java, определение её версии и автоматическая загрузка рантайма от Mojang
//! (чтобы лаунчер работал «из коробки» у игрока без установленной Java).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::io::Read;
use sha1::{Digest, Sha1};

use futures::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::net::{DownloadItem, Http, Reporter};
use crate::paths::Paths;
use crate::settings::Settings;

const RUNTIME_MANIFEST_URL: &str =
    "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

/// Компоненты рантаймов в порядке предпочтения (новые первыми).
const COMPONENT_PREFERENCE: [&str; 6] = [
    "java-runtime-epsilon",
    "java-runtime-delta",
    "java-runtime-gamma",
    "java-runtime-beta",
    "java-runtime-alpha",
    "jre-legacy",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JavaInstall {
    pub path: PathBuf,
    pub major: u32,
    pub vendor: String,
    /// "settings" | "system" | "mojang" — откуда взялась.
    pub source: String,
}

impl JavaInstall {
    pub fn display(&self) -> String {
        format!(
            "Java {} ({}, {})",
            self.major,
            self.vendor,
            self.path.display()
        )
    }
}

/// Разобрать вывод `java -version`.
pub fn parse_version_output(path: &Path, text: &str) -> Option<JavaInstall> {
    let re = Regex::new(r#"version "([^"]+)""#).ok()?;
    let version = re.captures(text)?.get(1)?.as_str().to_string();
    let major = parse_major(&version)?;
    let lower = text.to_lowercase();
    let vendor = if lower.contains("temurin") {
        "Eclipse Temurin"
    } else if lower.contains("adoptium") || lower.contains("adoptopenjdk") {
        "Adoptium"
    } else if lower.contains("graal") {
        "GraalVM"
    } else if lower.contains("zulu") {
        "Azul Zulu"
    } else if lower.contains("corretto") {
        "Amazon Corretto"
    } else if lower.contains("microsoft") {
        "Microsoft OpenJDK"
    } else if lower.contains("openjdk") {
        "OpenJDK"
    } else {
        "Java"
    };
    Some(JavaInstall {
        path: path.to_path_buf(),
        major,
        vendor: vendor.to_string(),
        source: "system".into(),
    })
}

/// "1.8.0_402" → 8, "17.0.9" → 17, "21" → 21.
pub fn parse_major(version: &str) -> Option<u32> {
    let version = version.trim();
    if let Some(rest) = version.strip_prefix("1.") {
        rest.split(['.', '_', '-', '+']).next()?.parse().ok()
    } else {
        version.split(['.', '_', '-', '+']).next()?.parse().ok()
    }
}

/// Имя исполняемого файла Java для текущей ОС.
pub fn java_binary(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join("bin").join("javaw.exe")
    } else {
        dir.join("bin").join("java")
    }
}

/// Запустить `java -version` и вернуть информацию.
pub async fn probe(path: &Path) -> Option<JavaInstall> {
    if !path.exists() {
        return None;
    }
    let output = tokio::process::Command::new(path)
        .arg("-version")
        .output()
        .await
        .ok()?;
    let mut text = String::from_utf8_lossy(&output.stderr).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stdout));
    parse_version_output(path, &text)
}

/// Кандидаты для сканирования системы.
pub fn system_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(java_home) = std::env::var("JAVA_HOME") {
        if !java_home.trim().is_empty() {
            candidates.push(java_binary(Path::new(java_home.trim())));
        }
    }

    if cfg!(windows) {
        let mut roots: Vec<PathBuf> = Vec::new();
        for var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(var) {
                roots.push(PathBuf::from(&base).join("Java"));
                roots.push(PathBuf::from(&base).join("Eclipse Adoptium"));
                roots.push(PathBuf::from(&base).join("Microsoft").join("jdk"));
                roots.push(PathBuf::from(&base).join("Programs").join("Eclipse Adoptium"));
                roots.push(PathBuf::from(&base).join("Amazon Corretto"));
                roots.push(PathBuf::from(&base).join("Zulu"));
            }
        }
        for root in roots {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    candidates.push(java_binary(&path));
                }
            }
            // Amazon Corretto кладёт jdk в подпапку версии — заглянем на уровень глубже.
            for entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    for inner in std::fs::read_dir(&path).into_iter().flatten().flatten() {
                        if inner.path().is_dir() {
                            candidates.push(java_binary(&inner.path()));
                        }
                    }
                }
            }
        }
    } else if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from("/usr/bin/java"));
        if let Ok(entries) = std::fs::read_dir("/Library/Java/JavaVirtualMachines") {
            for entry in entries.flatten() {
                candidates.push(java_binary(&entry.path().join("Contents").join("Home")));
            }
        }
    } else {
        candidates.push(PathBuf::from("/usr/bin/java"));
        candidates.push(PathBuf::from("/usr/local/bin/java"));
        if let Ok(entries) = std::fs::read_dir("/usr/lib/jvm") {
            for entry in entries.flatten() {
                candidates.push(java_binary(&entry.path()));
            }
        }
    }

    candidates
}

/// Ключ — реальный путь к бинарнику: `/usr/bin/java` и `/usr/lib/jvm/.../bin/java`
/// ведут к одной и той же Java, дублировать их в списке не нужно.
fn path_key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Отпечаток бинарника «время изменения|размер»: если Java обновили, отпечаток
/// изменится и мы опросим её заново.
fn binary_fingerprint(path: &Path) -> String {
    let Ok(meta) = std::fs::metadata(path) else {
        return String::new();
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|age| age.as_secs())
        .unwrap_or(0);
    format!("{mtime}|{}", meta.len())
}

/// Запись кеша найденных Java.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedJava {
    path: String,
    major: u32,
    vendor: String,
    source: String,
    stamp: String,
}

fn java_cache_file(paths: &Paths) -> PathBuf {
    paths.cache().join("java-detected.json")
}

/// Прочитать кеш и отбросить записи, у которых бинарник пропал или изменился.
/// Именно это убирает запуск `java -version` на каждый старт игры: раньше
/// подходящая Java искалась опросом процессов (на Windows это 1–3 секунды).
pub fn cached_installs(paths: &Paths) -> Vec<JavaInstall> {
    let Ok(text) = std::fs::read_to_string(java_cache_file(paths)) else {
        return Vec::new();
    };
    let Ok(entries) = serde_json::from_str::<Vec<CachedJava>>(&text) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter_map(|entry| {
            let path = PathBuf::from(&entry.path);
            let stamp = binary_fingerprint(&path);
            if stamp.is_empty() || stamp != entry.stamp {
                return None;
            }
            Some(JavaInstall {
                path,
                major: entry.major,
                vendor: entry.vendor,
                source: entry.source,
            })
        })
        .collect()
}

fn save_cache(paths: &Paths, installs: &[JavaInstall]) {
    let entries: Vec<CachedJava> = installs
        .iter()
        .filter_map(|install| {
            let stamp = binary_fingerprint(&install.path);
            if stamp.is_empty() {
                return None;
            }
            Some(CachedJava {
                path: install.path.display().to_string(),
                major: install.major,
                vendor: install.vendor.clone(),
                source: install.source.clone(),
                stamp,
            })
        })
        .collect();
    if let Ok(text) = serde_json::to_string_pretty(&entries) {
        let _ = std::fs::create_dir_all(paths.cache());
        let _ = std::fs::write(java_cache_file(paths), text);
    }
}

/// Все кандидаты-бинарники: рантаймы Mojang, системные папки и `java` из PATH.
fn candidate_binaries(paths: &Paths) -> Vec<(PathBuf, String)> {
    let mut result: Vec<(PathBuf, String)> = Vec::new();
    for component in std::fs::read_dir(paths.java_dir()).into_iter().flatten().flatten() {
        for version in std::fs::read_dir(component.path()).into_iter().flatten().flatten() {
            result.push((java_binary(&version.path()), "mojang".to_string()));
        }
    }
    for candidate in system_candidates() {
        result.push((candidate, "system".to_string()));
    }
    result.push((PathBuf::from("java"), "system".to_string()));
    result
}

/// Найти все Java в системе (без дублей).
///
/// Уже известные Java берутся из кеша (без запуска процессов), опрашиваются
/// только новые кандидаты — и параллельно, а не по одной.
pub async fn detect_all(paths: &Paths) -> Vec<JavaInstall> {
    let cached = cached_installs(paths);
    let mut seen: HashMap<PathBuf, JavaInstall> = HashMap::new();
    for install in &cached {
        seen.insert(path_key(&install.path), install.clone());
    }
    let known: std::collections::HashSet<PathBuf> =
        cached.iter().map(|install| install.path.clone()).collect();

    let mut fresh: Vec<(PathBuf, String)> = Vec::new();
    for (path, source) in candidate_binaries(paths) {
        if known.contains(&path) {
            continue;
        }
        fresh.push((path, source));
    }

    // Опроc вынесен в отдельную async-функцию: замыкание, возвращающее
    // async-блок, ломает вывод типов у `buffer_unordered` (Rust тогда не может
    // доказать Send для futures команд Tauri целиком).
    let mut probes = futures::stream::iter(
        fresh
            .into_iter()
            .map(|(path, source)| probe_candidate(path, source)),
    )
    .buffer_unordered(8);

    while let Some((maybe, source)) = probes.next().await {
        if let Some(install) = maybe {
            let mut install = install;
            if install.source != "mojang" {
                install.source = source.clone();
            }
            seen.entry(path_key(&install.path)).or_insert(install);
        }
    }

    let mut result: Vec<JavaInstall> = seen.into_values().collect();
    result.sort_by_key(|install| (install.major, install.path.clone()));
    save_cache(paths, &result);
    result
}

/// Один кандидат: запустить `java -version` и запомнить, откуда он взялся.
async fn probe_candidate(path: PathBuf, source: String) -> (Option<JavaInstall>, String) {
    (probe(&path).await, source)
}

/// Используем рекомендованную версию профиля: более новая Java не обязательно
/// совместима со старыми загрузчиками и модами (например, Forge 1.16.5).
pub fn pick_best(installs: Vec<JavaInstall>, required: u32) -> Option<JavaInstall> {
    installs.into_iter().find(|install| install.major == required)
}

/// Explicit per-instance paths are never silently replaced.
pub async fn find_explicit_java(custom: &str, required_major: u32) -> Result<JavaInstall> {
    let path = PathBuf::from(custom);
    let mut install = probe(&path).await.ok_or_else(|| Error::Java(format!("указанный путь к Java не работает: {custom}")))?;
    if install.major != required_major {
        return Err(Error::Java(format!("выбрана Java {}, а требуется Java {}: измените путь или включите автоматический выбор", install.major, required_major)));
    }
    install.source = "settings".into();
    Ok(install)
}

/// Найти подходящую Java: настройки → система → скачивание рантайма Mojang.
pub async fn find_java(
    http: &Http,
    paths: &Paths,
    settings: &Settings,
    required_major: u32,
    reporter: &Reporter,
) -> Result<JavaInstall> {
    // Global choices are preferences when auto-selection is enabled: a single
    // Java 21 path must not prevent an older profile from obtaining Java 8.
    let preferred = if required_major <= 8 {
        settings.java_path_legacy.as_deref().filter(|p| !p.trim().is_empty()).or_else(|| settings.java_path())
    } else { settings.java_path() };
    if let Some(custom) = preferred {
        match find_explicit_java(custom, required_major).await {
            Ok(install) => return Ok(install),
            Err(error) if settings.auto_java => reporter.emit("java", 0, 1, format!("{error}; ищем подходящую Java {required_major} автоматически")),
            Err(error) => return Err(error),
        }
    }

    // Сначала кеш: подходящая Java уже известна — ни одного лишнего процесса.
    let cached = pick_best(cached_installs(paths), required_major);
    if let Some(install) = cached {
        return Ok(install);
    }

    let detected = detect_all(paths).await;
    if let Some(install) = pick_best(detected, required_major) {
        return Ok(install);
    }

    if settings.auto_java {
        reporter.emit(
            "java",
            0,
            1,
            format!("подходящая Java {required_major} не найдена, качаем рантайм Mojang"),
        );
        return install_mojang_runtime(http, paths, required_major, reporter).await;
    }

    Err(Error::Java(format!(
        "нужна Java {required_major}, а подходящей не найдено. \
         Установите её, укажите путь в настройках или включите автозагрузку рантайма Mojang"
    )))
}

#[derive(Debug, Deserialize)]
struct RuntimeEntry {
    manifest: RuntimeRef,
    version: RuntimeVersion,
}

#[derive(Debug, Deserialize)]
struct RuntimeRef {
    url: String,
}

#[derive(Debug, Deserialize)]
struct RuntimeVersion {
    name: String,
}

#[derive(Debug, Deserialize)]
struct RuntimeFile {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    downloads: HashMap<String, RuntimeDownload>,
    #[serde(default)]
    executable: bool,
}

#[derive(Debug, Deserialize)]
struct RuntimeDownload {
    url: String,
    #[serde(default)]
    sha1: Option<String>,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Deserialize)]
struct RuntimeManifest {
    files: HashMap<String, RuntimeFile>,
}

fn platform_key() -> String {
    if cfg!(target_os = "windows") {
        if cfg!(target_arch = "x86") {
            "windows-x86".into()
        } else {
            "windows-x64".into()
        }
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "mac-os-arm64".into()
        } else {
            "mac-os".into()
        }
    } else if cfg!(target_arch = "x86") {
        "linux-i386".into()
    } else {
        "linux".into()
    }
}

/// Мажорная версия из файла `release` внутри рантайма.
fn major_from_release_file(text: &str) -> Option<u32> {
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("JAVA_VERSION=") {
            return parse_major(value.trim_matches('"'));
        }
    }
    None
}

fn safe_runtime_path(relative: &str) -> Result<&Path> {
    let path = Path::new(relative);
    if relative.contains('\\') || path.components().any(|c| !matches!(c, Component::Normal(_))) || relative.is_empty() {
        return Err(Error::Java(format!("небезопасный путь в манифесте Java: {relative}")));
    }
    Ok(path)
}

fn verify_runtime_file(path: &Path, expected_size: u64, expected_sha1: &str) -> Result<bool> {
    let mut file = std::fs::File::open(path)?;
    if file.metadata()?.len() != expected_size { return Ok(false); }
    let mut hash = Sha1::new();
    let mut buffer = [0u8; 65536];
    loop { let n = file.read(&mut buffer)?; if n == 0 { break; } hash.update(&buffer[..n]); }
    Ok(format!("{:x}", hash.finalize()).eq_ignore_ascii_case(expected_sha1))
}

/// Скачать рантайм Mojang нужной мажорной версии.
pub async fn install_mojang_runtime(
    http: &Http,
    paths: &Paths,
    required_major: u32,
    reporter: &Reporter,
) -> Result<JavaInstall> {
    let manifest: HashMap<String, HashMap<String, Vec<RuntimeEntry>>> =
        http.get_json(RUNTIME_MANIFEST_URL).await?;
    let platform = platform_key();
    let components = manifest
        .get(&platform)
        .ok_or_else(|| Error::Java(format!("для платформы {platform} нет рантаймов Mojang")))?;

    // Определяем мажорную версию каждого компонента по его файлу `release`.
    let mut candidates: Vec<(u32, String, String, String)> = Vec::new(); // (major, component, version, manifest url)
    for component in COMPONENT_PREFERENCE {
        let Some(entries) = components.get(component) else {
            continue;
        };
        let Some(entry) = entries.first() else {
            continue;
        };
        let Ok(runtime) = http.get_json::<RuntimeManifest>(&entry.manifest.url).await else {
            continue;
        };
        let major = match runtime.files.get("release").and_then(|file| file.downloads.get("raw")) {
            Some(download) => match http.get_text(&download.url).await {
                Ok(text) => major_from_release_file(&text),
                Err(_) => None,
            },
            None => None,
        };
        if let Some(major) = major {
            candidates.push((
                major,
                component.to_string(),
                entry.version.name.clone(),
                entry.manifest.url.clone(),
            ));
        }
    }

    if candidates.is_empty() {
        return Err(Error::Java(
            "не удалось определить доступные рантаймы Mojang".into(),
        ));
    }

    let chosen = candidates
        .iter()
        .find(|(major, _, _, _)| *major == required_major)
        .cloned()
        .ok_or_else(|| Error::Java(format!(
            "рантайм Mojang для Java {required_major} недоступен на этой платформе. Установите Java {required_major} и укажите её путь в настройках"
        )))?;

    let (major, component, version, manifest_url) = chosen;
    let target = paths.java_dir().join(&component).join(&version);
    let manifest: RuntimeManifest = http.get_json(&manifest_url).await?;

    let mut items = Vec::new();
    for (relative, file) in &manifest.files {
        if file.kind != "file" {
            continue;
        }
        let download = file.downloads.get("raw").ok_or_else(|| Error::Java(format!("файл Java {relative} недоступен для загрузки")))?;
        if download.sha1.as_deref().filter(|h| h.len() == 40 && h.bytes().all(|b| b.is_ascii_hexdigit())).is_none() {
            return Err(Error::Java(format!("у файла Java {relative} отсутствует контрольная сумма")));
        }
        let relative = safe_runtime_path(relative)?;
        items.push(
            DownloadItem::new(download.url.clone(), target.join(relative))
                .with_size(Some(download.size))
                .with_sha1(download.sha1.clone()),
        );
    }

    reporter.emit(
        "java",
        0,
        items.len() as u64,
        format!("скачиваем Java {major} ({component})"),
    );
    let total = items.len() as u64;
    let mut done = 0u64;
    let http_inner = http.clone();
    let reporter_inner = reporter.clone();
    let mut stream = futures::stream::iter(items.into_iter().map(|item| {
        let http = http_inner.clone();
        async move {
            let size = item.size.ok_or_else(|| Error::Java("нет размера файла Java".into()))?;
            let sha = item.sha1.as_deref().ok_or_else(|| Error::Java("нет контрольной суммы файла Java".into()))?;
            let valid = verify_runtime_file(&item.dest, size, sha).unwrap_or(false);
            if !valid {
                http.download(&item.url, &item.dest, Some(size), None, true).await?;
                if !verify_runtime_file(&item.dest, size, sha)? {
                    let _ = std::fs::remove_file(&item.dest);
                    return Err(Error::Java(format!("контрольная сумма файла Java не совпадает: {}", item.dest.display())));
                }
            }
            Ok::<(), Error>(())
        }
    }))
    .buffer_unordered(8)
    .boxed();
    use futures::StreamExt;
    while let Some(result) = stream.next().await {
        done += 1;
        result?;
        reporter_inner.emit("java", done, total, format!("{done}/{total}"));
    }

    // Отметим исполняемые файлы (на Unix без этого java не запустится).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for (relative, file) in &manifest.files {
            if file.executable && file.kind == "file" {
                let path = target.join(safe_runtime_path(relative)?);
                if let Ok(meta) = std::fs::metadata(&path) {
                    let mut perms = meta.permissions();
                    perms.set_mode(perms.mode() | 0o755);
                    let _ = std::fs::set_permissions(&path, perms);
                }
            }
        }
    }

    let binary = java_binary(&target);
    let install = probe(&binary)
        .await
        .ok_or_else(|| Error::Java(format!("скачанный рантайм не запускается: {}", binary.display())))?;
    if install.major != required_major {
        return Err(Error::Java(format!(
            "скачанный рантайм оказался Java {}, а требуется Java {}. Укажите корректный путь к Java {} в настройках",
            install.major, required_major, required_major
        )));
    }
    reporter.emit("java", 1, 1, format!("Java {major} готова"));
    reporter.emit_state("java", "done", "готово");
    Ok(JavaInstall {
        source: "mojang".into(),
        ..install
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_paths_and_runtime_hash() {
        assert!(safe_runtime_path("bin/java").is_ok());
        for path in ["../java", "/tmp/java", "bin/../java", "bin\\java", ""] {
            assert!(safe_runtime_path(path).is_err(), "{path}");
        }
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"abc").unwrap();
        assert!(verify_runtime_file(file.path(), 3, "a9993e364706816aba3e25717850c26c9cd0d89d").unwrap());
        assert!(!verify_runtime_file(file.path(), 3, "0000000000000000000000000000000000000000").unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn global_mismatch_falls_back_but_explicit_path_is_strict() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let paths = Paths::new(root.path()).unwrap();
        let fake = |path: &Path, version: &str| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, format!("#!/bin/sh\necho 'openjdk version \"{version}\"' >&2\n")).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let java8 = java_binary(&paths.java_dir().join("test").join("v8"));
        let java21 = root.path().join("java21");
        fake(&java8, "1.8.0_402"); fake(&java21, "21.0.4");
        let mut settings = Settings::default(); settings.java_path = Some(java21.to_string_lossy().to_string());
        assert!(find_explicit_java(settings.java_path().unwrap(), 8).await.is_err());
        let found = find_java(&Http::new(), &paths, &settings, 8, &Reporter::none()).await.unwrap();
        assert_eq!(found.major, 8);
        settings.auto_java = false;
        assert!(find_java(&Http::new(), &paths, &settings, 8, &Reporter::none()).await.is_err());
        settings.java_path_legacy = Some(java8.to_string_lossy().to_string());
        assert_eq!(find_java(&Http::new(), &paths, &settings, 8, &Reporter::none()).await.unwrap().source, "settings");
    }

    #[test]
    fn majors() {
        assert_eq!(parse_major("1.8.0_402"), Some(8));
        assert_eq!(parse_major("17.0.9"), Some(17));
        assert_eq!(parse_major("21"), Some(21));
        assert_eq!(parse_major("1.7.0"), Some(7));
    }

    #[test]
    fn release_file_parsing() {
        let text = "IMPLEMENTOR=\"Eclipse Adoptium\"\nJAVA_VERSION=\"21.0.4\"\n";
        assert_eq!(major_from_release_file(text), Some(21));
    }

    #[test]
    fn picking() {
        let make = |major: u32| JavaInstall {
            path: PathBuf::from(format!("/java{major}")),
            major,
            vendor: "test".into(),
            source: "system".into(),
        };
        assert_eq!(pick_best(vec![make(17), make(21)], 17).unwrap().major, 17);
        assert!(pick_best(vec![make(21), make(8)], 17).is_none());
        assert!(pick_best(vec![make(25)], 8).is_none());
        assert_eq!(pick_best(vec![make(25), make(8)], 8).unwrap().major, 8);
        assert!(pick_best(vec![make(8)], 17).is_none());
    }
}
