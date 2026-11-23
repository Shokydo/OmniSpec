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
            crate::instances::create_dir_beneath(game_dir, parent)?;
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

    let mut meta = install_archive(
        modrinth,
        paths,
        &archive,
        Some(format!("https://modrinth.com/modpack/{}", version.project_id)),
        reporter,
    )
    .await?;

    // Иконка сборки — та же картинка, что у проекта на Modrinth.
    set_project_icon(modrinth, paths, &mut meta, &version.project_id).await;
    instances::load(paths, &meta.id)?;
    Ok(meta)
}

/// Иконка внутри `.mrpack`: `icon.*` или `overrides/icon.*`.
/// Читаем байты как есть, чтобы GIF оставался анимированным после импорта.
fn read_icon(archive: &Path) -> Option<(String, Vec<u8>)> {
    let file = std::fs::File::open(archive).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    // Сначала проверяем корень, затем overrides — так сохраняется привычный
    // приоритет формата, но добавляются WebP/GIF и регистр имён не важен.
    let candidates = ["icon.png", "icon.jpg", "icon.jpeg", "icon.webp", "icon.gif"];
    for candidate in candidates {
        for prefix in ["", "overrides/"] {
            let wanted = format!("{prefix}{candidate}");
            let Ok(mut entry) = zip.by_name(&wanted) else {
                continue;
            };
            let mut bytes = Vec::new();
            if entry.read_to_end(&mut bytes).is_err() || bytes.is_empty() {
                continue;
            }
            let extension = candidate.rsplit('.').next().unwrap_or("png");
            return Some((format!("icon.{extension}"), bytes));
        }
    }
    // ZIP-архивы, созданные сторонними лаунчерами, иногда сохраняют регистр
    // расширения/папки. Для них делаем регистронезависимый проход.
    for index in 0..zip.len() {
        let Ok(mut entry) = zip.by_index(index) else {
            continue;
        };
        let name = entry.name().replace('\\', "/").to_ascii_lowercase();
        let file_name = name.strip_prefix("overrides/").unwrap_or(name.as_str());
        let allowed = ["icon.png", "icon.jpg", "icon.jpeg", "icon.webp", "icon.gif"];
        if !allowed.contains(&file_name) {
            continue;
        }
        let mut bytes = Vec::new();
        if entry.read_to_end(&mut bytes).is_err() || bytes.is_empty() {
            continue;
        }
        let extension = file_name.rsplit('.').next().unwrap_or("png");
        return Some((format!("icon.{extension}"), bytes));
    }
    None
}

/// Скачать иконку проекта Modrinth в папку сборки и прописать её в `meta.icon`.
///
/// Ошибки глотаем: сборка уже установлена, из-за картинки её ломать незачем.
async fn set_project_icon(
    modrinth: &Modrinth,
    paths: &Paths,
    meta: &mut InstanceMeta,
    project_id: &str,
) {
    let Ok(project) = modrinth.project(project_id).await else {
        return;
    };
    let Some(url) = project
        .icon_url
        .filter(|icon| !icon.trim().is_empty())
    else {
        return;
    };
    let extension = match url
        .rsplit('.')
        .next()
        .unwrap_or("")
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        "gif" => "gif",
        _ => "png",
    };
    let dir = paths.instance_dir(&meta.id);
    if instances::load(paths, &meta.id).is_err() || !dir.is_dir() {
        return;
    }
    let file_name = format!("icon.{extension}");
    let dest = dir.join(&file_name);
    if modrinth
        .http()
        .download_existing_dir(&url, &dest, None, None, false, None)
        .await
        .is_err()
    {
        return;
    }
    meta.icon = Some(file_name);
    let _ = instances::save(paths, meta);
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
            category: None,
            memory_mb: None,
            java_path: None,
            game_dir: None,
        },
    )?;

    // Иконка, если она лежит внутри архива (PNG/JPG/WebP/GIF сохраняем как есть).
    let mut meta = meta;
    if let Some((file_name, bytes)) = read_icon(archive) {
        let dir = paths.instance_dir(&meta.id);
        if dir.is_dir() && std::fs::write(dir.join(&file_name), bytes).is_ok()
        {
            meta.icon = Some(file_name);
            let _ = instances::save(paths, &meta);
        }
    }

    let game_dir = crate::instances::ensure_game_dir(paths, &meta)?;
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
    // Готовим вложенные папки без воссоздания корня после внешнего rename.
    for item in &items {
        if let Some(parent) = item.dest.parent() {
            crate::instances::create_dir_beneath(&game_dir, parent)?;
        }
    }
    modrinth
        .http()
        .download_all_existing_dirs(items, 8, reporter, "modpack")
        .await?;

    reporter.emit("modpack", 3, 4, "распаковываем overrides");
    let extracted = extract_overrides(archive, &game_dir)?;
    instances::load(paths, &meta.id)?;
    reporter.emit("modpack", 4, 4, format!("готово (overrides: {extracted})"));

    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn mrpack_gif_icon_is_read_without_reencoding() {
        let root = std::env::temp_dir().join(format!("omnispec-mrpack-gif-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let archive = root.join("icon.mrpack");
        let gif = b"GIF89a-fixture";
        let file = std::fs::File::create(&archive).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("OVERRIDES/ICON.GIF", options).unwrap();
        zip.write_all(gif).unwrap();
        zip.finish().unwrap();

        let result = read_icon(&archive).unwrap();
        assert_eq!(result.0, "icon.gif");
        assert_eq!(result.1, gif);
        let _ = std::fs::remove_dir_all(root);
    }
}
