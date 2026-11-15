//! Содержимое сборки: файлы в `mods`, `resourcepacks`, `shaderpacks` —
//! список, включение/выключение (`.disabled`), удаление и проверка обновлений
//! через Modrinth по SHA-1 файла.
//!
//! Рядом со сборкой лежит картотека `content.json`: для каждого установленного
//! файла запоминается проект и версия на Modrinth. По ней работают обновления
//! и автодокачка зависимостей — не нужно заново угадывать, что это за мод.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::error::{Error, Result};
use crate::instances::InstanceMeta;
use crate::paths::Paths;

use crate::modrinth::Modrinth;

/// Вид содержимого: `mod` | `resourcepack` | `shader`.
pub const KINDS: [&str; 3] = ["mod", "resourcepack", "shader"];

/// Папка сборки под вид содержимого.
pub fn folder(kind: &str) -> &'static str {
    match kind {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        _ => "mods",
    }
}

/// Файл вообще может лежать в этой папке?
pub fn matches_kind(filename: &str, kind: &str) -> bool {
    let lower = filename.to_ascii_lowercase();
    let base = lower.strip_suffix(".disabled").unwrap_or(&lower);
    match kind {
        "resourcepack" => base.ends_with(".zip"),
        "shader" => base.ends_with(".zip"),
        _ => base.ends_with(".jar"),
    }
}

/// Запись о файле для интерфейса.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentEntry {
    /// Имя файла на диске (с `.disabled`, если выключен).
    pub name: String,
    /// Имя без `.disabled`.
    pub filename: String,
    pub enabled: bool,
    pub size: u64,
    /// Проект и версия из картотеки — если файл ставили через лаунчер.
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub version_id: Option<String>,
    #[serde(default)]
    pub version_number: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

/// Что помним про установленный файл.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContentRecord {
    pub filename: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub version_id: Option<String>,
    #[serde(default)]
    pub version_number: String,
    #[serde(default)]
    pub title: String,
    /// `mod` | `resourcepack` | `shader`
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub sha1: String,
}

/// Картотека сборки: `<сборка>/content.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContentStore {
    #[serde(default)]
    pub files: HashMap<String, ContentRecord>,
}

fn store_path(paths: &Paths, instance: &InstanceMeta) -> PathBuf {
    paths.instance_dir(&instance.id).join("content.json")
}

pub fn load_store(paths: &Paths, instance: &InstanceMeta) -> ContentStore {
    let path = store_path(paths, instance);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_store(paths: &Paths, instance: &InstanceMeta, store: &ContentStore) -> Result<()> {
    let path = store_path(paths, instance);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(store)?;
    std::fs::write(path, text)?;
    Ok(())
}

/// Запомнить установленный файл (зовётся из установщика).
pub fn remember(paths: &Paths, instance: &InstanceMeta, record: ContentRecord) {
    let mut store = load_store(paths, instance);
    store.files.insert(record.filename.clone(), record);
    let _ = save_store(paths, instance, &store);
}

fn dir_of(paths: &Paths, instance: &InstanceMeta, kind: &str) -> PathBuf {
    paths.instance_game_dir(&instance.id).join(folder(kind))
}

/// Все файлы нужного вида в сборке.
pub fn list(paths: &Paths, instance: &InstanceMeta, kind: &str) -> Vec<ContentEntry> {
    let dir = dir_of(paths, instance, kind);
    let store = load_store(paths, instance);
    let mut entries: Vec<ContentEntry> = Vec::new();
    let Ok(read) = std::fs::read_dir(&dir) else {
        return entries;
    };
    for item in read.flatten() {
        let path = item.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !matches_kind(name, kind) {
            continue;
        }
        let enabled = !name.ends_with(".disabled");
        let filename = name.trim_end_matches(".disabled").to_string();
        let record = store.files.get(&filename);
        entries.push(ContentEntry {
            name: name.to_string(),
            filename: filename.clone(),
            enabled,
            size: item.metadata().map(|m| m.len()).unwrap_or(0),
            project_id: record.and_then(|r| r.project_id.clone()),
            version_id: record.and_then(|r| r.version_id.clone()),
            version_number: record
                .map(|r| r.version_number.clone())
                .filter(|v| !v.is_empty()),
            title: record.map(|r| r.title.clone()).filter(|v| !v.is_empty()),
        });
    }
    entries.sort_by(|a, b| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));
    entries
}

fn safe_name(name: &str) -> Result<&Path> {
    let path = Path::new(name);
    if path.components().count() != 1 {
        return Err(Error::Other("недопустимое имя файла".into()));
    }
    Ok(path)
}

/// Включить/выключить файл переименованием в `.disabled` и обратно.
pub fn toggle(paths: &Paths, instance: &InstanceMeta, kind: &str, name: &str) -> Result<String> {
    let dir = dir_of(paths, instance, kind);
    let file = safe_name(name)?;
    let source = dir.join(file);
    if !source.exists() {
        return Err(Error::not_found(format!("файл «{name}» не найден")));
    }
    let target = if name.ends_with(".disabled") {
        dir.join(name.trim_end_matches(".disabled"))
    } else {
        dir.join(format!("{name}.disabled"))
    };
    std::fs::rename(&source, &target)?;
    Ok(target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(name)
        .to_string())
}

/// Удалить файл из сборки (и запись в картотеке).
pub fn remove(paths: &Paths, instance: &InstanceMeta, kind: &str, name: &str) -> Result<()> {
    let dir = dir_of(paths, instance, kind);
    let file = safe_name(name)?;
    let path = dir.join(file);
    if !path.exists() {
        return Err(Error::not_found(format!("файл «{name}» не найден")));
    }
    std::fs::remove_file(&path)?;
    let filename = name.trim_end_matches(".disabled").to_string();
    let mut store = load_store(paths, instance);
    if store.files.remove(&filename).is_some() {
        save_store(paths, instance, &store)?;
    }
    Ok(())
}

/// SHA-1 файла — им Modrinth ищет версию.
pub fn file_sha1(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha1::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Найденное обновление файла.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentUpdate {
    /// Имя файла на диске сейчас.
    pub filename: String,
    pub kind: String,
    pub enabled: bool,
    pub title: String,
    pub page_url: String,
    pub project_id: String,
    pub version_id: String,
    pub current: String,
    pub latest: String,
    pub download_url: String,
    pub new_filename: String,
    pub size: u64,
}

fn project_page(slug_or_id: &str, kind: &str) -> String {
    let path = match kind {
        "resourcepack" => "resourcepack",
        "shader" => "shader",
        _ => "mod",
    };
    format!("https://modrinth.com/{path}/{slug_or_id}")
}

/// Загрузчик, под который ищем обновления: у ресурспаков и шейдеров его нет.
fn loader_for<'a>(instance: &'a InstanceMeta, kind: &str) -> Option<&'a str> {
    if kind == "mod" {
        Some(instance.loader.kind())
    } else {
        None
    }
}

/// Вспомнить проект/версию файла: сначала картотека, потом SHA-1.
async fn resolve_record(
    modrinth: &Modrinth,
    entry: &ContentEntry,
    dir: &Path,
    store: &mut ContentStore,
) -> Option<ContentRecord> {
    if let Some(record) = store.files.get(&entry.filename).cloned() {
        if record.version_id.is_some() {
            return Some(record);
        }
    }
    let hash = file_sha1(&dir.join(&entry.name)).ok()?;
    let version = modrinth.version_file_by_hash(&hash).await.ok()?;
    let record = ContentRecord {
        filename: entry.filename.clone(),
        project_id: Some(version.project_id.clone()),
        version_id: Some(version.id.clone()),
        version_number: version.version_number.clone(),
        title: version.name.clone(),
        kind: String::new(),
        sha1: hash,
    };
    store.files.insert(entry.filename.clone(), record.clone());
    Some(record)
}

/// Проверить обновления всех файлов вида `kind` под эту версию игры и загрузчик.
pub async fn check_updates(
    modrinth: &Modrinth,
    paths: &Paths,
    instance: &InstanceMeta,
    kind: &str,
) -> Result<Vec<ContentUpdate>> {
    let entries = list(paths, instance, kind);
    let dir = dir_of(paths, instance, kind);
    let mut store = load_store(paths, instance);
    let mut projects: HashMap<String, crate::modrinth::Project> = HashMap::new();
    let mut result = Vec::new();

    for entry in entries {
        let Some(record) = resolve_record(modrinth, &entry, &dir, &mut store).await else {
            continue;
        };
        let Some(project_id) = record.project_id.clone() else {
            continue;
        };
        let project = if let Some(project) = projects.get(&project_id) {
            project.clone()
        } else {
            let Ok(project) = modrinth.project(&project_id).await else {
                continue;
            };
            projects.insert(project_id.clone(), project.clone());
            project
        };
        let versions = modrinth
            .project_versions(
                &project_id,
                Some(&instance.mc_version),
                loader_for(instance, kind),
            )
            .await
            .unwrap_or_default();
        let Some(latest) = versions.first() else {
            continue;
        };
        // уже последняя версия — обновлять нечего
        if Some(latest.id.as_str()) == record.version_id.as_deref() {
            continue;
        }
        if latest.version_number == record.version_number && !record.version_number.is_empty() {
            continue;
        }
        let Some(file) = latest.primary_file() else {
            continue;
        };
        result.push(ContentUpdate {
            filename: entry.filename.clone(),
            kind: kind.to_string(),
            enabled: entry.enabled,
            title: if project.title.is_empty() {
                record.title.clone()
            } else {
                project.title.clone()
            },
            page_url: project_page(&project.slug, kind),
            project_id,
            version_id: latest.id.clone(),
            current: if record.version_number.is_empty() {
                record.title.clone()
            } else {
                record.version_number.clone()
            },
            latest: latest.version_number.clone(),
            download_url: file.url.clone(),
            new_filename: file.filename.clone(),
            size: file.size,
        });
    }

    let _ = save_store(paths, instance, &store);
    Ok(result)
}

/// Поставить обновление одного файла: скачать новый, убрать старый.
pub async fn apply_update(
    modrinth: &Modrinth,
    paths: &Paths,
    instance: &InstanceMeta,
    kind: &str,
    filename: &str,
) -> Result<ContentUpdate> {
    let updates = check_updates(modrinth, paths, instance, kind).await?;
    let update = updates
        .into_iter()
        .find(|item| item.filename == filename)
        .ok_or_else(|| Error::not_found(format!("для «{filename}» обновлений нет")))?;
    let dir = dir_of(paths, instance, kind);
    let dest = dir.join(&update.new_filename);
    modrinth
        .http()
        .download(&update.download_url, &dest, Some(update.size), None, true)
        .await?;

    // старый файл мог быть выключен — убираем оба варианта
    for candidate in [
        dir.join(&update.filename),
        dir.join(format!("{}.disabled", update.filename)),
    ] {
        if candidate.exists() && candidate != dest {
            let _ = std::fs::remove_file(candidate);
        }
    }

    let mut store = load_store(paths, instance);
    store.files.remove(&update.filename);
    store.files.insert(
        update.new_filename.clone(),
        ContentRecord {
            filename: update.new_filename.clone(),
            project_id: Some(update.project_id.clone()),
            version_id: Some(update.version_id.clone()),
            version_number: update.latest.clone(),
            title: update.title.clone(),
            kind: kind.to_string(),
            sha1: file_sha1(&dest).unwrap_or_default(),
        },
    );
    save_store(paths, instance, &store)?;
    Ok(update)
}

/// Проекты, которые уже стоят в сборке (по картотеке) — для автодокачки зависимостей.
pub fn installed_projects(
    paths: &Paths,
    instance: &InstanceMeta,
    kind: &str,
) -> Vec<(String, Option<String>)> {
    let files = list(paths, instance, kind);
    let store = load_store(paths, instance);
    files
        .iter()
        .filter_map(|entry| {
            let record = store.files.get(&entry.filename)?;
            let project = record.project_id.clone()?;
            Some((project, record.version_id.clone()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_folders() {
        assert_eq!(folder("mod"), "mods");
        assert_eq!(folder("resourcepack"), "resourcepacks");
        assert_eq!(folder("shader"), "shaderpacks");
        assert!(matches_kind("sodium.jar", "mod"));
        assert!(matches_kind("sodium.jar.disabled", "mod"));
        assert!(!matches_kind("sodium.zip", "mod"));
        assert!(matches_kind("BSL_v8.zip", "shader"));
    }

    #[test]
    fn sha1_of_file() {
        let dir = std::env::temp_dir().join(format!("omnispec-sha1-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("check.txt");
        std::fs::write(&file, b"omnispec").unwrap();
        let hash = file_sha1(&file).unwrap();
        assert_eq!(hash.len(), 40);
        assert_eq!(hash, hash.to_lowercase());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
