//! Импорт модпаков `.mrpack` с Modrinth: создаёт сборку, качает все файлы,
//! распаковывает overrides.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::instances::{self, CreateInstanceRequest, InstanceMeta, Loader};
use crate::net::{DownloadItem, Reporter};
use crate::paths::Paths;

use super::{Modrinth, Version};

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ModpackIndex {
    #[serde(default)]
    pub format_version: u32,
    #[serde(default)]
    pub game: String,
    #[serde(default)]
    pub version_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub files: Vec<IndexFile>,
    #[serde(default)]
    pub dependencies: HashMap<String, String>,
    /// Некоторые модпаки дублируют список версий игры здесь.
    #[serde(default, rename = "gameVersions")]
    pub game_versions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct IndexFile {
    pub path: String,
    #[serde(default)]
    pub hashes: HashMap<String, String>,
    #[serde(default)]
    pub env: Option<FileEnv>,
    #[serde(default)]
    pub downloads: Vec<String>,
    #[serde(default)]
    pub file_size: u64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct FileEnv {
    #[serde(default)]
    pub client: Option<String>,
    #[serde(default)]
    pub server: Option<String>,
}

/// Определить загрузчик из блока `dependencies` модпака.
fn loader_from_dependencies(dependencies: &HashMap<String, String>) -> Loader {
    if let Some(version) = dependencies.get("fabric-loader") {
        return Loader::Fabric {
            version: version.clone(),
        };
    }
    if let Some(version) = dependencies.get("quilt-loader") {
        return Loader::Quilt {
            version: version.clone(),
        };
    }
    if let Some(version) = dependencies.get("neoforge") {
        return Loader::NeoForge {
            version: version.clone(),
        };
    }
    if let Some(version) = dependencies.get("forge") {
        return Loader::Forge {
            version: version.clone(),
        };
    }
    Loader::Vanilla
}

fn read_index(archive_path: &Path) -> Result<ModpackIndex> {
    let file = std::fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut entry = archive
        .by_name("modrinth.index.json")
        .map_err(|_| Error::Other("в .mrpack нет modrinth.index.json".into()))?;
    let mut text = String::new();
    entry.read_to_string(&mut text)?;
    Ok(serde_json::from_str(&text)?)
}

/// Проверяем, что путь внутри архива не вылезет за пределы папки сборки.
fn safe_relative_path(path: &str) -> Result<std::path::PathBuf> {
    let candidate = std::path::PathBuf::from(path.replace('\\', "/"));
    if candidate.is_absolute() {
        return Err(Error::Other(format!("недопустимый путь в модпаке: {path}")));
    }
    for component in candidate.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(Error::Other(format!("недопустимый путь в модпаке: {path}")));
        }
    }
    Ok(candidate)
}

fn extract_overrides(archive_path: &Path, game_dir: &Path) -> Result<usize> {
    let file = std::fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut count = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let name = entry.name().to_string();
        let relative = name
            .strip_prefix("client-overrides/")
            .or_else(|| name.strip_prefix("overrides/"));
        let Some(relative) = relative else {
            continue;
        };
        if relative.is_empty() || name.ends_with('/') {
            continue;
        }
        let Ok(relative) = safe_relative_path(relative) else {
            continue;
        };
        let dest = game_dir.join(relative);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut buffer = Vec::new();
        entry.read_to_end(&mut buffer)?;
        std::fs::write(&dest, buffer)?;
        count += 1;
    }
    Ok(count)
}

/// Скачать и установить модпак с Modrinth как новую сборку.
pub async fn install(
    modrinth: &Modrinth,
    paths: &Paths,
    version: &Version,
    reporter: &Reporter,
) -> Result<InstanceMeta> {
    let file = version
        .modpack_file()
        .ok_or_else(|| Error::not_found("у этой версии нет файла .mrpack"))?;

    reporter.emit("modpack", 0, 4, "скачиваем модпак");
    let archive = paths.cache().join(&file.filename);
    modrinth
        .http()
        .download(&file.url, &archive, Some(file.size), None, true)
        .await?;

    install_archive(
        modrinth,
        paths,
        &archive,
        Some(format!("https://modrinth.com/modpack/{}", version.project_id)),
        reporter,
    )
    .await
}

/// Установить уже скачанный `.mrpack` (локальный импорт).
pub async fn install_archive(
    modrinth: &Modrinth,
    paths: &Paths,
    archive: &Path,
    source_url: Option<String>,
    reporter: &Reporter,
) -> Result<InstanceMeta> {
    reporter.emit("modpack", 1, 4, "читаем описание модпака");
    let index = read_index(archive)?;
    let mc_version = index
        .dependencies
        .get("minecraft")
        .cloned()
        .or_else(|| index.game_versions.first().cloned())
        .ok_or_else(|| Error::Other("в модпаке не указана версия Minecraft".into()))?;
    let loader = loader_from_dependencies(&index.dependencies);
    let name = if index.name.is_empty() {
        "Импортированный модпак".to_string()
    } else {
        index.name.clone()
    };

    let meta = instances::create(
        paths,
        CreateInstanceRequest {
            name,
            mc_version,
            loader,
            icon: None,
            notes: index.summary.clone().unwrap_or_default(),
            source: Some("modrinth".into()),
            source_url,
            id: None,
        },
    )?;

    let game_dir = paths.instance_game_dir(&meta.id);
    let mut items = Vec::new();
    for entry in &index.files {
        if entry
            .env
            .as_ref()
            .and_then(|env| env.client.clone())
            .map(|client| client == "unsupported")
            .unwrap_or(false)
        {
            continue;
        }
        let Some(url) = entry.downloads.first() else {
            continue;
        };
        let Ok(relative) = safe_relative_path(&entry.path) else {
            continue;
        };
        items.push(
            DownloadItem::new(url.clone(), game_dir.join(relative))
                .with_size(Some(entry.file_size))
                .with_sha1(entry.hashes.get("sha1").cloned()),
        );
    }

    reporter.emit(
        "modpack",
        2,
        4,
        format!("скачиваем файлов: {}", items.len()),
    );
    let total = items.len() as u64;
    let mut done = 0u64;
    let http = modrinth.http().clone();
    let reporter_inner = reporter.clone();
    let mut stream = futures::stream::iter(items.into_iter().map(|item| {
        let http = http.clone();
        async move { http.download(&item.url, &item.dest, item.size, None, false).await }
    }))
    .buffer_unordered(8)
    .boxed();
    use futures::StreamExt;
    while let Some(result) = stream.next().await {
        done += 1;
        result?;
        reporter_inner.emit("modpack", done, total, format!("файлов {done}/{total}"));
    }

    reporter.emit("modpack", 3, 4, "распаковываем overrides");
    let extracted = extract_overrides(archive, &game_dir)?;
    reporter.emit("modpack", 4, 4, format!("готово (overrides: {extracted})"));

    Ok(meta)
}
