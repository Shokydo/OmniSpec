//! Forge и NeoForge — ставятся официальным инсталлятором, как в Prism.
//!
//! Инсталлятор запускается с `--installClient <meta>`, поэтому все файлы
//! попадают в наши `meta/versions` и `meta/libraries`, а не в чужой `.minecraft`.

use std::path::PathBuf;

use regex::Regex;

use crate::error::{Error, Result};
use crate::net::{Http, Reporter};
use crate::paths::Paths;

use super::LoaderOption;

const FORGE_MAVEN: &str = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const FORGE_METADATA: &str = "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml";
const NEOFORGE_MAVEN: &str = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const NEOFORGE_METADATA: &str =
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";

fn parse_metadata_versions(xml: &str) -> Vec<String> {
    let Ok(re) = Regex::new(r"<version>([^<]+)</version>") else {
        return Vec::new();
    };
    re.captures_iter(xml)
        .filter_map(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

/// Версии Forge для указанной версии игры ("1.20.1" → "47.2.0").
pub async fn forge_versions(http: &Http, mc_version: &str) -> Result<Vec<LoaderOption>> {
    let xml = http.get_text(FORGE_METADATA).await?;
    let prefix = format!("{mc_version}-");
    let mut result: Vec<LoaderOption> = parse_metadata_versions(&xml)
        .into_iter()
        .filter_map(|version| version.strip_prefix(&prefix).map(|v| v.to_string()))
        .map(|version| LoaderOption {
            version,
            stable: true,
        })
        .collect();
    result.reverse();
    Ok(result)
}

/// Версии NeoForge для указанной версии игры ("1.21.4" → "21.4.100").
pub async fn neoforge_versions(http: &Http, mc_version: &str) -> Result<Vec<LoaderOption>> {
    let xml = http.get_text(NEOFORGE_METADATA).await?;
    let prefix = neoforge_prefix(mc_version);
    let mut result: Vec<LoaderOption> = parse_metadata_versions(&xml)
        .into_iter()
        .filter(|version| version.starts_with(&prefix))
        .map(|version| LoaderOption {
            version,
            stable: true,
        })
        .collect();
    result.reverse();
    Ok(result)
}

/// "1.21.4" → "21.4.", "1.21" → "21.0."
fn neoforge_prefix(mc_version: &str) -> String {
    let stripped = mc_version.strip_prefix("1.").unwrap_or(mc_version);
    let mut parts = stripped.split('.');
    let major = parts.next().unwrap_or("21");
    let minor = parts.next().unwrap_or("0");
    format!("{major}.{minor}.")
}

/// Инсталлятору Forge/NeoForge нужен `launcher_profiles.json` в целевой папке —
/// без него он падает с «no minecraft launcher profile, run the launcher first».
/// Создаём минимальный, если его ещё нет (существующий не трогаем).
fn ensure_launcher_profiles(meta: &std::path::Path) {
    let file = meta.join("launcher_profiles.json");
    if file.exists() {
        return;
    }
    let content = r#"{
  "version": 3,
  "profiles": {
    "Minecraft": {
      "name": "Minecraft",
      "type": "minecraft",
      "created": "2026-01-01T00:00:00.000Z",
      "lastUsed": "2026-01-01T00:00:00.000Z",
      "gameDir": ".",
      "javaArgs": ""
    }
  },
  "selectedProfile": "Minecraft"
}
"#;
    let _ = std::fs::write(&file, content);
}

/// Скачать и запустить инсталлятор, вернуть id созданной версии.
async fn run_installer(
    http: &Http,
    paths: &Paths,
    url: &str,
    file_name: &str,
    marker: &str,
    reporter: &Reporter,
) -> Result<String> {
    let before = list_version_ids(paths);
    let installer = paths.cache().join(file_name);
    reporter.emit("loader", 0, 3, "скачиваем инсталлятор");
    http.download(url, &installer, None, None, false).await?;

    reporter.emit("loader", 1, 3, "запускаем инсталлятор (это может занять пару минут)");
    let settings = crate::settings::Settings::load(paths)?;
    let java = crate::game::java::find_java(http, paths, &settings, 17, reporter).await?;
    let meta = paths.meta();
    std::fs::create_dir_all(&meta)?;
    ensure_launcher_profiles(&meta);

    let output = tokio::process::Command::new(&java.path)
        .arg("-jar")
        .arg(&installer)
        .arg("--installClient")
        .arg(&meta)
        .current_dir(paths.cache())
        .output()
        .await
        .map_err(|err| Error::Other(format!("не удалось запустить инсталлятор: {err}")))?;

    if !output.status.success() {
        let tail = String::from_utf8_lossy(&output.stdout);
        let err_tail = String::from_utf8_lossy(&output.stderr);
        return Err(Error::Other(format!(
            "инсталлятор завершился с ошибкой. {}\n{}",
            tail.chars().take(800).collect::<String>(),
            err_tail.chars().take(800).collect::<String>()
        )));
    }

    reporter.emit("loader", 3, 3, "инсталлятор отработал");
    let after = list_version_ids(paths);
    let created: Vec<String> = after
        .into_iter()
        .filter(|id| !before.contains(id) && id.to_lowercase().contains(marker))
        .collect();
    created
        .into_iter()
        .next()
        .ok_or_else(|| Error::Other("инсталлятор не создал профиль версии".into()))
}

fn list_version_ids(paths: &Paths) -> Vec<String> {
    let mut result = Vec::new();
    if let Ok(entries) = std::fs::read_dir(paths.versions()) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                result.push(entry.file_name().to_string_lossy().to_string());
            }
        }
    }
    result
}

pub async fn install_forge(
    http: &Http,
    paths: &Paths,
    mc_version: &str,
    forge_version: &str,
    reporter: &Reporter,
) -> Result<String> {
    // Инсталлятору нужен ванильный профиль версии рядом.
    let manifest = crate::game::fetch_manifest(http, paths, std::time::Duration::from_secs(3600)).await?;
    crate::game::ensure_version_json(http, paths, &manifest, mc_version).await?;

    let url = format!("{FORGE_MAVEN}/{mc_version}-{forge_version}/forge-{mc_version}-{forge_version}-installer.jar");
    let file_name = format!("forge-{mc_version}-{forge_version}-installer.jar");
    run_installer(http, paths, &url, &file_name, "forge", reporter).await
}

pub async fn install_neoforge(
    http: &Http,
    paths: &Paths,
    mc_version: &str,
    neoforge_version: &str,
    reporter: &Reporter,
) -> Result<String> {
    let manifest = crate::game::fetch_manifest(http, paths, std::time::Duration::from_secs(3600)).await?;
    crate::game::ensure_version_json(http, paths, &manifest, mc_version).await?;

    let url = format!("{NEOFORGE_MAVEN}/{neoforge_version}/neoforge-{neoforge_version}-installer.jar");
    let file_name = format!("neoforge-{neoforge_version}-installer.jar");
    let mut id = run_installer(http, paths, &url, &file_name, "neoforge", reporter).await?;

    // Некоторые версии инсталлятора создают папку вида "1.21.4-neoforge-21.4.100".
    if !paths.version_file(&id).exists() {
        if let Some(fixed) = find_profile_with_json(paths, &id) {
            id = fixed;
        }
    }
    Ok(id)
}

fn find_profile_with_json(paths: &Paths, id: &str) -> Option<String> {
    list_version_ids(paths)
        .into_iter()
        .find(|candidate| candidate.contains(id) && paths.version_file(candidate).exists())
}

/// Папка для ручной установки (на случай, если инсталлятор попросит путь).
pub fn meta_dir(paths: &Paths) -> PathBuf {
    paths.meta()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neoforge_prefixes() {
        assert_eq!(neoforge_prefix("1.21.4"), "21.4.");
        assert_eq!(neoforge_prefix("1.20.6"), "20.6.");
        assert_eq!(neoforge_prefix("1.21"), "21.0.");
    }

    #[test]
    fn metadata_parsing() {
        let xml = "<metadata><versioning><versions>\
            <version>1.20.1-47.2.0</version><version>1.20.1-47.1.3</version>\
            <version>1.19.2-43.3.0</version></versions></versioning></metadata>";
        let versions = parse_metadata_versions(xml);
        assert_eq!(versions.len(), 3);
        assert_eq!(versions[0], "1.20.1-47.2.0");
    }
}
