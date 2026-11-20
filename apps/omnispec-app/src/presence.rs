//! Discord Rich Presence: статус лаунчера в Discord («В ожидании /
//! Запускает / Играет» + сборка + таймер) через локальный IPC Discord.
//!
//! Протокол: pipe `\\.\pipe\discord-ipc-N` (Windows) или сокет
//! `/tmp/discord-ipc-N` (Linux/macOS), кадры [opcode u32 LE][len u32 LE][json]:
//! handshake → READY → SET_ACTIVITY, на PING отвечаем PONG.
//! Client ID приложения зашит в код (DEFAULT_CLIENT_ID).

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omnispec_core::settings::LauncherIcon;

/// Что показать в Discord. Обновляет фронт командой `set_presence`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PresenceInfo {
    /// "idle" | "launching" | "playing"
    pub mode: String,
    /// Название сборки (или "OmniSpec").
    pub details: String,
    /// Строка состояния: "В ожидании" / "Запускает" / "MC 1.21.1 · NeoForge".
    pub state: String,
    /// Unix-время начала (таймер в Discord); None — без таймера.
    pub started_at: Option<u64>,
    /// Публичный HTTPS-адрес иконки выбранной сборки, если она доступна.
    pub small_image: Option<String>,
}

/// Client ID приложения OmniSpec в Discord Developer Portal.
/// Зашит в код: в настройках поле убрано, ID один для всех.
pub const DEFAULT_CLIENT_ID: &str = "1304864863830540439";

#[derive(Default)]
struct Shared {
    info: PresenceInfo,
    enabled: bool,
    launcher_icon: LauncherIcon,
}

/// Общее состояние присутствия: фронт пишет, воркер читает.
#[derive(Clone, Default)]
pub struct Presence {
    shared: Arc<Mutex<Shared>>,
    log_path: Option<std::path::PathBuf>,
}

impl Presence {
    pub fn new() -> Self {
        Self::default()
    }

    /// Куда писать ошибки IPC (для диагностики, если RPC не работает).
    pub fn with_log_path(mut self, path: std::path::PathBuf) -> Self {
        self.log_path = Some(path);
        self
    }

    fn log(&self, message: &str) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        eprintln!("[omnispec] discord rpc: {message}");
        if let Some(path) = &self.log_path {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                use std::io::Write;
                let _ = writeln!(file, "[{stamp}] {message}");
            }
        }
    }

    /// Включён ли Discord RPC (тумблер в настройках). Client ID зашит
    /// в код (DEFAULT_CLIENT_ID) и из настроек убран.
    pub fn configure(&self, enabled: bool) {
        self.shared.lock().unwrap().enabled = enabled;
        self.log(&format!("configure: enabled={enabled}"));
    }

    /// Новое состояние от фронта.
    pub fn set(&self, info: PresenceInfo) {
        self.shared.lock().unwrap().info = info;
    }

    /// Большая иконка хранится отдельно от присылаемой фронтом сборки.
    pub fn set_launcher_icon(&self, icon: LauncherIcon) {
        self.shared.lock().unwrap().launcher_icon = icon;
    }

    fn snapshot(&self) -> (bool, PresenceInfo, LauncherIcon) {
        let shared = self.shared.lock().unwrap();
        (shared.enabled, shared.info.clone(), shared.launcher_icon)
    }

    /// Цикл воркера: сессия → пауза → снова. Молча ждёт, пока не включат RPC.
    pub fn run(&self) {
        self.log("воркер запущен");
        loop {
            let (enabled, _, _) = self.snapshot();
            if !enabled {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            if let Err(error) = self.session(DEFAULT_CLIENT_ID) {
                self.log(&error);
            }
            std::thread::sleep(Duration::from_secs(3));
        }
    }

    /// Одна сессия: handshake, затем SET_ACTIVITY при изменениях до обрыва.
    fn session(&self, client_id: &str) -> Result<(), String> {
        self.log("сессия: ищу Discord IPC…");
        let mut stream = connect_ipc().map_err(|error| format!("нет Discord IPC: {error}"))?;
        self.connected_session(&mut stream, client_id)
    }

    /// Протокол выделен отдельно, чтобы проверять настоящие кадры на тестовом
    /// сокете, не подключаясь к Discord и не меняя глобальные IPC-пути.
    fn connected_session<S: Read + Write>(&self, mut stream: &mut S, client_id: &str) -> Result<(), String> {
        self.log("IPC подключён, шлём handshake");
        // client_id дублируется на верхний уровень: часть сборок Discord
        // ищет его там, а не в args, и отвечает «No Client ID Specified».
        let handshake = serde_json::json!({
            "cmd": "HANDSHAKE",
            "args": {"version": 1, "client_id": client_id},
            "client_id": client_id,
            "nonce": next_nonce(),
        })
        .to_string();
        self.log(&format!("handshake payload: {handshake}"));
        write_frame(&mut stream, 0, &handshake)
            .map_err(|error| format!("handshake: {error}"))?;
        self.log("handshake отправлен, ждём READY");
        // ждём READY (на PING отвечаем PONG)
        loop {
            let Some((opcode, payload)) =
                read_frame(&mut stream).map_err(|error| format!("чтение: {error}"))?
            else {
                return Err("discord закрыл соединение до READY".into());
            };
            if opcode == 3 {
                write_frame(&mut stream, 4, &String::from_utf8_lossy(&payload))
                    .map_err(|error| format!("pong: {error}"))?;
                continue;
            }
            if payload.windows(5).any(|window| window == b"READY") {
                self.log("READY получен");
                break;
            }
            self.log(&format!(
                "неожиданный кадр opcode={opcode}: {}",
                String::from_utf8_lossy(&payload).chars().take(120).collect::<String>()
            ));
        }
        // После READY — только пишем, из Discord не читаем. Блокирующий
        // ReadFile в отдельном потоке на Windows сериализует pipe:
        // запись SET_ACTIVITY зависает, пока висит чтение. Поэтому
        // читалку убрали совсем. PING от Discord не отвечаем: если
        // Discord оборвёт соединение из-за пропущенного PONG, запись
        // упадёт с ошибкой, и run() переподключится (активность
        // переотправится, таймер продолжит идти — start тот же).
        // Писатель: шлём активность при изменениях и периодически повторяем
        // текущую (раз в 15 с) — иначе Discord не перерисовывает таймер и
        // может не показать обновление статуса.
        let mut last_sent: Option<serde_json::Value> = None;
        let mut last_send_at = std::time::Instant::now() - Duration::from_secs(60);
        loop {
            let (enabled, info, launcher_icon) = self.snapshot();
            if !enabled {
                // Выключение RPC должно убрать уже показанный статус.
                let clear = serde_json::json!({
                    "cmd": "SET_ACTIVITY",
                    "args": {"pid": std::process::id(), "activity": null},
                    "nonce": next_nonce(),
                }).to_string();
                let _ = write_frame(&mut stream, 1, &clear);
                return Ok(());
            }
            let activity = activity_value(&info, launcher_icon);
            let changed = last_sent.as_ref() != Some(&activity);
            let heartbeat = last_send_at.elapsed() >= Duration::from_secs(15);
            if changed || heartbeat {
                last_sent = Some(activity.clone());
                last_send_at = std::time::Instant::now();
                let payload = serde_json::json!({
                    "cmd": "SET_ACTIVITY",
                    "args": {"pid": std::process::id(), "activity": activity},
                    "nonce": next_nonce(),
                })
                .to_string();
                self.log("пишу активность…");
                write_frame(&mut stream, 1, &payload)
                    .map_err(|error| format!("set_activity: {error}"))?;
                self.log(&format!(
                    "активность отправлена: {}",
                    payload.chars().take(220).collect::<String>()
                ));
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

/// Тело активности для SET_ACTIVITY.
fn activity_value(info: &PresenceInfo, launcher_icon: LauncherIcon) -> serde_json::Value {
    let details = if info.details.trim().is_empty() {
        "OmniSpec"
    } else {
        info.details.trim()
    };
    let state = if info.state.trim().is_empty() {
        "В ожидании"
    } else {
        info.state.trim()
    };
    // Discord принимает публичные URL в assets; заранее загружать логотип
    // в Developer Portal не нужно. Локальные пути и data: недопустимы.
    let mut assets = serde_json::json!({
        "large_image": crate::launcher_icon::presence_url(launcher_icon),
        "large_text": "OmniSpec",
    });
    if let Some(url) = info.small_image.as_deref().filter(|url| valid_image_url(url)) {
        assets["small_image"] = serde_json::json!(url);
        assets["small_text"] = serde_json::json!(details.chars().take(128).collect::<String>());
    }
    let mut activity = serde_json::json!({
        "type": 0,
        "details": details,
        "state": state,
        "instance": false,
        "assets": assets,
    });
    if let Some(start) = info.started_at {
        activity["timestamps"] = serde_json::json!({"start": start});
    }
    activity
}

/// Допускаем только HTTPS-картинки известных источников, без локальных путей.
pub(crate) fn valid_image_url(value: &str) -> bool {
    if value.len() > 256 || value.chars().any(char::is_control) {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(value) else { return false; };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return false;
    }
    match url.host_str().unwrap_or("") {
        "raw.githubusercontent.com" | "cdn.modrinth.com" | "d.tmpfile.link" => true,
        host if host == "forgecdn.net" || host.ends_with(".forgecdn.net") => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_contains_launcher_and_instance_images() {
        let info = PresenceInfo {
            mode: "playing".into(), details: "Моя сборка".into(),
            state: "MC 1.21.1".into(), started_at: Some(123),
            small_image: Some("https://cdn.modrinth.com/data/test/icon.png".into()),
        };
        let value = activity_value(&info, LauncherIcon::Default);
        assert!(value["assets"]["large_image"].as_str().unwrap().ends_with("/icons/icon-512.png"));
        assert_eq!(value["assets"]["small_image"], "https://cdn.modrinth.com/data/test/icon.png");
        assert_eq!(value["assets"]["small_text"], "Моя сборка");
        assert_eq!(value["timestamps"]["start"], 123);
    }

    #[test]
    fn changing_launcher_icon_updates_large_without_touching_instance_or_timer() {
        let presence = Presence::new();
        presence.set(PresenceInfo {
            mode: "playing".into(), details: "Сборка".into(), state: "MC 1.21".into(),
            started_at: Some(123), small_image: Some("https://cdn.modrinth.com/data/test/icon.png".into()),
        });
        let (_, info, default) = presence.snapshot();
        let mut previous = activity_value(&info, default);
        for (icon, suffix) in [(LauncherIcon::Ru, "/ru.png"), (LauncherIcon::By, "/by.png"),
                               (LauncherIcon::Kz, "/kz.png"), (LauncherIcon::Ua, "/ua.png"),
                               (LauncherIcon::Us, "/us.png"), (LauncherIcon::Default, "/icon-512.png")] {
            presence.set_launcher_icon(icon);
            let (_, info, selected) = presence.snapshot();
            let value = activity_value(&info, selected);
            assert_ne!(value, previous, "worker must send a changed activity");
            assert!(value["assets"]["large_image"].as_str().unwrap().ends_with(suffix));
            assert_eq!(value["assets"]["small_image"], "https://cdn.modrinth.com/data/test/icon.png");
            assert_eq!(value["timestamps"]["start"], 123);
            previous = value;
        }
        // Поздний ответ фронта с данными сборки не отменяет выбор логотипа.
        presence.set_launcher_icon(LauncherIcon::Ua);
        presence.set(PresenceInfo::default());
        assert_eq!(presence.snapshot().2, LauncherIcon::Ua);
    }

    #[cfg(unix)]
    #[test]
    fn ipc_sends_every_chosen_large_icon_and_preserves_small_image() {
        use std::os::unix::net::UnixStream;
        let (mut client, mut server) = UnixStream::pair().unwrap();
        server.set_read_timeout(Some(Duration::from_secs(6))).unwrap();
        let presence = Presence::new();
        presence.configure(true);
        presence.set(PresenceInfo {
            mode: "playing".into(), details: "Сборка".into(), state: "Играет".into(),
            started_at: Some(123), small_image: Some("https://cdn.modrinth.com/data/test/icon.png".into()),
        });
        let worker_presence = presence.clone();
        let worker = std::thread::spawn(move || worker_presence.connected_session(&mut client, DEFAULT_CLIENT_ID));
        let (op, handshake) = read_frame(&mut server).unwrap().unwrap();
        assert_eq!(op, 0);
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&handshake).unwrap()["client_id"], DEFAULT_CLIENT_ID);
        write_frame(&mut server, 3, "ping").unwrap();
        assert_eq!(read_frame(&mut server).unwrap().unwrap(), (4, b"ping".to_vec()));
        write_frame(&mut server, 1, r#"{"evt":"READY"}"#).unwrap();
        let receive_activity = |server: &mut UnixStream| {
            let (op, bytes) = read_frame(server).unwrap().unwrap();
            assert_eq!(op, 1);
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["cmd"], "SET_ACTIVITY");
            value["args"]["activity"].clone()
        };
        assert_eq!(receive_activity(&mut server)["assets"]["large_image"], crate::launcher_icon::presence_url(LauncherIcon::Default));
        for icon in [LauncherIcon::Ru, LauncherIcon::By, LauncherIcon::Kz,
                     LauncherIcon::Ua, LauncherIcon::Us, LauncherIcon::Default] {
            presence.set_launcher_icon(icon);
            let activity = receive_activity(&mut server);
            assert_eq!(activity["assets"]["large_image"], crate::launcher_icon::presence_url(icon));
            assert_eq!(activity["assets"]["small_image"], "https://cdn.modrinth.com/data/test/icon.png");
            assert_eq!(activity["timestamps"]["start"], 123);
        }
        presence.configure(false);
        assert!(receive_activity(&mut server).is_null());
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn activity_omits_untrusted_or_local_image() {
        for url in ["file:///secret.png", "data:image/png;base64,AAAA", "http://localhost/a.png",
                    "https://cdn.modrinth.com.evil.example/x", "https://user@cdn.modrinth.com/x"] {
            assert!(!valid_image_url(url));
            let info = PresenceInfo { small_image: Some(url.into()), ..PresenceInfo::default() };
            assert!(activity_value(&info, LauncherIcon::Ru)["assets"].get("small_image").is_none());
        }
    }
}

static NONCE: AtomicU64 = AtomicU64::new(1);

fn next_nonce() -> String {
    NONCE.fetch_add(1, Ordering::Relaxed).to_string()
}

/// Один кадр IPC: [opcode u32 LE][длина u32 LE][json].
fn write_frame<W: Write>(writer: &mut W, opcode: u32, payload: &str) -> std::io::Result<()> {
    let mut frame = Vec::with_capacity(8 + payload.len());
    frame.extend_from_slice(&opcode.to_le_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload.as_bytes());
    writer.write_all(&frame)?;
    writer.flush()
}

/// Читает один кадр; None — чистый EOF.
fn read_frame<R: Read>(reader: &mut R) -> std::io::Result<Option<(u32, Vec<u8>)>> {
    let mut header = [0u8; 8];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let opcode = u32::from_le_bytes(header[0..4].try_into().unwrap());
    let len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
    if len > 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "слишком большой кадр discord ipc",
        ));
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload)?;
    Ok(Some((opcode, payload)))
}

#[cfg(windows)]
type IpcStream = std::fs::File;
#[cfg(not(windows))]
type IpcStream = std::os::unix::net::UnixStream;

/// Подключение к Discord IPC: перебираем discord-ipc-0…9.
fn connect_ipc() -> std::io::Result<IpcStream> {
    let mut last_err: Option<std::io::Error> = None;
    for index in 0..10 {
        #[cfg(windows)]
        let result = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(format!(r"\\.\pipe\discord-ipc-{index}"));
        #[cfg(not(windows))]
        let result = connect_unix(index);
        match result {
            Ok(stream) => return Ok(stream),
            Err(error) => last_err = Some(error),
        }
    }
    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "discord ipc не найден")
    }))
}

#[cfg(not(windows))]
fn connect_unix(index: usize) -> std::io::Result<std::os::unix::net::UnixStream> {
    let mut candidates = vec![format!("/tmp/discord-ipc-{index}")];
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            candidates.push(format!("{dir}/discord-ipc-{index}"));
        }
    }
    if let Ok(dir) = std::env::var("TMPDIR") {
        if !dir.is_empty() {
            candidates.push(format!("{dir}/discord-ipc-{index}"));
        }
    }
    let mut last_err: Option<std::io::Error> = None;
    for path in candidates {
        match std::os::unix::net::UnixStream::connect(&path) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_err = Some(error),
        }
    }
    Err(last_err.unwrap())
}
