//! Установка модов/ресурспаков/шейдеров с Modrinth в конкретную сборку,
//! вместе с обязательными зависимостями.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::instances::InstanceMeta;
use crate::net::Reporter;
use crate::paths::Paths;

use super::{Modrinth, Version};

/// Не доверяем одному лишь серверному фильтру: конкретный файл может быть
/// указан вручную или API может вернуть неподходящую версию. Без явных меток
/// игры и загрузчика мод нельзя считать совместимым.
pub fn validate_mod_compatibility(version: &Version, game_version: &str, loader: &str) -> Result<()> {
    let game_matches = version.game_versions.iter().any(|value| value == game_version);
    let loader_matches = version.loaders.iter().any(|value| value.eq_ignore_ascii_case(loader));
    if !game_matches || !loader_matches || loader.eq_ignore_ascii_case("vanilla") {
        return Err(Error::other(format!(
            "версия мода «{}» несовместима с Minecraft {} и загрузчиком {}",
            if version.name.is_empty() { &version.id } else { &version.name }, game_version, loader
        )));
    }
    Ok(())
}

/// Версия должна принадлежать запрошенному проекту и совпадать с профилем.
pub fn validate_project_version(version: &Version, project_id: &str, project_type: &str, instance: &InstanceMeta) -> Result<()> {
    if version.project_id != project_id {
        return Err(Error::other("выбранная версия принадлежит другому проекту"));
    }
    if project_type == "mod" {
        validate_mod_compatibility(version, &instance.mc_version, instance.loader.kind())?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InstallOutcome {
    pub installed: Vec<String>,
    pub skipped: Vec<String>,
}

/// API возвращает имя файла, а не относительный путь внутри сборки.
fn safe_filename(name: &str) -> Result<()> {
    let mut components = Path::new(name).components();
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.chars().any(char::is_control)
        || !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some()
    {
        return Err(Error::other("каталог вернул недопустимое имя файла мода"));
    }
    Ok(())
}

static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct StagingDir(PathBuf);
impl Drop for StagingDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

/// Данные существующей сборки нельзя перезаписывать даже если файл с таким
/// именем появился во время скачивания. Сначала грузим в собственную папку,
/// затем перемещаем готовый файл без перезаписи. На Windows используется
/// MoveFileEx без REPLACE_EXISTING, на Linux — renameat2 с NOREPLACE; в старых
/// системах возможен запасной вариант с жёсткой ссылкой. Если ни один способ
/// не поддерживается, возвращаем ошибку, не трогая существующий файл.
fn publish_new_content(staged: &Path, dest: &Path) -> Result<bool> {
    match tempfile::TempPath::try_from_path(staged)?.persist_noclobber(dest) {
        Ok(()) => Ok(true),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error.error.into()),
    }
}

pub async fn download_new_content(
    http: &crate::net::Http, dir: &Path, filename: &str, url: &str,
    expected_size: Option<u64>, sha1: Option<&str>, reporter: &Reporter,
) -> Result<bool> {
    safe_filename(filename)?;
    let dest = dir.join(filename);
    if std::fs::symlink_metadata(&dest).is_ok() { return Ok(false); }
    let staging = loop {
        let sequence = STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(".omnispec-install-{}-{sequence}", std::process::id()));
        match std::fs::create_dir(&path) {
            Ok(()) => break StagingDir(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    };
    let staged = staging.0.join("payload");
    let progress = reporter.clone();
    http.download_existing_dir(url, &staged, expected_size, sha1, true, Some(&|done, total| {
        progress.emit_bytes("mods", filename, done, total);
    })).await?;
    if let Some(size) = expected_size.filter(|size| *size > 0) {
        if tokio::fs::metadata(&staged).await?.len() != size {
            return Err(Error::other(format!("размер файла {filename} не совпадает с данными каталога")));
        }
    }
    if let Some(expected) = sha1.filter(|value| !value.is_empty()) {
        use sha1::{Digest, Sha1};
        use tokio::io::AsyncReadExt;
        let mut file = tokio::fs::File::open(&staged).await?;
        let mut hasher = Sha1::new();
        // Буфер живёт через await: на куче он не раздувает future установки
        // и не копируется десятками килобайт при каждом вложенном вызове.
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).await?;
            if count == 0 { break; }
            hasher.update(&buffer[..count]);
        }
        if !hex::encode(hasher.finalize()).eq_ignore_ascii_case(expected) {
            return Err(Error::other(format!("контрольная сумма файла {filename} не совпадает")));
        }
    }
    publish_new_content(&staged, &dest)
}

/// Папка сборки под тип проекта.
pub fn target_dir(paths: &Paths, instance: &InstanceMeta, project_type: &str) -> PathBuf {
    let base = crate::instances::game_dir_for(paths, instance);
    match project_type {
        "resourcepack" => base.join("resourcepacks"),
        "shader" => base.join("shaderpacks"),
        "modpack" => base.join("modpacks"),
        _ => base.join("mods"),
    }
}

/// Установить проект в сборку (выбирая версию под версию игры и загрузчик).
pub async fn install_project(
    modrinth: &Modrinth,
    paths: &Paths,
    instance: &InstanceMeta,
    project_id: &str,
    reporter: &Reporter,
) -> Result<InstallOutcome> {
    let mut outcome = InstallOutcome::default();
    let mut visited: HashSet<String> = HashSet::new();
    install_recursive(
        modrinth,
        paths,
        instance,
        project_id,
        None,
        &mut visited,
        reporter,
        &mut outcome,
    )
    .await?;
    crate::instances::load(paths, &instance.id)?;
    reporter.emit_state("mods", "done", "готово");
    Ok(outcome)
}

/// Установить конкретную версию проекта.
pub async fn install_version(
    modrinth: &Modrinth,
    paths: &Paths,
    instance: &InstanceMeta,
    version_id: &str,
    reporter: &Reporter,
) -> Result<InstallOutcome> {
    let mut outcome = InstallOutcome::default();
    let mut visited: HashSet<String> = HashSet::new();
    let version = modrinth.version(version_id).await?;
    install_recursive(
        modrinth,
        paths,
        instance,
        &version.project_id,
        Some(version_id),
        &mut visited,
        reporter,
        &mut outcome,
    )
    .await?;
    crate::instances::load(paths, &instance.id)?;
    reporter.emit_state("mods", "done", "готово");
    Ok(outcome)
}

#[allow(clippy::too_many_arguments)]
async fn install_recursive(
    modrinth: &Modrinth,
    paths: &Paths,
    instance: &InstanceMeta,
    project_ref: &str,
    version_hint: Option<&str>,
    visited: &mut HashSet<String>,
    reporter: &Reporter,
    outcome: &mut InstallOutcome,
) -> Result<()> {
    let key = version_hint.unwrap_or(project_ref).to_string();
    if !visited.insert(key.clone()) {
        return Ok(());
    }

    // Тип проекта нужен ДО поиска версии: ресурспаки и шейдеры не привязаны
    // к загрузчику, и фильтр по fabric/forge у них ничего не находит.
    let project = modrinth.project(project_ref).await?;
    let project_type = if project.project_type.is_empty() {
        "mod".to_string()
    } else {
        project.project_type.clone()
    };
    let loader_filter = match project_type.as_str() {
        "mod" | "modpack" => Some(instance.loader.kind()),
        _ => None,
    };

    let version = match version_hint {
        Some(version_id) => modrinth.version(version_id).await?,
        None => {
            let versions = modrinth
                .project_versions(project_ref, Some(&instance.mc_version), loader_filter)
                .await?;
            versions.into_iter()
                .find(|version| validate_project_version(version, &project.id, &project_type, instance).is_ok())
                .ok_or_else(|| {
                    Error::not_found(format!(
                        "у проекта «{project_ref}» нет совместимой версии для Minecraft {} и {}",
                        instance.mc_version, instance.loader.label()
                    ))
                })?
        }
    };
    validate_project_version(&version, &project.id, &project_type, instance)?;

    let file = version
        .primary_file()
        .ok_or_else(|| Error::not_found(format!("у версии {} нет файлов", version.id)))?;

    let game = crate::instances::ensure_game_dir(paths, instance)?;
    let dir = target_dir(paths, instance, &project_type);
    crate::instances::create_dir_beneath(&game, &dir)?;
    reporter.emit("mods", 0, 0, format!("проверяем {}", file.filename));
    let downloaded = download_new_content(
        modrinth.http(), &dir, &file.filename, &file.url, Some(file.size),
        file.hashes.get("sha1").map(String::as_str), reporter,
    ).await?;
    if !downloaded {
        outcome.skipped.push(file.filename.clone());
        reporter.emit("mods", 0, 0, format!("файл уже существует: {}", file.filename));
    } else {
        outcome.installed.push(file.filename.clone());
        // картотека: по ней потом ищутся обновления и зависимости
        crate::content::remember(
            paths,
            instance,
            crate::content::ContentRecord {
                filename: file.filename.clone(),
                project_id: Some(version.project_id.clone()),
                source: Some("modrinth".into()),
                version_id: Some(version.id.clone()),
                version_number: version.version_number.clone(),
                title: if project.title.is_empty() {
                    version.name.clone()
                } else {
                    project.title.clone()
                },
                kind: content_kind(&project_type).to_string(),
                sha1: file.hashes.get("sha1").cloned().unwrap_or_default(),
            },
        );
    }

    // Обязательные зависимости.
    for dependency in version.dependencies.iter() {
        if dependency.dependency_type != "required" {
            continue;
        }
        if let Some(dep_version) = &dependency.version_id {
            let dep_key = dep_version.clone();
            if visited.contains(&dep_key) {
                continue;
            }
            let dep = modrinth.version(dep_version).await?;
            let project_ref = dependency
                .project_id
                .clone()
                .unwrap_or_else(|| dep.project_id.clone());
            Box::pin(install_recursive(
                modrinth,
                paths,
                instance,
                &project_ref,
                Some(dep_version),
                visited,
                reporter,
                outcome,
            ))
            .await?;
        } else if let Some(dep_project) = &dependency.project_id {
            Box::pin(install_recursive(
                modrinth,
                paths,
                instance,
                dep_project,
                None,
                visited,
                reporter,
                outcome,
            ))
            .await?;
        }
    }

    Ok(())
}

/// Вид содержимого по типу проекта Modrinth.
fn content_kind(project_type: &str) -> &'static str {
    match project_type {
        "resourcepack" => "resourcepack",
        "shader" => "shader",
        _ => "mod",
    }
}

/// Докачать обязательные зависимости для уже установленных модов.
///
/// Версии берутся из картотеки `content.json`, поэтому лишний раз проекты
/// не перезапрашиваются, а уже лежащие файлы пропускаются.
pub async fn ensure_dependencies(
    modrinth: &Modrinth,
    paths: &Paths,
    instance: &InstanceMeta,
    reporter: &Reporter,
) -> Result<InstallOutcome> {
    let mut outcome = InstallOutcome::default();
    let mut visited: HashSet<String> = HashSet::new();
    let targets = crate::content::installed_projects(paths, instance, "mod");
    if targets.is_empty() {
        return Ok(outcome);
    }
    reporter.emit("mods", 0, 0, "проверяем зависимости модов");
    for (project_id, version_id) in targets {
        let Some(version_id) = version_id else {
            continue;
        };
        let Ok(version) = modrinth.version(&version_id).await else {
            continue;
        };
        for dependency in version.dependencies.iter() {
            if dependency.dependency_type != "required" {
                continue;
            }
            if let Some(dep_version) = &dependency.version_id {
                let project_ref = dependency
                    .project_id
                    .clone()
                    .unwrap_or_else(|| project_id.clone());
                Box::pin(install_recursive(
                    modrinth,
                    paths,
                    instance,
                    &project_ref,
                    Some(dep_version),
                    &mut visited,
                    reporter,
                    &mut outcome,
                ))
                .await?;
            } else if let Some(dep_project) = &dependency.project_id {
                Box::pin(install_recursive(
                    modrinth,
                    paths,
                    instance,
                    dep_project,
                    None,
                    &mut visited,
                    reporter,
                    &mut outcome,
                ))
                .await?;
            }
        }
    }
    let total = outcome.installed.len() as u64;
    let detail = if outcome.installed.is_empty() {
        "все зависимости на месте".to_string()
    } else {
        format!("докачано: {}", outcome.installed.join(", "))
    };
    reporter.emit("mods", total, total, detail);
    reporter.emit_state("mods", "done", "готово");
    Ok(outcome)
}

/// Удалить мод из сборки по имени файла.
pub fn remove_mod(paths: &Paths, instance: &InstanceMeta, filename: &str) -> Result<()> {
    let file = PathBuf::from(filename);
    if file.components().count() != 1 {
        return Err(Error::Other("недопустимое имя файла".into()));
    }
    for sub in ["mods", "resourcepacks", "shaderpacks"] {
        let path = crate::instances::game_dir_for(paths, instance)
            .join(sub)
            .join(filename);
        if path.exists() {
            std::fs::remove_file(path)?;
            return Ok(());
        }
    }
    Err(Error::not_found(format!("файл «{filename}» не найден")))
}

/// Включить/выключить мод переименованием в `.disabled`.
pub fn toggle_mod(paths: &Paths, instance: &InstanceMeta, filename: &str) -> Result<String> {
    let dir = crate::instances::game_dir_for(paths, instance).join("mods");
    let active = dir.join(filename);
    if active.exists() {
        let disabled = dir.join(format!("{filename}.disabled"));
        std::fs::rename(&active, &disabled)?;
        return Ok(format!("{filename}.disabled"));
    }
    if let Some(stripped) = filename.strip_suffix(".disabled") {
        let enabled = dir.join(stripped);
        std::fs::rename(dir.join(filename), &enabled)?;
        return Ok(stripped.to_string());
    }
    Err(Error::not_found(format!("мод «{filename}» не найден")))
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};

    fn version() -> Version {
        serde_json::from_value(json!({
            "id":"v1", "project_id":"p1", "name":"test",
            "game_versions":["1.21.1", "1.20.1"], "loaders":["fabric", "quilt"]
        })).unwrap()
    }

    fn instance(mc: &str, loader: &str) -> InstanceMeta {
        serde_json::from_value(json!({
            "id":"fixture", "name":"Fixture", "mc_version":mc,
            "loader": if loader == "vanilla" { json!({"type":"vanilla"}) }
                      else { json!({"type":loader, "version":"1.0"}) }
        })).unwrap()
    }

    #[test]
    fn installation_futures_do_not_embed_large_io_buffers() {
        // Tauri создаёт и перемещает future команды на рабочих потоках; большие
        // inline-буферы копируются вместе с каждым вложенным future.
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(temp.path()).unwrap();
        let meta = instance("1.21.1", "fabric");
        let http = crate::net::Http::new();
        let modrinth = Modrinth::new(http.clone());
        let curseforge = crate::curseforge::CurseForge::with_key(http.clone(), "fixture");
        let reporter = Reporter::none();
        let download = download_new_content(&http, temp.path(), "a.jar", "http://127.0.0.1/file", None, None, &reporter);
        let project = install_project(&modrinth, &paths, &meta, "fixture", &reporter);
        let version = install_version(&modrinth, &paths, &meta, "fixture", &reporter);
        let cf = crate::curseforge::install::install(&curseforge, &paths, &meta, "fixture", None, &reporter);
        let sizes = [
            ("download", std::mem::size_of_val(&download)),
            ("modrinth project", std::mem::size_of_val(&project)),
            ("modrinth version", std::mem::size_of_val(&version)),
            ("curseforge", std::mem::size_of_val(&cf)),
        ];
        for (name, bytes) in sizes { println!("INSTALL_FUTURE_SIZE {name}: {bytes} bytes"); }
        for (name, bytes) in sizes {
            assert!(bytes < 48 * 1024, "{name} future is unexpectedly large: {bytes} bytes");
        }
    }

    #[test]
    fn selected_file_requires_exact_game_loader_and_project() {
        let v = version();
        assert!(validate_project_version(&v, "p1", "mod", &instance("1.21.1", "fabric")).is_ok());
        assert!(validate_project_version(&v, "p1", "mod", &instance("1.20.1", "quilt")).is_ok());
        assert!(validate_project_version(&v, "other", "mod", &instance("1.21.1", "fabric")).is_err());
        assert!(validate_project_version(&v, "p1", "mod", &instance("1.21.4", "fabric")).is_err());
        assert!(validate_project_version(&v, "p1", "mod", &instance("1.21.1", "forge")).is_err());
        assert!(validate_project_version(&v, "p1", "mod", &instance("1.21.1", "vanilla")).is_err());
        let mut missing = v.clone();
        missing.loaders.clear();
        assert!(validate_project_version(&missing, "p1", "mod", &instance("1.21.1", "fabric")).is_err());
        missing = v.clone();
        missing.game_versions.clear();
        assert!(validate_project_version(&missing, "p1", "mod", &instance("1.21.1", "fabric")).is_err());
        // У ресурспаков и шейдеров нет тега загрузчика: прежняя установка остаётся доступной.
        assert!(validate_project_version(&missing, "p1", "resourcepack", &instance("1.21.1", "vanilla")).is_ok());
    }

    #[test]
    fn catalog_filename_must_not_escape_target_dir() {
        assert!(safe_filename("sodium-fabric-0.6.0+mc1.21.1.jar").is_ok());
        for bad in ["", ".", "..", "../other.jar", "dir/file.jar", "dir\\file.jar", "C:file.jar", "/file.jar", "a\n.jar"] {
            assert!(safe_filename(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn publish_staged_file_without_overwriting_existing_content() {
        let root = std::env::temp_dir().join(format!("omnispec-publish-{}-{}", std::process::id(), STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir(&root).unwrap();
        let staged = root.join("staged");
        let dest = root.join("mod.jar");
        std::fs::write(&staged, b"validated mod").unwrap();
        assert!(publish_new_content(&staged, &dest).unwrap());
        assert_eq!(std::fs::read(&dest).unwrap(), b"validated mod");
        assert!(!staged.exists());

        std::fs::write(&staged, b"different mod").unwrap();
        assert!(!publish_new_content(&staged, &dest).unwrap());
        assert_eq!(std::fs::read(&dest).unwrap(), b"validated mod");
        assert!(!staged.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn download_with_limited_stack_validates_and_preserves_files() {
        use std::net::TcpListener;
        use std::time::{Duration, Instant};
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().to_path_buf();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/file", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut requests = 0;
            while requests < 3 && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5)); continue;
                    }
                    Err(error) => panic!("local server: {error}"),
                };
                // На Windows accepted socket наследует nonblocking listener;
                // иначе read может случайно вернуть WSAEWOULDBLOCK до прихода запроса.
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request).unwrap();
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc").unwrap();
                requests += 1;
            }
            requests
        });
        let worker = std::thread::Builder::new().name("small-install-stack".into()).stack_size(1024 * 1024)
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                runtime.block_on(async {
                    let http = crate::net::Http::new();
                    let reporter = Reporter::none();
                    let good = "a9993e364706816aba3e25717850c26c9cd0d89d";
                    assert!(download_new_content(&http, &dir, "ok.jar", &url, Some(3), Some(good), &reporter).await.unwrap());
                    assert!(!download_new_content(&http, &dir, "ok.jar", &url, Some(3), Some(good), &reporter).await.unwrap());
                    assert!(download_new_content(&http, &dir, "bad-hash.jar", &url, Some(3), Some("0000000000000000000000000000000000000000"), &reporter).await.is_err());
                    assert!(download_new_content(&http, &dir, "bad-size.jar", &url, Some(4), Some(good), &reporter).await.is_err());
                    assert_eq!(std::fs::read(dir.join("ok.jar")).unwrap(), b"abc");
                    assert!(!dir.join("bad-hash.jar").exists() && !dir.join("bad-size.jar").exists());
                    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "временные файлы удалены");
                });
            }).unwrap();
        worker.join().unwrap();
        assert_eq!(server.join().unwrap(), 3, "повторная установка не перекачивает файл");
    }

    #[tokio::test]
    async fn download_never_overwrites_file_created_during_transfer() {
        use std::net::TcpListener;
        let root = std::env::temp_dir().join(format!("omnispec-noclobber-{}-{}", std::process::id(), STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir(&root).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/file", listener.local_addr().unwrap());
        let (arrived_tx, arrived_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf).unwrap();
            arrived_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc").unwrap();
        });
        let dir = root.clone();
        let task = tokio::spawn(async move {
            download_new_content(&crate::net::Http::new(), &dir, "mod.jar", &url, Some(3),
                Some("a9993e364706816aba3e25717850c26c9cd0d89d"), &Reporter::none()).await
        });
        arrived_rx.await.unwrap();
        std::fs::write(root.join("mod.jar"), b"user data").unwrap();
        release_tx.send(()).unwrap();
        assert!(!task.await.unwrap().unwrap());
        server.join().unwrap();
        assert_eq!(std::fs::read(root.join("mod.jar")).unwrap(), b"user data");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1, "временная папка удалена");
        std::fs::remove_dir_all(root).unwrap();
    }
}
