// Скрыть консольное окно в релизной сборке на Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri-оболочка OmniSpec: тонкий слой команд поверх `omnispec-core`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
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
use omnispec_core::net::{Http, Reporter};
use omnispec_core::paths::Paths;
use omnispec_core::settings::Settings;
use omnispec_core::update::{self, UpdateInfo};

type ChildHandle = Arc<Mutex<tokio::process::Child>>;

struct AppState {
    paths: Paths,
    /// Путь, с которым лаунчер запустили (`.mrpack` двойным щелчком или drag&drop в ярлык).
    startup_file: Option<String>,
    accounts: Mutex<AccountStore>,
    http: Http,
    modrinth: Modrinth,
    settings: Mutex<Settings>,
    running: Arc<Mutex<HashMap<String, ChildHandle>>>,
}

fn err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

/// Reporter, который отправляет прогресс в UI событием `progress`.
fn reporter_for(app: &AppHandle, instance_id: &str) -> Reporter {
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
            }),
        );
    })
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

/* ==================== НАСТРОЙКИ ==================== */

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.lock().await.clone())
}

#[tauri::command]
async fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    settings.save(&state.paths).map_err(err)?;
    *state.settings.lock().await = settings;
    Ok(())
}

/* ==================== СБОРКИ ==================== */

#[tauri::command]
fn list_instances(state: State<'_, AppState>) -> Result<Vec<InstanceMeta>, String> {
    instances::list(&state.paths).map_err(err)
}

#[tauri::command]
async fn create_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    req: CreateInstanceRequest,
) -> Result<InstanceMeta, String> {
    let meta = instances::create(&state.paths, req).map_err(err)?;
    let reporter = reporter_for(&app, &meta.id);
    reporter.emit("loader", 0, 1, "готовим профиль версии");
    // Сразу готовим профиль загрузчика, чтобы сборка была готова к запуску.
    if let Err(error) =
        loaders::ensure_profile(&state.http, &state.paths, &meta, &reporter).await
    {
        eprintln!("[omnispec] профиль загрузчика не установлен: {error}");
    }
    reporter.emit("loader", 1, 1, "готово");
    instances::load(&state.paths, &meta.id).map_err(err)
}

#[tauri::command]
fn delete_instance(state: State<'_, AppState>, instance_id: String) -> Result<(), String> {
    instances::delete(&state.paths, &instance_id).map_err(err)
}

#[tauri::command]
fn update_instance(state: State<'_, AppState>, meta: InstanceMeta) -> Result<(), String> {
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
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let reporter = reporter_for(&app, &instance_id);
    loaders::ensure_profile(&state.http, &state.paths, &meta, &reporter)
        .await
        .map_err(err)?;
    let report = game::install::ensure_installed(
        &state.http,
        &state.paths,
        &meta.version_id(),
        &reporter,
    )
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
) -> Result<Value, String> {
    {
        let running = state.running.lock().await;
        if running.contains_key(&instance_id) {
            return Err("эта сборка уже запущена".into());
        }
    }

    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let settings = state.settings.lock().await.clone();
    let account = current_account(&state, &settings).await?;
    let reporter = reporter_for(&app, &instance_id);

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
    instances::touch_play(&state.paths, &instance_id).ok();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    state
        .running
        .lock()
        .await
        .insert(instance_id.clone(), child.clone());

    emit_game_log(
        &app,
        &instance_id,
        format!(
            "[omnispec] запуск: {} (аргументов {}, файлов в classpath {})",
            plan.java,
            plan.args.len(),
            plan.classpath_entries
        ),
    );

    if let Some(stdout) = stdout {
        spawn_pump(app.clone(), instance_id.clone(), stdout);
    }
    if let Some(stderr) = stderr {
        spawn_pump(app.clone(), instance_id.clone(), stderr);
    }

    // Следим за завершением процесса.
    {
        let app = app.clone();
        let id = instance_id.clone();
        let child = child.clone();
        let running = state.running.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(700)).await;
                let status = {
                    let mut guard = child.lock().await;
                    guard.try_wait().ok().flatten()
                };
                if let Some(status) = status {
                    let code = status.code().unwrap_or(-1);
                    running.lock().await.remove(&id);
                    let _ = app.emit(
                        "game-exit",
                        json!({"instance": id, "code": code}),
                    );
                    break;
                }
            }
        });
    }

    Ok(launch_summary(&plan))
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
    })
}

fn emit_game_log(app: &AppHandle, instance_id: &str, line: String) {
    let _ = app.emit("game-log", json!({"instance": instance_id, "line": line}));
}

fn spawn_pump<R>(app: AppHandle, instance_id: String, reader: R)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_game_log(&app, &instance_id, line);
        }
    });
}

#[tauri::command]
async fn stop_instance(state: State<'_, AppState>, instance_id: String) -> Result<(), String> {
    let handle = state.running.lock().await.get(&instance_id).cloned();
    match handle {
        Some(child) => {
            let mut guard = child.lock().await;
            guard.start_kill().map_err(err)?;
            Ok(())
        }
        None => Err("сборка не запущена".into()),
    }
}

#[tauri::command]
async fn running_instances(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.running.lock().await.keys().cloned().collect())
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
    /// Сортировка Modrinth: relevance | downloads | follows | newest | updated.
    sort: Option<String>,
    limit: Option<u32>,
) -> Result<omnispec_core::modrinth::SearchResults, String> {
    state
        .modrinth
        .search(&SearchQuery {
            query,
            project_type,
            game_version: mc_version,
            loader,
            categories: Vec::new(),
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
async fn install_mod(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    project_id: String,
) -> Result<modrinth_install::InstallOutcome, String> {
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let reporter = reporter_for(&app, &instance_id);
    modrinth_install::install_project(&state.modrinth, &state.paths, &meta, &project_id, &reporter)
        .await
        .map_err(err)
}

#[tauri::command]
async fn install_mod_version(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    version_id: String,
) -> Result<modrinth_install::InstallOutcome, String> {
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let reporter = reporter_for(&app, &instance_id);
    modrinth_install::install_version(&state.modrinth, &state.paths, &meta, &version_id, &reporter)
        .await
        .map_err(err)
}

/// Установить модпак: принимает id версии Modrinth **или** путь к локальному `.mrpack`.
#[tauri::command]
async fn install_modpack(
    app: AppHandle,
    state: State<'_, AppState>,
    version_id: String,
) -> Result<InstanceMeta, String> {
    let reporter = reporter_for(&app, "modpack");
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
                .ok_or_else(|| "не понял ссылку — нужна вида modrinth.com/modpack/<название>".to_string())?;
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
        if matches!(component, std::path::Component::ParentDir) {
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
    let base = state.paths.instance_game_dir(&instance_id);
    let dir = if sub.trim().is_empty() {
        base
    } else {
        safe_join(&base, &sub)?
    };
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
    let base = state.paths.instance_game_dir(&instance_id);
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
    let base = state.paths.instance_game_dir(&instance_id);
    let target = safe_join(&base, &path)?;
    if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(err)
    } else {
        std::fs::remove_file(&target).map_err(err)
    }
}

#[derive(Serialize)]
struct ModEntry {
    name: String,
    size: u64,
    enabled: bool,
}

#[tauri::command]
fn list_mods(state: State<'_, AppState>, instance_id: String) -> Result<Vec<ModEntry>, String> {
    let dir = state.paths.instance_game_dir(&instance_id).join("mods");
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

#[tauri::command]
fn toggle_mod(
    state: State<'_, AppState>,
    instance_id: String,
    name: String,
) -> Result<String, String> {
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

/// Открыть ссылку в системном браузере.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("разрешены только http(s)-ссылки".into());
    }
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();

    result.map(|_| ()).map_err(err)
}


/* ==================== АККАУНТЫ ==================== */

#[derive(Serialize)]
struct AccountsInfo {
    accounts: Vec<Account>,
    active: Option<String>,
}

/// Выбранный аккаунт; если его нет — офлайн-аккаунт из настроек.
async fn current_account(state: &AppState, settings: &Settings) -> Result<Account, String> {
    let mut store = state.accounts.lock().await;
    let account = store
        .current()
        .cloned()
        .unwrap_or_else(|| Account::offline(&settings.username).unwrap_or_else(|_| Account {
            username: "Player".into(),
            uuid: omnispec_core::auth::offline_uuid("Player"),
            kind: "offline".into(),
            access_token: String::new(),
            refresh_token: String::new(),
            expires_at: 0,
        }));

    // Лицензионный токен живёт час — обновляем заранее, иначе игра не пустит на сервер.
    if account.needs_refresh() && !account.refresh_token.is_empty() {
        let client_id = settings.ms_client_id.clone().unwrap_or_default();
        match microsoft::refresh(&state.http, &client_id, &account.refresh_token).await {
            Ok(session) => {
                let fresh = Account::from_session(session);
                store.upsert(fresh.clone());
                let _ = store.save(&state.paths);
                return Ok(fresh);
            }
            Err(error) => {
                return Err(format!(
                    "не удалось обновить вход в Microsoft ({error}) — зайди в аккаунт заново"
                ))
            }
        }
    }
    Ok(account)
}

#[tauri::command]
async fn accounts_info(state: State<'_, AppState>) -> Result<AccountsInfo, String> {
    let store = state.accounts.lock().await;
    Ok(AccountsInfo {
        accounts: store.accounts.clone(),
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
        accounts: store.accounts.clone(),
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
        accounts: store.accounts.clone(),
        active: store.active.clone(),
    })
}

#[tauri::command]
async fn account_remove(state: State<'_, AppState>, uuid: String) -> Result<AccountsInfo, String> {
    let mut store = state.accounts.lock().await;
    store.remove(&uuid);
    store.save(&state.paths).map_err(err)?;
    Ok(AccountsInfo {
        accounts: store.accounts.clone(),
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
    let Some(session) = session else { return Ok(None) };
    let account = Account::from_session(session);
    let mut store = state.accounts.lock().await;
    store.upsert(account.clone());
    store.set_active(&account.uuid);
    store.save(&state.paths).map_err(err)?;
    Ok(Some(AccountsInfo {
        accounts: store.accounts.clone(),
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
            let list: Vec<String> = extensions.into_iter().map(|ext| ext.to_lowercase()).collect();
            let refs: Vec<&str> = list.iter().map(|ext| ext.as_str()).collect();
            if !refs.is_empty() {
                dialog = dialog.add_filter("Подходящие файлы", &refs);
            }
            dialog = dialog.add_filter("Все файлы", &["*"]);
        }
        dialog.pick_file().map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(chosen)
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
    let source = PathBuf::from(&path);
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err("подойдёт PNG, JPG или WebP".into());
    }
    let dir = state.paths.instance_dir(&instance_id);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let file_name = format!("icon.{extension}");
    std::fs::copy(&source, dir.join(&file_name))
        .map_err(|error| format!("не удалось скопировать картинку: {error}"))?;

    let mut meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    meta.icon = Some(file_name);
    instances::save(&state.paths, &meta).map_err(err)?;
    Ok(meta)
}

/// Данные картинки-иконки в виде data-URL (webview не умеет читать локальные пути).
#[tauri::command]
fn instance_icon(state: State<'_, AppState>, instance_id: String) -> Result<Option<String>, String> {
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let Some(icon) = meta.icon else { return Ok(None) };
    if !icon.contains('.') {
        return Ok(None); // встроенная иконка, рисуется из спрайта
    }
    let path = state.paths.instance_dir(&instance_id).join(&icon);
    let Ok(bytes) = std::fs::read(&path) else { return Ok(None) };
    let mime = match icon.rsplit('.').next().unwrap_or("png").to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    Ok(Some(format!("data:{mime};base64,{}", base64_encode(&bytes))))
}

/// Положить файл (мод/ресурспак) из проводника в папку сборки.
#[tauri::command]
fn copy_instance_file(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
    sub: String,
) -> Result<String, String> {
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
    let target_dir = state
        .paths
        .instance_dir(&instance_id)
        .join("minecraft")
        .join(&sub);
    std::fs::create_dir_all(&target_dir).map_err(err)?;
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

#[tauri::command]
fn open_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let root = &state.paths.root;
    let trimmed = path.trim();
    let target = if trimmed.is_empty() {
        root.clone()
    } else if let Some(rest) = trimmed.strip_prefix('/') {
        root.join(rest)
    } else {
        let first = trimmed.split('/').next().unwrap_or(trimmed);
        if state.paths.instance_dir(first).exists() {
            state.paths.instances().join(trimmed)
        } else {
            root.join(trimmed)
        }
    };
    if !target.exists() {
        return Err(format!("путь не найден: {}", target.display()));
    }
    open_in_file_manager(&target)
}

fn open_in_file_manager(target: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target)
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

#[tauri::command]
fn window_action(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        other => return Err(format!("неизвестное действие окна: {other}")),
    }
    .map_err(err)
}

fn main() {
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
    let state = AppState {
        modrinth: Modrinth::new(http.clone()),
        startup_file: startup_path,
        accounts: Mutex::new(AccountStore::load(&paths)),
        paths,
        http,
        settings: Mutex::new(settings),
        running: Arc::new(Mutex::new(HashMap::new())),
    };

    tauri::Builder::default()
        .manage(state)
        .setup(|app| {
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            get_settings,
            save_settings,
            list_instances,
            create_instance,
            delete_instance,
            update_instance,
            minecraft_versions,
            loader_versions,
            install_instance,
            launch_instance,
            stop_instance,
            running_instances,
            search_modrinth,
            modrinth_versions,
            install_mod,
            install_mod_version,
            install_modpack,
            list_dir,
            read_text_file,
            delete_file,
            list_mods,
            toggle_mod,
            list_java,
            open_path,
            window_action,
            version_info,
            check_update,
            net_check,
            accounts_info,
            account_add_offline,
            account_set_active,
            account_remove,
            ms_login_start,
            ms_login_poll,
            pick_file,
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
