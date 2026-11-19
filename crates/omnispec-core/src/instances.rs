//! Сборки (инстансы). Каждая сборка — папка `instances/<id>/` со своим
//! `instance.json` и изолированной игровой папкой `minecraft/`, ровно как в Prism.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
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
    /// Только в ответе списка: старые id до подтверждения UI.
    /// Не принимаются обратно как метаданные сборки.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub renamed_from: Option<String>,
    #[serde(default, skip_deserializing, skip_serializing_if = "Vec::is_empty")]
    pub renamed_froms: Vec<String>,
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
    /// Своя папка игры (место установки). Пусто — папка лаунчера.
    #[serde(default)]
    pub game_dir: Option<String>,
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
    /// Сколько ОЗУ выделить этой сборке (МБ).
    #[serde(default)]
    pub memory_mb: Option<u32>,
    /// Своя Java для этой сборки (`None` — автоматически).
    #[serde(default)]
    pub java_path: Option<String>,
    /// Место установки: своя папка игры (`None` — папка лаунчера).
    #[serde(default)]
    pub game_dir: Option<String>,
}

/// Имя реальной папки, а не устаревший id в JSON, определяет её адрес.
fn valid_id(id: &str) -> bool {
    let mut components = Path::new(id).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn relative_under(path: &Path, parent: &Path) -> Option<PathBuf> {
    if let Ok(tail) = path.strip_prefix(parent) { return Some(tail.to_owned()); }
    #[cfg(windows)]
    {
        // Windows сравнивает имена без учёта регистра, даже если пользователь
        // набрал путь в другом регистре в настройках.
        let mut actual = path.components();
        for wanted in parent.components() {
            let component = actual.next()?;
            if component.as_os_str().to_string_lossy().to_lowercase()
                != wanted.as_os_str().to_string_lossy().to_lowercase() { return None; }
        }
        return Some(actual.collect());
    }
    #[cfg(not(windows))]
    None
}

/// Переносим только пути, находившиеся внутри самой переименованной папки.
/// Внешнее место установки и внешняя Java остаются нетронутыми.
fn moved_path(paths: &Paths, old: &str, new: &str, value: &str) -> Option<String> {
    if !valid_id(old) { return None; }
    let value_path = Path::new(value);
    let old_dir = paths.instance_dir(old);
    let new_dir = paths.instance_dir(new);
    if let Some(tail) = relative_under(value_path, &old_dir) {
        if tail.components().any(|component| matches!(component, Component::ParentDir)) { return None; }
        return Some(new_dir.join(tail).to_string_lossy().into_owned());
    }
    // Относительный корень лаунчера может сочетаться с абсолютным путём
    // в настройках. Не канонизируем исчезнувшую старую папку.
    if !old_dir.is_absolute() && value_path.is_absolute() {
        let cwd = std::env::current_dir().ok()?;
        let tail = relative_under(value_path, &cwd.join(&old_dir))?;
        if tail.components().any(|component| matches!(component, Component::ParentDir)) { return None; }
        return Some(cwd.join(new_dir).join(tail).to_string_lossy().into_owned());
    }
    None
}

static TEMP_SERIAL: AtomicU64 = AtomicU64::new(0);
// Обновление времени игры, настроек и восстановления не должно терять записи.
static INSTANCE_WRITE_LOCK: Mutex<()> = Mutex::new(());
const PENDING_RENAMES_FILE: &str = ".omnispec-rename-pending.json";

/// Запись в той же папке через временный файл: сбой не обрывает instance.json.
fn write_json_atomic(file: &Path, value: &serde_json::Value) -> Result<()> {
    let parent = file.parent().ok_or_else(|| Error::other("у файла сборки нет родительской папки"))?;
    let temp = parent.join(format!(".instance-{}-{}.tmp", std::process::id(), TEMP_SERIAL.fetch_add(1, Ordering::Relaxed)));
    let result = (|| -> Result<()> {
        let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        output.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
        output.sync_all()?;
        drop(output);
        std::fs::rename(&temp, file)?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result
}

fn read_meta(file: &Path) -> Result<InstanceMeta> {
    Ok(serde_json::from_str(&std::fs::read_to_string(file)?)?)
}

fn pending_renames(file: &Path) -> Result<Vec<String>> {
    let marker = file.with_file_name(PENDING_RENAMES_FILE);
    match std::fs::read(marker) {
        Ok(data) => Ok(serde_json::from_slice(&data)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

/// Исправляем JSON непосредственно в новой папке, сохраняя неизвестные поля.
/// Маркер записываем до JSON: повторный список не потеряет переименование,
/// даже если другой файл списка не записался или ответ до UI не дошёл.
fn reconcile_meta(paths: &Paths, id: &str, file: &Path) -> Result<InstanceMeta> {
    let mut value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file)?)?;
    let mut meta: InstanceMeta = serde_json::from_value(value.clone())?;
    let mut previous = pending_renames(file)?;
    if meta.id != id {
        let old = meta.id.clone();
        previous.retain(|item| item != id && valid_id(item));
        if valid_id(&old) && !previous.contains(&old) { previous.push(old.clone()); }
        // Даже пустой список заменяет старый маркер при возврате к прежнему id.
        write_json_atomic(&file.with_file_name(PENDING_RENAMES_FILE), &serde_json::to_value(&previous)?)?;
        let object = value.as_object_mut().ok_or_else(|| Error::other("неверный instance.json"))?;
        object.insert("id".into(), serde_json::Value::String(id.to_string()));
        for key in ["game_dir", "icon", "java_path"] {
            let moved = object.get(key).and_then(|v| v.as_str())
                .and_then(|v| moved_path(paths, &old, id, v));
            if let Some(moved) = moved { object.insert(key.into(), serde_json::Value::String(moved)); }
        }
        write_json_atomic(file, &value).map_err(|error| Error::other(format!(
            "не удалось восстановить сборку {}: {error}", file.display()
        )))?;
        meta = serde_json::from_value(value)?;
    }
    meta.renamed_from = previous.last().cloned();
    meta.renamed_froms = previous;
    Ok(meta)
}

/// Удаляем только те старые id, которые UI уже обработал. Если папку снова
/// переименовали между ответом и подтверждением, новые id останутся в маркере.
pub fn acknowledge_renames(paths: &Paths, id: &str, known: &[String]) -> Result<()> {
    if !valid_id(id) { return Err(Error::other("недопустимое имя папки сборки")); }
    let _guard = INSTANCE_WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let file = paths.instance_file(id);
    let meta = read_meta(&file)?;
    if meta.id != id { return Err(Error::other("папка сборки изменилась; обнови список")); }
    let mut previous = pending_renames(&file)?;
    previous.retain(|old| !known.contains(old));
    let marker = file.with_file_name(PENDING_RENAMES_FILE);
    if previous.is_empty() {
        match std::fs::remove_file(marker) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.into()),
        }
    } else {
        write_json_atomic(&marker, &serde_json::to_value(&previous)?)?;
    }
    Ok(())
}

/// Все сборки, отсортированные по времени последнего запуска.
pub fn list(paths: &Paths) -> Result<Vec<InstanceMeta>> {
    list_with_blocked(paths, &HashSet::new())
}

/// Не меняем идентификатор, пока игра или запись ещё пользуются старым id.
pub fn list_with_blocked(paths: &Paths, blocked: &HashSet<String>) -> Result<Vec<InstanceMeta>> {
    let _guard = INSTANCE_WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let dir = paths.instances();
    if !dir.exists() { return Ok(Vec::new()); }
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() { continue; }
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else { continue; };
        if !valid_id(&id) { continue; }
        let file = entry.path().join("instance.json");
        if !file.is_file() { continue; }
        match read_meta(&file) {
            Ok(meta) => found.push((id, file, meta)),
            Err(err) => eprintln!("[omnispec] сборка {} пропущена: {err}", entry.path().display()),
        }
    }
    // Сначала проверяем ВСЕ папки: нельзя наполовину восстановить список.
    let global_write = ["__create__", "__modpack__", "__import__"].iter().any(|id| blocked.contains(*id));
    if let Some((_, _, meta)) = found.iter().find(|(id, _, meta)| id != &meta.id && (global_write || blocked.contains(&meta.id))) {
        return Err(Error::other(format!("папка сборки «{}» переименована во время работы. Останови игру и дождись завершения операций, затем обнови список сборок", meta.name)));
    }
    let mut result = Vec::with_capacity(found.len());
    for (id, file, _) in found {
        result.push(reconcile_meta(paths, &id, &file)?);
    }
    result.sort_by(|a, b| {
        let a_key = (a.last_played.unwrap_or(0), a.created);
        let b_key = (b.last_played.unwrap_or(0), b.created);
        b_key.cmp(&a_key)
    });
    Ok(result)
}

pub fn load(paths: &Paths, id: &str) -> Result<InstanceMeta> {
    if !valid_id(id) { return Err(Error::other("недопустимое имя папки сборки")); }
    let file = paths.instance_file(id);
    if !file.is_file() {
        return Err(Error::not_found(format!("сборка «{id}» не найдена; обнови список сборок")));
    }
    let meta = read_meta(&file)?;
    if meta.id != id {
        // Только list_with_blocked может сменить id: он знает о запусках и
        // незавершённых операциях. Чтение не обходит эту блокировку.
        return Err(Error::other("папка сборки переименована; обнови список сборок"));
    }
    Ok(meta)
}

pub fn save(paths: &Paths, meta: &InstanceMeta) -> Result<()> {
    let _guard = INSTANCE_WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    save_unlocked(paths, meta)
}

fn save_unlocked(paths: &Paths, meta: &InstanceMeta) -> Result<()> {
    if !valid_id(&meta.id) { return Err(Error::other("недопустимое имя папки сборки")); }
    let file = paths.instance_file(&meta.id);
    if !file.is_file() {
        return Err(Error::not_found(format!("папка сборки «{}» не найдена; обнови список сборок", meta.id)));
    }
    // Время игры и дату последнего запуска только накапливаем: любая запись
    // настроек со старым снимком меты не должна откатывать статистику.
    let mut meta = meta.clone();
    meta.renamed_from = None;
    meta.renamed_froms.clear();
    let disk = load(paths, &meta.id)?;
    meta.playtime_secs = meta.playtime_secs.max(disk.playtime_secs);
    meta.last_played = match (meta.last_played, disk.last_played) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    // Не теряем поля, добавленные будущей версией или другим инструментом.
    let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(&file)?)?;
    let current = serde_json::to_value(&meta)?;
    let object = value.as_object_mut().ok_or_else(|| Error::other("неверный instance.json"))?;
    object.remove("renamed_from");
    object.remove("renamed_froms");
    for (key, value) in current.as_object().ok_or_else(|| Error::other("неверные данные сборки"))? {
        object.insert(key.clone(), value.clone());
    }
    write_json_atomic(&file, &value)
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
        renamed_from: None,
        renamed_froms: Vec::new(),
        name,
        mc_version: request.mc_version.trim().to_string(),
        loader: request.loader,
        created: now_unix(),
        last_played: None,
        playtime_secs: 0,
        memory_mb: request.memory_mb,
        java_path: request
            .java_path
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        jvm_args: None,
        icon: request.icon,
        version_override: None,
        notes: request.notes,
        source: request.source.unwrap_or_else(|| "manual".into()),
        source_url: request.source_url,
        category: request.category,
        game_dir: request
            .game_dir
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    };

    let dir = paths.instance_dir(&id);
    // Только сам новый каталог, не перезаписываем внезапно появившуюся сборку.
    std::fs::create_dir(&dir)?;
    // Папки внутри игровой папки: по умолчанию в папке лаунчера, но если
    // выбрали своё место установки — там.
    let game_root = prepare_game_dir(paths, &meta)?;
    for sub in [
        "mods",
        "resourcepacks",
        "shaderpacks",
        "saves",
        "config",
        "logs",
        "screenshots",
    ] {
        create_dir_beneath(&game_root, &game_root.join(sub))?;
    }
    let _guard = INSTANCE_WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    write_json_atomic(&paths.instance_file(&id), &serde_json::to_value(&meta)?)?;
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
/// Дублировать сборку: копия папки с новым id и именем «… (копия)».
/// Логи и отчёты о падениях не копируем — они только раздувают архив.
pub fn duplicate(paths: &Paths, id: &str) -> Result<InstanceMeta> {
    let source = load(paths, id)?;
    let source_dir = paths.instance_dir(id);
    if !source_dir.exists() {
        return Err(Error::not_found(format!("сборка «{id}» не найдена")));
    }
    let new_id = unique_id(paths, &source.id);
    let target_dir = paths.instance_dir(&new_id);
    copy_dir_skip(&source_dir, &target_dir, &["logs", "crash-reports", PENDING_RENAMES_FILE])?;

    let mut meta = source.clone();
    meta.id = new_id;
    meta.renamed_from = None;
    meta.renamed_froms.clear();
    for path in [&mut meta.game_dir, &mut meta.icon, &mut meta.java_path] {
        if let Some(moved) = path.as_deref().and_then(|value| moved_path(paths, &source.id, &meta.id, value)) {
            *path = Some(moved);
        }
    }
    meta.name = format!("{} (копия)", source.name);
    meta.created = now_unix();
    meta.last_played = None;
    meta.playtime_secs = 0;
    // Это новая сборка, а не устаревший снимок исходной: не переносим её
    // статистику и не создаём уведомление о переименовании.
    let _guard = INSTANCE_WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let file = paths.instance_file(&meta.id);
    let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(&file)?)?;
    let object = value.as_object_mut().ok_or_else(|| Error::other("неверный instance.json"))?;
    object.remove("renamed_from");
    object.remove("renamed_froms");
    for (key, value) in serde_json::to_value(&meta)?.as_object().ok_or_else(|| Error::other("неверные данные сборки"))? {
        object.insert(key.clone(), value.clone());
    }
    write_json_atomic(&file, &value)?;
    Ok(meta)
}

/// Рекурсивное копирование папки, пропуская указанные подпапки верхнего уровня.
fn copy_dir_skip(from: &Path, to: &Path, skip: &[&str]) -> Result<()> {
    match std::fs::create_dir(to) {
        Ok(()) => {},
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && to.is_dir() => {},
        Err(error) => return Err(error.into()),
    }
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if skip.contains(&name.as_ref()) {
            continue;
        }
        let target = to.join(name.as_ref());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_skip(&entry.path(), &target, &[])?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

pub fn delete(paths: &Paths, id: &str) -> Result<()> {
    if !valid_id(id) { return Err(Error::other("недопустимое имя папки сборки")); }
    let _guard = INSTANCE_WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
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
    let _guard = INSTANCE_WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    if let Ok(mut meta) = load(paths, id) {
        meta.playtime_secs = meta.playtime_secs.saturating_add(secs);
        let _ = save_unlocked(paths, &meta);
        return;
    }
    // Если папку переместили во время игры, сохраняем статистику в неё,
    // не меняя id работающего процесса. Только при однозначном совпадении.
    let mut candidates = Vec::new();
    if let Ok(entries) = std::fs::read_dir(paths.instances()) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let file = entry.path().join("instance.json");
            if read_meta(&file).ok().is_some_and(|meta| meta.id == id) { candidates.push(file); }
        }
    }
    if candidates.len() != 1 { return; }
    let file = &candidates[0];
    if let Ok(text) = std::fs::read_to_string(file) {
        if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(object) = value.as_object_mut() {
                let old = object.get("playtime_secs").and_then(|v| v.as_u64()).unwrap_or(0);
                object.insert("playtime_secs".into(), old.saturating_add(secs).into());
                let _ = write_json_atomic(file, &value);
            }
        }
    }
}

/// Папка игры конкретной сборки: своя (место установки), иначе папка лаунчера.
pub fn game_dir_for(paths: &Paths, meta: &InstanceMeta) -> PathBuf {
    meta.game_dir
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.instance_game_dir(&meta.id))
}

pub fn game_dir(paths: &Paths, id: &str) -> Result<PathBuf> {
    let meta = load(paths, id)?;
    Ok(game_dir_for(paths, &meta))
}

/// Создаёт только потомков существующего корня, никогда не воссоздавая сам
/// корень. Если папку переместили во время операции, запись завершается ошибкой.
pub fn create_dir_beneath(anchor: &Path, dir: &Path) -> Result<()> {
    let tail = relative_under(dir, anchor).ok_or_else(|| Error::other("путь за пределами игровой папки"))?;
    if !anchor.is_dir() { return Err(Error::other("папка сборки перемещена или удалена; обнови список")); }
    let mut current = anchor.to_path_buf();
    for component in tail.components() {
        match component {
            Component::Normal(name) => current.push(name),
            Component::CurDir => continue,
            _ => return Err(Error::other("недопустимый путь в игровой папке")),
        }
        match std::fs::create_dir(&current) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && current.is_dir() => {},
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn prepare_game_dir(paths: &Paths, instance: &InstanceMeta) -> Result<PathBuf> {
    let game = game_dir_for(paths, instance);
    let root = paths.instance_dir(&instance.id);
    let cwd = std::env::current_dir()?;
    let absolute_root = if root.is_absolute() { root } else { cwd.join(root) };
    let absolute_game = if game.is_absolute() { game.clone() } else { cwd.join(&game) };
    if relative_under(&absolute_game, &absolute_root).is_some() {
        create_dir_beneath(&absolute_root, &absolute_game)?;
    } else {
        if !absolute_root.is_dir() { return Err(Error::other("папка сборки перемещена или удалена")); }
        std::fs::create_dir_all(&game)?; // отдельная внешняя игровая папка
    }
    Ok(game)
}

/// Готовит игровую папку, не воссоздавая переименованную папку сборки.
pub fn ensure_game_dir(paths: &Paths, instance: &InstanceMeta) -> Result<PathBuf> {
    let current = load(paths, &instance.id)?;
    let game = game_dir_for(paths, instance);
    if game_dir_for(paths, &current) != game {
        return Err(Error::other("папка игры изменилась; обнови список сборок"));
    }
    let game = prepare_game_dir(paths, instance)?;
    if !paths.instance_file(&instance.id).is_file() {
        return Err(Error::other("папка сборки перемещена или удалена; обнови список"));
    }
    Ok(game)
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
            renamed_from: None,
            renamed_froms: Vec::new(),
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
            game_dir: None,
        };
        std::fs::create_dir_all(paths.instance_dir(&meta.id)).unwrap();
        std::fs::write(paths.instance_file(&meta.id), serde_json::to_vec(&meta).unwrap()).unwrap();
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

    fn rename_fixture(label: &str) -> (PathBuf, Paths, InstanceMeta) {
        let root = std::env::temp_dir().join(format!("omnispec-rename-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        let meta = create(&paths, CreateInstanceRequest {
            name: "Сборка".into(), mc_version: "1.21.1".into(), loader: Loader::Vanilla,
            icon: None, notes: "не терять".into(), source: None, source_url: None,
            id: Some("old".into()), category: Some("cat".into()), memory_mb: Some(4096),
            java_path: None, game_dir: None,
        }).unwrap();
        (root, paths, meta)
    }

    #[test]
    fn renamed_folder_recovers_id_paths_and_unknown_fields_without_ghosts() {
        let (root, paths, mut meta) = rename_fixture("move");
        let old = paths.instance_dir("old");
        let new = paths.instance_dir("Новая сборка #1");
        meta.game_dir = Some(old.join("game").to_string_lossy().into_owned());
        meta.icon = Some(old.join("icon.png").to_string_lossy().into_owned());
        meta.java_path = Some(old.join("java/bin/java").to_string_lossy().into_owned());
        save(&paths, &meta).unwrap();
        std::fs::create_dir_all(old.join("game/saves/world")).unwrap();
        std::fs::write(old.join("game/saves/world/data"), b"world").unwrap();
        std::fs::write(old.join("content.json"), b"catalog").unwrap();
        let mut original: serde_json::Value = serde_json::from_slice(&std::fs::read(old.join("instance.json")).unwrap()).unwrap();
        original["future_field"] = serde_json::json!({"preserve": true});
        std::fs::write(old.join("instance.json"), serde_json::to_vec(&original).unwrap()).unwrap();
        std::fs::rename(&old, &new).unwrap();
        assert!(save(&paths, &meta).is_err(), "устаревший снимок не создаёт старую папку");
        assert!(game_dir(&paths, "old").is_err());
        let list = list(&paths).unwrap();
        assert_eq!(list.len(), 1);
        let restored = &list[0];
        assert_eq!(restored.id, "Новая сборка #1");
        assert_eq!(restored.renamed_from.as_deref(), Some("old"));
        assert_eq!(game_dir(&paths, &restored.id).unwrap(), new.join("game"));
        assert_eq!(restored.icon.as_deref(), new.join("icon.png").to_str());
        assert_eq!(restored.java_path.as_deref(), new.join("java/bin/java").to_str());
        assert_eq!(restored.notes, "не терять");
        assert_eq!(restored.category.as_deref(), Some("cat"));
        assert_eq!(std::fs::read(new.join("game/saves/world/data")).unwrap(), b"world");
        assert_eq!(std::fs::read(new.join("content.json")).unwrap(), b"catalog");
        let disk: serde_json::Value = serde_json::from_slice(&std::fs::read(new.join("instance.json")).unwrap()).unwrap();
        assert_eq!(disk["future_field"]["preserve"], true);
        assert_eq!(disk["id"], "Новая сборка #1");
        assert!(disk.get("renamed_from").is_none());
        assert!(!old.exists());
        assert!(load(&paths, &restored.id).unwrap().renamed_from.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn active_rename_waits_and_keeps_playtime_then_reconciles() {
        let (root, paths, meta) = rename_fixture("active");
        std::fs::rename(paths.instance_dir("old"), paths.instance_dir("new")).unwrap();
        let blocked = HashSet::from(["old".to_string()]);
        assert!(list_with_blocked(&paths, &blocked).unwrap_err().to_string().contains("Останови игру"));
        assert!(load(&paths, "new").is_err(), "обычное чтение не обходит блокировку");
        assert!(list_with_blocked(&paths, &HashSet::from(["__modpack__".into()])).is_err());
        add_playtime(&paths, "old", 77);
        let raw: InstanceMeta = read_meta(&paths.instance_file("new")).unwrap();
        assert_eq!(raw.id, "old", "работающий процесс сохраняет id до выхода");
        assert_eq!(raw.playtime_secs, 77);
        let recovered = list(&paths).unwrap().remove(0);
        assert_eq!(recovered.id, "new");
        assert_eq!(recovered.playtime_secs, 77);
        assert!(save(&paths, &meta).is_err());
        assert!(!paths.instance_dir("old").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn copied_id_and_external_game_folder_remain_independent() {
        let (root, paths, mut meta) = rename_fixture("copy");
        let external = root.join("external-game");
        meta.game_dir = Some(external.to_string_lossy().into_owned());
        save(&paths, &meta).unwrap();
        std::fs::create_dir_all(paths.instance_dir("copy")).unwrap();
        std::fs::copy(paths.instance_file("old"), paths.instance_file("copy")).unwrap();
        let entries = list(&paths).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|e| e.id == "old"));
        let copy = entries.iter().find(|e| e.id == "copy").unwrap();
        assert_eq!(copy.renamed_from.as_deref(), Some("old"));
        assert_eq!(game_dir_for(&paths, copy), external);
        assert_eq!(load(&paths, "old").unwrap().id, "old");
        assert_eq!(load(&paths, "copy").unwrap().id, "copy");
        assert!(load(&paths, "../old").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn renames_survive_lost_response_chains_and_partial_acknowledgement() {
        let (root, paths, _) = rename_fixture("chain");
        std::fs::rename(paths.instance_dir("old"), paths.instance_dir("middle")).unwrap();
        let first = list(&paths).unwrap().remove(0);
        assert_eq!(first.renamed_froms, vec!["old"]);
        // Потерянный ответ, ошибка другого элемента или перезапуск не уничтожают событие.
        assert_eq!(list(&paths).unwrap()[0].renamed_froms, vec!["old"]);
        save(&paths, &first).unwrap();
        assert_eq!(list(&paths).unwrap()[0].renamed_froms, vec!["old"]);
        std::fs::rename(paths.instance_dir("middle"), paths.instance_dir("final")).unwrap();
        let chain = list(&paths).unwrap().remove(0);
        assert_eq!(chain.renamed_froms, vec!["old", "middle"]);
        assert!(acknowledge_renames(&paths, "middle", &["old".into()]).is_err());
        acknowledge_renames(&paths, "final", &["old".into()]).unwrap();
        assert_eq!(list(&paths).unwrap()[0].renamed_froms, vec!["middle"]);
        acknowledge_renames(&paths, "final", &["middle".into()]).unwrap();
        assert!(list(&paths).unwrap()[0].renamed_froms.is_empty());
        assert!(!paths.instance_dir("final").join(PENDING_RENAMES_FILE).exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_preserves_unknown_fields_and_uses_its_own_paths_and_statistics() {
        let (root, paths, mut meta) = rename_fixture("duplicate");
        let old = paths.instance_dir("old");
        meta.game_dir = Some(old.join("game").to_string_lossy().into_owned());
        meta.icon = Some(old.join("icon.png").to_string_lossy().into_owned());
        meta.java_path = Some(root.join("external-java").to_string_lossy().into_owned());
        meta.playtime_secs = 900;
        meta.last_played = Some(123);
        save(&paths, &meta).unwrap();
        std::fs::create_dir_all(old.join("game/saves")).unwrap();
        std::fs::write(old.join("game/saves/test"), b"world").unwrap();
        let file = paths.instance_file("old");
        let mut json: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        json["future_field"] = serde_json::json!({"preserve": true});
        std::fs::write(&file, serde_json::to_vec(&json).unwrap()).unwrap();
        std::fs::write(old.join(PENDING_RENAMES_FILE), b"[\"earlier\"]").unwrap();
        let copy = duplicate(&paths, "old").unwrap();
        let dir = paths.instance_dir(&copy.id);
        assert_ne!(copy.id, "old");
        assert_eq!(copy.game_dir.as_deref(), dir.join("game").to_str());
        assert_eq!(copy.icon.as_deref(), dir.join("icon.png").to_str());
        assert_eq!(copy.java_path, meta.java_path);
        assert_eq!(load(&paths, &copy.id).unwrap().playtime_secs, 0);
        assert_eq!(load(&paths, &copy.id).unwrap().last_played, None);
        assert!(!dir.join(PENDING_RENAMES_FILE).exists());
        assert_eq!(std::fs::read(dir.join("game/saves/test")).unwrap(), b"world");
        let copied: serde_json::Value = serde_json::from_slice(&std::fs::read(paths.instance_file(&copy.id)).unwrap()).unwrap();
        assert_eq!(copied["future_field"]["preserve"], true);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn creating_subdirectories_never_recreates_a_moved_instance() {
        let (root, paths, meta) = rename_fixture("safe-mkdir");
        let old = paths.instance_dir("old");
        let game = ensure_game_dir(&paths, &meta).unwrap();
        create_dir_beneath(&game, &game.join("deep/nested")).unwrap();
        assert!(game.join("deep/nested").is_dir());
        assert!(create_dir_beneath(&game, &game.join("../escape")).is_err());
        std::fs::rename(&old, paths.instance_dir("new")).unwrap();
        assert!(ensure_game_dir(&paths, &meta).is_err());
        assert!(create_dir_beneath(&game, &game.join("mods/new/nested")).is_err());
        assert!(!old.exists(), "старая папка не появилась снова");
        let recovered = list(&paths).unwrap().remove(0);
        assert!(ensure_game_dir(&paths, &recovered).is_ok());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn simultaneous_playtime_updates_are_not_lost() {
        let (root, paths, _) = rename_fixture("parallel-time");
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let paths = &paths;
                scope.spawn(move || for _ in 0..10 { add_playtime(paths, "old", 1); });
            }
        });
        assert_eq!(load(&paths, "old").unwrap().playtime_secs, 80);
        assert!(delete(&paths, "../other").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn internal_windows_paths_ignore_case_but_not_siblings() {
        let (root, paths, _) = rename_fixture("windows-case");
        let old = paths.instance_dir("old");
        let old_upper = old.to_string_lossy().to_uppercase();
        let inside = PathBuf::from(&old_upper).join("game").to_string_lossy().into_owned();
        assert_eq!(moved_path(&paths, "old", "new", &inside).as_deref(), paths.instance_dir("new").join("game").to_str());
        let outside = format!("{}-else\\game", old.display());
        assert!(moved_path(&paths, "old", "new", &outside).is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn loader_version_ids() {
        let meta = InstanceMeta {
            id: "test".into(),
            renamed_from: None,
            renamed_froms: Vec::new(),
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
            game_dir: None,
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
                memory_mb: None,
                java_path: None,
                game_dir: None,
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
                memory_mb: None,
                java_path: None,
                game_dir: None,
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

    /// Своё место установки: папки сборки живут там, а не в папке лаунчера.
    #[test]
    fn custom_install_dir() {
        let root = std::env::temp_dir().join(format!("omnispec-custom-{}", std::process::id()));
        let custom = std::env::temp_dir().join(format!("omnispec-custom-game-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&custom);
        let paths = Paths::new(&root).unwrap();
        let meta = create(
            &paths,
            CreateInstanceRequest {
                name: "Своя папка".into(),
                mc_version: "1.21.4".into(),
                loader: Loader::Vanilla,
                icon: Some("i-gem".into()),
                notes: String::new(),
                source: None,
                source_url: None,
                id: None,
                category: None,
                memory_mb: Some(6144),
                java_path: None,
                game_dir: Some(custom.display().to_string()),
            },
        )
        .unwrap();
        assert_eq!(meta.memory_mb, Some(6144));
        assert_eq!(game_dir_for(&paths, &meta), custom);
        assert!(custom.join("mods").exists());
        assert_eq!(game_dir(&paths, &meta.id).unwrap(), custom);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&custom);
    }
}
