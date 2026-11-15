//! Всё про саму игру: манифест версий, установка файлов, Java и запуск.

pub mod install;
pub mod java;
pub mod launch;
pub mod version;

pub use version::{ResolvedVersion, VersionJson};

use std::path::Path;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::net::Http;
use crate::paths::Paths;

pub const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
pub const RESOURCES_URL: &str = "https://resources.download.minecraft.net";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatestVersions {
    pub release: String,
    pub snapshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
    #[serde(default, rename = "releaseTime")]
    pub release_time: Option<String>,
}

impl VersionEntry {
    pub fn is_snapshot(&self) -> bool {
        self.kind != "release"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionManifest {
    pub latest: LatestVersions,
    pub versions: Vec<VersionEntry>,
}

fn manifest_cache_path(paths: &Paths) -> std::path::PathBuf {
    paths.cache().join("version_manifest_v2.json")
}

/// Манифест версий с кешем на диск (чтобы лаунчер работал и без сети —
/// хотя бы со списком уже установленного).
pub async fn fetch_manifest(http: &Http, paths: &Paths, max_age: Duration) -> Result<VersionManifest> {
    let cache = manifest_cache_path(paths);
    let fresh = std::fs::metadata(&cache)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|age| age < max_age)
        .unwrap_or(false);

    if fresh {
        if let Ok(text) = std::fs::read_to_string(&cache) {
            if let Ok(manifest) = serde_json::from_str::<VersionManifest>(&text) {
                return Ok(manifest);
            }
        }
    }

    match http.get_text(MANIFEST_URL).await {
        Ok(text) => {
            let manifest: VersionManifest = serde_json::from_str(&text)?;
            let _ = std::fs::write(&cache, &text);
            Ok(manifest)
        }
        Err(err) => {
            if let Ok(text) = std::fs::read_to_string(&cache) {
                if let Ok(manifest) = serde_json::from_str::<VersionManifest>(&text) {
                    return Ok(manifest);
                }
            }
            Err(err)
        }
    }
}

/// Скачать `version.json` по id, если его ещё нет локально.
pub async fn ensure_version_json(
    http: &Http,
    paths: &Paths,
    manifest: &VersionManifest,
    id: &str,
) -> Result<VersionJson> {
    let file = paths.version_file(id);
    if file.exists() {
        return read_version_json(&file);
    }
    let entry = manifest
        .versions
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| Error::not_found(format!("версия «{id}» не найдена в манифесте Mojang")))?;
    let text = http.get_text(&entry.url).await?;
    let json: VersionJson = serde_json::from_str(&text)?;
    std::fs::create_dir_all(paths.version_dir(id))?;
    std::fs::write(&file, &text)?;
    Ok(json)
}

pub fn read_version_json(file: &Path) -> Result<VersionJson> {
    let text = std::fs::read_to_string(file)?;
    Ok(serde_json::from_str(&text)?)
}

/// Развернуть цепочку `inheritsFrom` из локальных файлов, без сети и манифеста.
/// Возвращает `None`, если хотя бы одного json не хватает на диске.
pub fn resolve_local(paths: &Paths, id: &str) -> Option<ResolvedVersion> {
    let mut chain = Vec::new();
    let mut current = id.to_string();
    for _ in 0..8 {
        let file = paths.version_file(&current);
        if !file.exists() {
            return None;
        }
        let json = read_version_json(&file).ok()?;
        let parent = json.inherits_from.clone();
        chain.push(json);
        match parent {
            Some(parent) if !parent.is_empty() && parent != current => current = parent,
            _ => break,
        }
    }
    if chain.is_empty() {
        return None;
    }
    let mut resolved = version::merge_chain(chain);
    resolved.id = id.to_string();
    if resolved.jar_id.is_empty() {
        resolved.jar_id = id.to_string();
    }
    if resolved.main_class.is_empty() {
        return None;
    }
    Some(resolved)
}

/// Развернуть цепочку `inheritsFrom` в единый профиль.
///
/// Быстрый путь (обычный запуск уже установленной сборки): все json лежат в
/// `meta/versions`, поэтому ни манифест, ни сеть не нужны вовсе — раньше на
/// каждый запуск парсился 400-килобайтный манифест Mojang.
pub async fn resolve(http: &Http, paths: &Paths, id: &str) -> Result<ResolvedVersion> {
    if let Some(resolved) = resolve_local(paths, id) {
        return Ok(resolved);
    }
    let manifest = fetch_manifest(http, paths, Duration::from_secs(3600)).await?;
    let mut chain = Vec::new();
    let mut current = id.to_string();
    for _ in 0..8 {
        let json = ensure_version_json(http, paths, &manifest, &current).await?;
        let parent = json.inherits_from.clone();
        chain.push(json);
        match parent {
            Some(parent) if !parent.is_empty() && parent != current => current = parent,
            _ => break,
        }
    }
    if chain.is_empty() {
        return Err(Error::not_found(format!("версия «{id}» не найдена")));
    }
    let mut resolved = version::merge_chain(chain);
    resolved.id = id.to_string();
    if resolved.jar_id.is_empty() {
        resolved.jar_id = id.to_string();
    }
    if resolved.main_class.is_empty() {
        return Err(Error::Other(format!(
            "в профиле «{id}» не указан mainClass"
        )));
    }
    Ok(resolved)
}

/// Локально сохранённые профили (ваниль + загрузчики).
pub fn local_version_ids(paths: &Paths) -> Vec<String> {
    let mut result = Vec::new();
    if let Ok(entries) = std::fs::read_dir(paths.versions()) {
        for entry in entries.flatten() {
            if entry.path().join("instance.json").exists() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if entry.path().join(format!("{id}.json")).exists() {
                result.push(id);
            }
        }
    }
    result.sort();
    result
}

/// Список версий для UI с фильтром по типу.
pub fn filter_versions(manifest: &VersionManifest, include_snapshots: bool) -> Vec<VersionEntry> {
    manifest
        .versions
        .iter()
        .filter(|entry| include_snapshots || entry.kind == "release")
        .cloned()
        .collect()
}

#[cfg(test)]
mod resolve_tests {
    use super::*;

    /// Без локальных json быстрый путь молчит — тогда работает сеть/манифест.
    #[test]
    fn local_resolve_needs_files() {
        let root = std::env::temp_dir().join(format!("omnispec-resolve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        assert!(resolve_local(&paths, "1.21.4").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Установленный профиль собирается из локальных файлов, без манифеста.
    #[test]
    fn local_resolve_merges_chain() {
        let root = std::env::temp_dir().join(format!("omnispec-resolve2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        let write = |id: &str, json: serde_json::Value| {
            let dir = paths.version_dir(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(format!("{id}.json")), json.to_string()).unwrap();
        };
        write(
            "1.21.4",
            serde_json::json!({
                "id": "1.21.4",
                "type": "release",
                "mainClass": "net.minecraft.client.main.Main",
                "assets": "17",
                "assetIndex": { "id": "17", "sha1": "00", "size": 1, "totalSize": 1, "url": "http://127.0.0.1/index.json" },
                "javaVersion": { "majorVersion": 21 },
                "downloads": { "client": { "sha1": "00", "size": 1, "url": "http://127.0.0.1/client.jar" } },
                "libraries": []
            }),
        );
        write(
            "fabric-loader-0.16.9-1.21.4",
            serde_json::json!({
                "id": "fabric-loader-0.16.9-1.21.4",
                "inheritsFrom": "1.21.4",
                "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
                "libraries": []
            }),
        );
        let resolved = resolve_local(&paths, "fabric-loader-0.16.9-1.21.4").expect("профиль должен собраться");
        assert_eq!(resolved.main_class, "net.fabricmc.loader.impl.launch.knot.KnotClient");
        // jar берётся из родительской ванили
        assert_eq!(resolved.jar_id, "1.21.4");
        assert_eq!(resolved.java_major, 21);
        assert_eq!(resolved.assets.as_deref(), Some("17"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
