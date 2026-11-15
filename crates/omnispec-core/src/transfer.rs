//! Перенос сборок: импорт из других лаунчеров и экспорт в `.mrpack` / `.zip`.
//!
//! Импорт смотрит в известные места Prism Launcher / MultiMC / Modrinth App —
//! оттуда берутся версия игры, загрузчик и папка с модами. Экспорт собирает
//! архив в формате Modrinth (`modrinth.index.json` + `overrides/`), который
//! принимают и Prism, и Modrinth App, и сам OmniSpec.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::instances::{self, CreateInstanceRequest, InstanceMeta, Loader};
use crate::paths::Paths;

/// Найденная сборка в другом лаунчере.
#[derive(Debug, Clone, Serialize)]
pub struct ExternalProfile {
    /// `prism` | `multimc` | `modrinth`.
    pub launcher: String,
    /// Как лаунчер её называет.
    pub name: String,
    /// Папка сборки (оттуда берём моды и конфиги).
    pub path: String,
    pub mc_version: String,
    /// `vanilla` | `fabric` | `quilt` | `forge` | `neoforge`.
    pub loader: String,
    pub loader_version: String,
    /// Иконка, если лаунчер её хранит рядом (путь к файлу).
    pub icon: Option<String>,
}

/* ───────────────────────── поиск чужих сборок ───────────────────────── */

fn home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn appdata() -> Option<PathBuf> {
    if let Ok(base) = std::env::var("APPDATA") {
        if !base.trim().is_empty() {
            return Some(PathBuf::from(base));
        }
    }
    home().map(|home| home.join("AppData").join("Roaming"))
}

fn localappdata() -> Option<PathBuf> {
    if let Ok(base) = std::env::var("LOCALAPPDATA") {
        if !base.trim().is_empty() {
            return Some(PathBuf::from(base));
        }
    }
    home().map(|home| home.join("AppData").join("Local"))
}

/// Куда лаунчеры складывают сборки — все известные варианты.
fn instance_roots() -> Vec<(String, PathBuf)> {
    let mut roots: Vec<(String, PathBuf)> = Vec::new();
    let mut push = |launcher: &str, path: PathBuf| {
        if path.is_dir() {
            roots.push((launcher.to_string(), path));
        }
    };

    if let Some(base) = appdata() {
        push("prism", base.join("PrismLauncher").join("instances"));
        push("multimc", base.join("MultiMC").join("instances"));
        push(
            "modrinth",
            base.join("com.modrinth.theseus").join("profiles"),
        );
    }
    if let Some(base) = localappdata() {
        push(
            "modrinth",
            base.join("com.modrinth.theseus").join("profiles"),
        );
    }
    if let Some(home) = home() {
        push(
            "prism",
            home.join(".local").join("share").join("PrismLauncher").join("instances"),
        );
        push(
            "prism",
            home.join(".var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher/instances"),
        );
        push(
            "multimc",
            home.join(".local").join("share").join("multimc").join("instances"),
        );
        push(
            "modrinth",
            home.join(".local").join("share").join("com.modrinth.theseus").join("profiles"),
        );
        push(
            "modrinth",
            home.join(".var/app/com.modrinth.ModrinthApp/data/com.modrinth.theseus/profiles"),
        );
    }
    roots
}

/// Прочитать `instance.cfg` (формат MultiMC/Prism): `ключ=значение` построчно.
fn read_cfg(path: &Path) -> Vec<(String, String)> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            Some((key.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct MmcPack {
    #[serde(default)]
    components: Vec<MmcComponent>,
}

#[derive(Debug, Deserialize)]
struct MmcComponent {
    uid: String,
    #[serde(default)]
    version: String,
}

#[derive(Debug, Deserialize)]
struct ModrinthProfile {
    #[serde(default)]
    name: String,
    #[serde(default)]
    game_version: String,
    #[serde(default)]
    loader: String,
    #[serde(default)]
    loader_version: String,
    #[serde(default)]
    icon: Option<String>,
}

/// Загрузчик по uid компонента Prism/MultiMC.
fn loader_from_uid(uid: &str) -> Option<&'static str> {
    match uid {
        "net.fabricmc.fabric-loader" => Some("fabric"),
        "org.quiltmc.quilt-loader" => Some("quilt"),
        "net.minecraftforge" => Some("forge"),
        "net.neoforged" => Some("neoforge"),
        _ => None,
    }
}

fn icon_in(folder: &Path) -> Option<String> {
    for name in ["icon.png", "icon.jpg", "icon.jpeg", "icon.webp"] {
        let path = folder.join(name);
        if path.is_file() {
            return Some(path.display().to_string());
        }
    }
    None
}

/// Все сборки, найденные в других лаунчерах.
pub fn scan_external() -> Vec<ExternalProfile> {
    let mut found: Vec<ExternalProfile> = Vec::new();

    for (launcher, root) in instance_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let folder = entry.path();
            if !folder.is_dir() {
                continue;
            }
            if launcher == "modrinth" {
                if let Some(profile) = read_modrinth_profile(&folder) {
                    found.push(profile);
                }
                continue;
            }
            if let Some(profile) = read_mmc_instance(&launcher, &folder) {
                found.push(profile);
            }
        }
    }

    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    found.dedup_by(|a, b| a.path == b.path);
    found
}

fn read_modrinth_profile(folder: &Path) -> Option<ExternalProfile> {
    let file = folder.join("profile.json");
    if !file.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&file).ok()?;
    let profile: ModrinthProfile = serde_json::from_str(&text).ok()?;
    if profile.game_version.trim().is_empty() {
        return None;
    }
    let name = if profile.name.trim().is_empty() {
        folder.file_name()?.to_string_lossy().to_string()
    } else {
        profile.name.clone()
    };
    let loader = match profile.loader.to_lowercase().as_str() {
        "fabric" => "fabric",
        "quilt" => "quilt",
        "forge" => "forge",
        "neoforge" => "neoforge",
        _ => "vanilla",
    };
    // в новых версиях Modrinth App файлы игры лежат в подпапке profile/
    let game = if folder.join("profile").is_dir() {
        folder.join("profile")
    } else {
        folder.to_path_buf()
    };
    Some(ExternalProfile {
        launcher: "modrinth".into(),
        name,
        path: game.display().to_string(),
        mc_version: profile.game_version,
        loader: loader.into(),
        loader_version: profile.loader_version,
        icon: profile.icon.or_else(|| icon_in(folder)),
    })
}

fn read_mmc_instance(launcher: &str, folder: &Path) -> Option<ExternalProfile> {
    if !folder.join("instance.cfg").is_file() && !folder.join("mmc-pack.json").is_file() {
        return None;
    }
    let cfg = read_cfg(&folder.join("instance.cfg"));
    let name = cfg
        .iter()
        .find(|(key, _)| key == "name")
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| folder.file_name().unwrap_or_default().to_string_lossy().to_string());

    let mut mc_version = String::new();
    let mut loader = "vanilla".to_string();
    let mut loader_version = String::new();
    if let Ok(text) = std::fs::read_to_string(folder.join("mmc-pack.json")) {
        if let Ok(pack) = serde_json::from_str::<MmcPack>(&text) {
            for component in pack.components {
                if component.uid == "net.minecraft" {
                    mc_version = component.version.clone();
                } else if let Some(kind) = loader_from_uid(&component.uid) {
                    loader = kind.to_string();
                    loader_version = component.version.clone();
                }
            }
        }
    }
    if mc_version.is_empty() {
        return None;
    }
    let game = if folder.join(".minecraft").is_dir() {
        folder.join(".minecraft")
    } else {
        folder.join("minecraft")
    };
    Some(ExternalProfile {
        launcher: launcher.into(),
        name,
        path: game.display().to_string(),
        mc_version,
        loader,
        loader_version,
        icon: icon_in(folder),
    })
}

/* ───────────────────────── импорт ───────────────────────── */

fn loader_of(kind: &str, version: &str, mc_version: &str) -> Loader {
    match kind {
        "fabric" => Loader::Fabric {
            version: version.to_string(),
        },
        "quilt" => Loader::Quilt {
            version: version.to_string(),
        },
        "forge" => Loader::Forge {
            version: version.to_string(),
        },
        "neoforge" => Loader::NeoForge {
            version: version.to_string(),
        },
        _ => Loader::Vanilla,
    }
    .normalized(mc_version)
}

impl Loader {
    /// Если версия загрузчика неизвестна — оставляем ваниль, иначе сборка не запустится.
    fn normalized(self, _mc_version: &str) -> Self {
        match &self {
            Loader::Fabric { version }
            | Loader::Quilt { version }
            | Loader::Forge { version }
            | Loader::NeoForge { version }
                if version.trim().is_empty() =>
            {
                Loader::Vanilla
            }
            _ => self,
        }
    }
}

/// Скопировать чужую сборку в OmniSpec (моды, конфиги, миры — всё, что есть).
pub fn import_external(
    paths: &Paths,
    profile_path: &str,
    name: Option<String>,
    mc_version: &str,
    loader: &str,
    loader_version: &str,
    icon: Option<&str>,
) -> Result<InstanceMeta> {
    let source = PathBuf::from(profile_path);
    if !source.is_dir() {
        return Err(Error::Other(format!(
            "папка сборки не найдена: {}",
            source.display()
        )));
    }

    let title = name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            source
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "Импортированная сборка".into())
        });

    let meta = instances::create(
        paths,
        CreateInstanceRequest {
            name: title,
            mc_version: mc_version.to_string(),
            loader: loader_of(loader, loader_version, mc_version),
            icon: None,
            notes: format!("перенесена из {} ({})", loader_label(loader), source.display()),
            source: Some("import".into()),
            source_url: None,
            id: None,
            category: None,
        },
    )?;

    let target = paths.instance_game_dir(&meta.id);
    std::fs::create_dir_all(&target)?;
    copy_tree(&source, &target, 0)?;

    let mut meta = meta;
    if let Some(icon) = icon {
        let icon_path = PathBuf::from(icon);
        if let Some(extension) = icon_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_lowercase())
        {
            if matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
                let file_name = format!("icon.{extension}");
                if std::fs::copy(&icon_path, paths.instance_dir(&meta.id).join(&file_name)).is_ok() {
                    meta.icon = Some(file_name);
                    let _ = instances::save(paths, &meta);
                }
            }
        }
    }
    Ok(meta)
}

/* ───────────────────────── zip-модпак (как в Prism) ───────────────────────── */

/// Общая папка внутри архива: `minecraft/`, `.minecraft/` или корень.
fn root_prefix(names: &[String]) -> String {
    for candidate in ["minecraft/", ".minecraft/"] {
        let total = names.iter().filter(|name| !name.ends_with('/')).count();
        let inside = names
            .iter()
            .filter(|name| !name.ends_with('/') && name.starts_with(candidate))
            .count();
        if total > 0 && inside * 10 >= total * 9 {
            return candidate.to_string();
        }
    }
    String::new()
}

/// Импорт обычного `.zip` с модами и конфигами — формат, который принимает Prism.
/// Версию игры и загрузчик выбирает пользователь: в таком архиве их нет.
pub fn import_zip(
    paths: &Paths,
    archive_path: &str,
    name: Option<&str>,
    mc_version: &str,
    loader: &str,
    loader_version: &str,
) -> Result<InstanceMeta> {
    let archive_path = PathBuf::from(archive_path);
    if !archive_path.is_file() {
        return Err(Error::Other(format!(
            "файл не найден: {}",
            archive_path.display()
        )));
    }
    let mc_version = mc_version.trim();
    if mc_version.is_empty() {
        return Err(Error::Other("не выбрана версия игры".into()));
    }

    let file = File::open(&archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let names: Vec<String> = (0..archive.len())
        .filter_map(|index| archive.by_index(index).ok().map(|entry| entry.name().to_string()))
        .collect();
    let prefix = root_prefix(&names);

    let title = name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            archive_path
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "Импортированная сборка".into())
        });

    let meta = instances::create(
        paths,
        CreateInstanceRequest {
            name: title,
            mc_version: mc_version.to_string(),
            loader: loader_of(loader, loader_version, mc_version),
            icon: None,
            notes: format!("импортирована из {}", archive_path.display()),
            source: Some("import".into()),
            source_url: None,
            id: None,
            category: None,
        },
    )?;

    let target = paths.instance_game_dir(&meta.id);
    std::fs::create_dir_all(&target)?;

    let mut icon: Option<(String, Vec<u8>)> = None;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.is_dir() {
            continue;
        }
        let full = entry.name().to_string();
        let Some(relative) = full.strip_prefix(prefix.as_str()) else {
            continue;
        };
        if relative.is_empty() {
            continue;
        }
        let Ok(relative) = safe_relative(relative) else {
            continue;
        };
        let first = relative
            .components()
            .next()
            .map(|part| part.as_os_str().to_string_lossy().to_string())
            .unwrap_or_default();
        if skip_entry(&first) || relative.to_string_lossy().to_lowercase().ends_with(".log") {
            continue;
        }
        let mut buffer = Vec::new();
        entry.read_to_end(&mut buffer)?;
        // Картинка сборки: кладём её как иконку, а не как файл в игровой папке.
        if relative.to_string_lossy() == "icon.png" || relative.to_string_lossy() == "icon.jpg" {
            let ext = if relative.to_string_lossy().ends_with("png") { "png" } else { "jpg" };
            icon = Some((format!("icon.{ext}"), buffer));
            continue;
        }
        let dest = target.join(&relative);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&dest, buffer)?;
    }

    let mut meta = meta;
    if let Some((file_name, bytes)) = icon {
        if std::fs::write(paths.instance_dir(&meta.id).join(&file_name), bytes).is_ok() {
            meta.icon = Some(file_name);
            let _ = instances::save(paths, &meta);
        }
    }
    Ok(meta)
}

/// Проверка пути внутри архива — без `..` и абсолютных путей.
fn safe_relative(path: &str) -> Result<PathBuf> {
    let candidate = PathBuf::from(path.replace('\\', "/"));
    if candidate.is_absolute() {
        return Err(Error::Other(format!("недопустимый путь в архиве: {path}")));
    }
    for component in candidate.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(Error::Other(format!("недопустимый путь в архиве: {path}")));
        }
    }
    Ok(candidate)
}

fn loader_label(kind: &str) -> &'static str {
    match kind {
        "fabric" => "Fabric",
        "quilt" => "Quilt",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        _ => "Vanilla",
    }
}

/// Рекурсивное копирование папки сборки (без логов, кэшей и временных файлов).
fn copy_tree(from: &Path, to: &Path, depth: usize) -> Result<()> {
    if depth > 24 {
        return Ok(());
    }
    let Ok(entries) = std::fs::read_dir(from) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if skip_entry(&name) {
            continue;
        }
        let dest = to.join(&name);
        if path.is_dir() {
            std::fs::create_dir_all(&dest)?;
            copy_tree(&path, &dest, depth + 1)?;
        } else if path.is_file() {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let _ = std::fs::copy(&path, &dest);
        }
    }
    Ok(())
}

/// Что не переносим: кэши и логи чужих лаунчеров.
fn skip_entry(name: &str) -> bool {
    matches!(
        name,
        "logs" | "crash-reports" | ".cache" | "cache" | "instance.cfg" | "mmc-pack.json"
            | "profile.json" | ".index"
    )
}

/* ───────────────────────── экспорт ───────────────────────── */

/// Что кладём в архив: игровая папка сборки без логов и кэшей.
const EXPORT_DIRS: [&str; 6] = ["mods", "config", "resourcepacks", "shaderpacks", "saves", "defaultconfig"];
const EXPORT_FILES: [&str; 4] = ["options.txt", "servers.dat", "servers.dat_old", "optionsof.txt"];

fn collect(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>, depth: usize) {
    if depth > 24 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, base, out, depth + 1);
        } else if let Ok(relative) = path.strip_prefix(base) {
            out.push((
                relative.to_string_lossy().replace('\\', "/"),
                path.clone(),
            ));
        }
    }
}

#[derive(Serialize)]
struct IndexFile {
    path: String,
    hashes: std::collections::HashMap<String, String>,
    downloads: Vec<String>,
    file_size: u64,
}

#[derive(Serialize)]
struct Index {
    format_version: u32,
    game: String,
    version_id: String,
    name: String,
    summary: String,
    files: Vec<IndexFile>,
    dependencies: std::collections::HashMap<String, String>,
}

/// Экспорт сборки: `format` = `mrpack` | `zip`.
pub fn export_instance(paths: &Paths, id: &str, out: &Path, format: &str) -> Result<PathBuf> {
    let meta = instances::load(paths, id)?;
    let game = paths.instance_game_dir(id);
    if !game.is_dir() {
        return Err(Error::Other("у сборки нет игровой папки".into()));
    }

    let file = File::create(out)
        .map_err(|error| format!("не создался {}: {error}", out.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mrpack = format == "mrpack";
    // префикс внутри архива: для .mrpack это overrides/, для .zip — корень
    let prefix = if mrpack { "overrides/" } else { "" };

    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    for name in EXPORT_DIRS {
        let dir = game.join(name);
        if dir.is_dir() {
            collect(&dir, &game, &mut entries, 0);
        }
    }
    for name in EXPORT_FILES {
        let path = game.join(name);
        if path.is_file() {
            entries.push((name.to_string(), path));
        }
    }
    // иконка сборки — рядом с файлами, чтобы форматы её подхватили
    let icon = paths.instance_dir(id).join("icon.png");
    if icon.is_file() {
        entries.push(("icon.png".to_string(), icon));
    }

    for (relative, path) in &entries {
        zip.start_file(format!("{prefix}{relative}"), options)
            .map_err(|error| format!("не записался {relative}: {error}"))?;
        let mut source = File::open(path).map_err(|error| format!("{relative}: {error}"))?;
        let mut buffer = Vec::new();
        source
            .read_to_end(&mut buffer)
            .map_err(|error| format!("{relative}: {error}"))?;
        zip.write_all(&buffer)
            .map_err(|error| format!("{relative}: {error}"))?;
    }

    if mrpack {
        let mut dependencies = std::collections::HashMap::new();
        dependencies.insert("minecraft".to_string(), meta.mc_version.clone());
        match &meta.loader {
            Loader::Fabric { version } => {
                dependencies.insert("fabric-loader".to_string(), version.clone());
            }
            Loader::Quilt { version } => {
                dependencies.insert("quilt-loader".to_string(), version.clone());
            }
            Loader::Forge { version } => {
                dependencies.insert("forge".to_string(), version.clone());
            }
            Loader::NeoForge { version } => {
                dependencies.insert("neoforge".to_string(), version.clone());
            }
            Loader::Vanilla => {}
        }
        let index = Index {
            format_version: 1,
            game: "minecraft".into(),
            version_id: format!("{}-{}", meta.id, env!("CARGO_PKG_VERSION")),
            name: meta.name.clone(),
            summary: meta.notes.clone(),
            files: Vec::new(),
            dependencies,
        };
        let text = serde_json::to_string_pretty(&index)?;
        zip.start_file("modrinth.index.json", options)
            .map_err(|error| format!("не записался modrinth.index.json: {error}"))?;
        zip.write_all(text.as_bytes())
            .map_err(|error| format!("modrinth.index.json: {error}"))?;
    }

    zip.finish()
        .map_err(|error| format!("архив не закрылся: {error}"))?;
    Ok(out.to_path_buf())
}
