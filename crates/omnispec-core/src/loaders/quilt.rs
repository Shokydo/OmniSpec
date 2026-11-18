//! Quilt: тот же принцип, что и у Fabric (профиль отдаётся сервером метаданных).

use serde::Deserialize;

use crate::error::Result;
use crate::net::Http;
use crate::paths::Paths;

use super::LoaderOption;

const META: &str = "https://meta.quiltmc.org/v3";

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

pub async fn versions(http: &Http, mc_version: &str) -> Result<Vec<LoaderOption>> {
    let url = format!("{META}/versions/loader/{mc_version}");
    let entries: Vec<LoaderEntry> = http.get_json(&url).await?;
    Ok(entries
        .into_iter()
        .map(|entry| LoaderOption {
            version: entry.loader.version,
            // В API Quilt нет поля stable — все версии считаем стабильными,
            // иначе фронт помечает их бетами и выбирает криво.
            stable: true,
        })
        .collect())
}

pub async fn profile(http: &Http, mc_version: &str, loader_version: &str) -> Result<String> {
    let url = format!("{META}/versions/loader/{mc_version}/{loader_version}/profile/json");
    http.get_text(&url).await
}

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
            return Err(crate::error::Error::Other(format!(
                "Версия Quilt {loader_version} не найдена для Minecraft {mc_version}. \
                 Выберите другую версию загрузчика."
            )));
        }
    }
    let text = profile(http, mc_version, loader_version).await?;
    super::save_profile(paths, &text)
}
