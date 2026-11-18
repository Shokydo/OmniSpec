//! Fabric: версии загрузчика и готовый профиль из meta.fabricmc.net.

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::net::Http;
use crate::paths::Paths;

use super::LoaderOption;

const META: &str = "https://meta.fabricmc.net/v2";

#[derive(Debug, Deserialize)]
struct LoaderEntry {
    loader: LoaderInfo,
}

#[derive(Debug, Deserialize)]
struct LoaderInfo {
    version: String,
    #[serde(default)]
    stable: bool,
}

/// Список версий загрузчика Fabric для версии игры.
pub async fn versions(http: &Http, mc_version: &str) -> Result<Vec<LoaderOption>> {
    let url = format!("{META}/versions/loader/{mc_version}");
    let entries: Vec<LoaderEntry> = http.get_json(&url).await?;
    Ok(entries
        .into_iter()
        .map(|entry| LoaderOption {
            version: entry.loader.version,
            stable: entry.loader.stable,
        })
        .collect())
}

/// Профиль версии Fabric (JSON, который склеивается с ванилью по inheritsFrom).
pub async fn profile(http: &Http, mc_version: &str, loader_version: &str) -> Result<String> {
    let url = format!("{META}/versions/loader/{mc_version}/{loader_version}/profile/json");
    http.get_text(&url).await
}

/// Установить профиль загрузчика локально, вернуть id версии.
pub async fn install(
    http: &Http,
    paths: &Paths,
    mc_version: &str,
    loader_version: &str,
) -> Result<String> {
    // Проверяем версию по списку API: иначе пользователь видит голый HTTP 404
    // и не понимает, что такой версии загрузчика для этой версии игры нет.
    if let Ok(available) = versions(http, mc_version).await {
        if !available.iter().any(|option| option.version == loader_version) {
            return Err(Error::Other(format!(
                "Версия Fabric {loader_version} не найдена для Minecraft {mc_version}. \
                 Выберите другую версию загрузчика."
            )));
        }
    }
    let text = profile(http, mc_version, loader_version).await?;
    let id = super::save_profile(paths, &text)?;
    let expected = format!("fabric-loader-{loader_version}-{mc_version}");
    if id != expected {
        return Err(Error::Other(format!(
            "Fabric вернул неожиданный id профиля: {id} (ожидался {expected})"
        )));
    }
    Ok(id)
}
