//! Forge и NeoForge — ставятся официальным инсталлятором, как в Prism.
//!
//! Инсталлятор запускается с `--installClient <meta>`, поэтому все файлы
//! попадают в наши `meta/versions` и `meta/libraries`, а не в чужой `.minecraft`.

use std::path::PathBuf;

use regex::Regex;
use serde::Deserialize;

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

/// Требуемая версия Java для версии игры — из её манифеста Mojang
/// (`javaVersion.majorVersion`). Инсталляторы для 1.20.5+ собраны под
/// Java 21 и на Java 17 падают, поэтому хардкод 17 здесь нельзя.
fn required_java_major(paths: &Paths, mc_version: &str) -> u32 {
    let file = paths.version_file(mc_version);
    if let Ok(text) = std::fs::read_to_string(&file) {
        #[derive(Deserialize)]
        struct Probe {
            #[serde(default, rename = "javaVersion")]
            java_version: Option<JavaVersionProbe>,
        }
        #[derive(Deserialize)]
        struct JavaVersionProbe {
            #[serde(default, rename = "majorVersion")]
            major_version: Option<u32>,
        }
        if let Ok(probe) = serde_json::from_str::<Probe>(&text) {
            if let Some(major) = probe.java_version.and_then(|java| java.major_version) {
                return major;
            }
        }
    }
    17
}

/// Скачать и запустить инсталлятор, вернуть id созданной версии.
async fn run_installer(
    http: &Http,
    paths: &Paths,
    url: &str,
    file_name: &str,
    marker: &str,
    mc_version: &str,
    loader_version: &str,
    java_major: u32,
    reporter: &Reporter,
) -> Result<String> {
    let before = list_version_ids(paths);
    let installer = paths.cache().join(file_name);
    reporter.emit("loader", 0, 3, "скачиваем инсталлятор");
    http.download(url, &installer, None, None, false).await?;

    reporter.emit("loader", 1, 3, "запускаем инсталлятор (это может занять пару минут)");
    let settings = crate::settings::Settings::load(paths)?;
    let java =
        crate::game::java::find_java(http, paths, &settings, java_major, reporter).await?;
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
    reporter.emit_state("loader", "done", "готово");
    let after = list_version_ids(paths);
    let created: Vec<String> = after
        .iter()
        .filter(|id| !before.contains(*id) && id.to_lowercase().contains(marker))
        .cloned()
        .collect();
    if let Some(id) = created.into_iter().next() {
        return Ok(id);
    }
    // Новой папки нет — инсталлятор уже был запущен раньше (например, второй
    // экземпляр с той же версией Forge/NeoForge). Ищем существующий профиль
    // по внутреннему id json: он содержит и версию игры, и версию загрузчика.
    let existing = after
        .iter()
        .filter(|id| id.to_lowercase().contains(marker))
        .find(|candidate| {
            profile_json_id(paths, candidate)
                .map(|json_id| {
                    json_id.contains(mc_version) && json_id.contains(loader_version)
                })
                .unwrap_or(false)
        })
        .cloned();
    existing.ok_or_else(|| Error::Other("инсталлятор не создал профиль версии".into()))
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
    let java_major = required_java_major(paths, mc_version);
    let id = run_installer(
        http,
        paths,
        &url,
        &file_name,
        "forge",
        mc_version,
        forge_version,
        java_major,
        reporter,
    )
    .await?;
    let expected = format!("forge-{mc_version}-{forge_version}");
    Ok(resolve_installed_id(paths, &id, &expected))
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
    let java_major = required_java_major(paths, mc_version);
    let id = run_installer(
        http,
        paths,
        &url,
        &file_name,
        "neoforge",
        mc_version,
        neoforge_version,
        java_major,
        reporter,
    )
    .await?;

    // Некоторые версии инсталлятора создают папку вида "1.21.4-neoforge-21.4.100"
    // или кладут внутрь json с другим именем — ищем профиль по внутреннему id.
    let expected = format!("neoforge-{mc_version}-{neoforge_version}");
    Ok(resolve_installed_id(paths, &id, &expected))
}

/// Реальный id установленного профиля: папка, внутри которой лежит json
/// с внутренним id из `expected` (или хотя бы любой json).
fn resolve_installed_id(paths: &Paths, installed: &str, expected: &str) -> String {
    if paths.version_file(installed).exists() {
        return installed.to_string();
    }
    if let Some(found) = find_profile_with_json(paths, expected) {
        return found;
    }
    if let Some(found) = find_profile_with_json(paths, installed) {
        return found;
    }
    installed.to_string()
}

fn find_profile_with_json(paths: &Paths, id: &str) -> Option<String> {
    list_version_ids(paths)
        .into_iter()
        .find(|candidate| {
            if !candidate.contains(id) && candidate != id {
                // папка может называться иначе — смотрим внутренний id json
                return profile_json_id(paths, candidate).as_deref() == Some(id);
            }
            paths.version_file(candidate).exists() || profile_json_id(paths, candidate).is_some()
        })
}

/// Внутренний `id` из json профиля в папке (имя файла может отличаться).
fn profile_json_id(paths: &Paths, folder: &str) -> Option<String> {
    let dir = paths.version_dir(folder);
    let file = if paths.version_file(folder).exists() {
        paths.version_file(folder)
    } else {
        std::fs::read_dir(&dir)
            .ok()?
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))?
    };
    let text = std::fs::read_to_string(file).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("id")
        .and_then(|id| id.as_str())
        .map(|id| id.to_string())
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
