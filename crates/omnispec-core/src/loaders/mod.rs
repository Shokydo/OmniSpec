//! Загрузчики модов: Fabric, Quilt, Forge, NeoForge.
//!
//! Fabric и Quilt отдают готовый JSON-профиль — это простая склейка с ванилью.
//! Forge и NeoForge ставятся своим официальным инсталлятором (как в Prism).

pub mod fabric;
pub mod forge;
pub mod quilt;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::instances::{self, InstanceMeta, Loader};
use crate::net::{Http, Reporter};
use crate::paths::Paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoaderOption {
    pub version: String,
    #[serde(default)]
    pub stable: bool,
}

/// Убедиться, что профиль версии (ваниль или загрузчик) есть в `meta/versions`.
pub async fn ensure_profile(
    http: &Http,
    paths: &Paths,
    instance: &InstanceMeta,
    reporter: &Reporter,
) -> Result<()> {
    let id = instance.version_id();
    if paths.version_file(&id).exists() {
        return Ok(());
    }

    reporter.emit("loader", 0, 2, format!("готовим профиль {id}"));
    match &instance.loader {
        Loader::Vanilla => {
            // Ваниль подтянется из манифеста Mojang при resolve.
        }
        Loader::Fabric { version } => {
            fabric::install(http, paths, &instance.mc_version, version).await?;
        }
        Loader::Quilt { version } => {
            quilt::install(http, paths, &instance.mc_version, version).await?;
        }
        Loader::Forge { version } | Loader::NeoForge { version } => {
            let installed_id = match &instance.loader {
                Loader::Forge { .. } => {
                    forge::install_forge(http, paths, &instance.mc_version, version, reporter)
                        .await?
                }
                _ => {
                    forge::install_neoforge(http, paths, &instance.mc_version, version, reporter)
                        .await?
                }
            };
            if installed_id != id {
                // Инсталлятор мог создать папку с другим именем — запомним его.
                let mut updated = instance.clone();
                updated.version_override = Some(installed_id);
                instances::save(paths, &updated)?;
            }
        }
    }
    reporter.emit("loader", 2, 2, "профиль готов");
    Ok(())
}

/// Доступные версии загрузчика для конкретной версии игры.
pub async fn loader_versions(
    http: &Http,
    kind: &str,
    mc_version: &str,
) -> Result<Vec<LoaderOption>> {
    match kind {
        "fabric" => fabric::versions(http, mc_version).await,
        "quilt" => quilt::versions(http, mc_version).await,
        "forge" => forge::forge_versions(http, mc_version).await,
        "neoforge" => forge::neoforge_versions(http, mc_version).await,
        other => Err(crate::error::Error::Other(format!(
            "неизвестный загрузчик: {other}"
        ))),
    }
}

/// Самый свежий стабильный загрузчик для версии игры.
pub async fn latest_loader(http: &Http, kind: &str, mc_version: &str) -> Result<Option<String>> {
    let mut versions = loader_versions(http, kind, mc_version).await?;
    versions.sort_by(|a, b| version_cmp(&a.version, &b.version));
    Ok(versions
        .iter()
        .find(|option| option.stable)
        .or_else(|| versions.last())
        .map(|option| option.version.clone()))
}

/// Сравнение версий «по-числовому» (1.10 > 1.9).
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let split = |value: &str| -> Vec<u64> {
        value
            .split(['.', '-', '+', '_'])
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let left = split(a);
    let right = split(b);
    let len = left.len().max(right.len());
    for index in 0..len {
        let l = left.get(index).copied().unwrap_or(0);
        let r = right.get(index).copied().unwrap_or(0);
        if l != r {
            return l.cmp(&r);
        }
    }
    std::cmp::Ordering::Equal
}

/// Сохранить JSON-профиль загрузчика в `meta/versions/<id>/<id>.json`.
pub(crate) fn save_profile(paths: &Paths, text: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct IdOnly {
        id: String,
    }
    let probe: IdOnly = serde_json::from_str(text)?;
    let dir = paths.version_dir(&probe.id);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(format!("{}.json", probe.id)), text)?;
    Ok(probe.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_ordering() {
        use std::cmp::Ordering;
        assert_eq!(version_cmp("0.16.9", "0.16.10"), Ordering::Less);
        assert_eq!(version_cmp("1.10", "1.9"), Ordering::Greater);
        assert_eq!(version_cmp("2.0", "2.0.0"), Ordering::Equal);
    }
}
