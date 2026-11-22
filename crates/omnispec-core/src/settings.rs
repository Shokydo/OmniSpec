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
/// Дефолтные JVM-флаги — набор официального лаунчера Minecraft
/// (G1GC, настроенный Mojang): меньше статтеров, чем у «голого» JVM.
fn default_jvm_args() -> String {
    "-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M".into()
}

/// Старый дефолт JVM-флагов: у кого он остался нетронутым — подтягиваем новый.
const OLD_JVM_ARGS: &str = "-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=20 -XX:G1MaxNewSizePercent=40 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=16M";
fn default_game_args() -> String {
    String::new()
}
fn default_language() -> String {
    "ru".into()
}
fn default_true() -> bool {
    true
}

/// Сворачивать окно в область уведомлений нужно включать явно.
/// Старые settings.json без этого поля остаются с обычным сворачиванием.
fn default_minimize_to_tray() -> bool {
    false
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

fn default_initial_tab() -> String {
    "console".to_string()
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

/// Вид гардероба плащей: центральный список или сетка плиток.
fn default_cape_view() -> String {
    "list".to_string()
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

/// Встроенные иконки лаунчера. Неизвестный вариант из будущего settings.json
/// безопасно возвращает исходную иконку, не сбрасывая остальные настройки.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LauncherIcon {
    Ru,
    By,
    Kz,
    Ua,
    Us,
    #[serde(rename = "icon_star_boom")]
    StarBoom,
    #[serde(rename = "icon_star_eye")]
    StarEye,
    #[default]
    #[serde(other)]
    Default,
}

impl LauncherIcon {
    /// Команда изменения принимает только известные идентификаторы.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "ru" => Some(Self::Ru),
            "by" => Some(Self::By),
            "kz" => Some(Self::Kz),
            "ua" => Some(Self::Ua),
            "us" => Some(Self::Us),
            "icon_star_boom" => Some(Self::StarBoom),
            "icon_star_eye" => Some(Self::StarEye),
            "default" => Some(Self::Default),
            _ => None,
        }
    }
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
    /// По кнопке сворачивания прятать окно в системный трей, не завершая приложение.
    /// Кнопка закрытия окна всегда завершает приложение.
    #[serde(default = "default_minimize_to_tray")]
    pub minimize_to_tray: bool,
    /// Последняя выбранная сборка.
    pub last_instance: Option<String>,

    /* ---------- сеть ---------- */
    /// Прокси для запросов к Modrinth/Mojang: `http://host:port` или `socks5://…`.
    pub proxy: Option<String>,

    /// Свой client id Azure для входа через Microsoft (пусто — публичный ID лаунчера).
    pub ms_client_id: Option<String>,

    /// Показывать статус лаунчера в Discord (Rich Presence).
    /// Client ID приложения зашит в код (presence.rs), в настройках его нет.
    #[serde(default = "default_true")]
    pub discord_rpc: bool,
    /// Маленькая картинка в статусе Discord — иконка выбранной сборки.
    #[serde(default = "default_true")]
    pub discord_instance_icon: bool,
    /// Разрешение публиковать локальную иконку на временном хостинге.
    /// По умолчанию выключено: локальные изображения не покидают компьютер.
    #[serde(default)]
    pub discord_upload_local_icon: bool,

    /* ---------- оформление ---------- */
    /// Иконка окна, панели задач и большой картинки Discord Rich Presence.
    #[serde(default)]
    pub launcher_icon: LauncherIcon,
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
    /// Поля прежней интеграции сохранены для совместимости; приложение их не запускает.
    #[serde(default)]
    pub wallpaper_workshop_project: Option<String>,
    /// Сохранённый флаг старой версии.
    #[serde(default = "default_true")]
    pub wallpaper_engine_enabled: bool,
    /// Сохранённая настройка звука старой версии.
    #[serde(default)]
    pub wallpaper_workshop_audio: bool,
    /// Сохранённый путь старой версии; содержимое не изменяется.
    #[serde(default)]
    pub wallpaper_steam_path: Option<String>,
    /// Звуковые эффекты интерфейса.
    #[serde(default = "default_true")]
    pub sound_fx: bool,
    /// Общая громкость этих звуков, 0–200 %.
    #[serde(default = "default_sound_volume")]
    pub sound_volume: u8,
    /// Копии пользовательских звуков и отдельная громкость для каждого события.
    #[serde(default)]
    pub sound_custom: std::collections::BTreeMap<String, CustomSound>,

    /// Категории (папки) сборок в списке слева.
    #[serde(default)]
    pub categories: Vec<Category>,

    /// Библиотека загруженных скинов. Старое имя ключа сохраняет все прежние записи.
    #[serde(default)]
    pub skin_presets: Vec<SkinPreset>,
    /// Избранные образы. Храним произвольные поля старых записей без потерь.
    #[serde(default)]
    pub skin_favorites: Vec<serde_json::Value>,
    /// Вид гардероба плащей: list — центральный карусельный список, grid — плитки.
    #[serde(default = "default_cape_view")]
    pub cape_view: String,

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
    /// Вкладка при открытии сборки; старые настройки начинают с консоли.
    #[serde(default = "default_initial_tab")]
    pub initial_tab: String,
    /// Фоновая анимация: stars | dust | sticks | snow | off.
    #[serde(default = "default_ambient")]
    pub ambient: String,
    /// Вариант звука интерфейса: soft | classic | glass | wood | deep.
    #[serde(default = "default_sound_style")]
    pub sound_style: String,
    /// Размер плиток в «Готовых сборках»: 1 — 12 в ряд, 2 — 9, 3 — 6.
    #[serde(default = "default_feed_grid")]
    pub feed_grid: u8,
    /// Старый размер плитки Modrinth; используется как запасной для прежних настроек.
    #[serde(default = "default_feed_grid")]
    pub mr_grid: u8,
    /// Общие вид и размер плитки обоих каталогов; None сохраняет старые настройки.
    #[serde(default)]
    pub mods_view: Option<String>,
    #[serde(default)]
    pub mods_grid: Option<u8>,
    /// Базовый цвет фона поверх обоев (#rrggbb). Пусто — цвет текущей темы.
    #[serde(default)]
    pub theme_tint: Option<String>,
    /// Свёрнута ли группа «Без категории».
    #[serde(default)]
    pub loose_collapsed: bool,
    /// Первый запуск пройден: окно быстрой настройки больше не показываем.
    #[serde(default)]
    pub onboarded: bool,
    /// Только новый профиль ожидает мастер. В старых settings.json отсутствует
    /// и по serde умолчанию false — обновление не запускает мастер повторно.
    #[serde(default)]
    pub onboarding_pending: bool,
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

/// Импортированный звук: исходный путь для интерфейса и безопасная копия в data/sounds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CustomSound {
    pub path: String,
    pub file: Option<String>,
    pub volume: u8,
}

impl Default for CustomSound {
    fn default() -> Self { Self { path: String::new(), file: None, volume: 100 } }
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

/// Запись библиотеки; формат совпадает со старыми пользовательскими пресетами.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SkinPreset {
    pub id: String,
    pub name: String,
    /// PNG скина, скопированный в папку лаунчера.
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
            minimize_to_tray: default_minimize_to_tray(),
            last_instance: None,
            proxy: None,
            ms_client_id: None,
            discord_rpc: true,
            discord_instance_icon: true,
            discord_upload_local_icon: false,
            launcher_icon: LauncherIcon::Default,
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
            wallpaper_workshop_project: None,
            wallpaper_engine_enabled: true,
            wallpaper_workshop_audio: false,
            wallpaper_steam_path: None,
            sound_fx: true,
            sound_volume: default_sound_volume(),
            sound_custom: std::collections::BTreeMap::new(),
            categories: Vec::new(),
            skin_presets: Vec::new(),
            skin_favorites: Vec::new(),
            cape_view: default_cape_view(),
            theme: default_theme(),
            theme_bg: None,
            theme_accent: None,
            theme_text: None,
            click_fx: default_click_fx(),
            ui_scale: default_ui_scale(),
            initial_tab: default_initial_tab(),
            ambient: default_ambient(),
            sound_style: default_sound_style(),
            feed_grid: default_feed_grid(),
            mr_grid: default_feed_grid(),
            mods_view: None,
            mods_grid: None,
            theme_tint: None,
            loose_collapsed: false,
            onboarded: false,
            onboarding_pending: true,
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
            Ok(mut settings) => {
                // GC-флаги обновлены под набор официального лаунчера:
                // нетронутый старый дефолт заменяем, свои значения не трогаем.
                if settings.jvm_args == OLD_JVM_ARGS {
                    settings.jvm_args = default_jvm_args();
                    settings.save_to(file).ok();
                }
                Ok(settings)
            }
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
        use std::io::Write;
        let parent = file.parent().filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)?;
        // Ошибка записи или закрытие приложения не должны оставлять усечённый
        // settings.json. Заменяем его только после полной записи соседа.
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(&mut temp, self)?;
        temp.flush()?;
        temp.persist(file).map_err(|error| error.error)?;
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

#[cfg(test)]
mod discord_tests {
    use super::*;

    #[test]
    fn launcher_icon_preserves_legacy_and_roundtrips_all_variants() {
        let old: Settings = serde_json::from_str(r#"{"username":"Alex","ui_scale":125}"#).unwrap();
        assert_eq!(old.launcher_icon, LauncherIcon::Default);
        for (id, icon) in [
            ("default", LauncherIcon::Default), ("ru", LauncherIcon::Ru),
            ("by", LauncherIcon::By), ("kz", LauncherIcon::Kz),
            ("ua", LauncherIcon::Ua), ("us", LauncherIcon::Us),
            ("icon_star_boom", LauncherIcon::StarBoom), ("icon_star_eye", LauncherIcon::StarEye),
        ] {
            assert_eq!(LauncherIcon::from_id(id), Some(icon));
            let mut changed = old.clone();
            changed.launcher_icon = icon;
            let json = serde_json::to_string(&changed).unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&json).unwrap()["launcher_icon"], id);
            let restored: Settings = serde_json::from_str(&json).unwrap();
            assert_eq!(restored.launcher_icon, icon);
            assert_eq!(restored.username, "Alex");
            assert_eq!(restored.ui_scale, 125);
        }
        assert_eq!(LauncherIcon::from_id("../../secret"), None);
        let future: Settings = serde_json::from_str(r#"{"username":"Alex","launcher_icon":"future"}"#).unwrap();
        assert_eq!(future.launcher_icon, LauncherIcon::Default);
        assert_eq!(future.username, "Alex");
    }

    #[test]
    fn only_new_profiles_start_onboarding_without_reprompting_old_settings() {
        let old: Settings = serde_json::from_str(r#"{"username":"Player","onboarded":false}"#).unwrap();
        assert!(!old.onboarded && !old.onboarding_pending);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let fresh = Settings::load_from(&file).unwrap();
        assert!(!fresh.onboarded && fresh.onboarding_pending);
        let restarted = Settings::load_from(&file).unwrap();
        assert!(restarted.onboarding_pending);
    }

    #[test]
    fn tray_setting_is_opt_in_and_roundtrips_with_legacy_settings() {
        let old: Settings = serde_json::from_str(r#"{"username":"LegacyPlayer","onboarded":true}"#).unwrap();
        assert!(!old.minimize_to_tray);

        let mut changed = old.clone();
        changed.minimize_to_tray = true;
        let restored: Settings = serde_json::from_str(&serde_json::to_string(&changed).unwrap()).unwrap();
        assert!(restored.minimize_to_tray);
        assert_eq!(restored.username, "LegacyPlayer");
    }

    #[test]
    fn language_defaults_and_persists_without_losing_legacy_data() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        std::fs::write(&file, r#"{
          "username":"LegacyPlayer", "ui_scale":125,
          "custom_wallpaper":"custom.gif", "wallpaper_workshop_project":"/steam/keep",
          "skin_presets":[{"id":"old","name":"Скин","path":"/skins/old.png"}]
        }"#).unwrap();
        let mut settings = Settings::load_from(&file).unwrap();
        assert_eq!(settings.language, "ru");
        for language in ["ru", "be", "kk", "uk", "en"] {
            settings.language = language.into();
            settings.save_to(&file).unwrap();
            let restored = Settings::load_from(&file).unwrap();
            assert_eq!(restored.language, language);
            assert_eq!(restored.username, "LegacyPlayer");
            assert_eq!(restored.ui_scale, 125);
            assert_eq!(restored.custom_wallpaper.as_deref(), Some("custom.gif"));
            assert_eq!(restored.wallpaper_workshop_project.as_deref(), Some("/steam/keep"));
            assert_eq!(restored.skin_presets[0].name, "Скин");
            assert_eq!(restored.skin_presets[0].path, "/skins/old.png");
            settings = restored;
        }
    }

    #[test]
    fn failed_atomic_settings_replacement_preserves_existing_content() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("settings.json");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep"), "untouched").unwrap();
        assert!(Settings::default().save_to(&target).is_err());
        assert_eq!(std::fs::read_to_string(target.join("keep")).unwrap(), "untouched");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "temporary file is cleaned up");
    }

    #[test]
    fn local_icon_upload_requires_explicit_consent_for_old_and_new_settings() {
        for settings in [
            Settings::default(),
            serde_json::from_str::<Settings>("{}").unwrap(),
        ] {
            assert!(settings.discord_instance_icon);
            assert!(!settings.discord_upload_local_icon);
        }
    }

    #[test]
    fn wallpaper_engine_controls_keep_legacy_defaults_and_selection() {
        let old: Settings = serde_json::from_str(r#"{
            "wallpaper":"workshop", "wallpaper_workshop_project":"/steam/project"
        }"#).unwrap();
        assert!(old.wallpaper_engine_enabled, "existing installations keep loading WE");
        assert!(!old.wallpaper_workshop_audio, "videos were previously muted");
        let mut changed = old;
        changed.wallpaper_engine_enabled = false;
        changed.wallpaper_workshop_audio = true;
        let restored: Settings = serde_json::from_str(&serde_json::to_string(&changed).unwrap()).unwrap();
        assert!(!restored.wallpaper_engine_enabled);
        assert!(restored.wallpaper_workshop_audio);
        assert_eq!(restored.wallpaper.as_deref(), Some("workshop"));
        assert_eq!(restored.wallpaper_workshop_project.as_deref(), Some("/steam/project"));
    }

    #[test]
    fn initial_tab_defaults_to_console_and_survives_roundtrip() {
        let old: Settings = serde_json::from_str(r#"{"ui_scale":125}"#).unwrap();
        assert_eq!(old.initial_tab, "console");
        for tab in ["console", "errors", "files", "mods", "resourcepacks", "shaders", "worlds", "screenshots", "download", "settings"] {
            let mut changed = old.clone();
            changed.initial_tab = tab.into();
            let restored: Settings = serde_json::from_str(&serde_json::to_string(&changed).unwrap()).unwrap();
            assert_eq!(restored.initial_tab, tab);
            assert_eq!(restored.ui_scale, 125);
        }
    }

    #[test]
    fn old_skin_library_and_favorites_survive_unrelated_settings_saves() {
        let input = r#"{
          "username":"LegacyPlayer",
          "custom_wallpaper":"custom.png",
          "skin_presets":[{"id":"old-1","name":"Старый скин","path":"/data/skin.png","variant":"slim","angle":17}],
          "skin_favorites":[{"id":"fav-1","name":"Образ","skinPath":"/data/skin.png","skinDataUrl":"data:image/png;base64,AA==","capeId":"cape-1","futureField":{"keep":true},"angle":17}]
        }"#;
        let mut settings: Settings = serde_json::from_str(input).unwrap();
        assert_eq!(settings.skin_presets[0].id, "old-1");
        assert_eq!(settings.skin_favorites[0]["futureField"]["keep"], true);
        assert_eq!(settings.custom_wallpaper.as_deref(), Some("custom.png"));
        assert!(settings.wallpaper_steam_path.is_none());
        settings.ui_scale = 125;
        let restored: Settings = serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        assert_eq!(restored.skin_presets[0].path, "/data/skin.png");
        assert_eq!(restored.skin_presets[0].variant, "slim");
        assert_eq!(restored.skin_favorites[0]["capeId"], "cape-1");
        assert_eq!(restored.skin_favorites[0]["futureField"]["keep"], true);
        assert_eq!(restored.ui_scale, 125);
    }

    #[test]
    fn catalog_view_and_size_survive_settings_roundtrip_without_breaking_old_files() {
        let old: Settings = serde_json::from_str(r#"{"mr_grid":3}"#).unwrap();
        assert_eq!(old.mr_grid, 3);
        assert_eq!(old.mods_view, None);
        assert_eq!(old.mods_grid, None);

        let mut changed = old;
        changed.mods_view = Some("grid".into());
        changed.mods_grid = Some(1);
        let restored: Settings =
            serde_json::from_str(&serde_json::to_string(&changed).unwrap()).unwrap();
        assert_eq!(restored.mods_view.as_deref(), Some("grid"));
        assert_eq!(restored.mods_grid, Some(1));
        assert_eq!(restored.mr_grid, 3);
    }
}
