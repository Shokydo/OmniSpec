// Скрыть консольное окно в релизной сборке на Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri-оболочка OmniSpec: тонкий слой команд поверх `omnispec-core`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::Mutex;

use omnispec_core::accounts::AccountStore;
use omnispec_core::auth::microsoft;
use omnispec_core::auth::Account;
use omnispec_core::game;
use omnispec_core::game::java::JavaInstall;
use omnispec_core::game::launch::LaunchPlan;
use omnispec_core::instances::{self, CreateInstanceRequest, InstanceMeta};
use omnispec_core::loaders::{self, LoaderOption};
use omnispec_core::modrinth::{install as modrinth_install, mrpack, Modrinth, SearchQuery};
use omnispec_core::curseforge::{install as curseforge_install, modpack as curseforge_modpack, CurseForge};
use omnispec_core::net::{Http, Reporter};
use omnispec_core::paths::Paths;
use omnispec_core::settings::Settings;
use omnispec_core::update::{self, UpdateInfo};

/// Discord Rich Presence (локальный IPC Discord).
mod presence;
/// Безопасное разрешение публичных иконок для Rich Presence.
mod rpc_icons;
/// Объём физической памяти, доступной операционной системе.
mod system_memory;
/// Файлы фона и локальная библиотека Wallpaper Engine.
mod wallpapers;
/// Потоковая выдача только выбранных видео на защищённом loopback-адресе.
mod video_stream;
/// Восстановление только своих живых процессов после перезапуска.
mod game_sessions;
/// Проверенные ответы профиля Minecraft и ограниченная загрузка текстур.
mod profile_service;
/// Защищённая доставка кадров выбранной сцены в WebView.
#[cfg(any(windows, test))]
mod scene_stream;
/// Windows Graphics Capture только для своего окна Wallpaper Engine.
#[cfg(windows)]
mod scene_capture;

struct RunningChild {
    /// После перезапуска Child недоступен; работаем с проверенным PID/временем.
    child: Mutex<Option<tokio::process::Child>>,
    record: Option<StdMutex<game_sessions::SessionRecord>>,
    account: String,
    started_at: u64,
    /// Реальная папка этого процесса не зависит от последующих правок профиля.
    game_dir: PathBuf,
    /// Отмечаем только успешно отправленный запрос на остановку.
    stop_requested: AtomicBool,
}
type ChildHandle = Arc<RunningChild>;


/// Резервируем попытку до асинхронной подготовки. Иначе два быстрых нажатия
/// «Играть» могут одновременно увидеть пустой `running` и запустить два окна.
struct LaunchReservation {
    instance_id: String,
    launching: Arc<StdMutex<HashMap<String, usize>>>,
}

impl Drop for LaunchReservation {
    fn drop(&mut self) {
        let mut launching = self.launching.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = launching.get_mut(&self.instance_id) {
            *count -= 1;
            if *count == 0 {
                launching.remove(&self.instance_id);
            }
        }
    }
}

fn reserve_launch(
    instance_id: &str,
    allow_duplicate: bool,
    has_running: bool,
    launching: &Arc<StdMutex<HashMap<String, usize>>>,
) -> Result<LaunchReservation, String> {
    let mut pending = launching.lock().unwrap_or_else(|e| e.into_inner());
    if !allow_duplicate && (has_running || pending.contains_key(instance_id)) {
        return Err("эта сборка уже запущена или подготавливается".into());
    }
    *pending.entry(instance_id.to_string()).or_insert(0) += 1;
    Ok(LaunchReservation {
        instance_id: instance_id.to_string(),
        launching: launching.clone(),
    })
}

/// Ремонт из диагностики не должен пересекаться с запуском или изменением
/// содержимого этой же сборки. Обычные операции между собой не блокируем.
#[derive(Default)]
struct ContentAccess {
    repairing: HashSet<String>,
    writers: HashMap<String, usize>,
}

struct ContentReservation {
    instance_id: String,
    access: Arc<StdMutex<ContentAccess>>,
    repair: bool,
}

impl Drop for ContentReservation {
    fn drop(&mut self) {
        let mut access = self.access.lock().unwrap_or_else(|e| e.into_inner());
        if self.repair {
            access.repairing.remove(&self.instance_id);
        } else if let Some(count) = access.writers.get_mut(&self.instance_id) {
            *count -= 1;
            if *count == 0 { access.writers.remove(&self.instance_id); }
        }
    }
}

fn reserve_content_write(id: &str, access: &Arc<StdMutex<ContentAccess>>) -> Result<ContentReservation, String> {
    let mut guard = access.lock().unwrap_or_else(|e| e.into_inner());
    if !guard.repairing.is_empty() { return Err("идёт установка из диагностики; дождись её завершения".into()); }
    *guard.writers.entry(id.to_string()).or_insert(0) += 1;
    Ok(ContentReservation { instance_id:id.to_string(), access:access.clone(), repair:false })
}

fn normalized_game_dir(paths: &Paths, meta: &InstanceMeta) -> PathBuf {
    let dir = instances::game_dir_for(paths, meta);
    dir.canonicalize().unwrap_or(dir)
}

fn reserve_diagnostic_repair(
    id: &str,
    has_running: bool,
    launching: &Arc<StdMutex<HashMap<String, usize>>>,
    access: &Arc<StdMutex<ContentAccess>>,
) -> Result<ContentReservation, String> {
    let mut guard = access.lock().unwrap_or_else(|e| e.into_inner());
    let pending = launching.lock().unwrap_or_else(|e| e.into_inner());
    // Пока профиль подготавливается, его папка могла измениться в настройках;
    // ждём окончания подготовки, вместо того чтобы угадывать реальный путь.
    if has_running || !pending.is_empty() {
        return Err("сначала останови все окна, использующие эту папку игры, и дождись окончания подготовки сборок".into());
    }
    // В том числе чужая сборка может использовать ту же внешнюю папку mods.
    // На время загрузки не допускаем новых изменений и других исправлений.
    if !guard.repairing.is_empty() || !guard.writers.is_empty() {
        return Err("сборка уже изменяется; дождись завершения операции".into());
    }
    guard.repairing.insert(id.to_string());
    Ok(ContentReservation { instance_id:id.to_string(), access:access.clone(), repair:true })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DiagnosticConfig {
    mc_version: String,
    loader: instances::Loader,
    game_dir: PathBuf,
    version_id: String,
    instance_java: Option<String>,
    global_java: Option<String>,
    legacy_java: Option<String>,
    auto_java: bool,
}

impl DiagnosticConfig {
    fn new(paths: &Paths, meta: &InstanceMeta, settings: &Settings, version_id: String) -> Self {
        Self {
            mc_version: meta.mc_version.clone(), loader: meta.loader.clone(),
            game_dir: normalized_game_dir(paths, meta), version_id,
            instance_java: meta.java_path.clone(), global_java: settings.java_path.clone(),
            legacy_java: settings.java_path_legacy.clone(), auto_java: settings.auto_java,
        }
    }
}

#[derive(Clone, Debug)]
struct DiagnosticLaunch {
    attempt_id: String,
    actual: Option<(DiagnosticConfig, u32, omnispec_core::diagnostic_install::ModDirSnapshot)>,
}

struct AppState {
    paths: Paths,
    /// Путь, с которым лаунчер запустили (`.mrpack` двойным щелчком или drag&drop в ярлык).
    startup_file: Option<String>,
    accounts: Mutex<AccountStore>,
    /// Повторить сохранение нового refresh-токена, если диск временно недоступен.
    accounts_dirty: AtomicBool,
    http: Http,
    modrinth: Modrinth,
    curseforge: CurseForge,
    settings: Mutex<Settings>,
    /// Потоковый сервер запускается только при выборе видеообоев.
    video_server: StdMutex<Option<video_stream::VideoServer>>,
    /// Отмена обходов библиотеки и выбора при выключении/смене папки.
    wallpaper_revision: Arc<AtomicU64>,
    #[cfg(windows)]
    scene_manager: Arc<StdMutex<Option<scene_capture::SceneManager>>>,
    #[cfg(windows)]
    scene_revision: Arc<std::sync::atomic::AtomicU64>,
    /// Подготовка + запись настроек + фиксация сцены — одна операция.
    #[cfg(windows)]
    scene_operation: Mutex<()>,
    running: Arc<Mutex<HashMap<String, ChildHandle>>>,
    /// Попытки, которые ещё готовятся; дубликаты с аккаунтом разрешены.
    launching: Arc<StdMutex<HashMap<String, usize>>>,
    content_access: Arc<StdMutex<ContentAccess>>,
    /// Последняя попытка каждой сборки и реально выбранная в ней Java.
    diagnostic_launches: StdMutex<HashMap<String, DiagnosticLaunch>>,
    /// Статус в Discord: фронт пишет через set_presence, воркер шлёт в IPC.
    presence: presence::Presence,
    /// Не загружаем одну и ту же иконку несколько раз параллельно.
    rpc_icon_lock: Mutex<()>,
    /// Отмена ещё не завершённой загрузки при отзыве согласия.
    rpc_upload_allowed: tokio::sync::watch::Sender<bool>,
}

fn err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

/// Reporter, который отправляет прогресс в UI событием `progress`.
fn reporter_for(app: &AppHandle, instance_id: &str) -> Reporter {
    // Новая операция — сбрасываем флаг отмены прошлой загрузки.
    omnispec_core::net::reset_cancel();
    let app = app.clone();
    let instance_id = instance_id.to_string();
    Reporter::new(move |event| {
        let _ = app.emit(
            "progress",
            json!({
                "instance": instance_id,
                "stage": event.stage,
                "done": event.done,
                "total": event.total,
                "detail": event.detail,
                "bytes_done": event.bytes_done,
                "bytes_total": event.bytes_total,
                "file": event.file,
                "state": event.state,
                "op": event.op,
            }),
        );
    })
}

/// Панель не должна завершить одну установку ответом другой параллельной операции.
fn reporter_for_content(app: &AppHandle, instance_id: &str, op_id: Option<String>) -> Reporter {
    let reporter = reporter_for(app, instance_id);
    match op_id.filter(|id| {
        id.starts_with("install:")
            && id.len() <= 100
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b':' | b'-' | b'_'))
    }) {
        Some(id) => reporter.with_op(id),
        None => reporter,
    }
}

/* ==================== ИНФОРМАЦИЯ ==================== */

#[derive(Serialize)]
struct AppInfo {
    home: String,
    version: String,
    platform: String,
    demo: bool,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        home: state.paths.root.display().to_string(),
        version: omnispec_core::APP_VERSION.to_string(),
        platform: format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
        demo: false,
    }
}

#[tauri::command]
fn system_memory() -> Option<system_memory::SystemMemory> {
    system_memory::read()
}

/* ==================== НАСТРОЙКИ ==================== */

#[cfg(windows)]
fn scene_bounds(app: &AppHandle) -> scene_capture::Bounds {
    let Some(window) = app.get_webview_window("main") else { return scene_capture::Bounds::default(); };
    match (window.outer_position(), window.outer_size()) {
        (Ok(pos), Ok(size)) => scene_capture::Bounds { x: pos.x, y: pos.y, width: size.width, height: size.height },
        _ => scene_capture::Bounds::default(),
    }
}

/// Смена фона отменяет ожидающий запуск и закрывает только наше окно WE.
/// Дожидаемся очистки, пока настройки ещё заблокированы: иначе запоздалый
/// stop мог бы закрыть уже восстановленную сцену с тем же номером ревизии.
#[cfg(windows)]
async fn invalidate_scene(state: &AppState) {
    let epoch = state.scene_revision.fetch_add(1, Ordering::AcqRel) + 1;
    let revision = state.scene_revision.clone();
    let manager = state.scene_manager.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = manager.lock().unwrap_or_else(|e| e.into_inner());
        if revision.load(Ordering::Acquire) == epoch {
            if let Some(mut manager) = guard.take() {
                manager.stop(); // только окно с уникальным именем OmniSpec
                // Drop завершает также loopback-сервер кадров.
            }
        }
    }).await;
}

/// Пока удерживается scene_operation, завершаем abort до следующего prepare.
/// Иначе запоздалая очистка могла бы отменить новый кандидат той же ревизии.
#[cfg(windows)]
async fn stop_scene_epoch(state: &AppState, epoch: u64) {
    let manager = state.scene_manager.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Some(manager) = manager.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            manager.abort(epoch);
        }
    }).await;
}

#[cfg(windows)]
fn commit_scene(state: &AppState, epoch: u64) -> Result<(), String> {
    let mut guard = state.scene_manager.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_mut().ok_or("подготовленная сцена больше не доступна")?.commit(epoch)
}

#[cfg(windows)]
async fn start_scene(state: &AppState, app: &AppHandle, engine: String, project: PathBuf, epoch: u64) -> Result<wallpapers::Media, String> {
    let manager = state.scene_manager.clone();
    let revision = state.scene_revision.clone();
    let bounds = scene_bounds(app);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = manager.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() { *guard = Some(scene_capture::SceneManager::new()?); }
        let src = guard.as_mut().unwrap().prepare(Path::new(&engine), &project, bounds, revision, epoch)?;
        Ok(wallpapers::Media { path: project.to_string_lossy().into_owned(), kind: "scene".into(), src: Some(src) })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.lock().await.clone())
}

fn preserve_recovered_last_instance(paths: &Paths, current: &Settings, incoming: &mut Settings) {
    if let (Some(old), Some(new)) = (&incoming.last_instance, &current.last_instance) {
        if old != new && instances::load(paths, old).is_err() && instances::load(paths, new).is_ok() {
            incoming.last_instance = Some(new.clone());
        }
    }
}

/// Эти поля меняют только адресные команды. Отставший снимок общих настроек
/// не должен незаметно включить WE или вернуть прежний проект/звук.
fn preserve_wallpaper_controls(current: &Settings, incoming: &mut Settings) {
    incoming.wallpaper_engine_enabled = current.wallpaper_engine_enabled;
    incoming.wallpaper_workshop_audio = current.wallpaper_workshop_audio;
    incoming.wallpaper_workshop_project = current.wallpaper_workshop_project.clone();
}

#[tauri::command]
async fn save_settings(state: State<'_, AppState>, mut settings: Settings) -> Result<(), String> {
    // Записи settings.json не должны обгонять друг друга или видеть частичный файл.
    let mut current = state.settings.lock().await;
    // Снимок настроек мог попасть в очередь ещё до переноса id сборки.
    preserve_recovered_last_instance(&state.paths, &current, &mut settings);
    preserve_wallpaper_controls(&current, &mut settings);
    // Запрет действует сразу, даже если сохранить файл не удалось: до перезапуска
    // не начнём новых отправок и попытаемся отменить уже начатую.
    if !settings.discord_rpc { current.discord_rpc = false; }
    if !settings.discord_instance_icon { current.discord_instance_icon = false; }
    if !settings.discord_upload_local_icon { current.discord_upload_local_icon = false; }
    if !current.discord_rpc || !current.discord_instance_icon || !current.discord_upload_local_icon {
        state.rpc_upload_allowed.send_replace(false);
    }
    if !current.discord_rpc { state.presence.configure(false); }
    // Отзыв согласия выше действует немедленно даже при занятой установке.
    // Блокируем только смену Java, от которой зависит совместимость JAR.
    let _java_change = if current.java_path != settings.java_path
        || current.java_path_legacy != settings.java_path_legacy || current.auto_java != settings.auto_java {
        Some(reserve_content_write("__settings__", &state.content_access)?)
    } else { None };
    #[cfg(windows)]
    let wallpaper_changed = current.wallpaper != settings.wallpaper
        || current.wallpaper_workshop_project != settings.wallpaper_workshop_project;
    let wallpaper_path_changed = current.wallpaper_steam_path != settings.wallpaper_steam_path;
    settings.save(&state.paths).map_err(err)?;
    state.presence.configure(settings.discord_rpc);
    *current = settings;
    if wallpaper_path_changed { state.wallpaper_revision.fetch_add(1, Ordering::AcqRel); }
    #[cfg(windows)]
    if wallpaper_changed { invalidate_scene(&state).await; }
    state.rpc_upload_allowed.send_replace(
        current.discord_rpc && current.discord_instance_icon && current.discord_upload_local_icon
    );
    Ok(())
}

/// Выключение касается только интеграции OmniSpec, не обоев рабочего стола.
/// Запись, отзыв видео и отмена сцены защищены той же блокировкой настроек.
#[tauri::command]
async fn set_wallpaper_engine_enabled(state: State<'_, AppState>, enabled: bool) -> Result<Settings, String> {
    let mut current = state.settings.lock().await;
    if current.wallpaper_engine_enabled != enabled {
        let mut next = current.clone();
        next.wallpaper_engine_enabled = enabled;
        next.save(&state.paths).map_err(err)?;
        *current = next;
        state.wallpaper_revision.fetch_add(1, Ordering::AcqRel);
    }
    if !enabled {
        // Свой видеофон продолжает работать, если использует этот сервер.
        revoke_video_slot(&state, "workshop");
        #[cfg(windows)]
        invalidate_scene(&state).await;
    }
    Ok(current.clone())
}

/// Звук управляется исключительно в видеоплеере OmniSpec, не через глобальный
/// mute Wallpaper Engine и не через общую аудиосессию Windows.
#[tauri::command]
async fn set_wallpaper_workshop_audio(state: State<'_, AppState>, enabled: bool) -> Result<Settings, String> {
    let mut current = state.settings.lock().await;
    let mut next = current.clone();
    next.wallpaper_workshop_audio = enabled;
    next.save(&state.paths).map_err(err)?;
    *current = next;
    Ok(current.clone())
}

/// Статус в Discord: фронт сообщает режим, сборку и время начала.
#[tauri::command]
async fn set_presence(
    state: State<'_, AppState>,
    mode: String,
    details: String,
    state_text: String,
    started_at: Option<u64>,
    small_image: Option<String>,
) -> Result<(), String> {
    let settings = state.settings.lock().await;
    let small_image = if settings.discord_rpc && settings.discord_instance_icon {
        small_image.filter(|url| {
            let temporary = reqwest::Url::parse(url).ok()
                .is_some_and(|parsed| parsed.host_str() == Some("d.tmpfile.link"));
            presence::valid_image_url(url) && (settings.discord_upload_local_icon || !temporary)
        })
    } else {
        None
    };
    state.presence.set(presence::PresenceInfo {
        mode,
        details,
        state: state_text,
        started_at,
        small_image,
    });
    Ok(())
}

/// Найти публичную иконку сборки. Пересылка локальных изображений возможна
/// исключительно по отдельному сохранённому согласию в настройках Discord.
#[tauri::command]
async fn resolve_presence_icon(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Option<String>, String> {
    let _guard = state.rpc_icon_lock.lock().await;
    let settings = state.settings.lock().await.clone();
    if !settings.discord_rpc || !settings.discord_instance_icon { return Ok(None); }
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let Some(image) = rpc_icons::read_local(&state.paths, &meta)? else { return Ok(None); };
    if let Some(url) = rpc_icons::cached(&state.paths, &image, settings.discord_upload_local_icon) {
        return Ok(Some(url));
    }
    if let Some(url) = rpc_icons::find_public(&state.http, &state.modrinth, &state.curseforge, &meta, &image).await {
        rpc_icons::remember(&state.paths, &image, &url, false);
        let current = state.settings.lock().await;
        return Ok((current.discord_rpc && current.discord_instance_icon).then_some(url));
    }
    // Согласие могло измениться, пока искали картинку проекта.
    let permission = {
        let current = state.settings.lock().await;
        if !current.discord_rpc || !current.discord_instance_icon || !current.discord_upload_local_icon {
            return Ok(None);
        }
        state.rpc_upload_allowed.subscribe()
    };
    let Some(result) = rpc_icons::until_revoked(
        permission, rpc_icons::upload_temporary(&state.http, &image)
    ).await else { return Ok(None); };
    let url = result?;
    rpc_icons::remember(&state.paths, &image, &url, true);
    let current = state.settings.lock().await;
    Ok((current.discord_rpc && current.discord_instance_icon && current.discord_upload_local_icon).then_some(url))
}

/* ==================== СБОРКИ ==================== */

#[tauri::command]
async fn list_instances(state: State<'_, AppState>) -> Result<Vec<InstanceMeta>, String> {
    // Не переназначаем id процесса или незаконченной установки. Тот же порядок
    // блокировок, что у запуска: running → content → launching.
    let list = {
        let running = state.running.lock().await;
        let content = state.content_access.lock().unwrap_or_else(|e| e.into_inner());
        let launching = state.launching.lock().unwrap_or_else(|e| e.into_inner());
        let mut blocked: HashSet<String> = running.keys()
            .map(|key| run_instance_id(key).to_string()).collect();
        blocked.extend(launching.keys().cloned());
        blocked.extend(content.writers.keys().cloned());
        blocked.extend(content.repairing.iter().cloned());
        instances::list_with_blocked(&state.paths, &blocked).map_err(err)?
    };
    // Сохраняем ссылку в настройках, если её можно перенести однозначно.
    let mut settings = state.settings.lock().await;
    if let Some(old) = settings.last_instance.clone() {
        if !list.iter().any(|item| item.id == old) {
            let candidates: Vec<_> = list.iter().filter(|item| item.renamed_froms.contains(&old)).collect();
            if candidates.len() == 1 {
                let mut updated = settings.clone();
                updated.last_instance = Some(candidates[0].id.clone());
                // Если запись не удалась, не подтверждаем переименование: маркер
                // позволит повторить перенос последней сборки при следующем списке.
                updated.save(&state.paths).map_err(|error| format!("не удалось обновить последнюю сборку в настройках: {error}"))?;
                *settings = updated;
            }
        }
    }
    Ok(list)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameAcknowledgement {
    id: String,
    previous_ids: Vec<String>,
}

/// UI подтвердил обработанные связи; новые изменения не стираем.
#[tauri::command]
fn acknowledge_instance_renames(
    state: State<'_, AppState>, acknowledgements: Vec<RenameAcknowledgement>,
) -> Result<(), String> {
    for item in acknowledgements {
        instances::acknowledge_renames(&state.paths, &item.id, &item.previous_ids).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
async fn create_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    req: CreateInstanceRequest,
) -> Result<InstanceMeta, String> {
    let _write = reserve_content_write("__create__", &state.content_access)?;
    let meta = instances::create(&state.paths, req).map_err(err)?;
    let reporter = reporter_for(&app, &meta.id);
    reporter.emit("loader", 0, 1, "готовим профиль версии");
    // Сразу готовим профиль загрузчика, чтобы сборка была готова к запуску.
    if let Err(error) = loaders::ensure_profile(&state.http, &state.paths, &meta, &reporter).await {
        eprintln!("[omnispec] профиль загрузчика не установлен: {error}");
    }
    reporter.emit("loader", 1, 1, "готово");
    instances::load(&state.paths, &meta.id).map_err(err)
}

#[derive(Serialize)]
struct ModCreateOutcome {
    instance: InstanceMeta,
    outcome: Option<modrinth_install::InstallOutcome>,
    /// Не удаляем созданную сборку автоматически: там уже могут появиться данные.
    install_error: Option<String>,
    profile_warning: Option<String>,
}

/// Создание по подтверждённому варианту мода. Все проверки выполняются ДО
/// создания каталога: тип проекта, принадлежность файла, совместимость,
/// настоящий Minecraft и доступная версия загрузчика.
#[tauri::command]
async fn create_instance_for_mod(
    app: AppHandle,
    state: State<'_, AppState>,
    req: CreateInstanceRequest,
    source: String,
    project_id: String,
    version_id: String,
    op_id: Option<String>,
) -> Result<ModCreateOutcome, String> {
    let _create = reserve_content_write("__create__", &state.content_access)?;
    if req.game_dir.is_some() || req.id.is_some() {
        return Err("новая сборка с модом создаётся только в отдельной папке лаунчера".into());
    }
    let loader_version = req.loader.version().filter(|version| !version.trim().is_empty())
        .ok_or_else(|| "для мода нужен поддерживаемый загрузчик".to_string())?;
    let (project, version) = match source.as_str() {
        "modrinth" => (
            state.modrinth.project(&project_id).await.map_err(err)?,
            state.modrinth.version(&version_id).await.map_err(err)?,
        ),
        "curseforge" => (
            state.curseforge.project(&project_id).await.map_err(err)?,
            state.curseforge.file(&project_id, &version_id).await.map_err(err)?,
        ),
        _ => return Err("неизвестный каталог модов".into()),
    };
    if project.project_type != "mod" || version.project_id != project.id || version.id != version_id {
        return Err("выбранный файл не принадлежит этому моду".into());
    }
    if version.primary_file().is_none() { return Err("у выбранной версии нет файла".into()); }
    modrinth_install::validate_mod_compatibility(&version, req.mc_version.trim(), req.loader.kind()).map_err(err)?;
    let manifest = game::fetch_manifest(&state.http, &state.paths, Duration::from_secs(1800)).await.map_err(err)?;
    if !manifest.versions.iter().any(|item| item.id == req.mc_version.trim()) {
        return Err("эта версия Minecraft отсутствует в официальном манифесте".into());
    }
    let choices = loaders::loader_versions(&state.http, req.loader.kind(), req.mc_version.trim()).await.map_err(err)?;
    if !choices.iter().any(|option| option.version == loader_version) {
        return Err("эта версия загрузчика недоступна для выбранного Minecraft".into());
    }

    let meta = instances::create(&state.paths, req).map_err(err)?;
    let _instance = match reserve_content_write(&meta.id, &state.content_access) {
        Ok(guard) => guard,
        Err(error) => return Ok(ModCreateOutcome { instance: meta, outcome: None, install_error: Some(error), profile_warning: None }),
    };
    let reporter = reporter_for_content(&app, &meta.id, op_id);
    let profile_warning = loaders::ensure_profile(&state.http, &state.paths, &meta, &reporter)
        .await.err().map(|error| error.to_string());
    let current = match instances::load(&state.paths, &meta.id) {
        Ok(value) => value,
        Err(error) => return Ok(ModCreateOutcome { instance: meta, outcome: None, install_error: Some(error.to_string()), profile_warning }),
    };
    let installed = match source.as_str() {
        "modrinth" => modrinth_install::install_version(&state.modrinth, &state.paths, &current, &version_id, &reporter).await,
        "curseforge" => curseforge_install::install(&state.curseforge, &state.paths, &current, &project_id, Some(&version_id), &reporter).await,
        _ => unreachable!(),
    };
    let (outcome, install_error) = match installed {
        Ok(outcome) => (Some(outcome), None),
        Err(error) => (None, Some(error.to_string())),
    };
    let instance = instances::load(&state.paths, &meta.id).unwrap_or(current);
    Ok(ModCreateOutcome { instance, outcome, install_error, profile_warning })
}

#[tauri::command]
fn delete_instance(state: State<'_, AppState>, instance_id: String) -> Result<(), String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    instances::delete(&state.paths, &instance_id).map_err(err)
}

/// Дублировать сборку: копия с новым id и именем «… (копия)».
#[tauri::command]
fn duplicate_instance(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<InstanceMeta, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    instances::duplicate(&state.paths, &instance_id).map_err(err)
}

#[tauri::command]
fn update_instance(state: State<'_, AppState>, meta: InstanceMeta) -> Result<(), String> {
    let _write = reserve_content_write(&meta.id, &state.content_access)?;
    instances::save(&state.paths, &meta).map_err(err)
}

/* ==================== ВЕРСИИ И ЗАГРУЗЧИКИ ==================== */

#[tauri::command]
async fn minecraft_versions(
    state: State<'_, AppState>,
    snapshots: bool,
) -> Result<Vec<game::VersionEntry>, String> {
    let manifest = game::fetch_manifest(&state.http, &state.paths, Duration::from_secs(1800))
        .await
        .map_err(err)?;
    Ok(game::filter_versions(&manifest, snapshots))
}

#[tauri::command]
async fn loader_versions(
    state: State<'_, AppState>,
    kind: String,
    mc_version: String,
) -> Result<Vec<LoaderOption>, String> {
    loaders::loader_versions(&state.http, &kind, &mc_version)
        .await
        .map_err(err)
}

/* ==================== УСТАНОВКА И ЗАПУСК ==================== */

#[tauri::command]
async fn install_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Value, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let reporter = reporter_for(&app, &instance_id);
    // id возвращаемый ensure_profile — реальный: инсталлятор мог назвать
    // папку профиля иначе, чем version_id() ожидает.
    let version_id = loaders::ensure_profile(&state.http, &state.paths, &meta, &reporter)
        .await
        .map_err(err)?;
    let report =
        game::install::ensure_installed(&state.http, &state.paths, &version_id, &reporter)
            .await
            .map_err(err)?;
    Ok(json!({
        "version": report.version_id,
        "classpath": report.classpath.len(),
        "assets": report.asset_index_id,
    }))
}

#[tauri::command]
async fn launch_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    account_uuid: Option<String>,
    attempt_id: Option<String>,
) -> Result<Value, String> {
    // Фронт создаёт токен до подготовки и получает его обратно в событиях —
    // они могут прийти даже раньше результата команды launch_instance.
    let attempt_id = attempt_id.filter(|id| {
        !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    });
    let _reservation = {
        let running = state.running.lock().await;
        let has_running = running
            .keys()
            .any(|key| run_instance_id(key) == instance_id.as_str());
        // Порядок блокировок совпадает с установкой: running → content → launching.
        let _content = state.content_access.lock().unwrap_or_else(|e| e.into_inner());
        if !_content.repairing.is_empty() { return Err("дождись окончания установки из диагностики".into()); }
        let reservation = reserve_launch(
            &instance_id,
            account_uuid.is_some(),
            has_running,
            &state.launching,
        )?;
        // Даже неудачная новая попытка делает старый диагностический контекст
        // неактуальным. Запись делается внутри общей секции резервирования.
        let mut attempts = state.diagnostic_launches.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(id) = &attempt_id {
            attempts.insert(instance_id.clone(), DiagnosticLaunch { attempt_id: id.clone(), actual: None });
        } else {
            attempts.remove(&instance_id);
        }
        reservation
    };
    // Случайный id не повторяется и после перезапуска лаунчера.
    let run_id = game_sessions::new_run_id(&instance_id)?;

    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let settings = state.settings.lock().await.clone();
    let account = account_for(&state, &settings, account_uuid.as_deref()).await?;
    // Прогресс подготовки привязан к той же попытке, что и диагностика.
    let reporter = reporter_for(&app, &instance_id).with_op(format!(
        "launch:{}",
        attempt_id.as_deref().unwrap_or(&run_id)
    ));

    let plan = game::launch::prepare(
        &state.http,
        &state.paths,
        &meta,
        &settings,
        &account,
        &reporter,
    )
    .await
    .map_err(err)?;

    let mut child = game::launch::spawn(&plan).map_err(err)?;
    if let Some(id) = &attempt_id {
        let mut attempts = state.diagnostic_launches.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = attempts.get_mut(&instance_id).filter(|entry| &entry.attempt_id == id) {
            // Java из реального плана, а не догадка UI по настройкам. Если
            // снимок mods недоступен, запуск продолжается без автоисправления.
            let mods = instances::game_dir_for(&state.paths, &meta).join("mods");
            entry.actual = omnispec_core::diagnostic_install::snapshot_mods(&mods).ok()
                .map(|snapshot| (DiagnosticConfig::new(&state.paths, &meta, &settings, plan.version_id.clone()), plan.java_major, snapshot));
        }
    }
    instances::touch_play(&state.paths, &instance_id).ok();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let game_dir = PathBuf::from(&plan.game_dir);
    let game_dir = game_dir.canonicalize().unwrap_or(game_dir);
    let started_at = game_sessions::now();
    let record = child.id().and_then(game_sessions::identify).map(|process| game_sessions::SessionRecord {
        run_id: run_id.clone(), instance_id: instance_id.clone(), account: account.username.clone(),
        game_dir: game_dir.to_string_lossy().into_owned(), started_at, checkpoint_at: started_at,
        ended_at: None, process,
    });
    let record = match record {
        Some(record) => match game_sessions::save(&state.paths.root, &record) {
            Ok(()) => Some(record),
            Err(error) => {
                emit_game_log(&app, &instance_id, &run_id, attempt_id.as_deref(),
                    format!("[omnispec] Не удалось сохранить состояние игры для перезапуска лаунчера: {error}"));
                // Не создаём журнал позднее из устаревшего снимка: другая копия
                // могла бы принять уже завершённый запуск за новый. Пока это
                // окно открыто, обычный счётчик продолжает учитывать время.
                None
            }
        },
        None => {
            emit_game_log(&app, &instance_id, &run_id, attempt_id.as_deref(),
                "[omnispec] ОС не позволила проверить идентификатор игры; восстановление после перезапуска недоступно".into());
            None
        }
    };
    let child = Arc::new(RunningChild {
        child: Mutex::new(Some(child)),
        record: record.map(StdMutex::new), account: account.username.clone(), started_at,
        game_dir,
        stop_requested: AtomicBool::new(false),
    });
    state
        .running
        .lock()
        .await
        .insert(run_id.clone(), child.clone());

    emit_game_log(
        &app,
        &instance_id,
        &run_id,
        attempt_id.as_deref(),
        format!(
            "[omnispec] запуск: {} (аргументов {}, файлов в classpath {}, подготовка {} мс)",
            plan.java,
            plan.args.len(),
            plan.classpath_entries,
            plan.prepare_ms
        ),
    );

    let mut pumps = Vec::new();
    if let Some(stdout) = stdout {
        pumps.push(spawn_pump(
            app.clone(),
            instance_id.clone(),
            run_id.clone(),
            attempt_id.clone(),
            stdout,
        ));
    }
    if let Some(stderr) = stderr {
        pumps.push(spawn_pump(
            app.clone(),
            instance_id.clone(),
            run_id.clone(),
            attempt_id.clone(),
            stderr,
        ));
    }

    // Один наблюдатель работает и с собственным Child, и после восстановления.
    monitor_game(app.clone(), instance_id.clone(), run_id.clone(), attempt_id.clone(),
        child, state.running.clone(), state.paths.clone(), pumps, false);

    let mut summary = launch_summary(&plan);
    if let Some(map) = summary.as_object_mut() {
        map.insert("run_id".into(), json!(run_id));
        map.insert("account".into(), json!(account.username));
        map.insert("account_uuid".into(), json!(account.uuid));
        map.insert("started_at".into(), json!(started_at));
    }
    Ok(summary)
}

/// После восстановления код выхода неизвестен — не выдаём его за ошибку.
/// Логи stdout/stderr восстановить нельзя: их pipes принадлежали старому окну.
fn monitor_game(
    app: AppHandle,
    id: String,
    session: String,
    attempt: Option<String>,
    child: ChildHandle,
    running: Arc<Mutex<HashMap<String, ChildHandle>>>,
    paths: Paths,
    pumps: Vec<tokio::task::JoinHandle<()>>,
    recovered: bool,
) {
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let mut flushed: u64 = 0;
        let mut first = true;
        let mut observed_alive = !recovered;
        loop {
            if !first { tokio::time::sleep(Duration::from_millis(700)).await; }
            first = false;
            let (finished, code, stopped) = {
                let mut guard = child.child.lock().await;
                let stopped = child.stop_requested.load(Ordering::Relaxed);
                if let Some(process) = guard.as_mut() {
                    match process.try_wait() {
                        Ok(Some(status)) => (true, Some(status.code().unwrap_or(-1)), stopped),
                        _ => (false, None, stopped),
                    }
                } else {
                    let alive = child.record.as_ref().map(|r| {
                        let r = r.lock().unwrap_or_else(|e| e.into_inner());
                        game_sessions::is_alive(&r.process)
                    }).unwrap_or(false);
                    (!alive, None, stopped)
                }
            };
            let elapsed = started.elapsed().as_secs();
            if let Some(record) = &child.record {
                let mut record = record.lock().unwrap_or_else(|e| e.into_inner());
                let now = game_sessions::now();
                if finished {
                    // Время выхода неизвестно, если восстановленный процесс
                    // завершился прежде, чем мы успели подтвердить его жизнь.
                    let until = if observed_alive { now } else { record.checkpoint_at };
                    record.ended_at = Some(until);
                    if let Err(error) = game_sessions::finalize(&paths, &record, until) {
                        emit_game_log(&app, &id, &session, attempt.as_deref(), format!(
                            "[omnispec] Не удалось сохранить итоговое время игры; журнал оставлен для повтора: {error}"
                        ));
                    }
                } else {
                    observed_alive = true;
                    let delta = now.saturating_sub(record.checkpoint_at);
                    if delta >= 60 || (recovered && flushed == 0) {
                        // Журнал и счётчик согласованы между копиями лаунчера:
                        // удалённую другой копией сессию нельзя воскресить.
                        let _ = game_sessions::checkpoint(&paths, &mut record, now);
                        flushed = elapsed.saturating_add(1);
                    }
                }
            } else if elapsed >= flushed + 60 || finished {
                instances::add_playtime(&paths, &id, elapsed.saturating_sub(flushed));
                flushed = elapsed;
            }
            if finished {
                running.lock().await.remove(&session);
                if !finish_pumps(pumps, Duration::from_secs(3)).await {
                    emit_game_log(&app, &id, &session, attempt.as_deref(),
                        "[omnispec] Не удалось полностью дочитать вывод игры после её завершения".into());
                }
                let _ = app.emit("game-exit", json!({
                    "instance": id, "code": code, "run_id": session,
                    "attempt_id": attempt, "stopped": stopped, "recovered": recovered
                }));
                break;
            }
        }
    });
}

fn launch_summary(plan: &LaunchPlan) -> Value {
    json!({
        "instance_id": plan.instance_id,
        "version_id": plan.version_id,
        "java": plan.java,
        "java_major": plan.java_major,
        "memory_mb": plan.memory_mb,
        "classpath_entries": plan.classpath_entries,
        "game_dir": plan.game_dir,
        "prepare_ms": plan.prepare_ms,
    })
}

fn emit_game_log(
    app: &AppHandle,
    instance_id: &str,
    run_id: &str,
    attempt_id: Option<&str>,
    line: String,
) {
    let _ = app.emit(
        "game-log",
        json!({
            "instance": instance_id, "run_id": run_id, "attempt_id": attempt_id, "line": line
        }),
    );
}

/// Разбиваем очень длинные строки на ограниченные части и не прерываем чтение
/// при не-UTF-8 байтах (например, вывод системной программы на Windows).
async fn pump_lines<R, F>(reader: R, mut emit: F)
where
    R: tokio::io::AsyncRead + Unpin,
    F: FnMut(String),
{
    const MAX_LINE_BYTES: u64 = 64 * 1024;
    let mut reader = BufReader::new(reader);
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        let result = (&mut reader)
            .take(MAX_LINE_BYTES)
            .read_until(b'\n', &mut bytes)
            .await;
        match result {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if bytes.last() == Some(&b'\n') {
                    bytes.pop();
                }
                if bytes.last() == Some(&b'\r') {
                    bytes.pop();
                }
                emit(String::from_utf8_lossy(&bytes).into_owned());
            }
        }
    }
}

fn spawn_pump<R>(
    app: AppHandle,
    instance_id: String,
    run_id: String,
    attempt_id: Option<String>,
    reader: R,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        pump_lines(reader, |line| {
            emit_game_log(&app, &instance_id, &run_id, attempt_id.as_deref(), line);
        })
        .await;
    })
}

/// Ограниченное ожидание stdout и stderr. По таймауту отменяем и дожидаемся
/// оставшихся задач, чтобы они не продолжали отправлять строки после game-exit.
async fn finish_pumps(mut pumps: Vec<tokio::task::JoinHandle<()>>, limit: Duration) -> bool {
    let mut completed = 0;
    let finished = tokio::time::timeout(limit, async {
        for pump in &mut pumps {
            let _ = pump.await;
            completed += 1;
        }
    })
    .await
    .is_ok();
    if !finished {
        for pump in pumps.iter().skip(completed) {
            pump.abort();
        }
        for pump in pumps.into_iter().skip(completed) {
            let _ = pump.await;
        }
    }
    finished
}

fn run_instance_id(key: &str) -> &str {
    key.rsplit_once('#').map(|(id, _)| id).unwrap_or(key)
}

/// Ключ сессии в `state.running` — «id#2». Из интерфейса приходит уже полный
/// ключ, но принимаем и короткий номер: раньше «id#2» превращался в «id#id#2»,
/// и дубликат не выключался («сборка не запущена»).
fn run_key(instance_id: &str, run_id: Option<String>) -> Option<String> {
    let value = run_id?;
    if value.contains('#') {
        Some(value)
    } else {
        Some(format!("{instance_id}#{value}"))
    }
}

#[tauri::command]
async fn stop_instance(
    state: State<'_, AppState>,
    instance_id: String,
    run_id: Option<String>,
) -> Result<(), String> {
    // run_id задан — гасим только это окно (дубликат), иначе все окна сборки
    let exact = run_key(&instance_id, run_id);
    if exact.as_ref().is_some_and(|key| run_instance_id(key) != instance_id) {
        return Err("этот запуск относится к другой сборке".into());
    }
    let handles: Vec<ChildHandle> = {
        let running = state.running.lock().await;
        running
            .iter()
            .filter(|(key, _)| match &exact {
                Some(target) => key.as_str() == target,
                None => run_instance_id(key) == instance_id.as_str(),
            })
            .map(|(_, handle)| handle.clone())
            .collect()
    };
    if handles.is_empty() {
        return Err("сборка не запущена".into());
    }
    for child in handles {
        request_stop(&child).await?;
    }
    Ok(())
}

async fn request_stop(child: &ChildHandle) -> Result<(), String> {
    let mut guard = child.child.lock().await;
    if let Some(process) = guard.as_mut() {
        process.start_kill().map_err(err)?;
    } else {
        let record = child.record.as_ref().ok_or("идентификатор процесса недоступен")?
            .lock().unwrap_or_else(|e| e.into_inner());
        game_sessions::terminate(&record.process)?;
    }
    // Пока замок занят, наблюдатель не успеет прочитать код завершения.
    child.stop_requested.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn running_instances(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let running = state.running.lock().await;
    let mut result: Vec<String> = Vec::new();
    for key in running.keys() {
        let id = run_instance_id(key).to_string();
        if !result.contains(&id) {
            result.push(id);
        }
    }
    Ok(result)
}

#[derive(Serialize)]
struct RunningSessionInfo {
    instance_id: String,
    run_id: String,
    account: String,
    started_at: u64,
}

#[tauri::command]
async fn running_sessions(state: State<'_, AppState>) -> Result<Vec<RunningSessionInfo>, String> {
    let running = state.running.lock().await;
    let mut result: Vec<_> = running.iter().map(|(key, child)| RunningSessionInfo {
        instance_id: run_instance_id(key).to_string(), run_id: key.clone(),
        account: child.account.clone(), started_at: child.started_at,
    }).collect();
    result.sort_by(|a, b| (a.started_at, &a.run_id).cmp(&(b.started_at, &b.run_id)));
    Ok(result)
}

/* ==================== MODRINTH ==================== */

#[tauri::command]
async fn search_modrinth(
    state: State<'_, AppState>,
    query: String,
    project_type: String,
    mc_version: Option<String>,
    loader: Option<String>,
    offset: Option<u32>,
    // Сортировка Modrinth: relevance | downloads | follows | newest | updated
    // (в параметрах команды doc-комментарии Rust не разрешает).
    sort: Option<String>,
    limit: Option<u32>,
    categories: Option<Vec<String>>,
) -> Result<omnispec_core::modrinth::SearchResults, String> {
    state
        .modrinth
        .search(&SearchQuery {
            query,
            project_type,
            game_version: mc_version,
            loader,
            categories: categories.unwrap_or_default(),
            limit: limit.unwrap_or(24),
            offset: offset.unwrap_or(0),
            sort: sort.unwrap_or_else(|| "relevance".into()),
        })
        .await
        .map_err(err)
}

#[tauri::command]
async fn modrinth_versions(
    state: State<'_, AppState>,
    project_id: String,
    mc_version: Option<String>,
    loader: Option<String>,
) -> Result<Vec<omnispec_core::modrinth::Version>, String> {
    state
        .modrinth
        .project_versions(&project_id, mc_version.as_deref(), loader.as_deref())
        .await
        .map_err(err)
}

#[tauri::command]
async fn modrinth_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<omnispec_core::modrinth::Project, String> {
    state.modrinth.project(&project_id).await.map_err(err)
}

/* ==================== CURSEFORGE ==================== */

/// Поиск на CurseForge: та же структура ответа, что у Modrinth, — поэтому
/// интерфейс рисует обе площадки одинаковыми карточками.
#[tauri::command]
async fn search_curseforge(
    state: State<'_, AppState>,
    query: String,
    project_type: String,
    mc_version: Option<String>,
    loader: Option<String>,
    offset: Option<u32>,
    sort: Option<String>,
    limit: Option<u32>,
    categories: Option<Vec<String>>,
) -> Result<omnispec_core::modrinth::SearchResults, String> {
    state
        .curseforge
        .search(&SearchQuery {
            query,
            project_type,
            game_version: mc_version,
            loader,
            categories: categories.unwrap_or_default(),
            limit: limit.unwrap_or(24),
            offset: offset.unwrap_or(0),
            sort: sort.unwrap_or_else(|| "downloads".into()),
        })
        .await
        .map_err(err)
}

#[tauri::command]
async fn curseforge_versions(
    state: State<'_, AppState>,
    project_id: String,
    mc_version: Option<String>,
    loader: Option<String>,
) -> Result<Vec<omnispec_core::modrinth::Version>, String> {
    state
        .curseforge
        .files(&project_id, mc_version.as_deref(), loader.as_deref())
        .await
        .map_err(err)
}

/// Последние файлы для разных версий игры и загрузчиков (не только первая
/// страница `/files`), для выбора параметров новой сборки с модом.
#[tauri::command]
async fn curseforge_compatibility_versions(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<omnispec_core::modrinth::Version>, String> {
    state.curseforge.compatibility_versions(&project_id).await.map_err(err)
}

#[tauri::command]
async fn curseforge_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<omnispec_core::modrinth::Project, String> {
    state.curseforge.project(&project_id).await.map_err(err)
}

/// Есть ли ключ CurseForge: без него вкладка честно скажет об этом.
#[tauri::command]
fn curseforge_ready(state: State<'_, AppState>) -> bool {
    state.curseforge.has_key()
}

/// Поставить проект с CurseForge: `file_id` — если версия выбрана вручную.
#[tauri::command]
async fn install_curseforge(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    project_id: String,
    file_id: Option<String>,
    op_id: Option<String>,
) -> Result<curseforge_install::InstallOutcome, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let reporter = reporter_for_content(&app, &instance_id, op_id);
    curseforge_install::install(
        &state.curseforge,
        &state.paths,
        &meta,
        &project_id,
        file_id.as_deref(),
        &reporter,
    )
    .await
    .map_err(err)
}

/// Поставить модпак CurseForge как новую сборку: манифест внутри архива
/// задаёт версию игры, загрузчик и список файлов.
#[tauri::command]
async fn install_curseforge_modpack(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    file_id: Option<String>,
    op_id: Option<String>,
) -> Result<InstanceMeta, String> {
    let _write = reserve_content_write("__modpack__", &state.content_access)?;
    let reporter = reporter_for_content(&app, "modpack", op_id);
    curseforge_modpack::install(
        &state.curseforge,
        &state.paths,
        &project_id,
        file_id.as_deref(),
        &reporter,
    )
    .await
    .map_err(err)
}

#[tauri::command]
async fn install_mod(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    project_id: String,
    op_id: Option<String>,
) -> Result<modrinth_install::InstallOutcome, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let reporter = reporter_for_content(&app, &instance_id, op_id);
    modrinth_install::install_project(&state.modrinth, &state.paths, &meta, &project_id, &reporter)
        .await
        .map_err(err)
}

/// Скачивание найденной в логе зависимости с проверкой профиля и JAR.
#[tauri::command]
async fn install_diagnostic_mod(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    attempt_id: String,
    mut request: omnispec_core::diagnostic_install::InstallRequest,
) -> Result<omnispec_core::diagnostic_install::InstallResult, String> {
    let before = instances::load(&state.paths, &instance_id).map_err(err)?;
    let target = normalized_game_dir(&state.paths, &before);
    let _reservation = {
        let running = state.running.lock().await;
        let has_running = running.values().any(|child| child.game_dir == target);
        reserve_diagnostic_repair(&instance_id, has_running, &state.launching, &state.content_access)?
    };
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    if normalized_game_dir(&state.paths, &meta) != target { return Err("папка сборки изменилась; повтори запуск".into()); }
    let settings = state.settings.lock().await.clone();
    let attempt = state.diagnostic_launches.lock().unwrap_or_else(|e| e.into_inner())
        .get(&instance_id).cloned().ok_or_else(|| "данные последнего запуска недоступны; запусти сборку снова".to_string())?;
    if attempt.attempt_id != attempt_id { return Err("это не последняя попытка запуска; проверь новую диагностику".into()); }
    let (used_config, used_java, used_mods) = attempt.actual.ok_or_else(|| "данные последнего запуска не определены; запусти сборку снова".to_string())?;
    let now = DiagnosticConfig::new(&state.paths, &meta, &settings, meta.version_id());
    if used_config != now { return Err("настройки игры, загрузчика или Java изменились после запуска; запусти сборку снова".into()); }
    let current_mods = omnispec_core::diagnostic_install::snapshot_mods(&instances::game_dir_for(&state.paths, &meta).join("mods")).map_err(err)?;
    if used_mods != current_mods { return Err("файлы mods изменились после запуска; запусти сборку снова для актуальной диагностики".into()); }
    request.java_major = Some(used_java);
    let reporter = reporter_for(&app, &instance_id);
    let result = match omnispec_core::diagnostic_install::install_missing(&state.modrinth, &state.paths, &meta, &request, &reporter).await {
        Ok(result) => result,
        Err(error) => {
            let status = if matches!(error, omnispec_core::error::Error::Cancelled) { "cancelled" } else { "error" };
            reporter.emit_state("mods", status, error.to_string());
            return Err(err(error));
        }
    };
    if result.status != "existing" {
        state.diagnostic_launches.lock().unwrap_or_else(|e| e.into_inner()).remove(&instance_id);
    }
    Ok(result)
}

#[tauri::command]
async fn install_mod_version(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    version_id: String,
    op_id: Option<String>,
    project_id: Option<String>,
) -> Result<modrinth_install::InstallOutcome, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    if let Some(project_id) = project_id {
        let project = state.modrinth.project(&project_id).await.map_err(err)?;
        let version = state.modrinth.version(&version_id).await.map_err(err)?;
        if version.project_id != project.id || version.id != version_id {
            return Err("выбранная версия принадлежит другому проекту".into());
        }
    }
    let reporter = reporter_for_content(&app, &instance_id, op_id);
    modrinth_install::install_version(&state.modrinth, &state.paths, &meta, &version_id, &reporter)
        .await
        .map_err(err)
}

/// Отменить текущую загрузку (кнопка в панели загрузок).
#[tauri::command]
fn cancel_download() {
    omnispec_core::net::cancel_current();
}

/// Установить модпак: принимает id версии Modrinth **или** путь к локальному `.mrpack`.
#[tauri::command]
async fn install_modpack(
    app: AppHandle,
    state: State<'_, AppState>,
    version_id: String,
    op_id: Option<String>,
) -> Result<InstanceMeta, String> {
    let _write = reserve_content_write("__modpack__", &state.content_access)?;
    let reporter = reporter_for_content(&app, "modpack", op_id);
    let source = version_id.trim().to_string();

    // 1) локальный файл .mrpack
    let as_path = PathBuf::from(&source);
    if as_path.exists() {
        return mrpack::install_archive(&state.modrinth, &state.paths, &as_path, None, &reporter)
            .await
            .map_err(err);
    }

    // 2) ссылка: страница модпака на Modrinth или прямой файл .mrpack
    if source.starts_with("http://") || source.starts_with("https://") {
        if source.to_lowercase().contains("modrinth.com") && !source.contains(".mrpack") {
            let slug = source
                .split('/')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .into_iter()
                .skip_while(|part| !part.contains("modrinth.com"))
                .nth(2)
                .map(|slug| slug.split(['?', '#']).next().unwrap_or(slug).to_string())
                .ok_or_else(|| {
                    "не понял ссылку — нужна вида modrinth.com/modpack/<название>".to_string()
                })?;
            let versions = state.modrinth.modpack_versions(&slug).await.map_err(err)?;
            let version = versions
                .into_iter()
                .next()
                .ok_or_else(|| format!("у модпака «{slug}» нет версий"))?;
            return mrpack::install(&state.modrinth, &state.paths, &version, &reporter)
                .await
                .map_err(err);
        }

        let name = source
            .split('/')
            .last()
            .unwrap_or("pack.mrpack")
            .split(['?', '#'])
            .next()
            .unwrap_or("pack.mrpack");
        let file_name = if name.to_lowercase().ends_with(".mrpack") {
            name.to_string()
        } else {
            format!("{name}.mrpack")
        };
        let temp = state.paths.cache().join(&file_name);
        state
            .http
            .download(&source, &temp, None, None, false)
            .await
            .map_err(err)?;
        return mrpack::install_archive(&state.modrinth, &state.paths, &temp, None, &reporter)
            .await
            .map_err(err);
    }
    let version = state.modrinth.version(&version_id).await.map_err(err)?;
    mrpack::install(&state.modrinth, &state.paths, &version, &reporter)
        .await
        .map_err(err)
}

/* ==================== ФАЙЛЫ СБОРКИ ==================== */

#[derive(Serialize)]
struct FileEntry {
    name: String,
    is_dir: bool,
    size: u64,
    path: String,
    /// Время изменения в секундах от эпохи — колонка «Изменён» в файловом менеджере.
    modified: Option<u64>,
}

fn safe_join(base: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(relative.replace('\\', "/"));
    if candidate.is_absolute() {
        return Err("абсолютные пути запрещены".into());
    }
    for component in candidate.components() {
        if matches!(component, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)) {
            return Err("путь за пределами сборки запрещён".into());
        }
    }
    Ok(base.join(candidate))
}

#[tauri::command]
fn list_dir(
    state: State<'_, AppState>,
    instance_id: String,
    sub: String,
) -> Result<Vec<FileEntry>, String> {
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let base = instances::ensure_game_dir(&state.paths, &meta).map_err(err)?;
    let dir = if sub.trim().is_empty() {
        base.clone()
    } else {
        safe_join(&base, &sub)?
    };
    // Создаём только потомков существующей папки: rename не создаст призрак.
    instances::create_dir_beneath(&base, &dir).map_err(err)?;
    let mut result = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(err)?.flatten() {
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = if sub.trim().is_empty() {
            name.clone()
        } else {
            format!("{}/{}", sub.trim_end_matches('/'), name)
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|delta| delta.as_secs());
        result.push(FileEntry {
            name,
            is_dir: meta.is_dir(),
            size: meta.len(),
            path: relative,
            modified,
        });
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

#[tauri::command]
fn read_text_file(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
) -> Result<String, String> {
    let base = instances::game_dir(&state.paths, &instance_id).map_err(err)?;
    let file = safe_join(&base, &path)?;
    let meta = std::fs::metadata(&file).map_err(err)?;
    const LIMIT: u64 = 512 * 1024;
    if meta.len() > LIMIT {
        return Err(format!(
            "файл слишком большой для просмотра ({} > {})",
            meta.len(),
            LIMIT
        ));
    }
    let bytes = std::fs::read(&file).map_err(err)?;
    if bytes.contains(&0) {
        return Err("это двоичный файл — открой его в системном проводнике".into());
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
fn delete_file(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
) -> Result<(), String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let base = instances::game_dir(&state.paths, &instance_id).map_err(err)?;
    let target = safe_join(&base, &path)?;
    if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(err)
    } else {
        std::fs::remove_file(&target).map_err(err)
    }
}

/// Формат архива по расширению: zip/jar/mrpack — крейт zip, rar — unrar.
#[derive(Clone, Copy)]
enum ArchiveKind {
    Zip,
    Rar,
}

fn archive_kind(path: &Path) -> Result<ArchiveKind, String> {
    match path
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .as_deref()
    {
        Some("zip") | Some("jar") | Some("mrpack") => Ok(ArchiveKind::Zip),
        Some("rar") => Ok(ArchiveKind::Rar),
        _ => Err("это не архив: поддержаны .zip, .jar, .mrpack и .rar".into()),
    }
}

#[derive(Serialize)]
struct ArchiveEntry {
    name: String,
    size: u64,
    packed: u64,
    is_dir: bool,
}

#[derive(Serialize)]
struct ArchivePreview {
    kind: String,
    size: u64,
    data_url: Option<String>,
    text: Option<String>,
}

/// Строка из архива: сначала UTF-8, иначе CP866 (старые архивы под Windows).
fn archive_name(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(text) if !text.is_empty() => text.to_string(),
        _ => {
            let (text, _, _) = encoding_rs::IBM866.decode(raw);
            text.to_string()
        }
    }
}

fn archive_list_entries(path: &Path) -> Result<Vec<ArchiveEntry>, String> {
    match archive_kind(path)? {
        ArchiveKind::Zip => {
            let file = std::fs::File::open(path).map_err(|e| format!("не открыть архив: {e}"))?;
            let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("не прочитать zip: {e}"))?;
            let mut out = Vec::with_capacity(zip.len());
            for index in 0..zip.len() {
                let entry = zip
                    .by_index(index)
                    .map_err(|e| format!("не прочитать запись архива: {e}"))?;
                out.push(ArchiveEntry {
                    name: archive_name(entry.name_raw()),
                    size: entry.size(),
                    packed: entry.compressed_size(),
                    is_dir: entry.is_dir(),
                });
            }
            Ok(out)
        }
        ArchiveKind::Rar => {
            let mut cursor = unrar::Archive::new(path)
                .open_for_listing()
                .map_err(|e| format!("не открыть rar: {e}"))?;
            let mut out = Vec::new();
            loop {
                match cursor
                    .read_header()
                    .map_err(|e| format!("не прочитать rar: {e}"))?
                {
                    Some(header) => {
                        let entry = header.entry();
                        out.push(ArchiveEntry {
                            name: entry.filename.to_string_lossy().replace('\\', "/"),
                            size: entry.unpacked_size,
                            packed: 0,
                            is_dir: entry.is_directory(),
                        });
                        cursor = header
                            .skip()
                            .map_err(|e| format!("не пропустить запись rar: {e}"))?;
                    }
                    None => break,
                }
            }
            Ok(out)
        }
    }
}

/// Байты одной записи архива — с ограничением, чтобы не тянуть гигабайты в окно.
const ARCHIVE_LIMIT: u64 = 64 * 1024 * 1024;

fn archive_bytes(path: &Path, entry_name: &str) -> Result<Vec<u8>, String> {
    match archive_kind(path)? {
        ArchiveKind::Zip => {
            let file = std::fs::File::open(path).map_err(|e| format!("не открыть архив: {e}"))?;
            let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("не прочитать zip: {e}"))?;
            let mut entry = zip
                .by_name(entry_name)
                .map_err(|e| format!("в архиве нет «{entry_name}» ({e})"))?;
            if entry.size() > ARCHIVE_LIMIT {
                return Err("файл в архиве больше 64 МБ".into());
            }
            let mut buffer = Vec::with_capacity(entry.size() as usize);
            std::io::copy(&mut entry, &mut buffer).map_err(|e| format!("не прочитать файл: {e}"))?;
            Ok(buffer)
        }
        ArchiveKind::Rar => {
            let mut cursor = unrar::Archive::new(path)
                .open_for_processing()
                .map_err(|e| format!("не открыть rar: {e}"))?;
            let wanted = entry_name.replace('\\', "/");
            loop {
                match cursor
                    .read_header()
                    .map_err(|e| format!("не прочитать rar: {e}"))?
                {
                    Some(header) => {
                        let name = header.entry().filename.to_string_lossy().replace('\\', "/");
                        if name == wanted && !header.entry().is_directory() {
                            if header.entry().unpacked_size > ARCHIVE_LIMIT {
                                return Err("файл в архиве больше 64 МБ".into());
                            }
                            let (data, _next) = header
                                .read()
                                .map_err(|e| format!("не распаковать запись: {e}"))?;
                            return Ok(data);
                        }
                        cursor = header
                            .skip()
                            .map_err(|e| format!("не пропустить запись rar: {e}"))?;
                    }
                    None => return Err(format!("в архиве нет «{entry_name}»")),
                }
            }
        }
    }
}

fn image_mime(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("bmp") => Some("image/bmp"),
        Some("ico") => Some("image/x-icon"),
        _ => None,
    }
}

/// Создать папку в сборке (в том числе вложенную).
#[tauri::command]
fn fm_create_dir(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
) -> Result<(), String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let base = instances::ensure_game_dir(&state.paths, &meta).map_err(err)?;
    let target = safe_join(&base, &path)?;
    instances::create_dir_beneath(&base, &target).map_err(err)
}

/// Переименовать файл или папку; возвращаем новый относительный путь.
#[tauri::command]
fn fm_rename(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
    name: String,
) -> Result<String, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let clean = name.trim();
    if clean.is_empty()
        || clean == "."
        || clean == ".."
        || clean.contains('/')
        || clean.contains('\\')
    {
        return Err("имя не годится: нужны буквы, цифры, точка, дефис".into());
    }
    let base = instances::game_dir(&state.paths, &instance_id).map_err(err)?;
    let from = safe_join(&base, &path)?;
    let parent = path.rsplit_once('/').map(|(head, _)| head).unwrap_or("");
    let relative = if parent.is_empty() {
        clean.to_string()
    } else {
        format!("{parent}/{clean}")
    };
    let to = safe_join(&base, &relative)?;
    if to == from {
        return Ok(relative);
    }
    if to.exists() {
        return Err(format!("«{clean}» уже есть в этой папке"));
    }
    std::fs::rename(&from, &to).map_err(err)?;
    Ok(relative)
}

/// Перенести файлы и папки в другую папку сборки; возвращаем число перенесённых.
#[tauri::command]
fn fm_move(
    state: State<'_, AppState>,
    instance_id: String,
    paths: Vec<String>,
    dir: String,
) -> Result<usize, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let base = instances::ensure_game_dir(&state.paths, &meta).map_err(err)?;
    let target = safe_join(&base, &dir)?;
    instances::create_dir_beneath(&base, &target).map_err(err)?;
    let mut moved = 0usize;
    for path in paths {
        let from = safe_join(&base, &path)?;
        if !from.exists() {
            continue;
        }
        let Some(name) = from.file_name().map(|name| name.to_os_string()) else {
            continue;
        };
        let to = target.join(&name);
        if to == from {
            continue;
        }
        // папку нельзя положить в саму себя
        if to.starts_with(&from) {
            return Err("папку нельзя перенести в неё же".into());
        }
        if to.exists() {
            return Err(format!(
                "«{}» уже есть в целевой папке",
                name.to_string_lossy()
            ));
        }
        std::fs::rename(&from, &to)
            .map_err(|e| format!("не перенести «{}»: {e}", name.to_string_lossy()))?;
        moved += 1;
    }
    Ok(moved)
}

/// Картинка файлом как data-url: просмотр с зумом без отдельного протокола.
#[tauri::command]
fn fm_read_image(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
) -> Result<String, String> {
    let base = instances::game_dir(&state.paths, &instance_id).map_err(err)?;
    let file = safe_join(&base, &path)?;
    let mime = image_mime(&file).ok_or_else(|| "это не картинка".to_string())?;
    let meta = std::fs::metadata(&file).map_err(err)?;
    if meta.len() > 32 * 1024 * 1024 {
        return Err("картинка больше 32 МБ — откройте её проводником".into());
    }
    let bytes = std::fs::read(&file).map_err(err)?;
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{data}"))
}

/// Содержимое архива как список записей — архив открывается как папка.
#[tauri::command]
fn archive_list(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
) -> Result<Vec<ArchiveEntry>, String> {
    let base = instances::game_dir(&state.paths, &instance_id).map_err(err)?;
    let file = safe_join(&base, &path)?;
    archive_list_entries(&file)
}

/// Прочитать запись архива: картинку отдаём data-url, остальное — строкой.
#[tauri::command]
fn archive_read(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
    entry: String,
) -> Result<ArchivePreview, String> {
    let base = instances::game_dir(&state.paths, &instance_id).map_err(err)?;
    let file = safe_join(&base, &path)?;
    let bytes = archive_bytes(&file, &entry)?;
    let lower = entry.to_lowercase();
    let is_image = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    if is_image {
        let mime = if lower.ends_with(".png") {
            "image/png"
        } else if lower.ends_with(".gif") {
            "image/gif"
        } else if lower.ends_with(".webp") {
            "image/webp"
        } else if lower.ends_with(".bmp") {
            "image/bmp"
        } else {
            "image/jpeg"
        };
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(ArchivePreview {
            kind: "image".into(),
            size: bytes.len() as u64,
            data_url: Some(format!("data:{mime};base64,{data}")),
            text: None,
        });
    }
    Ok(ArchivePreview {
        kind: "text".into(),
        size: bytes.len() as u64,
        data_url: None,
        text: Some(String::from_utf8_lossy(&bytes).to_string()),
    })
}

#[derive(Serialize)]
struct ModEntry {
    name: String,
    size: u64,
    enabled: bool,
}

#[tauri::command]
fn list_mods(state: State<'_, AppState>, instance_id: String) -> Result<Vec<ModEntry>, String> {
    let dir = instances::game_dir(&state.paths, &instance_id).map_err(err)?.join("mods");
    let mut result = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(result);
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !(name.ends_with(".jar") || name.ends_with(".jar.disabled") || name.ends_with(".zip")) {
            continue;
        }
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        result.push(ModEntry {
            enabled: !name.ends_with(".disabled"),
            name,
            size,
        });
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

/// Один скриншот из папки `screenshots` сборки. Только метаданные:
/// картинки отдаются отдельными командами по одному, иначе сотни
/// base64-URI в одном ответе роняют WebView по памяти.
#[derive(Debug, Clone, serde::Serialize)]
struct ScreenshotEntry {
    name: String,
    size: u64,
    /// Время изменения, секунды от эпохи.
    modified: Option<u64>,
    /// Абсолютный путь — для кнопок «открыть файл/папку».
    path: String,
}

/// Скриншоты сборки (папка `screenshots` в игровой папке), новые сверху.
#[tauri::command]
fn list_screenshots(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Vec<ScreenshotEntry>, String> {
    let dir = instances::game_dir(&state.paths, &instance_id).map_err(err)?.join("screenshots");
    let mut result = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(result);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if image_mime(&path).is_none() {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.metadata().ok();
        let modified = meta
            .as_ref()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs());
        result.push(ScreenshotEntry {
            name,
            size: meta.map(|meta| meta.len()).unwrap_or(0),
            modified,
            path: path.display().to_string(),
        });
    }
    result.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(result)
}

/// Путь к скриншоту по имени файла (без выхода за папку скриншотов).
fn screenshot_path(
    state: &State<'_, AppState>,
    instance_id: &str,
    name: &str,
) -> Result<std::path::PathBuf, String> {
    let file_name = std::path::Path::new(name)
        .file_name()
        .ok_or_else(|| "неверное имя файла".to_string())?;
    let dir = instances::game_dir(&state.paths, instance_id).map_err(err)?.join("screenshots");
    let path = dir.join(file_name);
    if !path.is_file() {
        return Err("скриншот не найден".to_string());
    }
    Ok(path)
}

/// Миниатюра скриншота (JPEG до 480px) как data URI. Кэшируется в
/// `cache/thumbs/<сборка>/` и перегенерируется, если файл новее.
#[tauri::command]
fn screenshot_thumb(
    state: State<'_, AppState>,
    instance_id: String,
    name: String,
) -> Result<String, String> {
    let path = screenshot_path(&state, &instance_id, &name)?;
    let cache_dir = state
        .paths
        .cache()
        .join("thumbs")
        .join(&instance_id);
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let thumb_path = cache_dir.join(format!(
        "{}.jpg",
        path.file_stem().unwrap_or_default().to_string_lossy()
    ));
    let fresh = thumb_path.exists()
        && std::fs::metadata(&thumb_path)
            .and_then(|thumb| thumb.modified())
            .ok()
            .zip(std::fs::metadata(&path).and_then(|src| src.modified()).ok())
            .map(|(thumb_time, src_time)| thumb_time >= src_time)
            .unwrap_or(false);
    if !fresh {
        let img = image::open(&path).map_err(|e| e.to_string())?;
        let thumb = img.thumbnail(480, 480).to_rgb8();
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgb8(thumb)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg)
            .map_err(|e| e.to_string())?;
        std::fs::write(&thumb_path, &buf).map_err(|e| e.to_string())?;
        return Ok(format!("data:image/jpeg;base64,{}", base64_encode(&buf)));
    }
    let bytes = std::fs::read(&thumb_path).map_err(|e| e.to_string())?;
    Ok(format!("data:image/jpeg;base64,{}", base64_encode(&bytes)))
}

/// Полный скриншот как data URI — по одному, для просмотра и копирования.
#[tauri::command]
fn screenshot_full(
    state: State<'_, AppState>,
    instance_id: String,
    name: String,
) -> Result<String, String> {
    let path = screenshot_path(&state, &instance_id, &name)?;
    let mime = image_mime(&path).ok_or_else(|| "неподдерживаемый формат".to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() > 32 * 1024 * 1024 {
        return Err("файл слишком большой".to_string());
    }
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// Иконки миров: имя папки мира → `icon.png` из неё (как в самой игре).
#[tauri::command]
fn world_icons(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<std::collections::HashMap<String, String>, String> {
    let saves = instances::game_dir(&state.paths, &instance_id).map_err(err)?.join("saves");
    let mut result = std::collections::HashMap::new();
    let Ok(entries) = std::fs::read_dir(&saves) else {
        return Ok(result);
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let icon = entry.path().join("icon.png");
        let Ok(bytes) = std::fs::read(&icon) else {
            continue;
        };
        if bytes.is_empty() || bytes.len() > 256 * 1024 {
            continue;
        }
        result.insert(name, format!("data:image/png;base64,{}", base64_encode(&bytes)));
    }
    Ok(result)
}

/// Иконки модов: имя файла → ссылка на картинку с Modrinth.
///
/// Имя мода берём из `fabric.mod.json` / `mods.toml` внутри jar, дальше ищем
/// проект на Modrinth. Результат кэшируется в `<данные>/cache/mod-icons.json`,
/// поэтому второй раз список открывается мгновенно.
#[tauri::command]
async fn mod_icons(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<std::collections::HashMap<String, String>, String> {
    let mods_dir = instances::game_dir(&state.paths, &instance_id).map_err(err)?.join("mods");
    let cache_file = state.paths.cache().join("mod-icons.json");
    let mut cache: std::collections::HashMap<String, String> = std::fs::read_to_string(&cache_file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();

    let mut result = std::collections::HashMap::new();
    // (имя файла, поисковый запрос, тип проекта на Modrinth)
    let mut missing: Vec<(String, String, String)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&mods_dir) {
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().to_string();
            if !file.ends_with(".jar") && !file.ends_with(".jar.disabled") {
                continue;
            }
            let key = mod_key(&file);
            if let Some(url) = cache.get(&key) {
                if !url.is_empty() {
                    result.insert(file.clone(), url.clone());
                }
                continue;
            }
            let probe = mod_display_name(&entry.path()).unwrap_or_else(|| key.clone());
            missing.push((file, probe, "mod".to_string()));
        }
    }

    // Ресурспаки и шейдеры: сначала pack.png изнутри zip (как в самой игре),
    // если его нет — ищем проект на Modrinth по имени файла.
    let game_dir = instances::game_dir(&state.paths, &instance_id).map_err(err)?;
    for (dir_name, project_type) in [("resourcepacks", "resourcepack"), ("shaderpacks", "shader")] {
        let dir = game_dir.join(dir_name);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().to_string();
            let lower = file.to_lowercase();
            if !lower.ends_with(".zip") && !lower.ends_with(".zip.disabled") {
                continue;
            }
            if let Some(data_url) = pack_png_data_url(&entry.path()) {
                result.insert(file, data_url);
                continue;
            }
            let key = format!("{project_type}:{}", mod_key(&file));
            if let Some(url) = cache.get(&key) {
                if !url.is_empty() {
                    result.insert(file.clone(), url.clone());
                }
                continue;
            }
            let probe = pack_probe(&file);
            missing.push((file, probe, project_type.to_string()));
        }
    }

    // Не больше 6 запросов разом — Modrinth не любит шквал.
    let http = state.http.clone();
    let mut stream = futures::stream::iter(missing.into_iter().map(|(file, probe, project_type)| {
        let http = http.clone();
        async move {
            let modrinth = omnispec_core::modrinth::Modrinth::new(http);
            let found = modrinth
                .search(&omnispec_core::modrinth::SearchQuery {
                    query: probe.clone(),
                    project_type,
                    game_version: None,
                    loader: None,
                    categories: Vec::new(),
                    limit: 1,
                    offset: 0,
                    sort: "relevance".into(),
                })
                .await
                .ok()
                .and_then(|results| results.hits.into_iter().next())
                .and_then(|hit| hit.icon_url);
            (mod_key(&file), file, found)
        }
    }))
    .buffer_unordered(6);
    {
        while let Some((key, file, icon)) = stream.next().await {
            match icon {
                Some(url) => {
                    cache.insert(key, url.clone());
                    result.insert(file, url);
                }
                None => {
                    cache.insert(key, String::new());
                }
            }
        }
    }
    if let Some(parent) = cache_file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(&cache) {
        let _ = std::fs::write(&cache_file, text);
    }
    Ok(result)
}

/// Иконка пака: `pack.png` из корня zip, как её показывает сама игра.
fn pack_png_data_url(zip_path: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(zip_path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let mut entry = zip.by_name("pack.png").ok()?;
    let mut bytes = Vec::new();
    use std::io::Read;
    entry.read_to_end(&mut bytes).ok()?;
    if bytes.is_empty() || bytes.len() > 512 * 1024 {
        return None;
    }
    Some(format!("data:image/png;base64,{}", base64_encode(&bytes)))
}

/// Поисковый запрос по имени файла пака: без версии и расширения.
fn pack_probe(file: &str) -> String {
    let stem = file
        .trim_end_matches(".disabled")
        .trim_end_matches(".zip");
    let cut = stem
        .find(|c: char| c.is_ascii_digit())
        .filter(|index| *index > 2)
        .unwrap_or(stem.len());
    stem[..cut]
        .replace(['_', '-'], " ")
        .trim()
        .to_string()
}

/// Ключ кэша: имя файла без версии и загрузчика.
fn mod_key(file: &str) -> String {
    let stem = file
        .trim_end_matches(".disabled")
        .trim_end_matches(".jar")
        .to_string();
    let cut = stem
        .find(|c: char| c.is_ascii_digit())
        .filter(|index| *index > 2)
        .unwrap_or(stem.len());
    stem[..cut]
        .trim_end_matches(['-', '_', '.', ' '])
        .to_lowercase()
}

/// Название мода из его метаданных внутри jar.
fn mod_display_name(jar: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(jar).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    for name in ["fabric.mod.json", "quilt.mod.json"] {
        if let Ok(mut entry) = zip.by_name(name) {
            let mut text = String::new();
            use std::io::Read;
            if entry.read_to_string(&mut text).is_ok() {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    for key in ["name", "id"] {
                        if let Some(found) = value.get(key).and_then(|v| v.as_str()) {
                            if !found.trim().is_empty() {
                                return Some(found.trim().to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    for name in ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"] {
        if let Ok(mut entry) = zip.by_name(name) {
            let mut text = String::new();
            use std::io::Read;
            if entry.read_to_string(&mut text).is_ok() {
                for line in text.lines() {
                    let line = line.trim();
                    if let Some(rest) = line.strip_prefix("displayName") {
                        let value = rest.trim_start_matches(['=', ' ']).trim().trim_matches('"');
                        if !value.is_empty() {
                            return Some(value.to_string());
                        }
                    }
                }
                for line in text.lines() {
                    let line = line.trim();
                    if let Some(rest) = line.strip_prefix("modId") {
                        let value = rest.trim_start_matches(['=', ' ']).trim().trim_matches('"');
                        if !value.is_empty() {
                            return Some(value.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

/// Найденные сборки в Prism / MultiMC / Modrinth App.
#[tauri::command]
async fn scan_external_launchers() -> Result<Vec<omnispec_core::transfer::ExternalProfile>, String>
{
    tauri::async_runtime::spawn_blocking(omnispec_core::transfer::scan_external)
        .await
        .map_err(err)
}

/// Перенести чужую сборку к себе.
#[tauri::command]
async fn import_external(
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
    mc_version: String,
    loader: Option<String>,
    loader_version: Option<String>,
    icon: Option<String>,
) -> Result<InstanceMeta, String> {
    let _write = reserve_content_write("__import__", &state.content_access)?;
    let paths = state.paths.clone();
    let kind = loader.unwrap_or_else(|| "vanilla".into());
    let version = loader_version.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        omnispec_core::transfer::import_external(
            &paths,
            &path,
            name,
            &mc_version,
            &kind,
            &version,
            icon.as_deref(),
        )
    })
    .await
    .map_err(err)?
    .map_err(err)
}

/// Экспорт сборки в `.mrpack` или `.zip`.
/// `include` — что класть в архив (ключи групп); None — всё.
#[tauri::command]
async fn export_instance(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
    format: Option<String>,
    include: Option<Vec<String>>,
) -> Result<String, String> {
    let paths = state.paths.clone();
    let kind = format.unwrap_or_else(|| "mrpack".into());
    let out = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        omnispec_core::transfer::export_instance(
            &paths,
            &instance_id,
            &out,
            &kind,
            include.as_deref(),
        )
    })
    .await
    .map_err(err)?
    .map(|path| path.display().to_string())
    .map_err(err)
}

#[tauri::command]
async fn import_zip(
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
    mc_version: String,
    loader: Option<String>,
    loader_version: Option<String>,
) -> Result<omnispec_core::instances::InstanceMeta, String> {
    let _write = reserve_content_write("__import__", &state.content_access)?;
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        omnispec_core::transfer::import_zip(
            &paths,
            &path,
            name.as_deref(),
            &mc_version,
            loader.as_deref().unwrap_or("vanilla"),
            loader_version.as_deref().unwrap_or(""),
        )
    })
    .await
    .map_err(err)?
    .map_err(err)
}

/// Системный диалог «сохранить как» — для экспорта сборки в архив.
#[tauri::command]
async fn pick_save_path(
    title: Option<String>,
    file_name: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog =
            rfd::FileDialog::new().set_title(title.unwrap_or_else(|| "Сохранить файл".into()));
        if let Some(file_name) = file_name {
            dialog = dialog.set_file_name(file_name);
        }
        if let Some(extensions) = extensions {
            let list: Vec<String> = extensions
                .into_iter()
                .map(|ext| ext.to_lowercase())
                .collect();
            let refs: Vec<&str> = list.iter().map(|ext| ext.as_str()).collect();
            if !refs.is_empty() {
                dialog = dialog.add_filter("Архив", &refs);
            }
        }
        dialog
            .save_file()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(chosen)
}

/* ==================== СОДЕРЖИМОЕ СБОРКИ ==================== */

/// Подтвердить наличие модов любой версии по содержимому реальных файлов.
#[tauri::command]
async fn catalog_installed_mods(
    state: State<'_, AppState>, instance_id: String, source: String,
) -> Result<Vec<String>, String> {
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    omnispec_core::catalog_installed::installed_projects(
        &state.paths, &meta, &source, &state.modrinth, &state.curseforge,
    ).await.map_err(err)
}

/// Файлы сборки нужного вида: моды, шейдеры или ресурспаки.
#[tauri::command]
fn content_list(
    state: State<'_, AppState>,
    instance_id: String,
    kind: String,
) -> Result<Value, String> {
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let entries = omnispec_core::content::list(&state.paths, &meta, &kind);
    Ok(json!(entries))
}

/// Включить/выключить файл (переименование в `.disabled`).
#[tauri::command]
fn content_toggle(
    state: State<'_, AppState>,
    instance_id: String,
    kind: String,
    name: String,
) -> Result<String, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    omnispec_core::content::toggle(&state.paths, &meta, &kind, &name).map_err(err)
}

/// Удалить файл из сборки.
#[tauri::command]
fn content_delete(
    state: State<'_, AppState>,
    instance_id: String,
    kind: String,
    name: String,
) -> Result<(), String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    omnispec_core::content::remove(&state.paths, &meta, &kind, &name).map_err(err)
}

/// Проверить обновления под эту версию игры и загрузчик.
#[tauri::command]
async fn content_updates(
    state: State<'_, AppState>,
    instance_id: String,
    kind: String,
) -> Result<Value, String> {
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let updates =
        omnispec_core::content::check_updates(&state.modrinth, &state.paths, &meta, &kind)
            .await
            .map_err(err)?;
    Ok(json!(updates))
}

/// Поставить обновление одного файла. Данные обновления приходят из UI
/// (список, который уже показала проверка) — повторная проверка не нужна.
#[tauri::command]
async fn content_update(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    kind: String,
    name: String,
    update: Option<Value>,
) -> Result<Value, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let reporter = reporter_for(&app, &meta.id);
    let update = match update {
        Some(value) => {
            let parsed: omnispec_core::content::ContentUpdate =
                serde_json::from_value(value).map_err(err)?;
            omnispec_core::content::apply_update_with(
                &state.modrinth,
                &state.paths,
                &meta,
                &kind,
                &parsed,
                Some(&reporter),
            )
            .await
            .map_err(err)?
        }
        None => {
            omnispec_core::content::apply_update(&state.modrinth, &state.paths, &meta, &kind, &name)
                .await
                .map_err(err)?
        }
    };
    Ok(json!(update))
}

/// Заменить файл на конкретную версию (ПКМ по моду → «Поменять версию»).
#[tauri::command]
async fn content_replace_version(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    kind: String,
    name: String,
    version_id: String,
    op_id: Option<String>,
) -> Result<Value, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let reporter = reporter_for_content(&app, &meta.id, op_id);
    let outcome = omnispec_core::content::replace_version(
        &state.modrinth,
        &state.paths,
        &meta,
        &kind,
        &name,
        &version_id,
        &reporter,
    )
    .await
    .map_err(err)?;
    Ok(json!({
        "installed": outcome.installed,
        "skipped": outcome.skipped
    }))
}

/// Догрузить обязательные зависимости уже установленных модов.
#[tauri::command]
async fn mods_ensure_dependencies(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    op_id: Option<String>,
) -> Result<Value, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let reporter = reporter_for_content(&app, &meta.id, op_id);
    let outcome =
        modrinth_install::ensure_dependencies(&state.modrinth, &state.paths, &meta, &reporter)
            .await
            .map_err(err)?;
    Ok(json!({
        "installed": outcome.installed,
        "skipped": outcome.skipped
    }))
}

#[tauri::command]
fn toggle_mod(
    state: State<'_, AppState>,
    instance_id: String,
    name: String,
) -> Result<String, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    modrinth_install::toggle_mod(&state.paths, &meta, &name).map_err(err)
}

/* ==================== ОБНОВЛЕНИЯ ==================== */

#[derive(Serialize)]
struct VersionInfo {
    version: String,
    repo: Option<String>,
    enabled: bool,
    platform: String,
}

#[tauri::command]
async fn version_info(state: State<'_, AppState>) -> Result<VersionInfo, String> {
    let settings = state.settings.lock().await.clone();
    Ok(VersionInfo {
        version: omnispec_core::APP_VERSION.to_string(),
        repo: settings.update_repo.clone(),
        enabled: settings.update_enabled,
        platform: format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
    })
}

/// Проверить, есть ли новая версия в GitHub Releases.
#[tauri::command]
async fn check_update(state: State<'_, AppState>) -> Result<Option<UpdateInfo>, String> {
    let settings = state.settings.lock().await.clone();
    let Some(config) = settings.update_config() else {
        return Ok(None);
    };
    update::check(&state.http, &config, omnispec_core::APP_VERSION)
        .await
        .map_err(err)
}

/// Скачать обновление, подменить exe и перезапустить лаунчер.
#[tauri::command]
async fn install_update(app: AppHandle, state: State<'_, AppState>) -> Result<UpdateInfo, String> {
    let settings = state.settings.lock().await.clone();
    let config = settings
        .update_config()
        .ok_or_else(|| "не настроен репозиторий обновлений".to_string())?;

    let info = update::check(&state.http, &config, omnispec_core::APP_VERSION)
        .await
        .map_err(err)?
        .ok_or_else(|| "обновлений нет".to_string())?;

    let reporter = reporter_for(&app, "update");
    let downloaded = update::download(
        &state.http,
        &state.paths,
        &info,
        config.token.as_deref(),
        &reporter,
    )
    .await
    .map_err(err)?;

    let current_exe = std::env::current_exe().map_err(err)?;
    update::apply_now(&downloaded, &current_exe).map_err(err)?;

    // На Windows уже запущен помощник, который заменит файл после нашего выхода.
    let _ = app.emit("update-applied", json!({ "version": info.version }));
    tokio::time::sleep(Duration::from_millis(400)).await;
    app.exit(0);
    Ok(info)
}

/// Проверка связи с Modrinth: короткий запрос и понятный результат для настроек.
#[tauri::command]
async fn net_check(state: State<'_, AppState>) -> Result<String, String> {
    let url = "https://api.modrinth.com/v2/search?query=sodium&limit=1";
    match state.http.probe(url).await {
        Ok(status) if (200..300).contains(&status) => {
            Ok(format!("связь есть — Modrinth ответил HTTP {status}"))
        }
        Ok(status) => Err(format!("Modrinth ответил HTTP {status}")),
        Err(error) => Err(error.to_string()),
    }
}

/// Проверяем ссылку до передачи системе; управляющие символы и прочие схемы
/// не должны попасть в обработчик внешних ссылок.
fn browser_url(raw: &str) -> Result<String, String> {
    if raw.len() > 16_384 || raw.chars().any(char::is_control) {
        return Err("недопустимая ссылка".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "недопустимая ссылка".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("разрешены только http(s)-ссылки".into());
    }
    Ok(url.to_string())
}

/// Открыть ссылку в системном браузере без интерпретации через командный shell.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = browser_url(&url)?;
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let address: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), address.as_ptr(),
                std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL)
        } as isize;
        if result <= 32 { return Err(format!("не удалось открыть ссылку (код Windows {result})")); }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg(&url).spawn().map(|_| ()).map_err(err) }
    #[cfg(all(unix, not(target_os = "macos")))]
    { std::process::Command::new("xdg-open").arg(&url).spawn().map(|_| ()).map_err(err) }
}

/* ==================== АККАУНТЫ ==================== */

#[derive(Serialize)]
struct AccountSummary {
    username: String,
    uuid: String,
    kind: String,
}

impl From<&Account> for AccountSummary {
    fn from(account: &Account) -> Self {
        Self { username: account.username.clone(), uuid: account.uuid.clone(), kind: account.kind.clone() }
    }
}

#[derive(Serialize)]
struct AccountsInfo {
    // Токены нужны Rust для запуска игры, но не интерфейсу WebView.
    accounts: Vec<AccountSummary>,
    active: Option<String>,
}

fn account_summaries(store: &AccountStore) -> Vec<AccountSummary> {
    store.accounts.iter().map(AccountSummary::from).collect()
}

fn save_pending_accounts(state: &AppState, store: &AccountStore) -> Result<(), String> {
    if state.accounts_dirty.load(Ordering::Acquire) {
        store.save(&state.paths).map_err(|error| format!("не удалось сохранить обновлённый вход: {error}"))?;
        state.accounts_dirty.store(false, Ordering::Release);
    }
    Ok(())
}

/// Под блокировкой хранилища: параллельные запросы профиля и запуска не
/// обновляют один и тот же refresh-токен одновременно внутри лаунчера.
async fn refresh_account_locked(state: &AppState, settings: &Settings, store: &mut AccountStore, account: &Account) -> Result<Account, String> {
    if account.refresh_token.trim().is_empty() {
        return Err("срок входа Microsoft истёк и нет refresh-токена — войди в аккаунт заново".into());
    }
    let client_id = settings.ms_client_id.clone().unwrap_or_default();
    let session = microsoft::refresh(&state.http, &client_id, &account.refresh_token).await
        .map_err(|error| format!("не удалось обновить вход Microsoft: {error}. Проверь сеть или войди заново"))?;
    let fresh = Account::from_session(session);
    if !profile_service::same_profile_id(&account.uuid, &fresh.uuid) {
        return Err("Microsoft вернул другой аккаунт; текущий вход не заменён".into());
    }
    // Сначала удерживаем новый токен в памяти, затем сохраняем. Если диск
    // недоступен, следующая операция повторит запись вместо молчаливой потери.
    store.upsert(fresh.clone());
    state.accounts_dirty.store(true, Ordering::Release);
    save_pending_accounts(state, store)?;
    Ok(fresh)
}

/// Выбранный аккаунт; optional UUID не позволяет применить скин/плащ к
/// другому аккаунту, если выбор поменялся перед обработкой команды.
async fn current_account_checked(state: &AppState, settings: &Settings, expected: Option<&str>) -> Result<Account, String> {
    let mut store = state.accounts.lock().await;
    save_pending_accounts(state, &store)?;
    let account = store.current().cloned().unwrap_or_else(|| {
        Account::offline(&settings.username).unwrap_or_else(|_| Account {
            username: "Player".into(), uuid: omnispec_core::auth::offline_uuid("Player"),
            kind: "offline".into(), access_token: String::new(), refresh_token: String::new(), expires_at: 0,
        })
    });
    if expected.is_some_and(|uuid| !profile_service::same_profile_id(uuid, &account.uuid)) {
        return Err("аккаунт переключён — повтори действие для выбранного аккаунта".into());
    }
    if account.needs_refresh() {
        return refresh_account_locked(state, settings, &mut store, &account).await;
    }
    Ok(account)
}

async fn current_account(state: &AppState, settings: &Settings) -> Result<Account, String> {
    current_account_checked(state, settings, None).await
}

/// После HTTP 401 пробуем обновить один раз, даже если локальный срок ещё не
/// истёк. Если другой запрос уже обновил токен, используем его, не обновляя повторно.
async fn refresh_rejected_account(state: &AppState, settings: &Settings, rejected: &Account) -> Result<Account, String> {
    let mut store = state.accounts.lock().await;
    save_pending_accounts(state, &store)?;
    let current = store.current().cloned().ok_or("аккаунт был удалён")?;
    if !profile_service::same_profile_id(&current.uuid, &rejected.uuid) || !current.is_microsoft() {
        return Err("аккаунт переключён — повтори действие для выбранного аккаунта".into());
    }
    if current.access_token != rejected.access_token && !current.access_token.is_empty() {
        return Ok(current);
    }
    refresh_account_locked(state, settings, &mut store, &current).await
}

async fn current_minecraft_profile(state: &AppState, settings: &Settings, mut account: Account) -> Result<(Account, Value), String> {
    for attempt in 0..2 {
        match profile_service::profile(&state.http, profile_service::PROFILE_URL, &account.access_token).await {
            Ok(profile) => {
                profile_service::verify_profile_identity(&profile, &account.uuid)?;
                return Ok((account, profile));
            }
            Err(profile_service::ProfileError::Unauthorized) if attempt == 0 => {
                account = refresh_rejected_account(state, settings, &account).await?;
            }
            Err(profile_service::ProfileError::Unauthorized) => return Err("Minecraft отклонил вход после обновления. Войди в Microsoft заново".into()),
            Err(profile_service::ProfileError::Other(message)) => return Err(message),
        }
    }
    Err("не удалось получить профиль Minecraft".into())
}

/// Аккаунт для запуска: конкретный (дубликат сборки) или выбранный в лаунчере.
async fn account_for(state: &AppState, settings: &Settings, uuid: Option<&str>) -> Result<Account, String> {
    let Some(uuid) = uuid else { return current_account(state, settings).await; };
    let mut store = state.accounts.lock().await;
    save_pending_accounts(state, &store)?;
    let account = store.accounts.iter()
        .find(|account| account.uuid == uuid || account.username.eq_ignore_ascii_case(uuid))
        .cloned().ok_or_else(|| "аккаунт не найден".to_string())?;
    if account.needs_refresh() { refresh_account_locked(state, settings, &mut store, &account).await }
    else { Ok(account) }
}

/// Текущий скин лицензионного аккаунта: вариант (classic/slim) и PNG в data-URL.
#[tauri::command]
async fn account_skin(state: State<'_, AppState>, account_uuid: Option<String>) -> Result<Value, String> {
    let settings = state.settings.lock().await.clone();
    let account = current_account_checked(&state, &settings, account_uuid.as_deref()).await?;
    if !account.is_microsoft() {
        return Ok(json!({"account_uuid": account.uuid, "licensed": false, "variant": "classic", "data_url": Value::Null}));
    }
    let (account, profile) = current_minecraft_profile(&state, &settings, account).await?;
    let skins = profile.get("skins").and_then(Value::as_array)
        .ok_or("Minecraft не вернул список скинов")?;
    // Никогда не показываем неактивную старую текстуру как действующий скин.
    let active = skins.iter().find(|skin| skin.get("state").and_then(Value::as_str) == Some("ACTIVE"));
    let Some(active) = active else {
        return Ok(json!({"account_uuid": account.uuid, "licensed": true, "variant": "classic", "data_url": Value::Null,
            "message": "У аккаунта нет активной текстуры; Minecraft выберет стандартный скин"}));
    };
    let variant = active.get("variant").and_then(Value::as_str).unwrap_or("CLASSIC").to_lowercase();
    let url = active.get("url").and_then(Value::as_str).ok_or("Minecraft не вернул адрес скина")?;
    let bytes = profile_service::texture_png(&state.http, url).await?;
    validate_skin_png(&bytes).map_err(|error| format!("текстура аккаунта: {error}"))?;
    Ok(json!({"account_uuid": account.uuid, "name": account.username, "licensed": true, "variant": variant,
        "data_url": format!("data:image/png;base64,{}", base64_encode(&bytes))}))
}

/// Плащи аккаунта: список с картинками-превью (PNG в data-URL) и отметкой активного.
#[tauri::command]
async fn account_capes(state: State<'_, AppState>, account_uuid: Option<String>) -> Result<Value, String> {
    let settings = state.settings.lock().await.clone();
    let account = current_account_checked(&state, &settings, account_uuid.as_deref()).await?;
    if !account.is_microsoft() {
        return Ok(json!({"account_uuid": account.uuid, "licensed": false, "capes": []}));
    }
    let (account, profile) = current_minecraft_profile(&state, &settings, account).await?;
    let capes = profile.get("capes").and_then(Value::as_array).cloned().unwrap_or_default();
    // Картинки не блокируют список по одной на долгом соединении. Проблема
    // отдельного превью не скрывает плащ, но показывается как предупреждение.
    let out: Vec<(Value, bool)> = futures::stream::iter(capes.into_iter().map(|cape| {
        let http = &state.http;
        async move {
            let id = cape.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let alias = cape.get("alias").and_then(Value::as_str).unwrap_or("Плащ").to_string();
            let active = cape.get("state").and_then(Value::as_str) == Some("ACTIVE");
            let data = match cape.get("url").and_then(Value::as_str) {
                Some(url) => profile_service::texture_png(http, url).await.ok(),
                None => None,
            };
            let failed = data.is_none();
            let data_url = data.map(|bytes| format!("data:image/png;base64,{}", base64_encode(&bytes)));
            (json!({"id": id, "alias": alias, "active": active, "data_url": data_url}), failed)
        }
    })).buffered(4).collect().await;
    let missing = out.iter().filter(|(_, failed)| *failed).count();
    let capes: Vec<Value> = out.into_iter().map(|(value, _)| value).collect();
    Ok(json!({"account_uuid": account.uuid, "licensed": true, "capes": capes,
        "warning": if missing > 0 { Some("Не удалось загрузить некоторые изображения плащей") } else { None }}))
}

/// Включить плащ (`cape_id`) или выключить все плащи (`None`).
#[tauri::command]
async fn set_cape(state: State<'_, AppState>, cape_id: Option<String>, account_uuid: Option<String>) -> Result<Value, String> {
    let settings = state.settings.lock().await.clone();
    let mut account = current_account_checked(&state, &settings, account_uuid.as_deref()).await?;
    if !account.is_microsoft() { return Err("плащи есть только у лицензионного аккаунта".into()); }
    let url = "https://api.minecraftservices.com/minecraft/profile/capes/active";
    for attempt in 0..2 {
        let request = match cape_id.as_deref() {
            Some(id) => state.http.inner().put(url).json(&json!({ "capeId": id })),
            None => state.http.inner().delete(url),
        };
        let response = request.bearer_auth(&account.access_token).timeout(Duration::from_secs(20)).send().await
            .map_err(|error| format!("не удалось изменить плащ: {error}"))?;
        let status = response.status();
        if status.is_success() { return Ok(json!({ "ok": true, "account_uuid": account.uuid })); }
        if status.as_u16() == 401 && attempt == 0 {
            account = refresh_rejected_account(&state, &settings, &account).await?;
            continue;
        }
        return Err(match status.as_u16() {
            401 => "Minecraft отклонил вход после обновления. Войди в Microsoft заново".into(),
            403 => "Minecraft не разрешил изменить плащ; проверь, что он принадлежит аккаунту".into(),
            429 => "Minecraft временно ограничил частоту запросов; попробуй позже".into(),
            _ => format!("Minecraft не принял изменение плаща (HTTP {status})"),
        });
    }
    Err("не удалось изменить плащ".into())
}

/// Смена скина пресетом: загружаем PNG в Mojang (только лицензия).
#[tauri::command]
async fn apply_skin(
    state: State<'_, AppState>,
    path: String,
    variant: String,
    account_uuid: Option<String>,
) -> Result<Value, String> {
    let settings = state.settings.lock().await.clone();
    let mut account = current_account_checked(&state, &settings, account_uuid.as_deref()).await?;
    if !account.is_microsoft() { return Err("скин можно менять только у лицензионного аккаунта".into()); }
    use std::io::Read;
    let meta = std::fs::metadata(&path).map_err(|error| format!("не удалось открыть файл: {error}"))?;
    if !meta.is_file() || meta.len() > 4 * 1024 * 1024 { return Err("нужен PNG со скином до 4 МБ".into()); }
    let mut bytes = Vec::new();
    std::fs::File::open(&path).map_err(|error| format!("не удалось открыть файл: {error}"))?
        .take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|error| format!("не удалось прочитать файл: {error}"))?;
    validate_skin_png(&bytes)?;
    let variant = match variant.to_lowercase().as_str() {
        "slim" => "slim",
        _ => "classic",
    };
    let boundary = "----OmniSpecSkinBoundary";
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"variant\"\r\n\r\n{variant}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"skin.png\"\r\nContent-Type: image/png\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    for attempt in 0..2 {
        let response = state.http.inner().post("https://api.minecraftservices.com/minecraft/profile/skins")
            .bearer_auth(&account.access_token)
            .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
            .body(body.clone()).timeout(Duration::from_secs(30)).send().await
            .map_err(|error| format!("не удалось отправить скин: {error}"))?;
        let status = response.status();
        if status.is_success() {
            return Ok(json!({"ok": true, "variant": variant, "account": account.username, "account_uuid": account.uuid}));
        }
        if status.as_u16() == 401 && attempt == 0 {
            account = refresh_rejected_account(&state, &settings, &account).await?;
            continue;
        }
        return Err(match status.as_u16() {
            401 => "Minecraft отклонил вход после обновления. Войди в Microsoft заново".into(),
            429 => "Minecraft временно ограничил смену скина; попробуй позже".into(),
            _ => format!("Minecraft не принял скин (HTTP {status})"),
        });
    }
    Err("не удалось отправить скин".into())
}

/// Проверка целого PNG, а не только поддельного заголовка. Ограничение по
/// размеру и размерам изображения применяется до декодирования.
fn validate_skin_png(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() < 33 || bytes.len() > 4 * 1024 * 1024
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return Err("нужен корректный PNG со скином (до 4 МБ)".into());
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if width != 64 || (height != 64 && height != 32) {
        return Err(format!("нужен скин 64×64 (или 64×32), а тут {width}×{height}"));
    }
    let image = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|_| "PNG повреждён или не читается".to_string())?;
    if image.width() != width || image.height() != height { return Err("неверный размер PNG".into()); }
    Ok((width, height))
}

fn write_skin_file(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    use std::io::Write;
    validate_skin_png(bytes)?;
    let (target, mut file) = wallpapers::create_unique(dir, name, "png")?;
    let result = file.write_all(bytes).and_then(|_| file.flush());
    drop(file);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&target);
        return Err(format!("не удалось сохранить скин: {error}"));
    }
    Ok(target)
}

/// Копия PNG избранного образа, в том числе если скин пришёл с сервера.
#[tauri::command]
fn save_skin_png(state: State<'_, AppState>, data_url: String, name: String) -> Result<String, String> {
    if !data_url.starts_with("data:image/png;base64,") || data_url.len() > 6 * 1024 * 1024 {
        return Err("ожидался PNG в data-URL размером до 4 МБ".into());
    }
    let payload = data_url.split_once("base64,").map(|(_, tail)| tail).unwrap_or("");
    let bytes = base64_decode(payload).ok_or_else(|| "не удалось прочитать картинку".to_string())?;
    let target = write_skin_file(&state.paths.meta().join("skins"), &name, &bytes)?;
    Ok(target.to_string_lossy().into_owned())
}

/// Каждому PNG выдаём уникальное имя, поэтому пакетный импорт не перезапишет
/// одноимённые изображения и старые сохранённые записи.
#[tauri::command]
fn import_skin(state: State<'_, AppState>, path: String) -> Result<Value, String> {
    let source = PathBuf::from(&path);
    let size = std::fs::metadata(&source).map_err(|error| format!("не удалось открыть файл: {error}"))?.len();
    if size > 4 * 1024 * 1024 { return Err("скин больше 4 МБ".into()); }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(&source).map_err(|error| format!("не удалось открыть файл: {error}"))?
        .take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|error| format!("не удалось прочитать файл: {error}"))?;
    let (width, height) = validate_skin_png(&bytes)?;
    let stem = source.file_stem().and_then(|value| value.to_str()).unwrap_or("skin");
    let target = write_skin_file(&state.paths.meta().join("skins"), stem, &bytes)?;
    Ok(json!({
        "path": target.to_string_lossy().to_string(),
        "name": stem,
        "data_url": format!("data:image/png;base64,{}", base64_encode(&bytes)),
        "width": width,
        "height": height,
    }))
}

/// Картинка по пути в виде data-URL (для превью своего скина в webview).
#[tauri::command]
fn image_data_url(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|error| format!("не удалось открыть файл: {error}"))?;
    if !meta.is_file() || meta.len() > 16 * 1024 * 1024 { return Err("файл слишком большой".into()); }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(&path).map_err(|error| format!("не удалось открыть файл: {error}"))?
        .take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|error| format!("не удалось прочитать файл: {error}"))?;
    if bytes.len() > 16 * 1024 * 1024 { return Err("файл слишком большой".into()); }
    let mime = match PathBuf::from(&path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

#[tauri::command]
async fn accounts_info(state: State<'_, AppState>) -> Result<AccountsInfo, String> {
    let store = state.accounts.lock().await;
    Ok(AccountsInfo {
        accounts: account_summaries(&store),
        active: store.current().map(|account| account.uuid.clone()),
    })
}

#[tauri::command]
async fn account_add_offline(
    state: State<'_, AppState>,
    username: String,
) -> Result<AccountsInfo, String> {
    let account = Account::offline(&username).map_err(err)?;
    let mut store = state.accounts.lock().await;
    store.upsert(account.clone());
    store.set_active(&account.uuid);
    store.save(&state.paths).map_err(err)?;
    Ok(AccountsInfo {
        accounts: account_summaries(&store),
        active: store.active.clone(),
    })
}

/// Переименовать офлайн-аккаунт: ник — единственное, что у него есть.
#[tauri::command]
async fn account_rename(
    state: State<'_, AppState>,
    uuid: String,
    username: String,
) -> Result<AccountsInfo, String> {
    let trimmed = username.trim();
    if trimmed.chars().count() < 3 || trimmed.chars().count() > 16 {
        return Err("ник — от 3 до 16 символов".into());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err("в нике можно только латиницу, цифры и _".into());
    }
    let mut store = state.accounts.lock().await;
    let Some(account) = store.find_mut(&uuid) else {
        return Err("аккаунт не найден".into());
    };
    if account.kind == "microsoft" {
        return Err("ник лицензионного аккаунта задаёт Mojang".into());
    }
    account.username = trimmed.to_string();
    store.save(&state.paths).map_err(err)?;
    Ok(AccountsInfo {
        accounts: account_summaries(&store),
        active: store.active.clone(),
    })
}

#[tauri::command]
async fn account_set_active(
    state: State<'_, AppState>,
    uuid: String,
) -> Result<AccountsInfo, String> {
    let mut store = state.accounts.lock().await;
    if !store.set_active(&uuid) {
        return Err("аккаунт не найден".into());
    }
    store.save(&state.paths).map_err(err)?;
    Ok(AccountsInfo {
        accounts: account_summaries(&store),
        active: store.active.clone(),
    })
}

#[tauri::command]
async fn account_remove(state: State<'_, AppState>, uuid: String) -> Result<AccountsInfo, String> {
    let mut store = state.accounts.lock().await;
    store.remove(&uuid);
    store.save(&state.paths).map_err(err)?;
    Ok(AccountsInfo {
        accounts: account_summaries(&store),
        active: store.current().map(|account| account.uuid.clone()),
    })
}

/// Шаг 1 входа через Microsoft: короткий код для microsoft.com/link.
#[tauri::command]
async fn ms_login_start(state: State<'_, AppState>) -> Result<microsoft::DeviceCode, String> {
    let settings = state.settings.lock().await.clone();
    let client_id = settings.ms_client_id.clone().unwrap_or_default();
    microsoft::start_device_code(&state.http, &client_id)
        .await
        .map_err(err)
}

/// Шаг 2: опрос. `null` — пользователь ещё не подтвердил вход.
#[tauri::command]
async fn ms_login_poll(
    state: State<'_, AppState>,
    device_code: String,
) -> Result<Option<AccountsInfo>, String> {
    let settings = state.settings.lock().await.clone();
    let client_id = settings.ms_client_id.clone().unwrap_or_default();
    let session = microsoft::poll_device_code(&state.http, &client_id, &device_code)
        .await
        .map_err(err)?;
    let Some(session) = session else {
        return Ok(None);
    };
    let account = Account::from_session(session);
    let mut store = state.accounts.lock().await;
    store.upsert(account.clone());
    store.set_active(&account.uuid);
    store.save(&state.paths).map_err(err)?;
    Ok(Some(AccountsInfo {
        accounts: account_summaries(&store),
        active: store.active.clone(),
    }))
}

/* ==================== ФАЙЛЫ ОТ ПОЛЬЗОВАТЕЛЯ ==================== */

/// Открыть системный диалог выбора файла. `None` — пользователь закрыл окно.
#[tauri::command]
async fn pick_file(
    title: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new();
        dialog = dialog.set_title(title.unwrap_or_else(|| "Выбери файл".into()));
        if let Some(extensions) = extensions {
            let list: Vec<String> = extensions
                .into_iter()
                .map(|ext| ext.to_lowercase())
                .collect();
            let refs: Vec<&str> = list.iter().map(|ext| ext.as_str()).collect();
            if !refs.is_empty() {
                dialog = dialog.add_filter("Подходящие файлы", &refs);
            }
            dialog = dialog.add_filter("Все файлы", &["*"]);
        }
        dialog
            .pick_file()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(chosen)
}

/// Выбор нескольких PNG за один проход. Отмена возвращает пустой список.
#[tauri::command]
async fn pick_files(title: Option<String>, extensions: Option<Vec<String>>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title(title.unwrap_or_else(|| "Выбери файлы".into()));
        if let Some(extensions) = extensions {
            let list: Vec<String> = extensions.into_iter().map(|ext| ext.to_lowercase()).collect();
            let refs: Vec<&str> = list.iter().map(String::as_str).collect();
            if !refs.is_empty() { dialog = dialog.add_filter("Подходящие файлы", &refs); }
            dialog = dialog.add_filter("Все файлы", &["*"]);
        }
        dialog.pick_files().unwrap_or_default().into_iter()
            .map(|p| p.to_string_lossy().into_owned()).collect()
    }).await.map_err(|error| error.to_string())
}

/// Открыть системный диалог выбора папки.
#[tauri::command]
async fn pick_dir(title: Option<String>) -> Result<Option<String>, String> {
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(title.unwrap_or_else(|| "Выбери папку".into()))
            .pick_folder()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(chosen)
}

/// Своя иконка сборки из картинки: копируем в папку сборки и пишем имя в `icon`.
#[tauri::command]
fn set_instance_icon_file(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
) -> Result<InstanceMeta, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let source = PathBuf::from(&path);
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err("подойдёт PNG, JPG или WebP".into());
    }
    let mut meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let dir = state.paths.instance_dir(&instance_id);
    let file_name = format!("icon.{extension}");
    std::fs::copy(&source, dir.join(&file_name))
        .map_err(|error| format!("не удалось скопировать картинку: {error}"))?;

    meta.icon = Some(file_name);
    instances::save(&state.paths, &meta).map_err(err)?;
    Ok(meta)
}

/// Данные картинки-иконки в виде data-URL (webview не умеет читать локальные пути).
#[tauri::command]
fn instance_icon(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Option<String>, String> {
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let Some(icon) = meta.icon else {
        return Ok(None);
    };
    if !icon.contains('.') {
        return Ok(None); // встроенная иконка, рисуется из спрайта
    }
    let path = state.paths.instance_dir(&instance_id).join(&icon);
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(None);
    };
    let mime = match icon
        .rsplit('.')
        .next()
        .unwrap_or("png")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    Ok(Some(format!(
        "data:{mime};base64,{}",
        base64_encode(&bytes)
    )))
}

/// Положить файл (мод/ресурспак) из проводника в папку сборки.
#[tauri::command]
fn copy_instance_file(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
    sub: String,
) -> Result<String, String> {
    let _write = reserve_content_write(&instance_id, &state.content_access)?;
    let source = PathBuf::from(&path);
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "у файла нет имени".to_string())?
        .to_string();
    let allowed = ["jar", "zip", "jar.disabled", "mrpack"];
    let lower = name.to_lowercase();
    if !allowed.iter().any(|ext| lower.ends_with(*ext)) {
        return Err("подойдёт .jar, .zip или .mrpack".into());
    }
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    if !matches!(sub.as_str(), "mods" | "resourcepacks" | "shaderpacks" | "modpacks") {
        return Err("неизвестная папка содержимого".into());
    }
    let game = instances::ensure_game_dir(&state.paths, &meta).map_err(err)?;
    let target_dir = game.join(&sub);
    instances::create_dir_beneath(&game, &target_dir).map_err(err)?;
    std::fs::copy(&source, target_dir.join(&name))
        .map_err(|error| format!("не удалось скопировать: {error}"))?;
    Ok(name)
}

/// Файл, с которым лаунчер запустили (например, `.mrpack` двойным щелчком).
#[tauri::command]
fn startup_file(state: State<'_, AppState>) -> Option<String> {
    state.startup_file.clone()
}

/// Простейший base64 — чтобы не тянуть отдельный крейт ради иконок.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut table = [255u8; 256];
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (index, ch) in ALPHABET.iter().enumerate() {
        table[*ch as usize] = index as u8;
    }
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in text.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let value = table[byte as usize];
        if value == 255 {
            return None;
        }
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 63] as char);
        out.push(TABLE[(triple >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(triple >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[triple as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/* ==================== JAVA И СИСТЕМА ==================== */

#[tauri::command]
async fn list_java(state: State<'_, AppState>) -> Result<Vec<JavaInstall>, String> {
    Ok(game::java::detect_all(&state.paths).await)
}

/// Служебный путь интерфейса (`<id>/minecraft/mods`, `/instances/<id>/minecraft`)
/// → настоящая папка игры. Уважает своё «место установки» сборки.
fn resolve_game_path(paths: &omnispec_core::paths::Paths, raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.starts_with('/') && !raw.starts_with("/instances/") { return None; }
    let trimmed = raw.trim_start_matches('/');
    let rest = trimmed.strip_prefix("instances/").unwrap_or(trimmed);
    let mut parts = rest.splitn(2, '/');
    let id = parts.next()?;
    if id.is_empty() {
        return None;
    }
    let tail = parts.next().unwrap_or("");
    let meta = instances::load(paths, id).ok()?;
    // без «minecraft» в интерфейсе — путь и так указывает на игровую папку
    let tail = tail.strip_prefix("minecraft").unwrap_or(tail);
    let tail = tail.trim_start_matches('/');
    let base = instances::game_dir_for(paths, &meta);
    if tail.is_empty() { Some(base) } else { safe_join(&base, tail).ok() }
}

fn prepare_open_path(paths: &Paths, path: &str) -> Result<PathBuf, String> {
    let root = &paths.root;
    let trimmed = path.trim();
    let resolved_game = resolve_game_path(paths, trimmed);
    let instance_id = resolved_game.as_ref().map(|_| {
        trimmed.trim_start_matches('/').strip_prefix("instances/")
            .unwrap_or(trimmed).split('/').next().unwrap_or("").to_string()
    });
    let target = if trimmed.is_empty() {
        root.clone()
    } else if let Some(game_path) = resolved_game {
        game_path
    } else if trimmed.trim_start_matches('/').starts_with("instances/") {
        // Не создаём старую папку, если её переименовали вне лаунчера.
        return Err("сборка не найдена; обнови список сборок".into());
    } else if let Some(rest) = trimmed.strip_prefix('/') {
        if Path::new(trimmed).exists() { PathBuf::from(trimmed) } else { root.join(rest) }
    } else {
        let first = trimmed.split('/').next().unwrap_or(trimmed);
        if paths.instance_dir(first).exists() {
            paths.instances().join(trimmed)
        } else {
            root.join(trimmed)
        }
    };

    // Только служебный путь проверенной сборки может создавать игровые папки.
    // Произвольный абсолютный путь может быть устаревшим после переименования.
    if !target.exists() {
        if let Some(id) = instance_id {
            let meta = instances::load(paths, &id).map_err(err)?;
            let base = instances::ensure_game_dir(paths, &meta).map_err(err)?;
            instances::create_dir_beneath(&base, &target).map_err(err)?;
        }
    }
    if !target.exists() {
        return Err(format!("путь не найден: {}", target.display()));
    }
    Ok(target)
}

#[tauri::command]
fn open_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let target = prepare_open_path(&state.paths, &path)?;
    // Если подсунули файл — открываем папку, где он лежит.
    let folder = if target.is_dir() {
        target
    } else {
        target
            .parent()
            .map(|parent| parent.to_path_buf())
            .unwrap_or(target)
    };
    open_in_file_manager(&folder)
}

fn open_in_file_manager(target: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // explorer.exe понимает только «настоящие» пути с обратными слэшами:
        // на смешанных он открывает «Документы» вместо папки сборки.
        let native = target.display().to_string().replace('/', "\\");
        let native = native.trim_end_matches('\\').to_string();
        std::process::Command::new("explorer")
            .arg(&native)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

/// Успешная запись нового имени происходит под тем же mutex, что и прочие
/// настройки. Предыдущий фон до этого момента не удаляется и остаётся рабочим.
async fn select_custom_wallpaper(state: &AppState, name: String) -> Result<Settings, String> {
    let mut current = state.settings.lock().await;
    let mut next = current.clone();
    next.custom_wallpaper = Some(name.clone());
    next.wallpaper = Some("custom".into());
    if let Err(error) = next.save(&state.paths) {
        let _ = std::fs::remove_file(state.paths.root.join("wallpapers").join(name));
        return Err(format!("не удалось сохранить настройки фона: {error}"));
    }
    *current = next.clone();
    #[cfg(windows)]
    invalidate_scene(state).await;
    Ok(next)
}

#[tauri::command]
async fn set_custom_wallpaper(state: State<'_, AppState>, path: String) -> Result<Settings, String> {
    let dir = state.paths.root.join("wallpapers");
    let name = tauri::async_runtime::spawn_blocking(move || wallpapers::copy_media(Path::new(&path), &dir))
        .await.map_err(|e| e.to_string())??;
    select_custom_wallpaper(&state, name).await
}

/// Прямые ссылки скачиваются с проверкой адресов, лимита, сигнатуры и каждого
/// redirect; несовместимая страница никогда не запускается в окне лаунчера.
#[tauri::command]
async fn download_custom_wallpaper(state: State<'_, AppState>, url: String) -> Result<Settings, String> {
    let dir = state.paths.root.join("wallpapers");
    let name = wallpapers::download_media(&url, &dir).await?;
    select_custom_wallpaper(&state, name).await
}

fn revoke_video_slot(state: &AppState, slot: &str) {
    let mut server = state.video_server.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(active) = server.as_ref() {
        active.revoke(slot);
        if active.is_empty() { server.take(); }
    }
}

/// Только проверенный файл: изображения через узкий asset scope, видео —
/// потоково через loopback, поскольку GStreamer не воспроизводит asset://.
#[tauri::command]
async fn wallpaper_source(app: AppHandle, state: State<'_, AppState>, source: String) -> Result<Option<wallpapers::Media>, String> {
    // Сцену восстанавливаем только если она действительно выбрана, а не при
    // каждой загрузке списка старых обоев. Проверяем библиотеку повторно.
    if source == "workshop" {
        let settings = state.settings.lock().await;
        if !settings.wallpaper_engine_enabled { return Ok(None); }
        let chosen = settings.wallpaper_workshop_project.clone();
        let scene = chosen.as_deref().and_then(|path| wallpapers::project(Path::new(path)))
            .is_some_and(|p| p.kind == "scene");
        if scene {
            if settings.wallpaper.as_deref() != Some("workshop") { return Ok(None); }
            #[cfg(not(windows))]
            return Err("сцены Wallpaper Engine доступны только в Windows".into());
            #[cfg(windows)]
            {
                let selected = PathBuf::from(chosen.as_deref().ok_or("сцена не выбрана")?)
                    .canonicalize().map_err(|_| "сцена недоступна".to_string())?;
                let manual = settings.wallpaper_steam_path.clone();
                let epoch = state.scene_revision.load(Ordering::Acquire);
                let library_epoch = state.wallpaper_revision.load(Ordering::Acquire);
                let revision = state.wallpaper_revision.clone();
                drop(settings);
                let check = selected.clone();
                let engine = tauri::async_runtime::spawn_blocking(move || {
                    validate_workshop(&check, manual.as_deref(), || revision.load(Ordering::Acquire) != library_epoch)
                }).await.map_err(|e| e.to_string())??.ok_or("выбран не проект сцены")?;
                let _operation = state.scene_operation.lock().await;
                {
                    let current = state.settings.lock().await;
                    if state.scene_revision.load(Ordering::Acquire) != epoch
                        || state.wallpaper_revision.load(Ordering::Acquire) != library_epoch
                        || !current.wallpaper_engine_enabled
                        || current.wallpaper.as_deref() != Some("workshop")
                        || current.wallpaper_workshop_project != chosen {
                        return Ok(None);
                    }
                }
                let media = start_scene(&state, &app, engine, selected.clone(), epoch).await?;
                let current = state.settings.lock().await;
                if state.scene_revision.load(Ordering::Acquire) != epoch
                    || state.wallpaper_revision.load(Ordering::Acquire) != library_epoch
                    || !current.wallpaper_engine_enabled
                    || current.wallpaper.as_deref() != Some("workshop")
                    || current.wallpaper_workshop_project != chosen {
                    stop_scene_epoch(&state, epoch).await;
                    return Ok(None);
                }
                if let Err(error) = commit_scene(&state, epoch) {
                    stop_scene_epoch(&state, epoch).await;
                    return Err(error);
                }
                revoke_video_slot(&state, &source);
                return Ok(Some(media));
            }
        }
    }
    // Чтение настроек и регистрация URL атомарны относительно смены файла:
    // старый запрос не сможет снова открыть уже заменённое видео.
    let settings = state.settings.lock().await;
    if source == "workshop" && !settings.wallpaper_engine_enabled { return Ok(None); }
    let result = match source.as_str() {
        "custom" => settings.custom_wallpaper.as_deref()
            .map(|name| wallpapers::custom_media(&state.paths.root.join("wallpapers"), name)).transpose(),
        "workshop" => settings.wallpaper_workshop_project.as_deref()
            .map(|dir| wallpapers::project_media(Path::new(dir))).transpose(),
        _ => return Err("неизвестный источник фона".into()),
    };
    let mut media = match result {
        Ok(Some(media)) => media,
        other => {
            revoke_video_slot(&state, &source);
            return other;
        }
    };
    if media.kind == "video" {
        let mut guard = state.video_server.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() { *guard = Some(video_stream::VideoServer::new()?); }
        media.src = Some(guard.as_ref().unwrap().expose(&source, Path::new(&media.path))?);
    } else {
        revoke_video_slot(&state, &source);
        app.asset_protocol_scope().allow_file(&media.path).map_err(|e| format!("не удалось открыть медиа: {e}"))?;
    }
    drop(settings);
    Ok(Some(media))
}

/// None — менеджер занят или платформа без WGC; false — выбранный захват
/// действительно завершился. Эта команда не запускает и не меняет обои.
#[tauri::command]
fn wallpaper_scene_status(state: State<'_, AppState>) -> Option<bool> {
    #[cfg(windows)]
    {
        state.scene_manager.try_lock().ok().map(|guard| guard.as_ref().is_some_and(|scene| scene.is_alive()))
    }
    #[cfg(not(windows))]
    { let _ = state; None }
}

#[tauri::command]
async fn scan_wallpaper_library(state: State<'_, AppState>) -> Result<wallpapers::Library, String> {
    let settings = state.settings.lock().await;
    if !settings.wallpaper_engine_enabled { return Err("Wallpaper Engine выключен в OmniSpec".into()); }
    let manual = settings.wallpaper_steam_path.clone();
    let epoch = state.wallpaper_revision.load(Ordering::Acquire);
    let revision = state.wallpaper_revision.clone();
    drop(settings);
    let library = tauri::async_runtime::spawn_blocking(move || {
        wallpapers::scan_library_cancellable(manual.as_deref(), || revision.load(Ordering::Acquire) != epoch)
    }).await.map_err(|e| e.to_string())??;
    let settings = state.settings.lock().await;
    if !settings.wallpaper_engine_enabled || state.wallpaper_revision.load(Ordering::Acquire) != epoch {
        return Err("поиск Wallpaper Engine отменён".into());
    }
    Ok(library)
}

#[tauri::command]
fn parse_wallpaper_workshop_link(url: String) -> Option<String> {
    wallpapers::workshop_link(&url)
}

/// None — обычное видео, Some — проверенный путь к WE для сцены.
fn validate_workshop(selected: &Path, manual: Option<&str>, cancelled: impl Fn() -> bool) -> Result<Option<String>, String> {
    let library = wallpapers::scan_library_cancellable(manual, cancelled)?;
    let item = library.projects.iter().find(|p| Path::new(&p.directory) == selected)
        .ok_or("проект не найден в выбранной библиотеке Steam")?;
    match item.kind.as_str() {
        "video" => { wallpapers::project_media(selected)?; Ok(None) }
        "scene" if cfg!(windows) => library.engine.map(Some)
            .ok_or_else(|| "Wallpaper Engine не найден. Укажи папку Steam с установленным Wallpaper Engine".into()),
        "scene" => Err("сцены Wallpaper Engine доступны только в Windows".into()),
        _ => Err("web-обои и приложения можно открыть только отдельно в Wallpaper Engine".into()),
    }
}

/// Разрешаем выбор только из найденной библиотеки, проверяя проект повторно.
/// Сцена сохраняется лишь после получения реального первого кадра.
#[tauri::command]
async fn set_workshop_wallpaper(app: AppHandle, state: State<'_, AppState>, directory: String) -> Result<Settings, String> {
    #[cfg(not(windows))]
    let _ = &app;
    let current = state.settings.lock().await;
    if !current.wallpaper_engine_enabled { return Err("Wallpaper Engine выключен в OmniSpec".into()); }
    let manual = current.wallpaper_steam_path.clone();
    let previous_wallpaper = current.wallpaper.clone();
    let previous_project = current.wallpaper_workshop_project.clone();
    let library_epoch = state.wallpaper_revision.load(Ordering::Acquire);
    let revision = state.wallpaper_revision.clone();
    #[cfg(windows)]
    let epoch = state.scene_revision.fetch_add(1, Ordering::AcqRel) + 1;
    drop(current);
    let selected = PathBuf::from(directory).canonicalize().map_err(|_| "проект не найден".to_string())?;
    let check_path = selected.clone();
    let engine = tauri::async_runtime::spawn_blocking(move || {
        validate_workshop(&check_path, manual.as_deref(), || revision.load(Ordering::Acquire) != library_epoch)
    }).await.map_err(|e| e.to_string())??;
    #[cfg(not(windows))]
    let _ = &engine;
    #[cfg(windows)]
    let _operation = state.scene_operation.lock().await;
    #[cfg(windows)]
    {
        let current = state.settings.lock().await;
        if state.scene_revision.load(Ordering::Acquire) != epoch
            || state.wallpaper_revision.load(Ordering::Acquire) != library_epoch
            || !current.wallpaper_engine_enabled
            || current.wallpaper != previous_wallpaper
            || current.wallpaper_workshop_project != previous_project {
            return Err("выбор фона изменился".into());
        }
    }
    #[cfg(windows)]
    if let Some(engine) = &engine { start_scene(&state, &app, engine.clone(), selected.clone(), epoch).await?; }
    let mut current = state.settings.lock().await;
    if state.wallpaper_revision.load(Ordering::Acquire) != library_epoch
        || !current.wallpaper_engine_enabled
        || current.wallpaper != previous_wallpaper
        || current.wallpaper_workshop_project != previous_project {
        #[cfg(windows)]
        stop_scene_epoch(&state, epoch).await;
        return Err("выбор фона изменился".into());
    }
    #[cfg(windows)]
    if state.scene_revision.load(Ordering::Acquire) != epoch {
        stop_scene_epoch(&state, epoch).await;
        return Err("выбор фона изменился".into());
    }
    let mut next = current.clone();
    next.wallpaper_workshop_project = Some(selected.to_string_lossy().into_owned());
    next.wallpaper = Some("workshop".into());
    if let Err(error) = next.save(&state.paths) {
        #[cfg(windows)]
        if engine.is_some() { stop_scene_epoch(&state, epoch).await; }
        return Err(err(error));
    }
    #[cfg(windows)]
    if engine.is_some() {
        if let Err(error) = commit_scene(&state, epoch) {
            // На случай отмены при уничтожении окна восстанавливаем старые
            // настройки; прежняя сцена ещё не закрыта.
            let rollback = current.save(&state.paths);
            stop_scene_epoch(&state, epoch).await;
            return Err(match rollback { Ok(()) => error, Err(rollback) => format!("{error}; не удалось вернуть старые настройки: {rollback}") });
        }
    }
    *current = next.clone();
    #[cfg(windows)]
    if engine.is_none() { invalidate_scene(&state).await; }
    Ok(next)
}

/// Сцена/web/application открываются только по явному подтверждению в
/// официальном Wallpaper Engine (в отдельном окне, не внутри OmniSpec).
#[tauri::command]
async fn open_wallpaper_engine(state: State<'_, AppState>, directory: String) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (state, directory);
        Err("официальный Wallpaper Engine доступен для запуска из OmniSpec только в Windows".into())
    }
    #[cfg(windows)]
    {
        let settings = state.settings.lock().await;
        if !settings.wallpaper_engine_enabled { return Err("Wallpaper Engine выключен в OmniSpec".into()); }
        let manual = settings.wallpaper_steam_path.clone();
        let epoch = state.wallpaper_revision.load(Ordering::Acquire);
        let revision = state.wallpaper_revision.clone();
        drop(settings);
        let selected = PathBuf::from(directory).canonicalize().map_err(|_| "проект не найден".to_string())?;
        let scan_revision = revision.clone();
        let lib = tauri::async_runtime::spawn_blocking(move || {
            wallpapers::scan_library_cancellable(manual.as_deref(), || scan_revision.load(Ordering::Acquire) != epoch)
        }).await.map_err(|e| e.to_string())??;
        if !lib.projects.iter().any(|p| Path::new(&p.directory) == selected) {
            return Err("проект не найден в выбранной библиотеке Steam".into());
        }
        let exe = lib.engine.ok_or_else(|| "wallpaper64.exe не найден. Укажи папку Steam с установленным Wallpaper Engine".to_string())?;
        // Внешнее окно тоже запускаем только из проверенного подписанного WE;
        // путь из пользовательской библиотеки сам по себе не является доверием.
        let verify_revision = revision.clone();
        let (exe, project_file) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let exe = PathBuf::from(exe).canonicalize().map_err(|_| "Wallpaper Engine не найден".to_string())?;
            scene_capture::verify_signature(&exe, &verify_revision, epoch)?;
            let project_file = selected.join("project.json").canonicalize().map_err(|_| "project.json не найден".to_string())?;
            if project_file.parent() != Some(selected.as_path()) { return Err("project.json находится вне папки проекта".into()); }
            Ok((exe, project_file))
        }).await.map_err(|error| format!("не удалось подготовить Wallpaper Engine: {error}"))??;
        // Последняя проверка и отправка не обгоняют выключение интеграции.
        let current = state.settings.lock().await;
        if !current.wallpaper_engine_enabled || revision.load(Ordering::Acquire) != epoch {
            return Err("открытие Wallpaper Engine отменено".into());
        }
        // Canonicalize на Windows выдаёт \\?\-путь; обычная форма совместимее
        // с внешними приложениями. Для длинных/особых путей префикс сохраняется.
        std::process::Command::new(dunce::simplified(&exe))
            .args(["-control", "openWallpaper", "-file"]).arg(dunce::simplified(&project_file))
            .args(["-playInWindow", "OmniSpec Wallpaper", "-width", "1280", "-height", "720"])
            .spawn().map(|_| ()).map_err(|e| format!("не удалось отправить команду Wallpaper Engine: {e}"))
    }
}

/// Где лежит сборка — строка «папка: …» в главном окне.
#[tauri::command]
fn instance_path(state: State<'_, AppState>, instance_id: String) -> Result<String, String> {
    instances::load(&state.paths, &instance_id).map_err(err)?;
    Ok(state.paths.instance_dir(&instance_id).display().to_string())
}

#[tauri::command]
fn window_action(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "drag" => window.start_dragging(),
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        "fullscreen" => {
            let full = window.is_fullscreen().unwrap_or(false);
            window.set_fullscreen(!full)
        }
        other => return Err(format!("неизвестное действие окна: {other}")),
    }
    .map_err(err)
}

fn main() {
    // На томах без коротких имён Shell не может буквально сохранить путь с
    // %ИМЯ% в рабочей папке .lnk. Исправляем её только по специальному аргументу
    // ярлыка; обычный запуск и относительные аргументы остаются без изменений.
    #[cfg(windows)]
    if let Err(error) = omnispec_core::windows_shortcut::enter_shortcut_directory() {
        eprintln!("[omnispec] не удалось установить рабочую папку ярлыка: {error}");
    }

    // Режим помощника обновления: заменяем exe уже после выхода лаунчера.
    let args: Vec<String> = std::env::args().collect();
    if let Some(index) = args.iter().position(|arg| arg == update::HELPER_FLAG) {
        let new_binary = args.get(index + 1).cloned().unwrap_or_default();
        let target = args.get(index + 2).cloned().unwrap_or_default();
        if new_binary.is_empty() || target.is_empty() {
            std::process::exit(2);
        }
        let code = update::run_helper(Path::new(&new_binary), Path::new(&target));
        std::process::exit(code);
    }

    let paths = Paths::discover().unwrap_or_else(|error| {
        panic!("не удалось создать папку данных: {error}");
    });
    if let Err(error) = paths.ensure() {
        eprintln!("[omnispec] не удалось создать папки: {error}");
    }
    let settings = Settings::load(&paths).unwrap_or_default();
    // Чистим хвосты прошлых обновлений (скачанные копии, помощники).
    update::cleanup(&paths, None);
    let http = Http::with_proxy(settings.proxy.as_deref());

    // имя не `startup_file`: иначе локальная переменная перекрывает команду в generate_handler!
    let startup_path = std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && std::path::Path::new(arg).exists());
    // Discord Rich Presence: воркер в фоне, молча ждёт Client ID в настройках.
    let presence = presence::Presence::new()
        .with_log_path(paths.root.join("discord-rpc.log"));
    presence.configure(settings.discord_rpc);
    let presence_worker = presence.clone();
    std::thread::spawn(move || presence_worker.run());
    let (rpc_upload_allowed, _) = tokio::sync::watch::channel(
        settings.discord_rpc && settings.discord_instance_icon && settings.discord_upload_local_icon
    );

    // Восстанавливаем только сессии, созданные новой версией лаунчера, и
    // только при полном совпадении PID и времени создания процесса.
    let mut restored = Vec::new();
    let mut restored_map = HashMap::new();
    for record in game_sessions::records(&paths.root) {
        if record.ended_at.is_some() || !game_sessions::is_alive(&record.process) {
            // Если игра закончилась, пока лаунчер был закрыт, точное время
            // неизвестно: не начисляем период после последней отметки.
            let until = record.ended_at.unwrap_or(record.checkpoint_at);
            if let Err(error) = game_sessions::finalize(&paths, &record, until) {
                eprintln!("[omnispec] не удалось завершить статистику сессии; журнал сохранён: {error}");
            }
            continue;
        }
        if instances::load(&paths, &record.instance_id).is_err() { continue; }
        let id = record.instance_id.clone();
        let run = record.run_id.clone();
        let handle = Arc::new(RunningChild {
            child: Mutex::new(None), account: record.account.clone(), started_at: record.started_at,
            game_dir: PathBuf::from(&record.game_dir), record: Some(StdMutex::new(record)),
            stop_requested: AtomicBool::new(false),
        });
        restored_map.insert(run.clone(), handle.clone());
        restored.push((id, run, handle));
    }
    let state = AppState {
        modrinth: Modrinth::new(http.clone()),
        curseforge: CurseForge::new(http.clone()),
        startup_file: startup_path,
        accounts: Mutex::new(AccountStore::load(&paths)),
        accounts_dirty: AtomicBool::new(false),
        paths,
        http,
        settings: Mutex::new(settings),
        video_server: StdMutex::new(None),
        wallpaper_revision: Arc::new(AtomicU64::new(0)),
        #[cfg(windows)]
        scene_manager: Arc::new(StdMutex::new(None)),
        #[cfg(windows)]
        scene_revision: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        #[cfg(windows)]
        scene_operation: Mutex::new(()),
        running: Arc::new(Mutex::new(restored_map)),
        launching: Arc::new(StdMutex::new(HashMap::new())),
        content_access: Arc::new(StdMutex::new(ContentAccess::default())),
        diagnostic_launches: StdMutex::new(HashMap::new()),
        presence,
        rpc_icon_lock: Mutex::new(()),
        rpc_upload_allowed,
    };

    tauri::Builder::default()
        .manage(state)
        .setup(move |app| {
            let _ = app.get_webview_window("main");
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                let manager = app.state::<AppState>().scene_manager.clone();
                let revision = app.state::<AppState>().scene_revision.clone();
                let position_revision = Arc::new(std::sync::atomic::AtomicU64::new(0));
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                        let position = position_revision.fetch_add(1, Ordering::AcqRel) + 1;
                        let latest = position_revision.clone();
                        let manager = manager.clone();
                        let bounds = scene_bounds(&handle);
                        tauri::async_runtime::spawn_blocking(move || {
                            let guard = manager.lock().unwrap_or_else(|e| e.into_inner());
                            if latest.load(Ordering::Acquire) == position {
                                if let Some(scene) = guard.as_ref() { scene.place(bounds); }
                            }
                        });
                    } else if matches!(event, tauri::WindowEvent::Destroyed) {
                        revision.fetch_add(1, Ordering::AcqRel);
                        if let Ok(mut guard) = manager.try_lock() { guard.take(); }
                    }
                });
            }
            for (id, run, child) in restored {
                let state = app.state::<AppState>();
                monitor_game(app.handle().clone(), id, run, None, child,
                    state.running.clone(), state.paths.clone(), Vec::new(), true);
            }
            // Прогрев кешей в фоне: поиск Java и манифест версий уже готовы к
            // первому запуску игры, поэтому «Играть» нажимается без ожидания.
            let paths = app.state::<AppState>().paths.clone();
            let http = app.state::<AppState>().http.clone();
            tauri::async_runtime::spawn(async move {
                let _ = game::java::detect_all(&paths).await;
                let _ = game::fetch_manifest(&http, &paths, Duration::from_secs(3600)).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            system_memory,
            get_settings,
            save_settings,
            set_wallpaper_engine_enabled,
            set_wallpaper_workshop_audio,
            set_presence,
            resolve_presence_icon,
            list_instances,
            acknowledge_instance_renames,
            create_instance,
            create_instance_for_mod,
            delete_instance,
            duplicate_instance,
            update_instance,
            minecraft_versions,
            loader_versions,
            install_instance,
            launch_instance,
            stop_instance,
            running_instances,
            running_sessions,
            search_modrinth,
            modrinth_versions,
            modrinth_project,
            search_curseforge,
            curseforge_versions,
            curseforge_compatibility_versions,
            curseforge_project,
            curseforge_ready,
            install_curseforge,
            install_curseforge_modpack,
            account_skin,
            account_capes,
            set_cape,
            apply_skin,
            save_skin_png,
            image_data_url,
            import_skin,
            install_mod,
            install_diagnostic_mod,
            install_mod_version,
            install_modpack,
            cancel_download,
            list_dir,
            read_text_file,
            delete_file,
            fm_create_dir,
            fm_rename,
            fm_move,
            fm_read_image,
            archive_list,
            archive_read,
            list_mods,
            toggle_mod,
            list_java,
            open_path,
            window_action,
            mod_icons,
            world_icons,
            list_screenshots,
            screenshot_thumb,
            screenshot_full,
            scan_external_launchers,
            import_external,
            export_instance,
            import_zip,
            pick_save_path,
            set_custom_wallpaper,
            download_custom_wallpaper,
            wallpaper_source,
            wallpaper_scene_status,
            scan_wallpaper_library,
            parse_wallpaper_workshop_link,
            set_workshop_wallpaper,
            open_wallpaper_engine,
            instance_path,
            version_info,
            check_update,
            net_check,
            catalog_installed_mods,
            content_list,
            content_toggle,
            content_delete,
            content_updates,
            content_update,
            content_replace_version,
            mods_ensure_dependencies,
            accounts_info,
            account_add_offline,
            account_rename,
            account_set_active,
            account_remove,
            ms_login_start,
            ms_login_poll,
            pick_file,
            pick_files,
            pick_dir,
            set_instance_icon_file,
            instance_icon,
            copy_instance_file,
            startup_file,
            install_update,
            open_url,
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска OmniSpec");
}

#[cfg(test)]
mod tests {
    use super::{finish_pumps, pump_lines, reserve_launch, run_key, run_instance_id};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn account_information_sent_to_webview_does_not_contain_tokens() {
        let mut account = super::Account::offline("Alex").unwrap();
        account.kind = "microsoft".into();
        account.access_token = "access-secret".into();
        account.refresh_token = "refresh-secret".into();
        let summary = super::AccountSummary::from(&account);
        let serialized = serde_json::to_string(&summary).unwrap();
        assert!(serialized.contains("Alex"));
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("access_token"));
        assert!(!serialized.contains("refresh_token"));
    }

    #[test]
    fn external_browser_urls_reject_non_http_and_control_characters() {
        use super::browser_url;
        assert_eq!(browser_url("https://example.org/path?a=1&b=2").unwrap(), "https://example.org/path?a=1&b=2");
        assert_eq!(browser_url("http://example.org/space here").unwrap(), "http://example.org/space%20here");
        for input in ["file:///etc/passwd", "javascript:alert(1)", "https://", "https://example.org/\ncalc", "https://example.org/\0x"] {
            assert!(browser_url(input).is_err(), "{input:?}");
        }
    }

    #[test]
    fn queued_settings_do_not_undo_recovered_last_instance() {
        use super::{instances, preserve_recovered_last_instance, Paths, Settings};
        let root = std::env::temp_dir().join(format!("omnispec-last-instance-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        let meta = instances::create(&paths, serde_json::from_value(serde_json::json!({
            "id":"new", "name":"New", "mc_version":"1.21.1"
        })).unwrap()).unwrap();
        let current = Settings { last_instance: Some(meta.id.clone()), ..Settings::default() };
        let mut stale = Settings { last_instance: Some("old".into()), ..Settings::default() };
        preserve_recovered_last_instance(&paths, &current, &mut stale);
        assert_eq!(stale.last_instance, Some(meta.id));
        let mut clear = Settings { last_instance: None, ..Settings::default() };
        preserve_recovered_last_instance(&paths, &current, &mut clear);
        assert_eq!(clear.last_instance, None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stale_settings_cannot_reenable_or_replace_wallpaper_engine_controls() {
        let current = super::Settings {
            wallpaper_engine_enabled: false,
            wallpaper_workshop_audio: true,
            wallpaper_workshop_project: Some("chosen".into()),
            ..super::Settings::default()
        };
        let mut stale = super::Settings {
            wallpaper_engine_enabled: true,
            wallpaper_workshop_audio: false,
            wallpaper_workshop_project: Some("old".into()),
            ui_scale: 125,
            ..super::Settings::default()
        };
        super::preserve_wallpaper_controls(&current, &mut stale);
        assert!(!stale.wallpaper_engine_enabled);
        assert!(stale.wallpaper_workshop_audio);
        assert_eq!(stale.wallpaper_workshop_project.as_deref(), Some("chosen"));
        assert_eq!(stale.ui_scale, 125, "unrelated settings still change");
    }

    #[test]
    fn opening_a_stale_absolute_path_never_recreates_a_moved_instance() {
        use super::{instances, prepare_open_path, Paths};
        let root = std::env::temp_dir().join(format!("omnispec-open-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        let meta = instances::create(&paths, serde_json::from_value(serde_json::json!({
            "id":"old", "name":"Old", "mc_version":"1.21.1"
        })).unwrap()).unwrap();
        let old = paths.instance_dir(&meta.id);
        let missing = old.join("minecraft").join("screenshots").join("missing.png");
        let created = prepare_open_path(&paths, "/instances/old/minecraft/logs/created").unwrap();
        assert!(created.is_dir());
        std::fs::rename(&old, paths.instance_dir("new")).unwrap();
        assert!(prepare_open_path(&paths, "/instances/old/minecraft/logs/created").is_err());
        assert!(prepare_open_path(&paths, &missing.to_string_lossy()).is_err());
        assert!(!old.exists(), "opening a stale path recreated the old instance");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn diagnostic_reservation_excludes_running_preparing_and_concurrent_writes() {
        use super::{reserve_content_write, reserve_diagnostic_repair, ContentAccess};
        let access = Arc::new(Mutex::new(ContentAccess::default()));
        let launching = Arc::new(Mutex::new(HashMap::new()));
        assert!(reserve_diagnostic_repair("pack", true, &launching, &access).is_err());
        launching.lock().unwrap().insert("different-pack".into(), 1);
        assert!(reserve_diagnostic_repair("pack", false, &launching, &access).is_err());
        launching.lock().unwrap().clear();
        let writer = reserve_content_write("different-pack", &access).unwrap();
        assert!(reserve_diagnostic_repair("pack", false, &launching, &access).is_err());
        drop(writer);
        let repair = reserve_diagnostic_repair("pack", false, &launching, &access).unwrap();
        assert!(reserve_content_write("pack", &access).is_err());
        assert!(reserve_content_write("different-pack", &access).is_err(), "shared game directories cannot bypass the guard");
        assert!(reserve_diagnostic_repair("other", false, &launching, &access).is_err());
        drop(repair);
        assert!(reserve_content_write("pack", &access).is_ok());
        assert!(reserve_diagnostic_repair("pack", false, &launching, &access).is_ok());
    }

    #[test]
    fn diagnostic_config_tracks_game_directory_and_actual_java_settings() {
        use super::{DiagnosticConfig, InstanceMeta, Paths, Settings};
        let root = std::env::temp_dir().join(format!("omnispec-config-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        let mut meta: InstanceMeta = serde_json::from_value(serde_json::json!({
            "id":"test","name":"Test","mc_version":"26.3","loader":{"type":"fabric","version":"0.19.3"}
        })).unwrap();
        let mut settings = Settings::default();
        let base = DiagnosticConfig::new(&paths, &meta, &settings, meta.version_id());
        settings.java_path = Some("another-java".into());
        assert_ne!(base, DiagnosticConfig::new(&paths, &meta, &settings, meta.version_id()));
        settings.java_path = None; meta.mc_version = "26.2".into();
        assert_ne!(base, DiagnosticConfig::new(&paths, &meta, &settings, meta.version_id()));
        meta.mc_version = "26.3".into(); meta.game_dir = Some(root.join("external").display().to_string());
        assert_ne!(base, DiagnosticConfig::new(&paths, &meta, &settings, meta.version_id()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn run_key_accepts_full_key_from_ui() {
        assert_eq!(run_key("atm10", Some("atm10#2".into())).as_deref(), Some("atm10#2"));
    }

    #[test]
    fn run_key_prefixes_short_number() {
        assert_eq!(run_key("atm10", Some("2".into())).as_deref(), Some("atm10#2"));
        assert_eq!(run_key("Сборка #1", Some("2".into())).as_deref(), Some("Сборка #1#2"));
        assert_eq!(run_instance_id("Сборка #1#2"), "Сборка #1");
    }

    #[test]
    fn run_key_without_run_id_stops_all_windows() {
        assert_eq!(run_key("atm10", None), None);
    }

    #[test]
    fn reservation_blocks_accidental_double_launch_but_allows_duplicates() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let first = reserve_launch("one", false, false, &pending).unwrap();
        assert!(reserve_launch("one", false, false, &pending).is_err());
        let duplicate = reserve_launch("one", true, false, &pending).unwrap();
        let other = reserve_launch("two", false, false, &pending).unwrap();
        drop(first);
        assert!(reserve_launch("one", false, false, &pending).is_err());
        drop(duplicate);
        assert!(reserve_launch("one", false, false, &pending).is_ok());
        assert!(reserve_launch("one", false, true, &pending).is_err());
        drop(other);
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn concurrent_regular_launches_get_only_one_reservation() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let barrier = Arc::new(Barrier::new(9));
        let successes = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for _ in 0..8 {
            let pending = pending.clone();
            let barrier = barrier.clone();
            let successes = successes.clone();
            threads.push(std::thread::spawn(move || {
                let reservation = reserve_launch("one", false, false, &pending);
                if reservation.is_ok() {
                    successes.fetch_add(1, Ordering::Relaxed);
                }
                // Победитель держит бронь, пока все потоки не закончат проверку.
                barrier.wait();
                drop(reservation);
            }));
        }
        barrier.wait();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(successes.load(Ordering::Relaxed), 1);
        assert!(pending.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_stop_is_recorded_for_the_exact_child() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let process = tokio::process::Command::new("sleep").arg("30").spawn().unwrap();
        let handle = Arc::new(super::RunningChild {
            child: tokio::sync::Mutex::new(Some(process)),
            record: None, account: "test".into(), started_at: 1,
            game_dir: std::path::PathBuf::from("test"),
            stop_requested: AtomicBool::new(false),
        });
        assert!(!handle.stop_requested.load(Ordering::Relaxed));
        super::request_stop(&handle).await.unwrap();
        assert!(handle.stop_requested.load(Ordering::Relaxed));
        let status = handle.child.lock().await.as_mut().unwrap().wait().await.unwrap();
        assert!(!status.success());
    }

    #[tokio::test]
    async fn pumps_drain_both_streams_before_exit_and_handle_invalid_utf8() {
        let output = Arc::new(Mutex::new(Vec::<String>::new()));
        let (mut stdout, stdout_reader) = tokio::io::duplex(1024);
        let (mut stderr, stderr_reader) = tokio::io::duplex(1024);
        let out_lines = output.clone();
        let err_lines = output.clone();
        let first = tokio::spawn(async move {
            pump_lines(stdout_reader, |line| out_lines.lock().unwrap().push(line)).await;
        });
        let second = tokio::spawn(async move {
            pump_lines(stderr_reader, |line| err_lines.lock().unwrap().push(line)).await;
        });
        stdout.write_all(b"ordinary output\n").await.unwrap();
        stdout.shutdown().await.unwrap();
        let writer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(35)).await;
            stderr.write_all(b"last error \xff\n").await.unwrap();
            stderr.shutdown().await.unwrap();
        });
        assert!(finish_pumps(vec![first, second], Duration::from_secs(1)).await);
        writer.await.unwrap();
        output.lock().unwrap().push("EXIT".into());
        let lines = output.lock().unwrap();
        assert!(lines.iter().any(|line| line == "ordinary output"));
        assert!(lines.iter().any(|line| line == "last error \u{fffd}"));
        assert_eq!(lines.last().map(String::as_str), Some("EXIT"));
    }

    #[tokio::test]
    async fn stuck_stream_is_cancelled_and_long_lines_are_bounded() {
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let captured = lines.clone();
        let (mut writer, reader) = tokio::io::duplex(128 * 1024);
        let pump = tokio::spawn(async move {
            pump_lines(reader, |line| captured.lock().unwrap().push(line)).await;
        });
        writer.write_all(&vec![b'a'; 70_000]).await.unwrap();
        writer.write_all(b"\n").await.unwrap();
        // Держим writer открытым, как у процесса, унаследовавшего дескриптор.
        assert!(!finish_pumps(vec![pump], Duration::from_millis(100)).await);
        let got = lines.lock().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].len(), 65_536);
        assert_eq!(got[1].len(), 70_000 - 65_536);
        drop(got);
        assert!(writer.write_all(b"too late\n").await.is_err());
    }
}

#[cfg(test)]
mod skin_library_tests {
    use super::*;
    use std::io::Cursor;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut data = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(width, height).write_to(&mut data, image::ImageFormat::Png).unwrap();
        data.into_inner()
    }

    #[test]
    fn skins_are_validated_and_same_names_never_overwrite() {
        let root = std::env::temp_dir().join(format!("omnispec-skins-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let good = png(64, 64);
        let legacy = png(64, 32);
        assert_eq!(validate_skin_png(&good).unwrap(), (64, 64));
        assert_eq!(validate_skin_png(&legacy).unwrap(), (64, 32));
        assert!(validate_skin_png(&png(128, 64)).is_err());
        assert!(validate_skin_png(&good[..33]).is_err());
        let a = write_skin_file(&root, "одинаковое", &good).unwrap();
        let b = write_skin_file(&root, "одинаковое", &legacy).unwrap();
        assert_ne!(a, b);
        assert_eq!(std::fs::read(a).unwrap(), good);
        assert_eq!(std::fs::read(b).unwrap(), legacy);
        std::fs::remove_dir_all(root).unwrap();
    }
}
