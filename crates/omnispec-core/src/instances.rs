//! Сборки (инстансы). Каждая сборка — папка `instances/<id>/` со своим
//! `instance.json` и изолированной игровой папкой `minecraft/`, ровно как в Prism.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::paths::{slugify, Paths};

/// Загрузчик сборки.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Loader {
    Vanilla,
    Fabric { version: String },
    Quilt { version: String },
    Forge { version: String },
    NeoForge { version: String },
}

impl Default for Loader {
    fn default() -> Self {
        Loader::Vanilla
    }
}

impl Loader {
    pub fn kind(&self) -> &'static str {
        match self {
            Loader::Vanilla => "vanilla",
            Loader::Fabric { .. } => "fabric",
            Loader::Quilt { .. } => "quilt",
            Loader::Forge { .. } => "forge",
            Loader::NeoForge { .. } => "neoforge",
        }
    }

    pub fn label(&self) -> String {
        match self {
            Loader::Vanilla => "Vanilla".into(),
            Loader::Fabric { version } => format!("Fabric {version}"),
            Loader::Quilt { version } => format!("Quilt {version}"),
            Loader::Forge { version } => format!("Forge {version}"),
            Loader::NeoForge { version } => format!("NeoForge {version}"),
        }
    }

    pub fn version(&self) -> Option<&str> {
        match self {
            Loader::Vanilla => None,
            Loader::Fabric { version }
            | Loader::Quilt { version }
            | Loader::Forge { version }
            | Loader::NeoForge { version } => Some(version),
        }
    }

    pub fn needs_mods(&self) -> bool {
        !matches!(self, Loader::Vanilla)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceMeta {
    pub id: String,
    pub name: String,
    /// Версия Minecraft, например "1.21.4".
    pub mc_version: String,
    #[serde(default)]
    pub loader: Loader,
    /// Unix-время создания.
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub last_played: Option<u64>,
    #[serde(default)]
    pub playtime_secs: u64,
    /// Переопределение памяти для этой сборки.
    #[serde(default)]
    pub memory_mb: Option<u32>,
    /// Переопределение пути к Java.
    #[serde(default)]
    pub java_path: Option<String>,
    /// Переопределение JVM-аргументов.
    #[serde(default)]
    pub jvm_args: Option<String>,
    /// Иконка: путь к png внутри сборки либо имя встроенной иконки.
    #[serde(default)]
    pub icon: Option<String>,
    /// Описание/заметка.
    #[serde(default)]
    pub notes: String,
    /// id версии, созданной инсталлятором загрузчика (если он назвал папку иначе).
    #[serde(default)]
    pub version_override: Option<String>,
    /// Откуда пришла сборка: "manual" | "modrinth" | "import".
    #[serde(default)]
    pub source: String,
    /// Ссылка на страницу модпака (если импортирована с Modrinth).
    #[serde(default)]
    pub source_url: Option<String>,
    /// Категория (папка) в списке слева.
    #[serde(default)]
    pub category: Option<String>,
}

impl InstanceMeta {
    /// id версии в `meta/versions`, которую надо ставить и запускать.
    pub fn version_id(&self) -> String {
        if let Some(override_id) = self
            .version_override
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            return override_id.clone();
        }
        match &self.loader {
            Loader::Vanilla => self.mc_version.clone(),
            Loader::Fabric { version } => format!("fabric-loader-{}-{}", version, self.mc_version),
            Loader::Quilt { version } => format!("quilt-loader-{}-{}", version, self.mc_version),
            Loader::Forge { version } => format!("forge-{}-{}", self.mc_version, version),
            Loader::NeoForge { version } => format!("neoforge-{}-{}", self.mc_version, version),
        }
    }

    pub fn memory_or(&self, default_mb: u32) -> u32 {
        self.memory_mb.unwrap_or(default_mb).clamp(512, 65536)
    }
}

/// Запрос на создание сборки.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateInstanceRequest {
    pub name: String,
    pub mc_version: String,
    #[serde(default)]
    pub loader: Loader,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    /// Готовое имя папки (при импорте модпака), иначе генерируется из названия.
    #[serde(default)]
    pub id: Option<String>,
    /// Категория, в которую положить сборку.
    #[serde(default)]
    pub category: Option<String>,
}

/// Все сборки, отсортированные по времени последнего запуска.
pub fn list(paths: &Paths) -> Result<Vec<InstanceMeta>> {
    let mut result = Vec::new();
    let dir = paths.instances();
    if !dir.exists() {
        return Ok(result);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let file = entry.path().join("instance.json");
        if !file.exists() {
            continue;
        }
        match read_meta(&file) {
            Ok(meta) => result.push(meta),
            Err(err) => eprintln!(
                "[omnispec] сборка {} пропущена: {err}",
                entry.path().display()
            ),
        }
    }
    result.sort_by(|a, b| {
        let a_key = (a.last_played.unwrap_or(0), a.created);
        let b_key = (b.last_played.unwrap_or(0), b.created);
        b_key.cmp(&a_key)
    });
    Ok(result)
}

fn read_meta(file: &Path) -> Result<InstanceMeta> {
    let text = std::fs::read_to_string(file)?;
    let meta: InstanceMeta = serde_json::from_str(&text)?;
    Ok(meta)
}

pub fn load(paths: &Paths, id: &str) -> Result<InstanceMeta> {
    let file = paths.instance_file(id);
    if !file.exists() {
        return Err(Error::not_found(format!("сборка «{id}» не найдена")));
    }
    read_meta(&file)
}

pub fn save(paths: &Paths, meta: &InstanceMeta) -> Result<()> {
    let file = paths.instance_file(&meta.id);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Время игры и дату последнего запуска только накапливаем: любая запись
    // настроек со старым снимком меты не должна откатывать статистику.
    let mut meta = meta.clone();
    if let Ok(disk) = load(paths, &meta.id) {
        meta.playtime_secs = meta.playtime_secs.max(disk.playtime_secs);
        meta.last_played = match (meta.last_played, disk.last_played) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }
    std::fs::write(file, serde_json::to_string_pretty(&meta)?)?;
    Ok(())
}

/// Создать структуру папок сборки, как это делает Prism.
pub fn create(paths: &Paths, request: CreateInstanceRequest) -> Result<InstanceMeta> {
    let name = request.name.trim().to_string();
    if name.is_empty() {
        return Err(Error::Other("укажите название сборки".into()));
    }
    if request.mc_version.trim().is_empty() {
        return Err(Error::Other("укажите версию Minecraft".into()));
    }

    let base_id = match &request.id {
        Some(id) if !id.trim().is_empty() => slugify(id),
        _ => slugify(&name),
    };
    let id = unique_id(paths, &base_id);

    let meta = InstanceMeta {
        id: id.clone(),
        name,
        mc_version: request.mc_version.trim().to_string(),
        loader: request.loader,
        created: now_unix(),
        last_played: None,
        playtime_secs: 0,
        memory_mb: None,
        java_path: None,
        jvm_args: None,
        icon: request.icon,
        version_override: None,
        notes: request.notes,
        source: request.source.unwrap_or_else(|| "manual".into()),
        source_url: request.source_url,
        category: request.category,
    };

    let dir = paths.instance_dir(&id);
    std::fs::create_dir_all(&dir)?;
    for sub in [
        "minecraft",
        "minecraft/mods",
        "minecraft/resourcepacks",
        "minecraft/shaderpacks",
        "minecraft/saves",
        "minecraft/config",
        "minecraft/logs",
        "minecraft/screenshots",
    ] {
        std::fs::create_dir_all(dir.join(sub))?;
    }
    save(paths, &meta)?;
    Ok(meta)
}

fn unique_id(paths: &Paths, base: &str) -> String {
    if !paths.instance_dir(base).exists() {
        return base.to_string();
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !paths.instance_dir(&candidate).exists() {
            return candidate;
        }
    }
    format!("{base}-{}", now_unix())
}

/// Удалить сборку вместе с мирами и модами.
pub fn delete(paths: &Paths, id: &str) -> Result<()> {
    let dir = paths.instance_dir(id);
    if !dir.exists() {
        return Err(Error::not_found(format!("сборка «{id}» не найдена")));
    }
    std::fs::remove_dir_all(dir)?;
    Ok(())
}

/// Отметить запуск (для сортировки «недавние» и статистики).
pub fn touch_play(paths: &Paths, id: &str) -> Result<()> {
    let mut meta = load(paths, id)?;
    meta.last_played = Some(now_unix());
    save(paths, &meta)
}

pub fn add_playtime(paths: &Paths, id: &str, secs: u64) {
    if let Ok(mut meta) = load(paths, id) {
        meta.playtime_secs = meta.playtime_secs.saturating_add(secs);
        let _ = save(paths, &meta);
    }
}

pub fn game_dir(paths: &Paths, id: &str) -> PathBuf {
    paths.instance_game_dir(id)
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Человекочитаемый размер файла.
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} {}", UNITS[unit])
    } else {
        format!("{size:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playtime_never_goes_back() {
        let root = std::env::temp_dir().join(format!("omnispec-playtime-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        let mut meta = InstanceMeta {
            id: "pt".into(),
            name: "Playtime".into(),
            mc_version: "1.21.4".into(),
            loader: Loader::Vanilla,
            created: 0,
            last_played: Some(100),
            playtime_secs: 3600,
            memory_mb: None,
            java_path: None,
            jvm_args: None,
            icon: None,
            version_override: None,
            notes: String::new(),
            source: "manual".into(),
            source_url: None,
            category: None,
        };
        save(&paths, &meta).unwrap();
        add_playtime(&paths, "pt", 600);
        assert_eq!(load(&paths, "pt").unwrap().playtime_secs, 4200);
        // устаревший снимок из интерфейса не должен откатывать статистику
        meta.playtime_secs = 0;
        meta.last_played = None;
        save(&paths, &meta).unwrap();
        let disk = load(&paths, "pt").unwrap();
        assert_eq!(disk.playtime_secs, 4200);
        assert_eq!(disk.last_played, Some(100));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn loader_version_ids() {
        let meta = InstanceMeta {
            id: "test".into(),
            name: "Test".into(),
            mc_version: "1.21.4".into(),
            loader: Loader::Fabric {
                version: "0.16.9".into(),
            },
            created: 0,
            last_played: None,
            playtime_secs: 0,
            memory_mb: None,
            java_path: None,
            jvm_args: None,
            icon: None,
            version_override: None,
            notes: String::new(),
            source: "manual".into(),
            source_url: None,
            category: None,
        };
        assert_eq!(meta.version_id(), "fabric-loader-0.16.9-1.21.4");
    }

    /// Категория сборки переживает запись и чтение instance.json.
    #[test]
    fn instance_category_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("omnispec-cat-test-{}", std::process::id()));
        let paths = Paths::new(tmp).unwrap();
        let mut meta = create(
            &paths,
            CreateInstanceRequest {
                name: "С категорией".into(),
                mc_version: "1.21.4".into(),
                loader: Loader::Vanilla,
                icon: None,
                notes: String::new(),
                source: None,
                source_url: None,
                id: None,
                category: Some("cat-perf".into()),
            },
        )
        .unwrap();
        assert_eq!(meta.category.as_deref(), Some("cat-perf"));
        meta.category = None;
        save(&paths, &meta).unwrap();
        assert!(load(&paths, &meta.id).unwrap().category.is_none());
        delete(&paths, &meta.id).unwrap();
        std::fs::remove_dir_all(&paths.root).ok();
    }

    #[test]
    fn create_and_list_instances() {
        let tmp = std::env::temp_dir().join(format!("omnispec-test-{}", std::process::id()));
        let paths = Paths::new(tmp).unwrap();
        let meta = create(
            &paths,
            CreateInstanceRequest {
                name: "Моя сборка".into(),
                mc_version: "1.21.4".into(),
                loader: Loader::Vanilla,
                icon: None,
                notes: String::new(),
                source: None,
                source_url: None,
                id: None,
                category: None,
            },
        )
        .unwrap();
        assert_eq!(meta.id, "moya-sborka");
        assert!(paths.instance_game_dir(&meta.id).join("mods").exists());
        assert_eq!(list(&paths).unwrap().len(), 1);
        delete(&paths, &meta.id).unwrap();
        assert!(list(&paths).unwrap().is_empty());
        std::fs::remove_dir_all(&paths.root).ok();
    }
}
