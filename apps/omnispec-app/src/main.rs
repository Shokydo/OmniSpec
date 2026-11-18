// Скрыть консольное окно в релизной сборке на Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri-оболочка OmniSpec: тонкий слой команд поверх `omnispec-core`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
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
use omnispec_core::curseforge::{install as curseforge_install, modpack as curseforge_modpack, CurseForge};
use omnispec_core::net::{Http, Reporter};
use omnispec_core::paths::Paths;
use omnispec_core::settings::Settings;
use omnispec_core::update::{self, UpdateInfo};

/// Discord Rich Presence (локальный IPC Discord).
mod presence;

type ChildHandle = Arc<Mutex<tokio::process::Child>>;

struct AppState {
    paths: Paths,
    /// Путь, с которым лаунчер запустили (`.mrpack` двойным щелчком или drag&drop в ярлык).
    startup_file: Option<String>,
    accounts: Mutex<AccountStore>,
    http: Http,
    modrinth: Modrinth,
    curseforge: CurseForge,
    settings: Mutex<Settings>,
    running: Arc<Mutex<HashMap<String, ChildHandle>>>,
    /// Статус в Discord: фронт пишет через set_presence, воркер шлёт в IPC.
    presence: presence::Presence,
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
    state
        .presence
        .configure(&settings.discord_client_id, settings.discord_rpc);
    settings.save(&state.paths).map_err(err)?;
    *state.settings.lock().await = settings;
    Ok(())
}

/// Предложение / баг-репорт: уходит на почту через FormSubmit.
/// Первый раз FormSubmit пришлёт ссылку активации на этот адрес —
/// её нужно открыть один раз, иначе отправка не работает.
#[tauri::command]
async fn send_feedback(
    state: State<'_, AppState>,
    name: String,
    email: String,
    kind: String,
    message: String,
) -> Result<(), String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("пустое сообщение".into());
    }
    let subject = if kind == "bug" {
        "OmniSpec: баг-репорт"
    } else {
        "OmniSpec: предложение"
    };
    let mut body = serde_json::json!({
        "name": name.trim(),
        "email": email.trim(),
        "_subject": subject,
        "_template": "table",
        "_captcha": "false",
        "message": message,
        "version": omnispec_core::APP_VERSION,
        "platform": std::env::consts::OS,
    });
    let reply = email.trim();
    if !reply.is_empty() {
        body["_replyto"] = serde_json::json!(reply);
    }
    let text = state
        .http
        .post_json("https://formsubmit.co/ajax/OmniSpecLauncher@gmail.com", &body)
        .await
        .map_err(err)?;
    // FormSubmit отвечает JSON: {"success":"true", ...}
    if text.contains("\"success\":\"true\"") || text.contains("\"success\": \"true\"") {
        Ok(())
    } else {
        Err(format!("сервис отправки не принял сообщение: {text}"))
    }
}

/// Статус в Discord: фронт сообщает режим, сборку и время начала.
#[tauri::command]
fn set_presence(
    state: State<'_, AppState>,
    mode: String,
    details: String,
    state_text: String,
    started_at: Option<u64>,
) {
    state.presence.set(presence::PresenceInfo {
        mode,
        details,
        state: state_text,
        started_at,
    });
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
    if let Err(error) = loaders::ensure_profile(&state.http, &state.paths, &meta, &reporter).await {
        eprintln!("[omnispec] профиль загрузчика не установлен: {error}");
    }
    reporter.emit("loader", 1, 1, "готово");
    instances::load(&state.paths, &meta.id).map_err(err)
}

#[tauri::command]
fn delete_instance(state: State<'_, AppState>, instance_id: String) -> Result<(), String> {
    instances::delete(&state.paths, &instance_id).map_err(err)
}

/// Дублировать сборку: копия с новым id и именем «… (копия)».
#[tauri::command]
fn duplicate_instance(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<InstanceMeta, String> {
    instances::duplicate(&state.paths, &instance_id).map_err(err)
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
) -> Result<Value, String> {
    // Ключ запуска — «id#номер»: так одна сборка может работать сразу в нескольких окнах.
    let run_id = {
        let running = state.running.lock().await;
        let mut taken: Vec<u32> = running
            .keys()
            .filter_map(|key| match key.split_once('#') {
                Some((id, num)) if id == instance_id => num.parse().ok(),
                _ => None,
            })
            .collect();
        if !taken.is_empty() && account_uuid.is_none() {
            return Err("эта сборка уже запущена".into());
        }
        taken.sort_unstable();
        let mut next = 1u32;
        for num in taken {
            if num == next {
                next += 1;
            }
        }
        format!("{instance_id}#{next}")
    };

    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let settings = state.settings.lock().await.clone();
    let account = account_for(&state, &settings, account_uuid.as_deref()).await?;
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
        .insert(run_id.clone(), child.clone());

    emit_game_log(
        &app,
        &instance_id,
        format!(
            "[omnispec] запуск: {} (аргументов {}, файлов в classpath {}, подготовка {} мс)",
            plan.java,
            plan.args.len(),
            plan.classpath_entries,
            plan.prepare_ms
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
        let session = run_id.clone();
        let child = child.clone();
        let running = state.running.clone();
        let paths = state.paths.clone();
        // время использования: считаем от запуска до выхода из игры
        let started = std::time::Instant::now();
        tokio::spawn(async move {
            // раз в минуту дописываем время на диск: если лаунчер закроют или
            // он обновится, статистика не потеряется
            let mut flushed: u64 = 0;
            loop {
                tokio::time::sleep(Duration::from_millis(700)).await;
                let elapsed = started.elapsed().as_secs();
                if elapsed >= flushed + 60 {
                    instances::add_playtime(&paths, &id, elapsed - flushed);
                    flushed = elapsed;
                }
                let status = {
                    let mut guard = child.lock().await;
                    guard.try_wait().ok().flatten()
                };
                if let Some(status) = status {
                    let code = status.code().unwrap_or(-1);
                    // накопленное время игры в часах показываем в списке сборок
                    instances::add_playtime(&paths, &id, elapsed.saturating_sub(flushed));
                    running.lock().await.remove(&session);
                    let _ = app.emit(
                        "game-exit",
                        json!({"instance": id, "code": code, "run_id": session}),
                    );
                    break;
                }
            }
        });
    }

    let mut summary = launch_summary(&plan);
    if let Some(map) = summary.as_object_mut() {
        map.insert("run_id".into(), json!(run_id));
        map.insert("account".into(), json!(account.username));
        map.insert("account_uuid".into(), json!(account.uuid));
    }
    Ok(summary)
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
    let handles: Vec<ChildHandle> = {
        let running = state.running.lock().await;
        running
            .iter()
            .filter(|(key, _)| match &exact {
                Some(target) => key.as_str() == target,
                None => key.split_once('#').map(|(id, _)| id) == Some(instance_id.as_str()),
            })
            .map(|(_, handle)| handle.clone())
            .collect()
    };
    if handles.is_empty() {
        return Err("сборка не запущена".into());
    }
    for child in handles {
        let mut guard = child.lock().await;
        guard.start_kill().map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
async fn running_instances(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let running = state.running.lock().await;
    let mut result: Vec<String> = Vec::new();
    for key in running.keys() {
        let id = key
            .split_once('#')
            .map(|(id, _)| id)
            .unwrap_or(key.as_str())
            .to_string();
        if !result.contains(&id) {
            result.push(id);
        }
    }
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
) -> Result<omnispec_core::modrinth::SearchResults, String> {
    state
        .curseforge
        .search(&SearchQuery {
            query,
            project_type,
            game_version: mc_version,
            loader,
            categories: Vec::new(),
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
) -> Result<curseforge_install::InstallOutcome, String> {
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let reporter = reporter_for(&app, &instance_id);
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
) -> Result<InstanceMeta, String> {
    let reporter = reporter_for(&app, "modpack");
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
    let base = instances::game_dir(&state.paths, &instance_id);
    let dir = if sub.trim().is_empty() {
        base
    } else {
        safe_join(&base, &sub)?
    };
    // Папки вроде resourcepacks/shaderpacks могут ещё не существовать — создаём,
    // чтобы список был пустым, а не ошибкой.
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
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
    let base = instances::game_dir(&state.paths, &instance_id);
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
    let base = instances::game_dir(&state.paths, &instance_id);
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
    let base = instances::game_dir(&state.paths, &instance_id);
    let target = safe_join(&base, &path)?;
    std::fs::create_dir_all(&target).map_err(err)
}

/// Переименовать файл или папку; возвращаем новый относительный путь.
#[tauri::command]
fn fm_rename(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
    name: String,
) -> Result<String, String> {
    let clean = name.trim();
    if clean.is_empty()
        || clean == "."
        || clean == ".."
        || clean.contains('/')
        || clean.contains('\\')
    {
        return Err("имя не годится: нужны буквы, цифры, точка, дефис".into());
    }
    let base = instances::game_dir(&state.paths, &instance_id);
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
    let base = instances::game_dir(&state.paths, &instance_id);
    let target = safe_join(&base, &dir)?;
    std::fs::create_dir_all(&target).map_err(err)?;
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
    let base = instances::game_dir(&state.paths, &instance_id);
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
    let base = instances::game_dir(&state.paths, &instance_id);
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
    let base = instances::game_dir(&state.paths, &instance_id);
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
    let dir = instances::game_dir(&state.paths, &instance_id).join("mods");
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

/// Один скриншот из папки `screenshots` сборки.
#[derive(Debug, Clone, serde::Serialize)]
struct ScreenshotEntry {
    name: String,
    size: u64,
    /// Время изменения, секунды от эпохи.
    modified: Option<u64>,
    /// Абсолютный путь — для кнопок «открыть файл/папку».
    path: String,
    /// Картинка как data URI (base64): `file://` в WebView2 не грузится.
    src: String,
}

/// Скриншоты сборки (папка `screenshots` в игровой папке), новые сверху.
#[tauri::command]
fn list_screenshots(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Vec<ScreenshotEntry>, String> {
    let dir = instances::game_dir(&state.paths, &instance_id).join("screenshots");
    let mut result = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(result);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(mime) = image_mime(&path) else {
            continue;
        };
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
        // Картинку отдаём data URI, как превью в файловом менеджере:
        // webview не умеет грузить file:// с чужого origin.
        let src = match std::fs::read(&path) {
            Ok(bytes) if !bytes.is_empty() && bytes.len() <= 32 * 1024 * 1024 => {
                format!("data:{mime};base64,{}", base64_encode(&bytes))
            }
            _ => String::new(),
        };
        result.push(ScreenshotEntry {
            name,
            size: meta.map(|meta| meta.len()).unwrap_or(0),
            modified,
            path: path.display().to_string(),
            src,
        });
    }
    result.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(result)
}

/// Иконки миров: имя папки мира → `icon.png` из неё (как в самой игре).
#[tauri::command]
fn world_icons(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<std::collections::HashMap<String, String>, String> {
    let saves = instances::game_dir(&state.paths, &instance_id).join("saves");
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
    let mods_dir = instances::game_dir(&state.paths, &instance_id).join("mods");
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
    let game_dir = instances::game_dir(&state.paths, &instance_id);
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

/// Поставить обновление одного файла.
#[tauri::command]
async fn content_update(
    state: State<'_, AppState>,
    instance_id: String,
    kind: String,
    name: String,
) -> Result<Value, String> {
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let update =
        omnispec_core::content::apply_update(&state.modrinth, &state.paths, &meta, &kind, &name)
            .await
            .map_err(err)?;
    Ok(json!(update))
}

/// Догрузить обязательные зависимости уже установленных модов.
#[tauri::command]
async fn mods_ensure_dependencies(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Value, String> {
    let meta = instances::load(&state.paths, &instance_id).map_err(err)?;
    let reporter = reporter_for(&app, &meta.id);
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
    let account = store.current().cloned().unwrap_or_else(|| {
        Account::offline(&settings.username).unwrap_or_else(|_| Account {
            username: "Player".into(),
            uuid: omnispec_core::auth::offline_uuid("Player"),
            kind: "offline".into(),
            access_token: String::new(),
            refresh_token: String::new(),
            expires_at: 0,
        })
    });

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

/// Аккаунт для запуска: конкретный (дубликат сборки) или выбранный в лаунчере.
async fn account_for(
    state: &AppState,
    settings: &Settings,
    uuid: Option<&str>,
) -> Result<Account, String> {
    let Some(uuid) = uuid else {
        return current_account(state, settings).await;
    };
    let mut store = state.accounts.lock().await;
    let account = store
        .accounts
        .iter()
        .find(|account| account.uuid == uuid || account.username.eq_ignore_ascii_case(uuid))
        .cloned()
        .ok_or_else(|| "аккаунт не найден".to_string())?;
    if account.needs_refresh() && !account.refresh_token.is_empty() {
        let client_id = settings.ms_client_id.clone().unwrap_or_default();
        match microsoft::refresh(&state.http, &client_id, &account.refresh_token).await {
            Ok(session) => {
                let fresh = Account::from_session(session);
                store.upsert(fresh.clone());
                let _ = store.save(&state.paths);
                Ok(fresh)
            }
            Err(error) => Err(format!(
                "не удалось обновить вход в Microsoft ({error}) — зайди в аккаунт заново"
            )),
        }
    } else {
        Ok(account)
    }
}

/// Текущий скин лицензионного аккаунта: вариант (classic/slim) и PNG в data-URL.
#[tauri::command]
async fn account_skin(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.settings.lock().await.clone();
    let account = current_account(&state, &settings).await?;
    if account.kind != "microsoft" || account.access_token.is_empty() {
        return Ok(json!({"licensed": false, "variant": "classic", "data_url": Value::Null}));
    }
    let profile: Value = state
        .http
        .inner()
        .get("https://api.minecraftservices.com/minecraft/profile")
        .header("Authorization", format!("Bearer {}", account.access_token))
        .send()
        .await
        .map_err(|error| format!("не удалось получить профиль скина: {error}"))?
        .json()
        .await
        .map_err(|error| format!("не удалось прочитать профиль скина: {error}"))?;

    let skins = profile
        .get("skins")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let active = skins
        .iter()
        .find(|skin| skin.get("state").and_then(|value| value.as_str()) == Some("ACTIVE"))
        .or_else(|| skins.first());
    let variant = active
        .and_then(|skin| skin.get("variant"))
        .and_then(|value| value.as_str())
        .unwrap_or("CLASSIC")
        .to_lowercase();
    let url = active
        .and_then(|skin| skin.get("url"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());

    let mut data_url = Value::Null;
    if let Some(url) = url {
        if let Ok(response) = state.http.inner().get(&url).send().await {
            if let Ok(bytes) = response.bytes().await {
                data_url = json!(format!("data:image/png;base64,{}", base64_encode(&bytes)));
            }
        }
    }
    Ok(json!({"licensed": true, "variant": variant, "data_url": data_url}))
}

/// Плащи аккаунта: список с картинками-превью (PNG в data-URL) и отметкой активного.
#[tauri::command]
async fn account_capes(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.settings.lock().await.clone();
    let account = current_account(&state, &settings).await?;
    if account.kind != "microsoft" || account.access_token.is_empty() {
        return Ok(json!({"licensed": false, "capes": []}));
    }
    let profile: Value = state
        .http
        .inner()
        .get("https://api.minecraftservices.com/minecraft/profile")
        .header("Authorization", format!("Bearer {}", account.access_token))
        .send()
        .await
        .map_err(|error| format!("не удалось получить список плащей: {error}"))?
        .json()
        .await
        .map_err(|error| format!("не удалось прочитать список плащей: {error}"))?;

    let capes = profile
        .get("capes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for cape in capes {
        let id = cape
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let alias = cape
            .get("alias")
            .and_then(|value| value.as_str())
            .unwrap_or("Плащ")
            .to_string();
        let active = cape
            .get("state")
            .and_then(|value| value.as_str())
            .map(|value| value == "ACTIVE")
            .unwrap_or(false);
        let url = cape
            .get("url")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        let mut data_url = Value::Null;
        if let Some(url) = url {
            if let Ok(response) = state.http.inner().get(&url).send().await {
                if let Ok(bytes) = response.bytes().await {
                    data_url = json!(format!("data:image/png;base64,{}", base64_encode(&bytes)));
                }
            }
        }
        out.push(json!({
            "id": id,
            "alias": alias,
            "active": active,
            "data_url": data_url
        }));
    }
    Ok(json!({"licensed": true, "capes": out}))
}

/// Включить плащ (`cape_id`) или выключить все плащи (`None`).
#[tauri::command]
async fn set_cape(state: State<'_, AppState>, cape_id: Option<String>) -> Result<Value, String> {
    let settings = state.settings.lock().await.clone();
    let account = current_account(&state, &settings).await?;
    if account.kind != "microsoft" || account.access_token.is_empty() {
        return Err("плащи есть только у лицензионного аккаунта".into());
    }
    let url = "https://api.minecraftservices.com/minecraft/profile/capes/active";
    let request = match cape_id {
        Some(id) => state
            .http
            .inner()
            .put(url)
            .header("Authorization", format!("Bearer {}", account.access_token))
            .json(&json!({ "capeId": id })),
        None => state
            .http
            .inner()
            .delete(url)
            .header("Authorization", format!("Bearer {}", account.access_token)),
    };
    let response = request
        .send()
        .await
        .map_err(|error| format!("не удалось изменить плащ: {error}"))?;
    let status = response.status();
    if status.is_success() {
        return Ok(json!({ "ok": true }));
    }
    let text = response.text().await.unwrap_or_default();
    let message = if text.contains("does not own cape") {
        "на аккаунте нет такого плаща".to_string()
    } else if status.as_u16() == 401 {
        "вход в Microsoft устарел — зайди в аккаунт заново".to_string()
    } else {
        format!("Mojang не принял запрос ({status})")
    };
    Err(message)
}

/// Смена скина пресетом: загружаем PNG в Mojang (только лицензия).
#[tauri::command]
async fn apply_skin(
    state: State<'_, AppState>,
    path: String,
    variant: String,
) -> Result<Value, String> {
    let settings = state.settings.lock().await.clone();
    let account = current_account(&state, &settings).await?;
    if account.kind != "microsoft" || account.access_token.is_empty() {
        return Err("скин можно менять только у лицензионного аккаунта".into());
    }
    let bytes =
        std::fs::read(&path).map_err(|error| format!("не удалось открыть файл: {error}"))?;
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

    let response = state
        .http
        .inner()
        .post("https://api.minecraftservices.com/minecraft/profile/skins")
        .header("Authorization", format!("Bearer {}", account.access_token))
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|error| format!("не удалось отправить скин: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let short: String = text.chars().take(220).collect();
        return Err(format!("Mojang не принял скин ({status}): {short}"));
    }
    Ok(json!({"ok": true, "variant": variant, "account": account.username}))
}

/// Готовый скин из пресета: фронтенд рисует PNG, мы сохраняем его на диск.
#[tauri::command]
fn save_skin_png(
    state: State<'_, AppState>,
    data_url: String,
    name: String,
) -> Result<String, String> {
    let payload = data_url
        .split_once("base64,")
        .map(|(_, tail)| tail.to_string())
        .ok_or_else(|| "ожидался PNG в data-URL".to_string())?;
    let bytes =
        base64_decode(&payload).ok_or_else(|| "не удалось прочитать картинку".to_string())?;
    if bytes.len() < 64 {
        return Err("картинка пустая".into());
    }
    let safe: String = name
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let dir = state.paths.meta().join("skins");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let file_name = if safe.is_empty() {
        "skin".to_string()
    } else {
        safe
    };
    let file = dir.join(format!("{file_name}.png"));
    std::fs::write(&file, bytes).map_err(err)?;
    Ok(file.to_string_lossy().to_string())
}

/// Скин из файла: копируем PNG в папку данных, чтобы пресет не зависел от исходника.
#[tauri::command]
fn import_skin(state: State<'_, AppState>, path: String) -> Result<Value, String> {
    let source = PathBuf::from(&path);
    let bytes =
        std::fs::read(&source).map_err(|error| format!("не удалось открыть файл: {error}"))?;
    if bytes.len() < 64 {
        return Err("файл пустой или это не PNG".into());
    }
    // PNG 64×64 (или 64×32 для старых скинов) — проверяем по заголовку IHDR
    if bytes.len() < 26 || &bytes[1..4] != b"PNG" {
        return Err("нужен файл PNG со скином".into());
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if width != 64 || (height != 64 && height != 32) {
        return Err(format!(
            "нужен скин 64×64 (или 64×32), а тут {width}×{height}"
        ));
    }
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("skin");
    let safe: String = stem
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let dir = state.paths.meta().join("skins");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let file_name = format!(
        "{}-{}.png",
        if safe.is_empty() {
            "skin".to_string()
        } else {
            safe
        },
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0)
    );
    let target = dir.join(&file_name);
    std::fs::write(&target, &bytes).map_err(err)?;
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
    let bytes =
        std::fs::read(&path).map_err(|error| format!("не удалось открыть файл: {error}"))?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("файл слишком большой".into());
    }
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
    let Some(session) = session else {
        return Ok(None);
    };
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
    let trimmed = raw.trim().trim_start_matches('/');
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
    Some(if tail.is_empty() { base } else { base.join(tail) })
}

#[tauri::command]
fn open_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let root = &state.paths.root;
    let trimmed = path.trim();
    let target = if trimmed.is_empty() {
        root.clone()
    } else if let Some(game_path) = resolve_game_path(&state.paths, trimmed) {
        game_path
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

    // Папку сборки создаём, если её ещё нет: иначе проводник Windows
    // молча открывает «Документы» вместо нужного места.
    if !target.exists() && (target.starts_with(root) || target.is_absolute()) {
        let _ = std::fs::create_dir_all(&target);
    }
    if !target.exists() {
        return Err(format!("путь не найден: {}", target.display()));
    }
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

/// Свой фон: копируем картинку в данные лаунчера и запоминаем имя файла.
#[tauri::command]
fn set_custom_wallpaper(state: State<'_, AppState>, path: String) -> Result<Settings, String> {
    let source = PathBuf::from(&path);
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err("подойдёт PNG, JPG или WebP".into());
    }
    let folder = state.paths.root.join("wallpapers");
    std::fs::create_dir_all(&folder).map_err(err)?;
    // старый свой фон убираем, чтобы не копился мусор
    if let Ok(entries) = std::fs::read_dir(&folder) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("custom.") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let file_name = format!("custom.{extension}");
    std::fs::copy(&source, folder.join(&file_name))
        .map_err(|error| format!("не скопировалась картинка: {error}"))?;

    let mut settings = Settings::load(&state.paths).map_err(err)?;
    settings.custom_wallpaper = Some(file_name);
    settings.wallpaper = Some("custom".into());
    settings.save(&state.paths).map_err(err)?;
    Ok(settings)
}

/// Свой фон в виде data-URL (webview не читает локальные пути).
#[tauri::command]
fn custom_wallpaper(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let settings = Settings::load(&state.paths).map_err(err)?;
    let Some(name) = settings.custom_wallpaper else {
        return Ok(None);
    };
    let path = state.paths.root.join("wallpapers").join(&name);
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(None);
    };
    let mime = match name
        .rsplit('.')
        .next()
        .unwrap_or("png")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };
    Ok(Some(format!(
        "data:{mime};base64,{}",
        base64_encode(&bytes)
    )))
}

/// Где лежит сборка — строка «папка: …» в главном окне.
#[tauri::command]
fn instance_path(state: State<'_, AppState>, instance_id: String) -> Result<String, String> {
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
    let presence = presence::Presence::new();
    presence.configure(&settings.discord_client_id, settings.discord_rpc);
    let presence_worker = presence.clone();
    std::thread::spawn(move || presence_worker.run());

    let state = AppState {
        modrinth: Modrinth::new(http.clone()),
        curseforge: CurseForge::new(http.clone()),
        startup_file: startup_path,
        accounts: Mutex::new(AccountStore::load(&paths)),
        paths,
        http,
        settings: Mutex::new(settings),
        running: Arc::new(Mutex::new(HashMap::new())),
        presence,
    };

    tauri::Builder::default()
        .manage(state)
        .setup(|app| {
            let _ = app.get_webview_window("main");
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
            get_settings,
            save_settings,
            set_presence,
            send_feedback,
            list_instances,
            create_instance,
            delete_instance,
            duplicate_instance,
            update_instance,
            minecraft_versions,
            loader_versions,
            install_instance,
            launch_instance,
            stop_instance,
            running_instances,
            search_modrinth,
            modrinth_versions,
            modrinth_project,
            search_curseforge,
            curseforge_versions,
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
            install_mod_version,
            install_modpack,
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
            scan_external_launchers,
            import_external,
            export_instance,
            import_zip,
            pick_save_path,
            set_custom_wallpaper,
            custom_wallpaper,
            instance_path,
            version_info,
            check_update,
            net_check,
            content_list,
            content_toggle,
            content_delete,
            content_updates,
            content_update,
            mods_ensure_dependencies,
            accounts_info,
            account_add_offline,
            account_rename,
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

#[cfg(test)]
mod tests {
    use super::run_key;

    #[test]
    fn run_key_accepts_full_key_from_ui() {
        assert_eq!(run_key("atm10", Some("atm10#2".into())).as_deref(), Some("atm10#2"));
    }

    #[test]
    fn run_key_prefixes_short_number() {
        assert_eq!(run_key("atm10", Some("2".into())).as_deref(), Some("atm10#2"));
    }

    #[test]
    fn run_key_without_run_id_stops_all_windows() {
        assert_eq!(run_key("atm10", None), None);
    }
}
