//! Полноценный backend локальных серверов Minecraft для OmniSpec.
//!
//! Сервер хранится как обычный instance с маркером `server.json`. Это позволяет
//! показывать его в общем списке сборок и одновременно использовать отдельные
//! команды управления сервером. Все серверные файлы, ядро, плагины и моды
//! лежат в одной корневой папке сервера.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;

use omnispec_core::instances::{self, CreateInstanceRequest, InstanceMeta, Loader};
use omnispec_core::net::{Http, Reporter};
use omnispec_core::paths::{slugify, Paths};

pub const SERVER_MARKER: &str = "server.json";
const MAX_SCAN_DIRS: usize = 50_000;
const MAX_SCAN_DEPTH: usize = 5;
const MAX_BACKUP_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_BACKUP_ENTRIES: usize = 200_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_kernel")]
    pub kernel: String,
    #[serde(default)]
    pub mc_version: String,
    #[serde(default)]
    pub kernel_version: String,
    #[serde(default)]
    pub jar: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default = "default_stop_command")]
    pub stop_command: String,
    #[serde(default)]
    pub tps_command: Option<String>,
    #[serde(default = "default_memory")]
    pub memory_mb: u32,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub java_path: Option<String>,
    #[serde(default)]
    pub auto_restart: bool,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub encoding: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub updated: u64,
}

fn default_kernel() -> String {
    "paper".into()
}
fn default_stop_command() -> String {
    "stop".into()
}
fn default_memory() -> u32 {
    4096
}
fn default_port() -> u16 {
    25565
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            kernel: default_kernel(),
            mc_version: String::new(),
            kernel_version: String::new(),
            jar: None,
            command: None,
            stop_command: default_stop_command(),
            tps_command: Some("tps".into()),
            memory_mb: default_memory(),
            port: default_port(),
            java_path: None,
            auto_restart: false,
            auto_start: false,
            encoding: "auto".into(),
            icon: None,
            env: HashMap::new(),
            created: now(),
            updated: now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateServerRequest {
    pub name: String,
    #[serde(default)]
    pub mc_version: String,
    #[serde(default = "default_kernel")]
    pub kernel: String,
    #[serde(default)]
    pub kernel_version: String,
    #[serde(default)]
    pub import_path: Option<String>,
    #[serde(default)]
    pub custom_url: Option<String>,
    #[serde(default)]
    pub java_path: Option<String>,
    #[serde(default)]
    pub memory_mb: Option<u32>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub stop_command: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KernelInfo {
    pub id: String,
    pub label: String,
    pub group: String,
    pub kind: String,
    pub supports_plugins: bool,
    pub supports_mods: bool,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct KernelVersion {
    pub id: String,
    pub label: String,
    /// Версия Minecraft, к которой относится артефакт ядра. Для NeoForge
    /// `id` — версия установщика, поэтому эти значения различаются.
    pub mc_version: Option<String>,
    pub java: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KernelArtifact {
    pub url: String,
    pub file_name: String,
    pub installer: bool,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerCandidate {
    pub path: String,
    pub name: String,
    pub kernel: String,
    pub mc_version: String,
    pub jar: Option<String>,
    pub command: Option<String>,
    pub port: Option<u16>,
    pub has_icon: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: u64,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerPlayer {
    pub name: String,
    pub online: bool,
    pub last_seen: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerMetrics {
    pub pid: Option<u32>,
    pub memory_bytes: u64,
    pub cpu_percent: f32,
    pub uptime_secs: u64,
    pub tps: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerSnapshot {
    pub id: String,
    pub config: ServerConfig,
    pub root: String,
    pub eula_accepted: bool,
    pub running: bool,
    pub metrics: ServerMetrics,
    pub players: Vec<ServerPlayer>,
    pub files: Vec<ServerFile>,
    pub log_tail: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub created: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerAddon {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub kind: String,
    pub enabled: bool,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.is_file() && !meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn marker(paths: &Paths, id: &str) -> PathBuf {
    paths.instance_dir(id).join(SERVER_MARKER)
}

fn ensure_not_symlink(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(format!("{label} не может быть символической ссылкой"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("не удалось проверить {label}: {error}")),
    }
}

fn ensure_directory(path: &Path, label: &str) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|_| format!("{label} не найдена"))?;
    if meta.file_type().is_symlink() {
        return Err(format!("{label} не может быть символической ссылкой"));
    }
    if !meta.is_dir() {
        return Err(format!("{label} не является папкой"));
    }
    Ok(())
}

fn ensure_no_symlink_components(base: &Path, candidate: &Path, label: &str) -> Result<(), String> {
    ensure_directory(base, "папка сервера")?;
    let relative = candidate
        .strip_prefix(base)
        .map_err(|_| format!("путь {label} выходит за пределы сервера"))?;
    let mut current = base.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            if matches!(component, Component::CurDir) {
                continue;
            }
            return Err(format!("недопустимый путь {label}"));
        };
        current.push(name);
        ensure_not_symlink(&current, label)?;
    }
    Ok(())
}

pub fn root(paths: &Paths, meta: &InstanceMeta) -> PathBuf {
    instances::game_dir_for(paths, meta)
}

pub fn is_server(paths: &Paths, id: &str) -> bool {
    if instances::load(paths, id).is_err() {
        return false;
    }
    let file = marker(paths, id);
    fs::symlink_metadata(file)
        .map(|meta| meta.is_file() && !meta.file_type().is_symlink())
        .unwrap_or(false)
}

pub fn load(paths: &Paths, id: &str) -> Result<ServerConfig, String> {
    let _meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let file = marker(paths, id);
    ensure_not_symlink(&file, "server.json")?;
    let text = fs::read_to_string(&file)
        .map_err(|e| format!("не удалось прочитать настройки сервера: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("неверный server.json: {e}"))
}

pub fn save(paths: &Paths, id: &str, mut config: ServerConfig) -> Result<ServerConfig, String> {
    let meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let dir = paths.instance_dir(id);
    ensure_directory(&dir, "папка сервера")?;
    config.memory_mb = config.memory_mb.clamp(512, 65536);
    config.port = config.port.clamp(1, u16::MAX);
    config.updated = now();
    let file = marker(paths, id);
    ensure_not_symlink(&file, "server.json")?;
    let tmp = file.with_extension("json.tmp");
    ensure_not_symlink(&tmp, "временный server.json")?;
    let data = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    let server_root = root(paths, &meta);
    if server_root.is_dir() {
        write_server_port(&server_root, config.port)?;
    }
    Ok(config)
}

pub fn decorate(paths: &Paths, meta: &InstanceMeta) -> Value {
    let mut value = serde_json::to_value(meta).unwrap_or_else(|_| json!({}));
    if let Ok(config) = load(paths, &meta.id) {
        if let Some(object) = value.as_object_mut() {
            object.insert("is_server".into(), json!(true));
            object.insert("kind".into(), json!("server"));
            object.insert(
                "server".into(),
                serde_json::to_value(config).unwrap_or(Value::Null),
            );
            object.insert(
                "server_root".into(),
                json!(root(paths, meta).to_string_lossy().to_string()),
            );
        }
    }
    value
}

pub fn decorate_all(paths: &Paths, metas: Vec<InstanceMeta>) -> Vec<Value> {
    metas.iter().map(|meta| decorate(paths, meta)).collect()
}

pub fn kernel_catalog() -> Vec<KernelInfo> {
    vec![
        KernelInfo {
            id: "paper".into(),
            label: "Paper".into(),
            group: "Bukkit-плагины".into(),
            kind: "minecraft".into(),
            supports_plugins: true,
            supports_mods: false,
            description: "Быстрый совместимый сервер с экосистемой Bukkit/Spigot.".into(),
        },
        KernelInfo {
            id: "purpur".into(),
            label: "Purpur".into(),
            group: "Bukkit-плагины".into(),
            kind: "minecraft".into(),
            supports_plugins: true,
            supports_mods: false,
            description: "Paper-форк с расширенными настройками геймплея.".into(),
        },
        KernelInfo {
            id: "spigot".into(),
            label: "Spigot".into(),
            group: "Bukkit-плагины".into(),
            kind: "minecraft".into(),
            supports_plugins: true,
            supports_mods: false,
            description:
                "Классический Bukkit-сервер; можно указать собственную ссылку или BuildTools."
                    .into(),
        },
        KernelInfo {
            id: "folia".into(),
            label: "Folia".into(),
            group: "Bukkit-плагины".into(),
            kind: "minecraft".into(),
            supports_plugins: true,
            supports_mods: false,
            description: "Параллельная модель Paper для больших серверов.".into(),
        },
        KernelInfo {
            id: "fabric".into(),
            label: "Fabric".into(),
            group: "Модовые".into(),
            kind: "minecraft".into(),
            supports_plugins: false,
            supports_mods: true,
            description: "Лёгкий модовый сервер Fabric.".into(),
        },
        KernelInfo {
            id: "forge".into(),
            label: "Forge".into(),
            group: "Модовые".into(),
            kind: "minecraft".into(),
            supports_plugins: false,
            supports_mods: true,
            description: "Официальная экосистема Forge; установщик готовит серверную папку.".into(),
        },
        KernelInfo {
            id: "neoforge".into(),
            label: "NeoForge".into(),
            group: "Модовые".into(),
            kind: "minecraft".into(),
            supports_plugins: false,
            supports_mods: true,
            description: "Современная ветка Forge для новых версий.".into(),
        },
        KernelInfo {
            id: "vanilla".into(),
            label: "Vanilla".into(),
            group: "Официальные".into(),
            kind: "minecraft".into(),
            supports_plugins: false,
            supports_mods: false,
            description: "Чистый сервер Mojang.".into(),
        },
        KernelInfo {
            id: "velocity".into(),
            label: "Velocity".into(),
            group: "Прокси".into(),
            kind: "proxy".into(),
            supports_plugins: true,
            supports_mods: false,
            description: "Современный прокси-сервер Minecraft.".into(),
        },
        KernelInfo {
            id: "waterfall".into(),
            label: "Waterfall".into(),
            group: "Прокси".into(),
            kind: "proxy".into(),
            supports_plugins: true,
            supports_mods: false,
            description: "Прокси-ветка Paper для совместимости с BungeeCord.".into(),
        },
        KernelInfo {
            id: "bungeecord".into(),
            label: "BungeeCord".into(),
            group: "Прокси".into(),
            kind: "proxy".into(),
            supports_plugins: true,
            supports_mods: false,
            description: "Классический прокси; укажи готовый jar.".into(),
        },
        KernelInfo {
            id: "custom".into(),
            label: "Другое / свой jar".into(),
            group: "Другое".into(),
            kind: "custom".into(),
            supports_plugins: true,
            supports_mods: true,
            description: "Импорт готовой папки или загрузка по прямой ссылке.".into(),
        },
    ]
}

fn kernel_is(id: &str, names: &[&str]) -> bool {
    names.iter().any(|name| id.eq_ignore_ascii_case(name))
}

pub async fn kernel_versions(http: &Http, kernel: &str) -> Result<Vec<KernelVersion>, String> {
    let mut out = Vec::new();
    if kernel_is(kernel, &["paper", "folia", "velocity", "waterfall"]) {
        let url = format!("https://api.papermc.io/v2/projects/{kernel}");
        let value: Value = http.get_json(&url).await.map_err(|e| e.to_string())?;
        if let Some(items) = value.get("versions").and_then(Value::as_array) {
            for item in items.iter().rev().take(100) {
                if let Some(id) = item.as_str() {
                    out.push(KernelVersion {
                        id: id.into(),
                        label: id.into(),
                        mc_version: Some(id.into()),
                        java: None,
                    });
                }
            }
        }
    } else if kernel.eq_ignore_ascii_case("purpur") {
        let value: Value = http
            .get_json("https://api.purpurmc.org/v2/purpur")
            .await
            .map_err(|e| e.to_string())?;
        if let Some(items) = value.get("versions").and_then(Value::as_array) {
            for item in items.iter().rev().take(100) {
                if let Some(id) = item.as_str() {
                    out.push(KernelVersion {
                        id: id.into(),
                        label: id.into(),
                        mc_version: Some(id.into()),
                        java: None,
                    });
                }
            }
        }
    } else if kernel.eq_ignore_ascii_case("fabric") {
        let value: Value = http
            .get_json("https://meta.fabricmc.net/v2/versions/game")
            .await
            .map_err(|e| e.to_string())?;
        if let Some(items) = value.as_array() {
            for item in items
                .iter()
                .filter(|item| item.get("stable").and_then(Value::as_bool).unwrap_or(true))
                .take(100)
            {
                if let Some(id) = item.get("version").and_then(Value::as_str) {
                    out.push(KernelVersion {
                        id: id.into(),
                        label: id.into(),
                        mc_version: Some(id.into()),
                        java: None,
                    });
                }
            }
        }
    } else if kernel.eq_ignore_ascii_case("vanilla") {
        let value: Value = http
            .get_json("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
            .await
            .map_err(|e| e.to_string())?;
        if let Some(items) = value.get("versions").and_then(Value::as_array) {
            for item in items
                .iter()
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("release"))
                .take(100)
            {
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    out.push(KernelVersion {
                        id: id.into(),
                        label: id.into(),
                        mc_version: Some(id.into()),
                        java: None,
                    });
                }
            }
        }
    } else if kernel.eq_ignore_ascii_case("forge") {
        let value: Value = http
            .get_json(
                "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
            )
            .await
            .map_err(|e| e.to_string())?;
        if let Some(map) = value.get("promos").and_then(Value::as_object) {
            let mut seen = BTreeSet::new();
            for key in map
                .keys()
                .filter(|key| key.ends_with("-latest") || key.ends_with("-recommended"))
            {
                if let Some(mc) = key
                    .strip_suffix("-latest")
                    .or_else(|| key.strip_suffix("-recommended"))
                {
                    if seen.insert(mc.to_string()) {
                        out.push(KernelVersion {
                            id: mc.into(),
                            label: mc.into(),
                            mc_version: Some(mc.into()),
                            java: None,
                        });
                    }
                }
            }
        }
    } else if kernel.eq_ignore_ascii_case("neoforge") {
        // NeoForge versions are installer versions. Keep the Minecraft
        // version separately so the server metadata remains truthful.
        out = [
            ("21.1.77", "1.21.1"),
            ("21.1.65", "1.21.1"),
            ("20.6.119", "1.20.6"),
            ("20.4.251", "1.20.4"),
        ]
        .iter()
        .map(|(id, mc)| KernelVersion {
            id: (*id).into(),
            label: format!("{id} · MC {mc}"),
            mc_version: Some((*mc).into()),
            java: Some(21),
        })
        .collect();
    }
    Ok(out)
}

async fn vanilla_artifact(http: &Http, version: &str) -> Result<KernelArtifact, String> {
    let manifest: Value = http
        .get_json("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
        .await
        .map_err(|e| e.to_string())?;
    let item = manifest
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|v| v.get("id").and_then(Value::as_str) == Some(version))
        })
        .ok_or_else(|| "версия Vanilla не найдена".to_string())?;
    let url = item
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "у версии Vanilla нет metadata URL".to_string())?;
    let metadata: Value = http.get_json(url).await.map_err(|e| e.to_string())?;
    let server = metadata
        .get("downloads")
        .and_then(|v| v.get("server"))
        .ok_or_else(|| "для этой версии нет server.jar".to_string())?;
    let server_url = server
        .get("url")
        .and_then(Value::as_str)
        .filter(|value| value.starts_with("https://"))
        .ok_or_else(|| "у Vanilla отсутствует безопасная ссылка на server.jar".to_string())?;
    Ok(KernelArtifact {
        url: server_url.into(),
        file_name: "server.jar".into(),
        installer: false,
        size: server.get("size").and_then(Value::as_u64),
    })
}

pub async fn resolve_kernel(
    http: &Http,
    kernel: &str,
    version: &str,
    custom_url: Option<&str>,
) -> Result<KernelArtifact, String> {
    if let Some(url) = custom_url
        .map(str::trim)
        .filter(|v| v.starts_with("http://") || v.starts_with("https://"))
    {
        return Ok(KernelArtifact {
            url: url.into(),
            file_name: file_name_from_url(url),
            installer: false,
            size: None,
        });
    }
    if kernel.eq_ignore_ascii_case("vanilla") {
        return vanilla_artifact(http, version).await;
    }
    if kernel.eq_ignore_ascii_case("purpur") {
        return Ok(KernelArtifact {
            url: format!("https://api.purpurmc.org/v2/purpur/{version}/latest/download"),
            file_name: format!("purpur-{version}.jar"),
            installer: false,
            size: None,
        });
    }
    if kernel.eq_ignore_ascii_case("spigot") {
        return Ok(KernelArtifact { url: "https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar".into(), file_name: "BuildTools.jar".into(), installer: true, size: None });
    }
    if kernel_is(kernel, &["paper", "folia", "velocity", "waterfall"]) {
        let project = kernel.to_ascii_lowercase();
        let url = format!("https://api.papermc.io/v2/projects/{project}/versions/{version}/builds");
        let value: Value = http.get_json(&url).await.map_err(|e| e.to_string())?;
        let build = value
            .get("builds")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .rev()
                    .find(|b| {
                        b.get("channel").and_then(Value::as_str).unwrap_or("STABLE") == "STABLE"
                    })
                    .or_else(|| items.last())
            })
            .ok_or_else(|| format!("для {kernel} {version} нет сборок"))?;
        let number = build
            .get("build")
            .and_then(Value::as_i64)
            .ok_or_else(|| "API ядра не вернул номер сборки".to_string())?;
        let name = format!("{project}-{version}-{number}.jar");
        return Ok(KernelArtifact { url: format!("https://api.papermc.io/v2/projects/{project}/versions/{version}/builds/{number}/downloads/{name}"), file_name: name, installer: false, size: None });
    }
    if kernel.eq_ignore_ascii_case("fabric") {
        let loaders: Value = http
            .get_json("https://meta.fabricmc.net/v2/versions/loader")
            .await
            .map_err(|e| e.to_string())?;
        let loader = loaders
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|v| v.get("stable").and_then(Value::as_bool).unwrap_or(false))
                    .or_else(|| items.first())
            })
            .and_then(|v| v.get("version"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Fabric Loader не найден".to_string())?;
        return Ok(KernelArtifact {
            url: format!(
                "https://meta.fabricmc.net/v2/versions/loader/{version}/{loader}/1.0.0/server/jar"
            ),
            file_name: format!("fabric-server-{version}.jar"),
            installer: false,
            size: None,
        });
    }
    if kernel.eq_ignore_ascii_case("forge") {
        let promos: Value = http
            .get_json(
                "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
            )
            .await
            .map_err(|e| e.to_string())?;
        let recommended_key = format!("{version}-recommended");
        let latest_key = format!("{version}-latest");
        let build = promos
            .get("promos")
            .and_then(|v| v.get(recommended_key.as_str()))
            .and_then(Value::as_str)
            .or_else(|| {
                promos
                    .get("promos")
                    .and_then(|v| v.get(latest_key.as_str()))
                    .and_then(Value::as_str)
            })
            .ok_or_else(|| "Forge не опубликовал recommended/latest для этой версии".to_string())?;
        let full = format!("{version}-{build}");
        return Ok(KernelArtifact { url: format!("https://maven.minecraftforge.net/net/minecraftforge/forge/{full}/forge-{full}-installer.jar"), file_name: format!("forge-{full}-installer.jar"), installer: true, size: None });
    }
    if kernel.eq_ignore_ascii_case("neoforge") {
        return Ok(KernelArtifact { url: format!("https://maven.neoforged.net/releases/net/neoforged/neoforge/{version}/neoforge-{version}-installer.jar"), file_name: format!("neoforge-{version}-installer.jar"), installer: true, size: None });
    }
    Err(format!("для ядра {kernel} нужна прямая ссылка на jar"))
}

fn file_name_from_url(url: &str) -> String {
    let candidate = url
        .split('?')
        .next()
        .and_then(|value| value.rsplit('/').next())
        .filter(|value| !value.is_empty())
        .unwrap_or("server.jar");
    if candidate == "."
        || candidate == ".."
        || candidate.contains('\\')
        || candidate.chars().any(char::is_control)
        || candidate.len() > 180
    {
        "server.jar".into()
    } else {
        candidate.to_string()
    }
}

fn find_jar(root: &Path, kernel: &str) -> Option<String> {
    let mut jars = Vec::new();
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if regular_file(&path)
                && path
                    .extension()
                    .and_then(|v| v.to_str())
                    .map(|v| v.eq_ignore_ascii_case("jar"))
                    .unwrap_or(false)
            {
                jars.push(path);
            }
        }
    }
    jars.sort_by_key(|p| {
        let name = p
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
            .to_lowercase();
        let preferred = if name.contains("buildtools") || name.contains("installer") {
            4
        } else if name.contains(kernel) {
            0
        } else if name.contains("server") || name.starts_with("spigot-") {
            1
        } else {
            2
        };
        (preferred, name)
    });
    jars.into_iter().find_map(|p| {
        let name = p.file_name()?.to_str()?.to_string();
        let lower = name.to_ascii_lowercase();
        if lower.contains("installer") || lower.contains("buildtools") {
            None
        } else {
            Some(name)
        }
    })
}

fn parse_port(root: &Path) -> Option<u16> {
    let text = fs::read_to_string(root.join("server.properties")).ok()?;
    text.lines().find_map(|line| {
        line.trim()
            .strip_prefix("server-port=")?
            .trim()
            .parse()
            .ok()
    })
}

fn write_server_port(root: &Path, port: u16) -> Result<(), String> {
    ensure_directory(root, "папка сервера")?;
    let file = root.join("server.properties");
    ensure_not_symlink(&file, "server.properties")?;
    let text = fs::read_to_string(&file).unwrap_or_default();
    let mut found = false;
    let mut lines = Vec::new();
    for line in text.lines() {
        if line.trim_start().starts_with("server-port=") {
            if !found {
                lines.push(format!("server-port={port}"));
                found = true;
            }
        } else {
            lines.push(line.to_string());
        }
    }
    if !found {
        lines.push(format!("server-port={port}"));
    }
    let ending = if text.contains("\r\n") { "\r\n" } else { "\n" };
    fs::write(file, lines.join(ending)).map_err(|e| e.to_string())
}

fn infer_kernel(root: &Path) -> String {
    let names: Vec<String> = fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_lowercase())
        .collect();
    let joined = names.join(" ");
    if joined.contains("purpur") {
        "purpur".into()
    } else if joined.contains("paper") {
        "paper".into()
    } else if joined.contains("folia") {
        "folia".into()
    } else if joined.contains("fabric") {
        "fabric".into()
    } else if joined.contains("neoforge") {
        "neoforge".into()
    } else if joined.contains("forge") {
        "forge".into()
    } else if joined.contains("velocity") {
        "velocity".into()
    } else if joined.contains("waterfall") {
        "waterfall".into()
    } else {
        "custom".into()
    }
}

fn infer_version(root: &Path) -> String {
    for file in [
        "version_history.json",
        "logs/latest.log",
        "logs/latest.log.0",
    ] {
        if let Ok(text) = fs::read_to_string(root.join(file)) {
            let re = regex::Regex::new(r"\b1\.\d+(?:\.\d+)?\b").ok();
            if let Some(value) = re.and_then(|re| re.find(&text).map(|m| m.as_str().to_string())) {
                return value;
            }
        }
    }
    String::new()
}

fn infer_command(root: &Path, _jar: Option<&str>) -> Option<String> {
    #[cfg(windows)]
    let scripts = [
        "start.bat",
        "start.cmd",
        "run.bat",
        "run.cmd",
        "start.sh",
        "run.sh",
    ];
    #[cfg(not(windows))]
    let scripts = ["start.sh", "run.sh"];
    scripts
        .into_iter()
        .find(|name| regular_file(&root.join(name)))
        .map(str::to_owned)
}

fn config_from_folder(root: &Path) -> ServerConfig {
    let kernel = infer_kernel(root);
    let jar = find_jar(root, &kernel);
    let script = infer_command(root, jar.as_deref());
    let mut config = ServerConfig {
        kernel,
        mc_version: infer_version(root),
        kernel_version: String::new(),
        jar,
        command: script,
        port: parse_port(root).unwrap_or(25565),
        ..ServerConfig::default()
    };
    if config.kernel == "velocity" || config.kernel == "waterfall" || config.kernel == "bungeecord"
    {
        config.stop_command = "end".into();
        config.tps_command = None;
    }
    if regular_file(&root.join("server-icon.png")) {
        config.icon = Some("server-icon.png".into());
    }
    config
}

struct CreateCleanup {
    paths: Paths,
    id: String,
    keep: bool,
}

impl Drop for CreateCleanup {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(self.paths.instance_dir(&self.id));
        }
    }
}

fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    ensure_directory(src, "исходная папка")?;
    ensure_not_symlink(dst, "целевая папка")?;
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    ensure_directory(dst, "целевая папка")?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let name = entry.file_name();
        if name == SERVER_MARKER || name == ".omnispec-backups" {
            continue;
        }
        let to = dst.join(&name);
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            if to
                .symlink_metadata()
                .map(|meta| meta.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Err(format!("цель является ссылкой: {}", to.display()));
            }
            copy_tree(&from, &to)?;
        } else if ty.is_file() {
            if to
                .symlink_metadata()
                .map(|meta| meta.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Err(format!("цель является ссылкой: {}", to.display()));
            }
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        } else if ty.is_symlink() {
            // Импорт и синхронизация не следуют символическим ссылкам.
            continue;
        }
    }
    Ok(())
}

pub async fn create(
    http: &Http,
    paths: &Paths,
    request: CreateServerRequest,
    reporter: &Reporter,
) -> Result<InstanceMeta, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("укажите название сервера".into());
    }
    let imported = request
        .import_path
        .as_ref()
        .map(|p| PathBuf::from(p.trim()))
        .filter(|p| !p.as_os_str().is_empty());
    if imported.is_none() && request.mc_version.trim().is_empty() {
        return Err("укажите версию Minecraft или импортируйте папку".into());
    }
    if let Some(source) = imported.as_ref() {
        if !source.is_dir() {
            return Err(format!("папка сервера не найдена: {}", source.display()));
        }
    }
    let source_config = imported.as_ref().map(|p| config_from_folder(p));
    let mc = if !request.mc_version.trim().is_empty() {
        request.mc_version.trim().to_string()
    } else {
        source_config
            .as_ref()
            .map(|c| c.mc_version.clone())
            .unwrap_or_default()
    };
    let kernel = if request.kernel.trim().is_empty()
        || request.kernel == "paper" && source_config.is_some()
    {
        source_config
            .as_ref()
            .map(|c| c.kernel.clone())
            .unwrap_or_else(|| "paper".into())
    } else {
        request.kernel.trim().to_lowercase()
    };
    let loader = Loader::Vanilla;
    let meta = instances::create(
        paths,
        CreateInstanceRequest {
            name: name.into(),
            mc_version: if mc.is_empty() {
                "server".into()
            } else {
                mc.clone()
            },
            loader,
            icon: None,
            notes: String::new(),
            source: Some("server".into()),
            source_url: None,
            id: Some(slugify(name)),
            category: request.category.clone(),
            memory_mb: request.memory_mb,
            java_path: request.java_path.clone(),
            game_dir: None,
        },
    )
    .map_err(|e| e.to_string())?;
    let mut cleanup = CreateCleanup {
        paths: paths.clone(),
        id: meta.id.clone(),
        keep: false,
    };
    let server_root = paths.instance_dir(&meta.id).join("server");
    fs::create_dir_all(&server_root).map_err(|e| e.to_string())?;
    if let Some(source) = imported.as_ref() {
        let source_canonical = source.canonicalize().map_err(|e| e.to_string())?;
        let target_canonical = server_root.canonicalize().map_err(|e| e.to_string())?;
        if source_canonical == target_canonical || target_canonical.starts_with(&source_canonical) {
            return Err(
                "нельзя импортировать папку сервера в саму себя или в её дочернюю папку".into(),
            );
        }
        reporter.emit("server", 0, 3, "импортируем файлы сервера");
        copy_tree(source, &server_root)?;
    }
    let mut config = source_config.unwrap_or_default();
    config.kernel = kernel;
    config.mc_version = mc.clone();
    config.kernel_version = request.kernel_version.trim().to_string();
    config.java_path = request.java_path.clone().filter(|v| !v.trim().is_empty());
    config.memory_mb = request
        .memory_mb
        .unwrap_or(config.memory_mb)
        .clamp(512, 65536);
    config.port = request.port.unwrap_or(config.port).clamp(1, u16::MAX);
    if request
        .command
        .as_ref()
        .is_some_and(|v| !v.trim().is_empty())
    {
        config.command = request.command.clone();
    }
    if let Some(stop) = request.stop_command.filter(|v| !v.trim().is_empty()) {
        config.stop_command = stop;
    }
    config.created = now();
    config.updated = now();
    if !server_root.join("server-icon.png").is_file() {
        config.icon = None;
    }

    if imported.is_none() {
        let version = if config.kernel == "fabric" && config.kernel_version.trim().is_empty() {
            mc.clone()
        } else {
            config.kernel_version.clone().if_empty_then(&mc)
        };
        reporter.emit(
            "server",
            1,
            3,
            format!("получаем ядро {} {}", config.kernel, version),
        );
        let artifact = resolve_kernel(
            http,
            &config.kernel,
            &version,
            request.custom_url.as_deref(),
        )
        .await?;
        let target = server_root.join(&artifact.file_name);
        reporter.emit("server", 2, 3, format!("скачиваем {}", artifact.file_name));
        http.download_tracked(
            &artifact.url,
            &target,
            artifact.size,
            None,
            false,
            &|done, total| reporter.emit_bytes("server", &artifact.file_name, done, total),
        )
        .await
        .map_err(|e| e.to_string())?;
        if artifact.installer {
            reporter.emit("server", 2, 3, "запускаем установщик ядра");
            let java = config.java_path.clone().unwrap_or_else(|| "java".into());
            let mut installer = Command::new(java);
            installer.arg("-jar").arg(&artifact.file_name);
            if config.kernel.eq_ignore_ascii_case("spigot") {
                installer.arg("--rev").arg(&version);
            } else {
                installer.arg("--installServer");
            }
            let output = installer
                .current_dir(&server_root)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await
                .map_err(|e| format!("не удалось запустить установщик: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "установщик ядра завершился с ошибкой: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }
        config.jar = find_jar(&server_root, &config.kernel).or_else(|| Some(artifact.file_name));
        config.command = infer_command(&server_root, config.jar.as_deref());
    }
    let eula_file = server_root.join("eula.txt");
    ensure_not_symlink(&eula_file, "eula.txt")?;
    if !regular_file(&eula_file) {
        fs::write(&eula_file, "# Generated by OmniSpec\neula=false\n")
            .map_err(|e| e.to_string())?;
    }
    let properties_file = server_root.join("server.properties");
    ensure_not_symlink(&properties_file, "server.properties")?;
    if !regular_file(&properties_file) {
        fs::write(
            &properties_file,
            format!(
                "server-port={}\nmotd={}\n",
                config.port,
                name.replace('\n', " ")
            ),
        )
        .map_err(|e| e.to_string())?;
    }
    write_server_port(&server_root, config.port)?;
    // Absolute game_dir is intentional: it keeps imports stable if the profile
    // is renamed, just like an external game directory in the normal model.
    let mut final_meta = instances::load(paths, &meta.id).map_err(|e| e.to_string())?;
    final_meta.game_dir = Some(server_root.to_string_lossy().into_owned());
    instances::save(paths, &final_meta).map_err(|e| e.to_string())?;
    save(paths, &meta.id, config)?;
    cleanup.keep = true;
    reporter.emit("server", 3, 3, "сервер готов");
    Ok(final_meta)
}

trait EmptyThen {
    fn if_empty_then(self, fallback: &str) -> String;
}
impl EmptyThen for String {
    fn if_empty_then(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.into()
        } else {
            self
        }
    }
}

fn safe_relative(base: &Path, raw: &str, label: &str) -> Result<PathBuf, String> {
    let normalized = raw.replace('\\', "/");
    let relative = Path::new(&normalized);
    if normalized.trim().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("недопустимый путь {label}"));
    }
    Ok(base.join(relative))
}

fn ensure_inside(base: &Path, candidate: &Path, label: &str) -> Result<(), String> {
    let canonical_base = base
        .canonicalize()
        .map_err(|_| format!("папка сервера не найдена"))?;
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|_| format!("{label} не найден"))?;
    if !canonical_candidate.starts_with(&canonical_base) {
        return Err(format!("путь {label} выходит за пределы сервера"));
    }
    Ok(())
}

fn addon_path(base: &Path, raw: &str) -> Result<PathBuf, String> {
    let file = safe_relative(base, raw, "аддона")?;
    let relative = file
        .strip_prefix(base)
        .map_err(|_| "недопустимый путь аддона".to_string())?;
    let components: Vec<_> = relative.components().collect();
    if components.len() != 2 {
        return Err("аддон должен находиться непосредственно в mods или plugins".into());
    }
    let Component::Normal(folder) = components[0] else {
        return Err("недопустимая папка аддона".into());
    };
    if !folder.to_string_lossy().eq_ignore_ascii_case("mods")
        && !folder.to_string_lossy().eq_ignore_ascii_case("plugins")
    {
        return Err("аддон должен находиться в mods или plugins".into());
    }
    if !matches!(components[1], Component::Normal(_)) {
        return Err("недопустимое имя аддона".into());
    }
    Ok(file)
}

pub fn files(paths: &Paths, id: &str, sub: Option<&str>) -> Result<Vec<ServerFile>, String> {
    let meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let base = root(paths, &meta);
    let dir = match sub.filter(|v| !v.trim().is_empty()) {
        Some(value) => safe_relative(&base, value, "каталога")?,
        None => base.clone(),
    };
    ensure_directory(&base, "папка сервера")?;
    if !dir.is_dir() {
        return Err("папка сервера не найдена".into());
    }
    ensure_inside(&base, &dir, "каталог")?;
    ensure_no_symlink_components(&base, &dir, "каталога")?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let md = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".omnispec-backups" {
            continue;
        }
        out.push(ServerFile {
            name: name.clone(),
            path: sub
                .map(|s| format!("{s}/{name}"))
                .unwrap_or_else(|| name.clone()),
            size: if md.is_file() { md.len() } else { 0 },
            modified: md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            kind: if md.is_dir() {
                "directory".into()
            } else {
                extension_kind(&name)
            },
        });
    }
    out.sort_by(|a, b| {
        (a.kind != "directory", a.name.to_lowercase())
            .cmp(&(b.kind != "directory", b.name.to_lowercase()))
    });
    Ok(out)
}

fn extension_kind(name: &str) -> String {
    match Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jar" => "addon".into(),
        "log" => "log".into(),
        "json" | "yml" | "yaml" | "properties" | "toml" => "config".into(),
        _ => "file".into(),
    }
}

pub fn eula_accepted(root: &Path) -> bool {
    let file = root.join("eula.txt");
    if fs::symlink_metadata(&file)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return false;
    }
    fs::read_to_string(file).ok().is_some_and(|text| {
        text.lines().any(|line| {
            let Some((key, value)) = line.split_once('=') else {
                return false;
            };
            key.trim().eq_ignore_ascii_case("eula") && value.trim().eq_ignore_ascii_case("true")
        })
    })
}

pub fn set_eula(paths: &Paths, id: &str, accepted: bool) -> Result<(), String> {
    let meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let dir = root(paths, &meta);
    ensure_directory(&dir, "папка сервера")?;
    let file = dir.join("eula.txt");
    ensure_not_symlink(&file, "eula.txt")?;
    let text = fs::read_to_string(&file).unwrap_or_default();
    let mut lines = Vec::new();
    let mut found = false;
    for line in text.lines() {
        let is_eula = line
            .split_once('=')
            .map(|(key, _)| key.trim().eq_ignore_ascii_case("eula"))
            .unwrap_or(false);
        if is_eula {
            if !found {
                lines.push(format!("eula={}", if accepted { "true" } else { "false" }));
                found = true;
            }
        } else {
            lines.push(line.to_string());
        }
    }
    if !found {
        lines.push(format!("eula={}", if accepted { "true" } else { "false" }));
    }
    let ending = if text.contains("\r\n") { "\r\n" } else { "\n" };
    fs::write(file, lines.join(ending)).map_err(|e| e.to_string())
}

fn read_log(root: &Path) -> Vec<String> {
    for rel in [
        "logs/latest.log",
        "logs/latest.log.0",
        "latest.log",
        "server.log",
    ] {
        if let Ok(text) = fs::read_to_string(root.join(rel)) {
            return text
                .lines()
                .rev()
                .take(500)
                .map(|line| line.to_string())
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
        }
    }
    Vec::new()
}

fn players_from_logs(lines: &[String]) -> Vec<ServerPlayer> {
    let joined = regex::Regex::new(r"(?:\]:?\s+|\s)([A-Za-z0-9_]{2,16}) joined the game").ok();
    let left = regex::Regex::new(r"(?:\]:?\s+|\s)([A-Za-z0-9_]{2,16}) left the game").ok();
    let mut states: HashMap<String, bool> = HashMap::new();
    for line in lines {
        if let Some(re) = &joined {
            if let Some(c) = re.captures(line) {
                states.insert(c[1].to_string(), true);
            }
        }
        if let Some(re) = &left {
            if let Some(c) = re.captures(line) {
                states.insert(c[1].to_string(), false);
            }
        }
    }
    let mut out: Vec<_> = states
        .into_iter()
        .map(|(name, online)| ServerPlayer {
            name,
            online,
            last_seen: None,
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

pub fn list_players(paths: &Paths, id: &str) -> Result<Vec<ServerPlayer>, String> {
    let meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let mut lines = read_log(&root(paths, &meta));
    if let Ok(text) = fs::read_to_string(log_path(paths, id)) {
        lines = text.lines().map(|line| line.to_string()).collect();
    }
    Ok(players_from_logs(&lines))
}

pub fn metrics(pid: Option<u32>, started: Option<u64>, tps: Option<f32>) -> ServerMetrics {
    let mut memory_bytes = 0;
    let mut cpu_percent = 0.0;
    if let Some(pid) = pid {
        #[cfg(target_os = "linux")]
        {
            if let Ok(text) = fs::read_to_string(format!("/proc/{pid}/status")) {
                memory_bytes = text
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("VmRSS:")
                            .and_then(|v| v.split_whitespace().next())
                            .and_then(|v| v.parse::<u64>().ok())
                    })
                    .unwrap_or(0)
                    * 1024;
            }
            // Средняя загрузка процесса за его жизнь: utime+stime в jiffies
            // делим на возраст процесса и число логических CPU. Это честная
            // оценка даже без фонового семплера и не выдаёт raw jiffies за %.
            if let (Ok(stat), Ok(uptime)) = (
                fs::read_to_string(format!("/proc/{pid}/stat")),
                fs::read_to_string("/proc/uptime"),
            ) {
                let fields: Vec<&str> = stat
                    .rsplit_once(") ")
                    .map(|(_, rest)| rest.split_whitespace().collect())
                    .unwrap_or_default();
                let system_uptime = uptime
                    .split_whitespace()
                    .next()
                    .and_then(|v| v.parse::<f32>().ok())
                    .unwrap_or(0.0);
                let ticks_per_second = 100.0_f32;
                // После PID и comm начинаются state, ppid, ...; эти индексы
                // не ломаются, если имя процесса содержит пробелы.
                if fields.len() > 19 {
                    let user_ticks = fields
                        .get(11)
                        .and_then(|v| v.parse::<f32>().ok())
                        .unwrap_or(0.0);
                    let system_ticks = fields
                        .get(12)
                        .and_then(|v| v.parse::<f32>().ok())
                        .unwrap_or(0.0);
                    let start_ticks = fields
                        .get(19)
                        .and_then(|v| v.parse::<f32>().ok())
                        .unwrap_or(0.0);
                    let age = system_uptime - start_ticks / ticks_per_second;
                    let cpus = std::thread::available_parallelism()
                        .map(|value| value.get() as f32)
                        .unwrap_or(1.0);
                    if age > 0.0 {
                        cpu_percent =
                            ((user_ticks + system_ticks) / ticks_per_second / age * 100.0 / cpus)
                                .clamp(0.0, 100.0 * cpus);
                    }
                }
            }
        }
    }
    ServerMetrics {
        pid,
        memory_bytes,
        cpu_percent,
        uptime_secs: started.map(|v| now().saturating_sub(v)).unwrap_or(0),
        tps,
    }
}

fn tps_from_logs(lines: &[String]) -> Option<f32> {
    let re = regex::Regex::new(r"(?i)(?:TPS|tps)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)").ok()?;
    lines.iter().rev().find_map(|line| {
        re.captures(line)
            .and_then(|c| c.get(1))
            .and_then(|v| v.as_str().parse().ok())
    })
}

pub fn snapshot(
    paths: &Paths,
    id: &str,
    pid: Option<u32>,
    started: Option<u64>,
    running: bool,
) -> Result<ServerSnapshot, String> {
    let meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let config = load(paths, id)?;
    let server_root = root(paths, &meta);
    let mut log_tail = read_log(&server_root);
    if let Ok(text) = fs::read_to_string(log_path(paths, id)) {
        log_tail = text
            .lines()
            .rev()
            .take(500)
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
    }
    let players = players_from_logs(&log_tail);
    let metrics = metrics(pid, started, tps_from_logs(&log_tail));
    let eula_accepted = !regular_file(&server_root.join("eula.txt")) || eula_accepted(&server_root);
    Ok(ServerSnapshot {
        id: id.into(),
        config,
        root: server_root.to_string_lossy().into_owned(),
        eula_accepted,
        running,
        metrics,
        players,
        files: files(paths, id, None)?,
        log_tail,
    })
}

pub fn addons(paths: &Paths, id: &str) -> Result<Vec<ServerAddon>, String> {
    let meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let root = root(paths, &meta);
    ensure_directory(&root, "папка сервера")?;
    let config = load(paths, id)?;
    let dirs: Vec<&str> = if kernel_is(&config.kernel, &["fabric", "forge", "neoforge"]) {
        vec!["mods", "plugins"]
    } else {
        vec!["plugins", "mods"]
    };
    let mut out = Vec::new();
    for dir in dirs {
        let path = root.join(dir);
        if fs::symlink_metadata(&path)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                if entry
                    .file_type()
                    .map(|kind| kind.is_symlink())
                    .unwrap_or(true)
                {
                    continue;
                }
                let md = entry.metadata().ok();
                let file_name = entry.file_name().to_string_lossy().to_string();
                let is_jar = file_name.to_ascii_lowercase().ends_with(".jar")
                    || file_name.to_ascii_lowercase().ends_with(".jar.disabled");
                if md.as_ref().is_some_and(|m| m.is_file()) && is_jar {
                    out.push(ServerAddon {
                        name: file_name.clone(),
                        path: format!("{dir}/{file_name}"),
                        size: md.map(|m| m.len()).unwrap_or(0),
                        kind: dir.into(),
                        enabled: !file_name.to_ascii_lowercase().ends_with(".disabled"),
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub fn toggle_addon(paths: &Paths, id: &str, relative: &str) -> Result<ServerAddon, String> {
    let meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let base = root(paths, &meta);
    ensure_directory(&base, "папка сервера")?;
    let file = addon_path(&base, relative)?;
    if !file.is_file() {
        return Err("аддон не найден".into());
    }
    ensure_inside(&base, &file, "аддона")?;
    ensure_no_symlink_components(&base, &file, "аддона")?;
    let file_name = file
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("некорректное имя аддона")?;
    let lower_name = file_name.to_ascii_lowercase();
    let target_name = if lower_name.ends_with(".jar.disabled") {
        file_name[..file_name.len() - ".disabled".len()].to_string()
    } else if lower_name.ends_with(".jar") {
        format!("{file_name}.disabled")
    } else {
        return Err("переключать можно только JAR-аддоны".into());
    };
    let target = file.parent().unwrap_or(&base).join(target_name);
    ensure_not_symlink(&target, "аддон")?;
    if target.exists() {
        return Err("рядом уже есть включённая или выключенная копия аддона".into());
    }
    fs::rename(&file, &target).map_err(|e| e.to_string())?;
    let path = target
        .strip_prefix(root(paths, &meta))
        .unwrap_or(&target)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(ServerAddon {
        name: target
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        path,
        size: fs::metadata(&target).map(|m| m.len()).unwrap_or(0),
        kind: "addon".into(),
        enabled: !target.to_string_lossy().ends_with(".disabled"),
    })
}

pub fn delete_addon(paths: &Paths, id: &str, relative: &str) -> Result<(), String> {
    let meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let base = root(paths, &meta);
    ensure_directory(&base, "папка сервера")?;
    let file = addon_path(&base, relative)?;
    let lower = file
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !lower.ends_with(".jar") && !lower.ends_with(".jar.disabled") {
        return Err("удалять можно только JAR-аддоны".into());
    }
    ensure_inside(&base, &file, "аддона")?;
    ensure_no_symlink_components(&base, &file, "аддона")?;
    fs::remove_file(file).map_err(|e| e.to_string())
}

fn backup_dir(paths: &Paths, id: &str) -> Result<PathBuf, String> {
    let _meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let dir = paths.root.join("backups").join(id);
    ensure_not_symlink(&dir, "папка бэкапов")?;
    Ok(dir)
}

fn path_is_absent(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}

pub fn list_backups(paths: &Paths, id: &str) -> Result<Vec<BackupInfo>, String> {
    let dir = backup_dir(paths, id)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let md = entry.metadata().map_err(|e| e.to_string())?;
        if !md.is_file()
            || entry
                .path()
                .extension()
                .and_then(|v| v.to_str())
                .map(|v| !v.eq_ignore_ascii_case("zip"))
                .unwrap_or(true)
        {
            continue;
        }
        out.push(BackupInfo {
            name: entry.file_name().to_string_lossy().into(),
            path: entry.path().to_string_lossy().into(),
            size: md.len(),
            created: md
                .modified()
                .ok()
                .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
                .map(|v| v.as_secs())
                .unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

fn should_skip(rel: &str, lean: bool) -> bool {
    let lower = rel.to_ascii_lowercase();
    if lower.contains("/.git/")
        || lower.starts_with(".git/")
        || lower.ends_with("/session.lock")
        || lower == "session.lock"
        || lower.contains("/.omnispec-backups/")
    {
        return true;
    }
    lean && ["logs/", "crash-reports/", "libraries/", "versions/"]
        .iter()
        .any(|name| lower.starts_with(name) || lower.contains(&format!("/{name}")))
}

fn add_zip_dir(
    writer: &mut zip::ZipWriter<File>,
    root: &Path,
    current: &Path,
    lean: bool,
    count: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if should_skip(&rel, lean) {
            continue;
        }
        let md = entry.metadata().map_err(|e| e.to_string())?;
        if md.is_dir() {
            add_zip_dir(writer, root, &path, lean, count, bytes)?;
        } else if md.is_file() {
            if *count >= MAX_BACKUP_ENTRIES
                || md.len() > MAX_BACKUP_BYTES
                || *bytes > MAX_BACKUP_BYTES.saturating_sub(md.len())
            {
                return Err("папка слишком большая для этого бэкапа".into());
            }
            let mut file = File::open(&path).map_err(|e| e.to_string())?;
            writer
                .start_file(&rel, options)
                .map_err(|e| e.to_string())?;
            let copied = std::io::copy(&mut file, writer).map_err(|e| e.to_string())?;
            if copied > MAX_BACKUP_BYTES.saturating_sub(*bytes) {
                return Err("папка слишком большая для этого бэкапа".into());
            }
            *bytes += copied;
            *count += 1;
        }
    }
    Ok(())
}

pub fn create_backup(
    paths: &Paths,
    id: &str,
    label: Option<&str>,
    lean: bool,
) -> Result<BackupInfo, String> {
    let meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let source = root(paths, &meta);
    ensure_directory(&source, "папка сервера")?;
    let dest = backup_dir(paths, id)?;
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    ensure_directory(&dest, "папка бэкапов")?;
    let safe = slugify(label.filter(|v| !v.trim().is_empty()).unwrap_or("server"));
    let stamp = now();
    let mut serial = 0_u32;
    let (file, tmp) = loop {
        let suffix = if serial == 0 {
            stamp.to_string()
        } else {
            format!("{stamp}_{serial}")
        };
        let file = dest.join(format!("{safe}_{suffix}.zip"));
        let tmp = file.with_extension("zip.part");
        if path_is_absent(&file)? && path_is_absent(&tmp)? {
            break (file, tmp);
        }
        serial = serial.saturating_add(1);
    };
    let handle = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    let mut writer = zip::ZipWriter::new(handle);
    let mut count = 0;
    let mut bytes = 0;
    if let Err(error) = add_zip_dir(&mut writer, &source, &source, lean, &mut count, &mut bytes) {
        let _ = writer.finish();
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(error) = writer.finish() {
        let _ = fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    let size = fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    Ok(BackupInfo {
        name: file
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        path: file.to_string_lossy().into(),
        size,
        created: now(),
    })
}

pub fn delete_backup(paths: &Paths, id: &str, name: &str) -> Result<(), String> {
    let base = backup_dir(paths, id)?;
    let file = safe_relative(&base, name, "бэкапа")?;
    if file
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("zip"))
        .unwrap_or(true)
    {
        return Err("разрешены только ZIP-бэкапы".into());
    }
    ensure_not_symlink(&file, "файл бэкапа")?;
    fs::remove_file(file).map_err(|e| e.to_string())
}

pub fn restore_backup(paths: &Paths, id: &str, name: &str) -> Result<(), String> {
    let backup_dir = backup_dir(paths, id)?;
    let path = safe_relative(&backup_dir, name, "бэкапа")?;
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("zip"))
        .unwrap_or(true)
    {
        return Err("разрешены только ZIP-бэкапы".into());
    }
    ensure_not_symlink(&path, "файл бэкапа")?;
    let meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let dest = root(paths, &meta);
    ensure_directory(&dest, "папка сервера")?;
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut restored_bytes = 0_u64;
    if archive.len() > MAX_BACKUP_ENTRIES {
        return Err("архив содержит слишком много файлов".into());
    }
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let Some(enclosed) = entry.enclosed_name().map(|v| v.to_owned()) else {
            continue;
        };
        let target = dest.join(enclosed);
        ensure_no_symlink_components(&dest, &target, "архива")?;
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            ensure_inside(&dest, &target, "архива")?;
            continue;
        }
        let declared = entry.size();
        if declared > MAX_BACKUP_BYTES || restored_bytes > MAX_BACKUP_BYTES.saturating_sub(declared)
        {
            return Err("архив слишком большой для восстановления".into());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            ensure_inside(&dest, parent, "архива")?;
            ensure_no_symlink_components(&dest, parent, "архива")?;
        }
        ensure_not_symlink(&target, "файл архива")?;
        let mut output = File::create(&target).map_err(|e| e.to_string())?;
        let copied = std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
        if copied > MAX_BACKUP_BYTES.saturating_sub(restored_bytes) {
            return Err("архив слишком большой для восстановления".into());
        }
        restored_bytes += copied;
    }
    Ok(())
}

pub fn sync_to(
    paths: &Paths,
    id: &str,
    destination: &str,
    direction: &str,
) -> Result<Value, String> {
    let meta = instances::load(paths, id).map_err(|e| e.to_string())?;
    let server = root(paths, &meta);
    ensure_directory(&server, "папка сервера")?;
    let other = PathBuf::from(destination);
    if !other.is_absolute() {
        return Err("папка синхронизации должна быть абсолютной".into());
    }
    if !matches!(direction, "push" | "pull") {
        return Err("неизвестное направление синхронизации".into());
    }
    ensure_not_symlink(&other, "папка синхронизации")?;
    let (from, to) = if direction == "pull" {
        (&other, &server)
    } else {
        (&server, &other)
    };
    if !from.is_dir() {
        return Err("исходная папка синхронизации не найдена".into());
    }
    let canonical_from = from.canonicalize().map_err(|e| e.to_string())?;
    let canonical_to_parent = to
        .parent()
        .unwrap_or(to)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target_name = to.file_name().ok_or("недопустимая папка синхронизации")?;
    let canonical_to = canonical_to_parent.join(target_name);
    if canonical_from == canonical_to || canonical_to.starts_with(&canonical_from) {
        return Err("папка синхронизации не может быть внутри исходной папки".into());
    }
    copy_tree(from, to)?;
    Ok(json!({"from": from, "to": to, "synced_at": now()}))
}

pub async fn scan(roots: Vec<String>) -> Result<Vec<ServerCandidate>, String> {
    let roots = if roots.is_empty() {
        vec![std::env::current_dir()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into()]
    } else {
        roots
    };
    let mut queue: Vec<(PathBuf, usize)> = roots
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .map(|p| (p, 0))
        .collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    while let Some((dir, depth)) = queue.pop() {
        if out.len() >= MAX_SCAN_DIRS || !seen.insert(dir.clone()) {
            continue;
        }
        let config = config_from_folder(&dir);
        let has_server = regular_file(&dir.join("server.properties"))
            || regular_file(&dir.join("eula.txt"))
            || find_jar(&dir, &config.kernel).is_some()
            || ["start.bat", "start.sh", "run.bat", "run.sh"]
                .iter()
                .any(|f| regular_file(&dir.join(f)));
        if has_server {
            out.push(ServerCandidate {
                path: dir.to_string_lossy().into(),
                name: dir.file_name().unwrap_or_default().to_string_lossy().into(),
                kernel: config.kernel,
                mc_version: config.mc_version,
                jar: config.jar,
                command: config.command,
                port: Some(config.port),
                has_icon: regular_file(&dir.join("server-icon.png")),
            });
            continue;
        }
        if depth >= MAX_SCAN_DEPTH {
            continue;
        }
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                    if ![
                        ".git",
                        "node_modules",
                        "logs",
                        "libraries",
                        "versions",
                        "world",
                        "world_nether",
                        "world_the_end",
                    ]
                    .contains(&name.as_str())
                    {
                        queue.push((entry.path(), depth + 1));
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub fn split_command(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote = None;
    for ch in command.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => cur.push(ch),
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            None => cur.push(ch),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

pub fn command_line(config: &ServerConfig) -> Result<(String, Vec<String>), String> {
    if let Some(command) = config.command.as_ref().filter(|v| !v.trim().is_empty()) {
        let args = split_command(command);
        if args.is_empty() {
            return Err("команда сервера пустая".into());
        }
        return Ok((args[0].clone(), args[1..].to_vec()));
    }
    let jar = config
        .jar
        .as_ref()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "у сервера не найдено ядро .jar".to_string())?;
    let java = config.java_path.clone().unwrap_or_else(|| "java".into());
    Ok((
        java,
        vec![
            format!("-Xmx{}M", config.memory_mb.clamp(512, 65536)),
            "-Xms512M".into(),
            "-jar".into(),
            jar.clone(),
            "nogui".into(),
        ],
    ))
}

pub fn log_path(paths: &Paths, id: &str) -> PathBuf {
    paths.logs().join("servers").join(format!("{id}.log"))
}

pub fn append_log(paths: &Paths, id: &str, line: &str) {
    let file = log_path(paths, id);
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut output) = fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(output, "{line}");
    }
}

pub async fn send_command(
    stdin: &mut tokio::process::ChildStdin,
    command: &str,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    stdin
        .write_all(command.trim_end().as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_parser_preserves_quoted_paths() {
        assert_eq!(
            split_command("java -jar \"server files/paper.jar\" nogui"),
            vec!["java", "-jar", "server files/paper.jar", "nogui"]
        );
    }

    #[test]
    fn server_marker_is_not_a_build() {
        let root = std::env::temp_dir().join(format!("omnispec-server-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        instances::create(
            &paths,
            CreateInstanceRequest {
                name: "Server".into(),
                mc_version: "1.21.4".into(),
                loader: Loader::Vanilla,
                icon: None,
                notes: String::new(),
                source: Some("server".into()),
                source_url: None,
                id: Some("srv".into()),
                category: None,
                memory_mb: None,
                java_path: None,
                game_dir: None,
            },
        )
        .unwrap();
        fs::write(
            marker(&paths, "srv"),
            serde_json::to_vec(&ServerConfig::default()).unwrap(),
        )
        .unwrap();
        assert!(is_server(&paths, "srv"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn server_paths_and_eula_are_strict() {
        assert!(safe_relative(Path::new("/tmp/server"), "mods/example.jar", "аддона").is_ok());
        assert!(safe_relative(Path::new("/tmp/server"), "../outside.jar", "аддона").is_err());
        assert!(addon_path(Path::new("/tmp/server"), "mods/example.jar").is_ok());
        assert!(addon_path(Path::new("/tmp/server"), "paper.jar").is_err());

        let root = std::env::temp_dir().join(format!("omnispec-eula-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("eula.txt"), "# comment\nEULA = true\n").unwrap();
        assert!(eula_accepted(&root));
        fs::write(root.join("eula.txt"), "eula=false\n").unwrap();
        assert!(!eula_accepted(&root));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn default_jar_command_honours_java_path() {
        let config = ServerConfig {
            jar: Some("paper.jar".into()),
            java_path: Some("/custom/java".into()),
            command: None,
            ..ServerConfig::default()
        };
        assert_eq!(command_line(&config).unwrap().0, "/custom/java");
    }
}
