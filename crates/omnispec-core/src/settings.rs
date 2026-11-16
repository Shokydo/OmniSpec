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
fn default_theme() -> String {
    "dark".to_string()
}

fn default_update_auto() -> bool {
    true
}

fn default_ui_scale() -> u32 {
    100
}

fn default_feed_grid() -> u8 {
    2
}

/// Размер частиц эффектов в процентах.
fn default_effect_size() -> u8 {
    100
}

fn default_true_trail() -> bool {
    true
}

/// Размер кисти трейса в процентах: по умолчанию искры — тонкие.
fn default_trail_size() -> u8 {
    50
}

/// Вариант трейса за курсором: при первом запуске — искры.
fn default_trail_style() -> String {
    "sparks".to_string()
}

/// Длина следа трейса в процентах: короткий хвост.
fn default_trail_length() -> u8 {
    20
}

/// Плотность частиц на экране в процентах.
fn default_ambient_density() -> u8 {
    100
}

/// Прозрачность трейса в процентах: еле заметный след.
fn default_trail_opacity() -> u8 {
    15
}

/// Прозрачность частиц на экране в процентах.
fn default_ambient_opacity() -> u8 {
    80
}

fn default_ambient() -> String {
    "stars".to_string()
}

fn default_sound_style() -> String {
    "soft".to_string()
}

fn default_click_fx() -> String {
    "wave".to_string()
}

fn default_wallpaper_fit() -> String {
    "cover".to_string()
}

/// Форма элементов интерфейса — как «ФОРМА ЭЛЕМЕНТОВ» в OmniPanel.
fn default_shape() -> String {
    "soft".to_string()
}

fn default_sound_volume() -> u8 {
    60
}

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
    /// Отдельный путь к старой Java 8 — она нужна версиям игры до 1.17.
    pub java_path_legacy: Option<String>,
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

    /* ---------- сеть ---------- */
    /// Прокси для запросов к Modrinth/Mojang: `http://host:port` или `socks5://…`.
    pub proxy: Option<String>,

    /// Свой client id Azure для входа через Microsoft (пусто — публичный ID лаунчера).
    pub ms_client_id: Option<String>,

    /* ---------- оформление ---------- */
    /// Обои: имя встроенных (`grid`, `aurora`, …) или путь к своему файлу.
    pub wallpaper: Option<String>,
    /// Как показывать обои: cover | contain | fill | tile.
    pub wallpaper_fit: String,
    /// Размытие обоев, 0–20.
    pub wallpaper_blur: u8,
    /// Затемнение обоев под интерфейсом, 0–80 %.
    pub wallpaper_dim: u8,
    /// История обоев: последние выбранные, свежие — в начале.
    pub wallpaper_recent: Vec<String>,

    /* ---------- автообновление ---------- */
    /// Репозиторий GitHub с релизами: «владелец/репозиторий».
    pub update_repo: Option<String>,
    /// Проверять обновления при запуске лаунчера.
    pub update_enabled: bool,
    /// Ставить найденное обновление при запуске сразу, без лишних кликов.
    #[serde(default = "default_update_auto")]
    pub update_auto: bool,
    /// Токен GitHub — нужен только для приватного репозитория.
    pub update_token: Option<String>,
    /// Учитывать бета-версии (prerelease).
    pub update_prerelease: bool,

    /* ---------- оформление ---------- */
    /// Форма элементов: square | soft | rounded | pill (как в OmniPanel).
    #[serde(default = "default_shape")]
    pub shape: String,
    /// Свой фон: имя файла в <данные>/wallpapers.
    #[serde(default)]
    pub custom_wallpaper: Option<String>,
    /// Звуковые эффекты интерфейса.
    #[serde(default = "default_true")]
    pub sound_fx: bool,
    /// Громкость этих звуков, 0–100.
    #[serde(default = "default_sound_volume")]
    pub sound_volume: u8,

    /// Категории (папки) сборок в списке слева.
    #[serde(default)]
    pub categories: Vec<Category>,

    /// Сохранённые пользователем пресеты скина.
    #[serde(default)]
    pub skin_presets: Vec<SkinPreset>,

    /// Тема интерфейса (id пресета из OmniPanel: dark, navy, light, … + custom).
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Своя тема: цвет фона (только для theme = "custom").
    #[serde(default)]
    pub theme_bg: Option<String>,
    /// Своя тема: цвет акцента.
    #[serde(default)]
    pub theme_accent: Option<String>,
    /// Своя тема: цвет текста.
    #[serde(default)]
    pub theme_text: Option<String>,
    /// Эффект от клика: wave | dot | ring | cross | off.
    #[serde(default = "default_click_fx")]
    pub click_fx: String,
    /// Масштаб интерфейса в процентах: 80, 90, 100, 110, 125, 150.
    #[serde(default = "default_ui_scale")]
    pub ui_scale: u32,
    /// Фоновая анимация: stars | dust | sticks | snow | off.
    #[serde(default = "default_ambient")]
    pub ambient: String,
    /// Вариант звука интерфейса: soft | classic | glass | wood | deep.
    #[serde(default = "default_sound_style")]
    pub sound_style: String,
    /// Размер плиток в «Готовых сборках»: 1 — 12 в ряд, 2 — 9, 3 — 6.
    #[serde(default = "default_feed_grid")]
    pub feed_grid: u8,
    /// Размер эффектов в процентах: 60–220.
    #[serde(default = "default_effect_size")]
    pub effect_size: u8,
    /// Трейс за курсором.
    #[serde(default = "default_true_trail")]
    pub trail: bool,
    /// Размер кисти трейса в процентах: 40–300.
    #[serde(default = "default_trail_size")]
    pub trail_size: u8,
    /// Вариант трейса: line | brush | glow | sparks.
    #[serde(default = "default_trail_style")]
    pub trail_style: String,
    /// Длина следа трейса в процентах: 40–300.
    #[serde(default = "default_trail_length")]
    pub trail_length: u8,
    /// Плотность частиц на экране: 30–200 %.
    #[serde(default = "default_ambient_density")]
    pub ambient_density: u8,
    /// Прозрачность трейса: 5–100 %.
    #[serde(default = "default_trail_opacity")]
    pub trail_opacity: u8,
    /// Свой цвет трейса (`#rrggbb`), `None` — как в теме.
    #[serde(default)]
    pub trail_color: Option<String>,
    /// Прозрачность частиц на экране: 5–100 %.
    #[serde(default = "default_ambient_opacity")]
    pub ambient_opacity: u8,
    /// Свой цвет частиц (`#rrggbb`), `None` — как в теме.
    #[serde(default)]
    pub ambient_color: Option<String>,
}

/// Категория сборок: обычная «папка» в списке слева.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Category {
    pub id: String,
    pub name: String,
    /// Свёрнута ли папка в списке.
    #[serde(default)]
    pub collapsed: bool,
}

/// Пресет скина: палитра + модель, чтобы пресетов могло быть сколько угодно.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SkinPreset {
    pub id: String,
    pub name: String,
    /// PNG скина, скопированный в папку лаунчера: пресет не зависит от исходника.
    #[serde(default)]
    pub path: String,
    /// classic (wide) | slim.
    #[serde(default)]
    pub variant: String,
    /// Угол поворота превью, −180…180.
    #[serde(default)]
    pub angle: i32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            username: default_username(),
            java_path: None,
            java_path_legacy: None,
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
            proxy: None,
            ms_client_id: None,
            wallpaper: None,
            wallpaper_fit: default_wallpaper_fit(),
            wallpaper_blur: 0,
            wallpaper_dim: 40,
            wallpaper_recent: Vec::new(),
            update_repo: default_update_repo(),
            update_enabled: true,
            update_auto: true,
            update_token: None,
            update_prerelease: false,
            shape: default_shape(),
            custom_wallpaper: None,
            sound_fx: true,
            sound_volume: default_sound_volume(),
            categories: Vec::new(),
            skin_presets: Vec::new(),
            theme: default_theme(),
            theme_bg: None,
            theme_accent: None,
            theme_text: None,
            click_fx: default_click_fx(),
            ui_scale: default_ui_scale(),
            ambient: default_ambient(),
            sound_style: default_sound_style(),
            feed_grid: default_feed_grid(),
            effect_size: default_effect_size(),
            trail: default_true_trail(),
            trail_size: default_trail_size(),
            trail_style: default_trail_style(),
            trail_length: default_trail_length(),
            ambient_density: default_ambient_density(),
            trail_opacity: default_trail_opacity(),
            trail_color: None,
            ambient_opacity: default_ambient_opacity(),
            ambient_color: None,
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
