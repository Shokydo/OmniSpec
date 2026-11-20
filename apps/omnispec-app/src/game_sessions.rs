//! Журнал только своих запущенных игр: PID вместе с неизменяемым временем
//! создания процесса. Переиспользованный PID никогда не принимается за игру.
//! Здесь нет токенов, аргументов командной строки или данных авторизации.
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use serde::{Deserialize, Serialize};

// Порядок блокировок всегда одинаков: сначала журнал сессий, затем instance.json.
// Файл остаётся на месте после освобождения: его нельзя удалять или переименовывать.
static SESSION_WRITE_LOCK: Mutex<()> = Mutex::new(());
struct SessionWriteGuard {
    _file: omnispec_core::file_lock::FileLock,
    _thread: MutexGuard<'static, ()>,
}
fn lock_session_writes(root: &Path) -> Result<SessionWriteGuard, String> {
    let thread = SESSION_WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let file = omnispec_core::file_lock::FileLock::acquire(&root.join(".omnispec-sessions.lock"))
        .map_err(|error| format!("не удалось заблокировать журнал сессий: {error}"))?;
    Ok(SessionWriteGuard { _file: file, _thread: thread })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// Linux: такты от загрузки; Windows: FILETIME создания (100 ns).
    pub start: u64,
    /// Linux: id загрузки, Windows: FILETIME уже содержит абсолютное время.
    pub boot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub run_id: String,
    pub instance_id: String,
    pub account: String,
    pub game_dir: String,
    pub started_at: u64,
    pub checkpoint_at: u64,
    /// Известное время выхода для повторной записи статистики после ошибки.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    pub process: ProcessIdentity,
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_secs()
}

pub fn new_run_id(instance: &str) -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("нет случайного идентификатора запуска: {e}"))?;
    Ok(format!("{instance}#{}", hex::encode(bytes)))
}

fn nonce(run_id: &str) -> Option<&str> {
    let (_, value) = run_id.rsplit_once('#')?;
    (value.len() == 32 && value.bytes().all(|c| c.is_ascii_hexdigit())).then_some(value)
}

fn record_path(root: &Path, run_id: &str) -> Result<PathBuf, String> {
    let name = nonce(run_id).ok_or("недопустимый идентификатор запуска")?;
    Ok(root.join("running-sessions").join(format!("{name}.json")))
}

/// Регистрирует новый запуск. Последующие отметки и завершение выполняются
/// отдельными операциями под той же межпроцессной блокировкой.
pub fn save(root: &Path, record: &SessionRecord) -> Result<(), String> {
    let _guard = lock_session_writes(root)?;
    save_unlocked(root, record)
}

/// Каждый запуск имеет отдельный файл, не содержащий секретов. Чтение и замену
/// уже существующей записи вызывающий делает под lock_session_writes.
fn save_unlocked(root: &Path, record: &SessionRecord) -> Result<(), String> {
    if record.run_id != format!("{}#{}", record.instance_id, nonce(&record.run_id).unwrap_or("")) {
        return Err("идентификатор запуска не соответствует сборке".into());
    }
    let path = record_path(root, &record.run_id)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut suffix = [0u8; 8];
    getrandom::fill(&mut suffix).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", hex::encode(suffix)));
    let data = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    let result = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temp)?;
        file.write_all(&data)?;
        file.sync_all()?;
        drop(file);
        // std::fs::rename replaces an existing file on Windows as well. Do not
        // unlink it first: a crash in that gap would erase a running session.
        std::fs::rename(&temp, &path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result.map_err(|e| e.to_string())
}

/// True только если журнал точно удалён; иначе отметку статистики сохраняем.
#[cfg(test)]
fn remove(root: &Path, run_id: &str) -> bool {
    let Ok(_guard) = lock_session_writes(root) else { return false; };
    remove_unlocked(root, run_id)
}

fn remove_unlocked(root: &Path, run_id: &str) -> bool {
    let Ok(path) = record_path(root, run_id) else { return false; };
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

/// Неверные записи не используются. Завершённые записи тоже возвращаются:
/// сначала нужно надёжно записать статистику, прежде чем удалять журнал.
/// Незнакомые форматы оставляем нетронутыми на случай будущей версии.
pub fn records(root: &Path) -> Vec<SessionRecord> {
    let Ok(entries) = std::fs::read_dir(root.join("running-sessions")) else { return Vec::new(); };
    let mut found = Vec::new();
    for entry in entries.flatten().take(4096) {
        let path = entry.path();
        let Some(filename) = path.file_name().and_then(|n| n.to_str()) else { continue; };
        let Some(n) = filename.strip_suffix(".json") else { continue; };
        if n.len() != 32 || !n.bytes().all(|c| c.is_ascii_hexdigit()) { continue; }
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue; };
        if !meta.file_type().is_file() || meta.len() > 64 * 1024 { continue; }
        let Ok(data) = std::fs::read(&path) else { continue; };
        let Ok(record) = serde_json::from_slice::<SessionRecord>(&data) else { continue; };
        if nonce(&record.run_id) != Some(n)
            || record.run_id != format!("{}#{n}", record.instance_id)
            || record.process.pid == 0
            || record.started_at == 0
            || record.game_dir.is_empty() { continue; }
        found.push(record);
    }
    found.sort_by_key(|r| (r.started_at, r.run_id.clone()));
    found
}

/// Читаем именно текущую запись под межпроцессной блокировкой. Устаревший
/// наблюдатель не должен менять другой запуск или воскрешать удалённый журнал.
fn current_record(root: &Path, expected: &SessionRecord) -> Result<Option<SessionRecord>, String> {
    let path = record_path(root, &expected.run_id)?;
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !meta.file_type().is_file() || meta.len() > 64 * 1024 {
        return Err("неверный файл журнала сессии".into());
    }
    let data = std::fs::read(&path).map_err(|error| error.to_string())?;
    let current: SessionRecord = serde_json::from_slice(&data).map_err(|error| error.to_string())?;
    if current.run_id != expected.run_id || current.instance_id != expected.instance_id
        || current.started_at != expected.started_at || current.process != expected.process {
        return Err("журнал сессии изменился другим процессом".into());
    }
    Ok(Some(current))
}

/// Согласуем обновление счётчика и журнала между наблюдателями. После сбоя
/// между двумя файлами повторный checkpoint не начислит те же секунды дважды.
/// false означает, что другая копия уже завершила или удалила эту сессию.
pub fn checkpoint(paths: &omnispec_core::paths::Paths, record: &mut SessionRecord, until: u64) -> Result<bool, String> {
    let _guard = lock_session_writes(&paths.root)?;
    let Some(mut current) = current_record(&paths.root, record)? else { return Ok(false); };
    if current.ended_at.is_some() { return Ok(false); }
    let checkpoint = until.max(current.checkpoint_at).max(record.checkpoint_at).max(current.started_at);
    omnispec_core::instances::checkpoint_playtime(
        paths, &current.instance_id, &current.run_id, current.started_at, checkpoint,
    ).map_err(|error| error.to_string())?;
    current.checkpoint_at = checkpoint;
    save_unlocked(&paths.root, &current)?;
    record.checkpoint_at = checkpoint;
    Ok(true)
}

/// Идемпотентно завершаем статистику под той же блокировкой, что и checkpoint.
/// Сначала сохраняем известное время выхода, затем счётчик, затем удаляем
/// журнал и отметку. Второй процесс увидит отсутствие журнала и не начислит
/// тот же запуск повторно, даже если держит устаревший снимок записи в памяти.
pub fn finalize(paths: &omnispec_core::paths::Paths, record: &SessionRecord, until: u64) -> Result<(), String> {
    let _guard = lock_session_writes(&paths.root)?;
    let Some(mut current) = current_record(&paths.root, record)? else { return Ok(()); };
    let until = current.ended_at.unwrap_or(until).max(current.checkpoint_at).max(current.started_at);
    if current.ended_at != Some(until) {
        current.ended_at = Some(until);
        if let Err(error) = save_unlocked(&paths.root, &current) {
            // При ошибке журнала всё равно пробуем сохранить счётчик; старый
            // журнал и отметка останутся для идемпотентного повтора.
            let stats = omnispec_core::instances::checkpoint_playtime(
                paths, &current.instance_id, &current.run_id, current.started_at, until,
            );
            return Err(format!("не удалось обновить журнал завершения: {error}{}",
                stats.err().map(|e| format!("; время игры: {e}")).unwrap_or_default()));
        }
    }
    omnispec_core::instances::checkpoint_playtime(
        paths, &current.instance_id, &current.run_id, current.started_at, until,
    ).map_err(|error| error.to_string())?;
    if !remove_unlocked(&paths.root, &current.run_id) {
        return Err("не удалось удалить журнал завершённой сессии".into());
    }
    // Если очистка не удалась, лишняя отметка безопасна и не изменит время.
    if let Err(error) = omnispec_core::instances::clear_playtime_checkpoint(paths, &current.instance_id, &current.run_id) {
        eprintln!("[omnispec] не удалось очистить отметку статистики: {error}");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn identify(pid: u32) -> Option<ProcessIdentity> {
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?.trim().to_owned();
    if boot.is_empty() { return None; }
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // comm может содержать пробелы и скобки; закрывающая скобка — последняя.
    let tail = stat.rsplit_once(") ")?.1;
    let fields: Vec<_> = tail.split_whitespace().collect();
    if matches!(fields.first().copied(), Some("Z" | "X" | "x")) { return None; }
    let start = fields.get(19)?.parse().ok()?; // stat field 22, начиная с field 3
    Some(ProcessIdentity { pid, start, boot })
}

#[cfg(windows)]
fn from_handle(pid: u32, handle: windows_sys::Win32::Foundation::HANDLE) -> Option<ProcessIdentity> {
    use windows_sys::Win32::Foundation::{FILETIME, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, WaitForSingleObject};
    let mut create = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut exit = create;
    let mut kernel = create;
    let mut user = create;
    unsafe {
        // Exit code 259 совпадает со STILL_ACTIVE, но может быть настоящим
        // кодом завершённого процесса. Сигнальное состояние handle надёжнее.
        if WaitForSingleObject(handle, 0) != WAIT_TIMEOUT
            || GetProcessTimes(handle, &mut create, &mut exit, &mut kernel, &mut user) == 0 { return None; }
    }
    Some(ProcessIdentity {
        pid,
        start: (u64::from(create.dwHighDateTime) << 32) | u64::from(create.dwLowDateTime),
        boot: String::new(),
    })
}

#[cfg(windows)]
pub fn identify(pid: u32) -> Option<ProcessIdentity> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() { return None; }
        let result = from_handle(pid, handle);
        CloseHandle(handle);
        result
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn identify(_pid: u32) -> Option<ProcessIdentity> { None }

pub fn is_alive(identity: &ProcessIdentity) -> bool {
    identify(identity.pid).as_ref() == Some(identity)
}

/// Проверка и завершение через один и тот же дескриптор процесса. Если PID уже
/// был переиспользован, или ОС не предоставляет безопасный pidfd, не убиваем.
#[cfg(target_os = "linux")]
pub fn terminate(identity: &ProcessIdentity) -> Result<(), String> {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, identity.pid as libc::pid_t, 0) as i32 };
    if fd < 0 { return Err(format!("не удалось безопасно открыть процесс игры: {}", std::io::Error::last_os_error())); }
    let matches = is_alive(identity);
    let result = if matches {
        let rc = unsafe { libc::syscall(libc::SYS_pidfd_send_signal, fd, libc::SIGKILL, std::ptr::null::<libc::siginfo_t>(), 0) };
        if rc == 0 { Ok(()) } else { Err(format!("не удалось остановить игру: {}", std::io::Error::last_os_error())) }
    } else { Err("процесс игры завершился или его PID уже занят другим процессом".into()) };
    unsafe { libc::close(fd); }
    result
}

#[cfg(windows)]
pub fn terminate(identity: &ProcessIdentity) -> Result<(), String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, identity.pid);
        if handle.is_null() { return Err(format!("не удалось безопасно открыть процесс игры: {}", std::io::Error::last_os_error())); }
        let result = if from_handle(identity.pid, handle).as_ref() != Some(identity) {
            Err("процесс игры завершился или его PID уже занят другим процессом".into())
        } else if TerminateProcess(handle, 1) == 0 {
            Err(format!("не удалось остановить игру: {}", std::io::Error::last_os_error()))
        } else { Ok(()) };
        CloseHandle(handle);
        result
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn terminate(_identity: &ProcessIdentity) -> Result<(), String> {
    Err("безопасная остановка восстановленного процесса не поддерживается этой ОС".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_process_identity_refuses_reused_pid() {
        let ours = identify(std::process::id()).expect("свой процесс доступен");
        assert!(is_alive(&ours));
        let mut wrong = ours.clone(); wrong.start += 1;
        assert!(!is_alive(&wrong));
        assert!(terminate(&wrong).is_err());
        assert!(is_alive(&ours), "не убили чужой/текущий процесс");
    }
    #[test]
    fn restore_and_clean_only_own_live_sessions() {
        let root = std::env::temp_dir().join(format!("omnispec-sessions-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let identity = identify(std::process::id()).unwrap();
        let id = new_run_id("fabric").unwrap();
        let mut record = SessionRecord {run_id:id.clone(), instance_id:"fabric".into(), account:"Alex".into(), game_dir:"/game".into(), started_at:now(), checkpoint_at:now(), ended_at:None, process:identity};
        save(&root, &record).unwrap();
        let other = new_run_id("fabric").unwrap();
        record.run_id = other.clone(); save(&root, &record).unwrap();
        assert_eq!(records(&root).len(), 2);
        record.process.start += 1; save(&root, &record).unwrap();
        let found = records(&root);
        assert_eq!(found.iter().filter(|r| is_alive(&r.process)).count(), 1);
        assert_eq!(found.iter().filter(|r| !is_alive(&r.process)).count(), 1);
        assert!(record_path(&root, &other).unwrap().exists(), "нельзя удалять журнал до сохранения статистики");
        let stored = std::fs::read_to_string(record_path(&root, &id).unwrap()).unwrap();
        assert!(!stored.contains("token"));
        assert!(!stored.contains("ended_at"), "старый формат журнала остаётся совместимым");
        remove(&root, &id); remove(&root, &other); assert!(records(&root).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn helper_process() {
        match std::env::var("OMNISPEC_SESSION_TEST_CHILD").as_deref() {
            Ok("live") => std::thread::sleep(std::time::Duration::from_secs(30)),
            #[cfg(windows)]
            Ok("exit259") => std::process::exit(259),
            _ => {}
        }
    }

    #[test]
    fn live_child_can_be_recovered_and_safely_stopped() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "game_sessions::tests::helper_process", "--nocapture"])
            .env("OMNISPEC_SESSION_TEST_CHILD", "live")
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .spawn().unwrap();
        let identity = identify(child.id()).expect("child identity");
        let root = std::env::temp_dir().join(format!("omnispec-session-child-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let id = new_run_id("fabric").unwrap();
        let record = SessionRecord {run_id:id.clone(), instance_id:"fabric".into(), account:"Alex".into(),
            game_dir:root.to_string_lossy().into_owned(), started_at:now(), checkpoint_at:now(), ended_at:None,
            process:identity.clone()};
        save(&root, &record).unwrap();
        let restored = records(&root).remove(0);
        assert!(is_alive(&restored.process));
        let mut wrong = identity.clone(); wrong.start += 1;
        assert!(terminate(&wrong).is_err());
        assert!(is_alive(&identity), "reused PID must not terminate a different process");
        terminate(&restored.process).unwrap();
        child.wait().unwrap();
        assert!(!is_alive(&identity));
        assert_eq!(records(&root).len(), 1, "dead journal waits for statistics checkpoint");
        remove(&root, &id);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn exited_process_code_259_is_not_still_running() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "game_sessions::tests::helper_process", "--nocapture"])
            .env("OMNISPEC_SESSION_TEST_CHILD", "exit259")
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        let pid = child.id();
        assert_eq!(child.wait().unwrap().code(), Some(259));
        assert!(identify(pid).is_none(), "259 is an exit code, not proof of liveness");
    }

    #[test]
    fn concurrent_session_process_worker() {
        let Ok(root) = std::env::var("OMNISPEC_SESSION_WORKER_ROOT") else { return; };
        let index: usize = std::env::var("OMNISPEC_SESSION_WORKER_INDEX").unwrap().parse().unwrap();
        let root = PathBuf::from(root);
        let paths = omnispec_core::paths::Paths::new(&root).unwrap();
        // Все процессы получают один и тот же снимок до старта гонки.
        let mut record = records(&root).remove(0);
        std::fs::write(root.join(format!("session-ready-{index}")), b"ready").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while !root.join("session-go").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert!(root.join("session-go").exists());
        if index % 2 == 0 {
            for second in 101..=140 {
                if !checkpoint(&paths, &mut record, second).unwrap() { break; }
            }
        }
        finalize(&paths, &record, 150).unwrap();
        // Даже очень поздний наблюдатель не должен воскресить журнал и
        // начислить время после очистки отметки завершившегося запуска.
        assert!(!checkpoint(&paths, &mut record, 170).unwrap());
        finalize(&paths, &record, 200).unwrap();
    }

    #[test]
    fn concurrent_session_finalization_never_resurrects_or_double_counts() {
        use omnispec_core::instances::{self, CreateInstanceRequest, Loader};
        use omnispec_core::paths::Paths;
        const WORKERS: usize = 6;
        let root = std::env::temp_dir().join(format!("omnispec-session-cross-process-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        instances::create(&paths, CreateInstanceRequest {
            name:"Test".into(), mc_version:"1.21.1".into(), loader:Loader::Vanilla,
            icon:None, notes:String::new(), source:None, source_url:None,
            id:Some("fabric".into()), category:None, memory_mb:None, java_path:None, game_dir:None,
        }).unwrap();
        let id = new_run_id("fabric").unwrap();
        let mut record = SessionRecord {run_id:id.clone(), instance_id:"fabric".into(), account:"Alex".into(),
            game_dir:root.to_string_lossy().into_owned(), started_at:100, checkpoint_at:100, ended_at:None,
            process:identify(std::process::id()).unwrap()};
        save(&root, &record).unwrap();
        let mut mismatched = record.clone(); mismatched.process.start += 1;
        assert!(checkpoint(&paths, &mut mismatched, 120).is_err(), "a different process identity must not modify this journal");
        let exe = std::env::current_exe().unwrap();
        let mut children: Vec<_> = (0..WORKERS).map(|index| {
            std::process::Command::new(&exe)
                .args(["--exact", "game_sessions::tests::concurrent_session_process_worker", "--nocapture"])
                .env("OMNISPEC_SESSION_WORKER_ROOT", &root)
                .env("OMNISPEC_SESSION_WORKER_INDEX", index.to_string())
                .stdout(std::process::Stdio::null())
                .spawn().unwrap()
        }).collect();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while !(0..WORKERS).all(|index| root.join(format!("session-ready-{index}")).exists())
            && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!((0..WORKERS).all(|index| root.join(format!("session-ready-{index}")).exists()), "workers did not start");
        std::fs::write(root.join("session-go"), b"go").unwrap();
        for child in &mut children { assert!(child.wait().unwrap().success(), "session worker failed"); }
        assert!(!record_path(&root, &id).unwrap().exists());
        assert!(!checkpoint(&paths, &mut record, 170).unwrap());
        finalize(&paths, &record, 200).unwrap();
        assert_eq!(instances::load(&paths, "fabric").unwrap().playtime_secs, 50);
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(paths.instance_file("fabric")).unwrap()).unwrap();
        assert!(value.get("_omnispec_playtime_checkpoints").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_final_checkpoint_keeps_journal_for_safe_retry() {
        use omnispec_core::instances::{self, CreateInstanceRequest, Loader};
        use omnispec_core::paths::Paths;
        let root = std::env::temp_dir().join(format!("omnispec-session-final-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        instances::create(&paths, CreateInstanceRequest {
            name:"Test".into(), mc_version:"1.21.1".into(), loader:Loader::Vanilla,
            icon:None, notes:String::new(), source:None, source_url:None,
            id:Some("fabric".into()), category:None, memory_mb:None, java_path:None, game_dir:None,
        }).unwrap();
        let id = new_run_id("fabric").unwrap();
        let record = SessionRecord {run_id:id.clone(), instance_id:"fabric".into(), account:"Alex".into(),
            game_dir:root.to_string_lossy().into_owned(), started_at:100, checkpoint_at:100, ended_at:Some(150),
            process:identify(std::process::id()).unwrap()};
        save(&root, &record).unwrap();
        let meta = paths.instance_file("fabric");
        let held = meta.with_extension("hold");
        std::fs::rename(&meta, &held).unwrap();
        assert!(finalize(&paths, &record, 150).is_err());
        assert!(record_path(&root, &id).unwrap().exists(), "журнал нужен для повторной попытки");
        assert_eq!(records(&root)[0].ended_at, Some(150));
        std::fs::rename(&held, &meta).unwrap();
        // Сбой сразу после записи счётчика, но до удаления журнала.
        instances::checkpoint_playtime(&paths, "fabric", &id, 100, 150).unwrap();
        finalize(&paths, &record, 150).unwrap();
        assert_eq!(instances::load(&paths, "fabric").unwrap().playtime_secs, 50);
        assert!(!record_path(&root, &id).unwrap().exists());
        finalize(&paths, &record, 150).unwrap();
        assert_eq!(instances::load(&paths, "fabric").unwrap().playtime_secs, 50);
        let _ = std::fs::remove_dir_all(root);
    }
}
