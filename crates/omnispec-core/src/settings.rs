//! Глобальные настройки лаунчера: `settings.json` в корне данных.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::paths::Paths;

fn default_username() -> String {
    "Player".into()
}
fn default_memory() -> u32 {
    4096
}
fn default_jvm_args() -> String {
    "-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=20 -XX:G1MaxNewSizePercent=40 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=16M".into()
}
fn default_game_args() -> String {
    String::new()
}
fn default_language() -> String {
    "ru".into()
}
fn default_true() -> bool {
    true
}
/// Репозиторий обновлений по умолчанию.
fn default_update_repo() -> Option<String> {
    Some("Shokydo/OmniSpec".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Ник офлайн-аккаунта по умолчанию.
    pub username: String,
    /// Путь к java(.exe). `None` — искать автоматически.
    pub java_path: Option<String>,
    /// Выделенная память по умолчанию, МБ.
    pub memory_mb: u32,
    /// Дополнительные JVM-аргументы (как в Prism: «JVM arguments»).
    pub jvm_args: String,
    /// Дополнительные аргументы игре.
    pub game_args: String,
    /// Если Java не найдена — скачать рантайм с серверов Mojang.
    pub auto_java: bool,
    /// Показывать снапшоты в списке версий.
    pub show_snapshots: bool,
    /// Дополнительно: полная проверка SHA1 при установке (медленнее).
    pub verify_hashes: bool,
    /// Язык интерфейса.
    pub language: String,
    /// Оставлять окно консоли открытым после выхода из игры.
    pub keep_console_open: bool,
    /// Загружать моды только с Modrinth (CurseForge выключен).
    pub enable_modrinth: bool,
    /// Показывать окно лаунчера после запуска игры (обычно нет).
    pub hide_on_launch: bool,
    /// Последняя выбранная сборка.
    pub last_instance: Option<String>,

    /* ---------- автообновление ---------- */
    /// Репозиторий GitHub с релизами: «владелец/репозиторий».
    pub update_repo: Option<String>,
    /// Проверять обновления при запуске лаунчера.
    pub update_enabled: bool,
    /// Токен GitHub — нужен только для приватного репозитория.
    pub update_token: Option<String>,
    /// Учитывать бета-версии (prerelease).
    pub update_prerelease: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            username: default_username(),
            java_path: None,
            memory_mb: default_memory(),
            jvm_args: default_jvm_args(),
            game_args: default_game_args(),
            auto_java: true,
            show_snapshots: false,
            verify_hashes: false,
            language: default_language(),
            keep_console_open: false,
            enable_modrinth: default_true(),
            hide_on_launch: false,
            last_instance: None,
            update_repo: default_update_repo(),
            update_enabled: true,
            update_token: None,
            update_prerelease: false,
        }
    }
}

impl Settings {
    pub fn load(paths: &Paths) -> Result<Self> {
        let file = paths.settings_file();
        Self::load_from(&file)
    }

    pub fn load_from(file: &Path) -> Result<Self> {
        if !file.exists() {
            let settings = Self::default();
            settings.save_to(file)?;
            return Ok(settings);
        }
        let text = std::fs::read_to_string(file)?;
        match serenity_parse(&text) {
            Ok(settings) => Ok(settings),
            Err(err) => {
                // Битый файл не должен блокировать запуск лаунчера.
                eprintln!("[omnispec] не удалось прочитать settings.json: {err}");
                Ok(Self::default())
            }
        }
    }

    pub fn save(&self, paths: &Paths) -> Result<()> {
        self.save_to(&paths.settings_file())
    }

    pub fn save_to(&self, file: &Path) -> Result<()> {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(file, text)?;
        Ok(())
    }

    /// Память с защитой от опечаток.
    pub fn memory_clamped(&self) -> u32 {
        self.memory_mb.clamp(512, 65536)
    }

    /// Конфигурация автообновления (None — репозиторий не задан).
    pub fn update_config(&self) -> Option<crate::update::UpdateConfig> {
        let mut config = crate::update::UpdateConfig::from_slug(self.update_repo.as_deref()?)?;
        config.token = self
            .update_token
            .clone()
            .filter(|token| !token.trim().is_empty());
        config.include_prerelease = self.update_prerelease;
        Some(config)
    }

    pub fn java_path(&self) -> Option<&str> {
        self.java_path.as_deref().filter(|p| !p.trim().is_empty())
    }
}

fn serenity_parse(text: &str) -> Result<Settings> {
    serde_json::from_str::<Settings>(text).map_err(Error::from)
}
