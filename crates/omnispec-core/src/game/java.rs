//! Поиск Java, определение её версии и автоматическая загрузка рантайма от Mojang
//! (чтобы лаунчер работал «из коробки» у игрока без установленной Java).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::net::{DownloadItem, Http, Reporter};
use crate::paths::Paths;
use crate::settings::Settings;

const RUNTIME_MANIFEST_URL: &str =
    "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

/// Компоненты рантаймов в порядке предпочтения (новые первыми).
const COMPONENT_PREFERENCE: [&str; 5] = [
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

/// Найти все Java в системе (без дублей).
pub async fn detect_all(paths: &Paths) -> Vec<JavaInstall> {
    let mut seen: HashMap<PathBuf, JavaInstall> = HashMap::new();

    // Скачанные нами рантаймы Mojang
    for component in std::fs::read_dir(paths.java_dir()).into_iter().flatten().flatten() {
        for version in std::fs::read_dir(component.path()).into_iter().flatten().flatten() {
            let binary = java_binary(&version.path());
            if let Some(mut install) = probe(&binary).await {
                install.source = "mojang".into();
                seen.insert(binary, install);
            }
        }
    }

    for candidate in system_candidates() {
        if seen.contains_key(&candidate) {
            continue;
        }
        if let Some(install) = probe(&candidate).await {
            seen.insert(candidate, install);
        }
    }

    // "java" из PATH
    if let Some(install) = probe(Path::new("java")).await {
        seen.entry(install.path.clone()).or_insert(install);
    }

    let mut result: Vec<JavaInstall> = seen.into_values().collect();
    result.sort_by_key(|install| (install.major, install.path.clone()));
    result
}

/// Выбрать Java под требуемую мажорную версию.
/// Приоритет: точное совпадение → ближайшая старшая. Младшая не подходит никогда
/// (иначе игра просто не запустится), в этом случае нужно скачать рантайм.
pub fn pick_best(mut installs: Vec<JavaInstall>, required: u32) -> Option<JavaInstall> {
    if installs.is_empty() {
        return None;
    }
    installs.sort_by_key(|install| install.major);
    if let Some(exact) = installs.iter().find(|install| install.major == required) {
        return Some(exact.clone());
    }
    installs
        .into_iter()
        .filter(|install| install.major >= required)
        .min_by_key(|install| install.major)
}

/// Найти подходящую Java: настройки → система → скачивание рантайма Mojang.
pub async fn find_java(
    http: &Http,
    paths: &Paths,
    settings: &Settings,
    required_major: u32,
    reporter: &Reporter,
) -> Result<JavaInstall> {
    if let Some(custom) = settings.java_path() {
        let path = PathBuf::from(custom);
        if let Some(mut install) = probe(&path).await {
            install.source = "settings".into();
            return Ok(install);
        }
        return Err(Error::Java(format!(
            "указанный в настройках путь к Java не работает: {custom}"
        )));
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
        "нужна Java {required_major} (или новее), а подходящей не найдено. \
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

    candidates.sort_by_key(|(major, _, _, _)| *major);
    let chosen = candidates
        .iter()
        .find(|(major, _, _, _)| *major == required_major)
        .or_else(|| {
            candidates
                .iter()
                .filter(|(major, _, _, _)| *major >= required_major)
                .min_by_key(|(major, _, _, _)| *major)
        })
        .or_else(|| candidates.last())
        .cloned()
        .unwrap();

    let (major, component, version, manifest_url) = chosen;
    let target = paths.java_dir().join(&component).join(&version);
    let manifest: RuntimeManifest = http.get_json(&manifest_url).await?;

    let mut items = Vec::new();
    for (relative, file) in &manifest.files {
        if file.kind != "file" {
            continue;
        }
        let Some(download) = file.downloads.get("raw") else {
            // Бывает только lzma-вариант — такие файлы пропускаем.
            continue;
        };
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
        async move { http.download(&item.url, &item.dest, item.size, None, false).await }
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
                let path = target.join(relative);
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
    reporter.emit("java", 1, 1, format!("Java {major} готова"));
    Ok(JavaInstall {
        source: "mojang".into(),
        ..install
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(pick_best(vec![make(21), make(8)], 17).unwrap().major, 21);
        assert!(pick_best(vec![make(8)], 17).is_none());
    }
}
