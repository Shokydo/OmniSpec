//! Discord Rich Presence: статус лаунчера в Discord («В ожидании /
//! Запускает / Играет» + сборка + таймер) через локальный IPC Discord.
//!
//! Протокол: pipe `\\.\pipe\discord-ipc-N` (Windows) или сокет
//! `/tmp/discord-ipc-N` (Linux/macOS), кадры [opcode u32 LE][len u32 LE][json]:
//! handshake → READY → SET_ACTIVITY, на PING отвечаем PONG.
//! Работает только если в настройках задан Client ID приложения Discord.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
}

/// Client ID приложения OmniSpec в Discord Developer Portal.
/// Используется, когда в настройках поле пустое (например, у тех, кто
/// обновился со старой версии, где ID ещё не было по умолчанию).
pub const DEFAULT_CLIENT_ID: &str = "1304864863830540439";

#[derive(Default)]
struct Shared {
    info: PresenceInfo,
    client_id: String,
    enabled: bool,
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

    /// Настройки Discord из settings.json (при старте и сохранении).
    /// Пустое поле означает «использовать дефолтный ID приложения» —
    /// так RPC работает и у тех, кто обновился со старой версии.
    pub fn configure(&self, client_id: &str, enabled: bool) {
        let mut shared = self.shared.lock().unwrap();
        let client_id = client_id.trim();
        shared.client_id = if client_id.is_empty() {
            DEFAULT_CLIENT_ID.to_string()
        } else {
            client_id.to_string()
        };
        shared.enabled = enabled;
    }

    /// Новое состояние от фронта.
    pub fn set(&self, info: PresenceInfo) {
        self.shared.lock().unwrap().info = info;
    }

    fn snapshot(&self) -> (String, bool, PresenceInfo) {
        let shared = self.shared.lock().unwrap();
        (
            shared.client_id.clone(),
            shared.enabled,
            shared.info.clone(),
        )
    }

    /// Цикл воркера: сессия → пауза → снова. Молча ждёт, пока не зададут ID.
    pub fn run(&self) {
        loop {
            let (client_id, enabled, _) = self.snapshot();
            if !enabled || client_id.is_empty() {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            if let Err(error) = self.session(&client_id) {
                self.log(&error);
            }
            std::thread::sleep(Duration::from_secs(3));
        }
    }

    /// Одна сессия: handshake, затем SET_ACTIVITY при изменениях до обрыва.
    fn session(&self, client_id: &str) -> Result<(), String> {
        let mut stream = connect_ipc().map_err(|error| format!("нет Discord IPC: {error}"))?;
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
        // читалка: PING → PONG, обрыв → сигнал писателю
        let (gone_tx, gone_rx) = std::sync::mpsc::channel::<()>();
        let mut reader_stream = stream
            .try_clone()
            .map_err(|error| format!("clone: {error}"))?;
        std::thread::spawn(move || {
            loop {
                match read_frame(&mut reader_stream) {
                    Ok(Some((3, payload))) => {
                        let _ =
                            write_frame(&mut reader_stream, 4, &String::from_utf8_lossy(&payload));
                    }
                    Ok(Some(_)) => {}
                    _ => break,
                }
            }
            let _ = gone_tx.send(());
        });
        // писатель: шлём активность при изменениях и периодически повторяем
        // текущую (раз в 15 с) — иначе Discord не перерисовывает таймер и
        // может не показать обновление статуса.
        let mut last_sent: Option<serde_json::Value> = None;
        let mut last_send_at = std::time::Instant::now() - Duration::from_secs(60);
        loop {
            if gone_rx.try_recv().is_ok() {
                return Err("discord закрыл соединение".into());
            }
            let (_, _, info) = self.snapshot();
            let activity = activity_value(&info);
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
fn activity_value(info: &PresenceInfo) -> serde_json::Value {
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
    // Минимальная активность: только текст и таймер. Ссылки на картинки
    // (assets) и кнопки убраны — если ассет «logo» ещё не загружен в портале,
    // Discord может не показывать активность целиком. Картинку вернём,
    // когда ассет будет на месте.
    let mut activity = serde_json::json!({
        "type": 0,
        "details": details,
        "state": state,
        "instance": false,
    });
    if let Some(start) = info.started_at {
        activity["timestamps"] = serde_json::json!({"start": start});
    }
    activity
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
