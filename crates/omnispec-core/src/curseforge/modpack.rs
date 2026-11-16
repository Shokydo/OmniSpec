//! Установка модпаков CurseForge как отдельной сборки.
//!
//! Внутри архива лежит `manifest.json`: версия Minecraft, загрузчик, список
//! файлов (`projectID` + `fileID`) и папка overrides. Сборку создаём сами,
//! файлы тянем через API (ссылки в манифесте не хранятся), overrides просто
//! распаковываем поверх.

use std::io::Read;
use std::path::Path;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::instances::{self, CreateInstanceRequest, InstanceMeta, Loader};
use crate::net::{DownloadItem, Reporter};
use crate::paths::Paths;

use super::CurseForge;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub minecraft: ManifestMinecraft,
    #[serde(default)]
    pub files: Vec<ManifestFile>,
    /// Папка с готовыми файлами внутри архива, обычно `overrides`.
    #[serde(default)]
    pub overrides: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ManifestMinecraft {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub mod_loaders: Vec<ManifestLoader>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ManifestLoader {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub primary: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    // в манифесте CurseForge ключи именно с большой «ID», camelCase тут не подходит
    #[serde(default, rename = "projectID")]
    pub project_id: u32,
    #[serde(default, rename = "fileID")]
    pub file_id: u32,
    /// `false` — необязательный файл, такие не ставим.
    #[serde(default = "yes")]
    pub required: bool,
}

fn yes() -> bool {
    true
}

/// `forge-47.2.0`, `neoforge-21.1.80`, `fabric-0.16.9`, `quilt-0.20.0`.
fn loader_from_manifest(loaders: &[ManifestLoader]) -> Loader {
    let chosen = loaders
        .iter()
        .find(|loader| loader.primary)
        .or_else(|| loaders.first());
    let Some(id) = chosen.map(|loader| loader.id.trim()).filter(|id| !id.is_empty()) else {
        return Loader::Vanilla;
    };
    let (kind, version) = match id.split_once('-') {
        Some((kind, version)) => (kind.to_lowercase(), version.to_string()),
        None => (id.to_lowercase(), String::new()),
    };
    match kind.as_str() {
        "forge" => Loader::Forge { version },
        "neoforge" | "neo-forge" => Loader::NeoForge { version },
        "fabric" => Loader::Fabric { version },
        "quilt" => Loader::Quilt { version },
        _ => Loader::Vanilla,
    }
}

fn read_manifest(archive_path: &Path) -> Result<Manifest> {
    let file = std::fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut entry = archive
        .by_name("manifest.json")
        .map_err(|_| Error::Other("в модпаке CurseForge нет manifest.json".into()))?;
    let mut text = String::new();
    entry.read_to_string(&mut text)?;
    Ok(serde_json::from_str(&text)?)
}

/// Путь внутри архива не должен вылезать за пределы папки сборки.
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

/// Распаковать `overrides/` (или папку из манифеста) поверх папки сборки.
fn extract_overrides(archive_path: &Path, game_dir: &Path, folder: &str) -> Result<usize> {
    let prefix = format!("{}/", folder.trim_matches('/'));
    let file = std::fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut count = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let name = entry.name().to_string();
        let Some(relative) = name.strip_prefix(&prefix) else {
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

/// Скачать иконку проекта в папку сборки. Ошибки глотаем: сборка важнее картинки.
async fn set_project_icon(
    curseforge: &CurseForge,
    paths: &Paths,
    meta: &mut InstanceMeta,
    icon_url: Option<&str>,
) {
    let Some(url) = icon_url.filter(|url| !url.trim().is_empty()) else {
        return;
    };
    let dir = paths.instance_dir(&meta.id);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
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
    let file_name = format!("icon.{extension}");
    let dest = dir.join(&file_name);
    if curseforge
        .http()
        .download(url, &dest, None, None, false)
        .await
        .is_err()
    {
        return;
    }
    meta.icon = Some(file_name);
    let _ = instances::save(paths, meta);
}

/// Установить модпак CurseForge как новую сборку.
///
/// `file_id` — конкретная версия модпака; без него берём самый свежий файл.
pub async fn install(
    curseforge: &CurseForge,
    paths: &Paths,
    project_id: &str,
    file_id: Option<&str>,
    reporter: &Reporter,
) -> Result<InstanceMeta> {
    let project = curseforge.project(project_id).await?;
    let version = match file_id {
        Some(file_id) => curseforge.file(project_id, file_id).await?,
        None => curseforge
            .files(project_id, None, None)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| Error::not_found("у этого модпака нет файлов"))?,
    };
    let file = version
        .primary_file()
        .cloned()
        .ok_or_else(|| Error::not_found(format!("у версии {} нет файлов", version.id)))?;

    let url = if file.url.trim().is_empty() {
        curseforge.download_url(project_id, &version.id).await?
    } else {
        file.url.clone()
    };

    reporter.emit("modpack", 0, 4, "скачиваем модпак");
    let archive = paths.cache().join(&file.filename);
    let sha1 = file.hashes.get("sha1").cloned();
    curseforge
        .http()
        .download(&url, &archive, Some(file.size), sha1.as_deref(), true)
        .await?;

    reporter.emit("modpack", 1, 4, "читаем описание модпака");
    let manifest = read_manifest(&archive)?;
    let mc_version = manifest.minecraft.version.trim().to_string();
    if mc_version.is_empty() {
        return Err(Error::Other(
            "в манифесте модпака не указана версия Minecraft".into(),
        ));
    }
    let loader = loader_from_manifest(&manifest.minecraft.mod_loaders);
    let name = if project.title.trim().is_empty() {
        if manifest.name.trim().is_empty() {
            "Модпак с CurseForge".to_string()
        } else {
            manifest.name.clone()
        }
    } else {
        project.title.clone()
    };
    let source_url = Some(format!(
        "https://www.curseforge.com/minecraft/modpacks/{}",
        if project.slug.trim().is_empty() {
            project_id
        } else {
            project.slug.as_str()
        }
    ));

    let mut meta = instances::create(
        paths,
        CreateInstanceRequest {
            name,
            mc_version,
            loader,
            icon: None,
            notes: project.description.clone(),
            source: Some("curseforge".into()),
            source_url,
            id: None,
            category: None,
            memory_mb: None,
            java_path: None,
            game_dir: None,
        },
    )?;

    let game_dir = crate::instances::game_dir_for(paths, &meta);
    let overrides_folder = manifest
        .overrides
        .clone()
        .filter(|folder| !folder.trim().is_empty())
        .unwrap_or_else(|| "overrides".to_string());
    reporter.emit("modpack", 2, 4, "распаковываем overrides");
    let _ = extract_overrides(&archive, &game_dir, &overrides_folder)?;

    // Файлы из манифеста: ссылок там нет, поэтому берём их через API.
    let mods_dir = game_dir.join("mods");
    std::fs::create_dir_all(&mods_dir)?;
    let mut items: Vec<DownloadItem> = Vec::new();
    let required: Vec<&ManifestFile> = manifest
        .files
        .iter()
        .filter(|entry| entry.required && entry.project_id > 0 && entry.file_id > 0)
        .collect();
    reporter.emit(
        "modpack",
        0,
        required.len() as u64,
        format!("файлов в модпаке: {}", required.len()),
    );
    let mut skipped = 0usize;
    for entry in required {
        let project_ref = entry.project_id.to_string();
        let file_ref = entry.file_id.to_string();
        let Ok(version) = curseforge.file(&project_ref, &file_ref).await else {
            skipped += 1;
            continue;
        };
        let Some(file) = version.primary_file() else {
            skipped += 1;
            continue;
        };
        let url = if file.url.trim().is_empty() {
            match curseforge.download_url(&project_ref, &file_ref).await {
                Ok(url) => url,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            }
        } else {
            file.url.clone()
        };
        let dest = mods_dir.join(&file.filename);
        if dest.exists() {
            continue;
        }
        let mut item = DownloadItem::new(url, dest).with_size(Some(file.size));
        if let Some(sha1) = file.hashes.get("sha1") {
            item = item.with_sha1(Some(sha1.clone()));
        }
        items.push(item);
    }

    reporter.emit("modpack", 3, 4, "качаем моды модпака");
    curseforge
        .http()
        .download_all(items, 4, reporter, "modpack")
        .await?;

    set_project_icon(
        curseforge,
        paths,
        &mut meta,
        project.icon_url.as_deref(),
    )
    .await;

    reporter.emit(
        "modpack",
        4,
        4,
        format!(
            "готово: сборка «{}», пропущено файлов: {skipped}",
            meta.name
        ),
    );
    Ok(meta)
}
