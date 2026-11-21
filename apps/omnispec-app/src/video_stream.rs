//! Локальная потоковая выдача только выбранных видеообоев.
//!
//! WebKitGTK/GStreamer не воспроизводит видео из `asset://`; HTTP на loopback
//! поддерживает обычные Range-запросы. Сервер не слушает внешние интерфейсы,
//! не выдаёт пути из запроса и использует случайный секрет и отдельные ID.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone)]
struct Entry {
    slot: String,
    path: PathBuf,
    mime: &'static str,
    /// Отзыв действует и на уже начатый ответ, а не только на новые запросы.
    active: Arc<AtomicBool>,
}

pub struct VideoServer {
    port: u16,
    secret: String,
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    shutdown: Arc<AtomicBool>,
}

fn random_hex() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|e| format!("не удалось создать защищённый адрес видео: {e}"))?;
    Ok(hex::encode(bytes))
}

impl VideoServer {
    pub fn new() -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("не удалось открыть локальное видео: {e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let secret = random_hex()?;
        let entries = Arc::new(Mutex::new(HashMap::<String, Entry>::new()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let known = entries.clone();
        let token = secret.clone();
        let stopped = shutdown.clone();
        std::thread::Builder::new()
            .name("omnispec-wall-video".into())
            .spawn(move || {
                let active = Arc::new(AtomicUsize::new(0));
                while !stopped.load(Ordering::Acquire) {
                    let stream = match listener.accept() {
                        Ok((stream, _)) => stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(25));
                            continue;
                        }
                        Err(_) => break,
                    };
                    if active.fetch_add(1, Ordering::AcqRel) >= 16 {
                        active.fetch_sub(1, Ordering::AcqRel);
                        continue;
                    }
                    let known = known.clone();
                    let token = token.clone();
                    let request_active = active.clone();
                    if std::thread::Builder::new()
                        .name("omnispec-wall-request".into())
                        .spawn(move || {
                            struct Guard(Arc<AtomicUsize>);
                            impl Drop for Guard {
                                fn drop(&mut self) {
                                    self.0.fetch_sub(1, Ordering::AcqRel);
                                }
                            }
                            let _guard = Guard(request_active);
                            let _ = serve(stream, port, &token, &known);
                        })
                        .is_err()
                    {
                        active.fetch_sub(1, Ordering::AcqRel);
                    }
                }
            })
            .map_err(|e| format!("не удалось запустить локальное видео: {e}"))?;
        Ok(Self {
            port,
            secret,
            entries,
            shutdown,
        })
    }

    /// Слот — только внутренний идентификатор, URL не содержит локального пути.
    pub fn expose(&self, slot: &str, path: &Path) -> Result<String, String> {
        if slot != "custom" {
            return Err("неизвестный источник видео".into());
        }
        let media = crate::wallpapers::media_at(path)?;
        if media.kind != "video" {
            return Err("это не видео".into());
        }
        let path = PathBuf::from(&media.path);
        let ext = path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime = if ext == "webm" {
            "video/webm"
        } else {
            "video/mp4"
        };
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        // Повторное открытие одного и того же источника не должно инвалидировать
        // URL уже играющего видео (например, при параллельном открытии настроек).
        let id = if let Some((id, _)) = entries
            .iter()
            .find(|(_, entry)| entry.slot == slot && entry.path == path && entry.mime == mime)
        {
            id.clone()
        } else {
            let id = random_hex()?;
            entries.retain(|_, entry| {
                if entry.slot == slot { entry.active.store(false, Ordering::Release); false } else { true }
            });
            entries.insert(
                id.clone(),
                Entry {
                    slot: slot.to_string(),
                    path,
                    mime,
                    active: Arc::new(AtomicBool::new(true)),
                },
            );
            id
        };
        Ok(format!(
            "http://127.0.0.1:{}/{}/{}.{}",
            self.port,
            self.secret,
            id,
            if ext == "webm" { "webm" } else { "mp4" }
        ))
    }

    pub fn revoke(&self, slot: &str) {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, entry| {
            if entry.slot == slot { entry.active.store(false, Ordering::Release); false } else { true }
        });
    }

    pub fn is_empty(&self) -> bool {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
    }
}

impl Drop for VideoServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        for (_, entry) in self.entries.lock().unwrap_or_else(|e| e.into_inner()).drain() {
            entry.active.store(false, Ordering::Release);
        }
    }
}

fn reply(stream: &mut TcpStream, code: &str, extra: &str) -> std::io::Result<()> {
    write!(stream, "HTTP/1.1 {code}\r\nConnection: close\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\n{extra}\r\n")
}

/// Один диапазон, включая открытый и суффиксный. Множественные отклоняем,
/// вместо неожиданного чтения всего многомегабайтного файла в память.
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let range = header.strip_prefix("bytes=")?;
    if range.contains(',') || len == 0 {
        return None;
    }
    let (start, end) = range.split_once('-')?;
    if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        return Some((len.saturating_sub(suffix), len - 1));
    }
    let first: u64 = start.parse().ok()?;
    if first >= len {
        return None;
    }
    let last = if end.is_empty() {
        len - 1
    } else {
        end.parse::<u64>().ok()?.min(len - 1)
    };
    (last >= first).then_some((first, last))
}

fn copy_while_active(
    mut input: impl Read, mut output: impl Write, mut remaining: u64, active: &AtomicBool,
) -> std::io::Result<()> {
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 && active.load(Ordering::Acquire) {
        let max = remaining.min(buffer.len() as u64) as usize;
        let count = input.read(&mut buffer[..max])?;
        if count == 0 || !active.load(Ordering::Acquire) { break; }
        output.write_all(&buffer[..count])?;
        remaining -= count as u64;
    }
    Ok(())
}

fn serve(
    mut stream: TcpStream,
    port: u16,
    secret: &str,
    entries: &Mutex<HashMap<String, Entry>>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut request = Vec::new();
    let mut chunk = [0u8; 1024];
    while request.len() < 16 * 1024 && !request.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        request.extend_from_slice(&chunk[..n]);
    }
    if request.len() >= 16 * 1024 {
        return reply(&mut stream, "431 Request Header Fields Too Large", "");
    }
    let Ok(text) = std::str::from_utf8(&request) else {
        return reply(&mut stream, "400 Bad Request", "");
    };
    let mut lines = text.split("\r\n");
    let Some(first) = lines.next() else {
        return Ok(());
    };
    let mut parts = first.split_whitespace();
    let (Some(method), Some(uri), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return reply(&mut stream, "400 Bad Request", "");
    };
    if parts.next().is_some()
        || !version.starts_with("HTTP/1.")
        || !matches!(method, "GET" | "HEAD" | "OPTIONS")
    {
        return reply(
            &mut stream,
            "405 Method Not Allowed",
            "Allow: GET, HEAD, OPTIONS\r\n",
        );
    }
    let mut host = None;
    let mut range = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            return reply(&mut stream, "400 Bad Request", "");
        };
        if key.eq_ignore_ascii_case("host") {
            if host.is_some() {
                return reply(&mut stream, "400 Bad Request", "");
            }
            host = Some(value.trim());
        }
        if key.eq_ignore_ascii_case("range") {
            if range.is_some() {
                return reply(&mut stream, "416 Range Not Satisfiable", "");
            }
            range = Some(value.trim());
        }
    }
    // Препятствуем DNS rebinding и любым входящим адресам кроме loopback.
    if host != Some(format!("127.0.0.1:{port}").as_str()) {
        return reply(&mut stream, "403 Forbidden", "");
    }
    let prefix = format!("/{secret}/");
    let Some(rest) = uri.strip_prefix(&prefix) else {
        return reply(&mut stream, "404 Not Found", "");
    };
    let Some((id, ext)) = rest.rsplit_once('.') else {
        return reply(&mut stream, "404 Not Found", "");
    };
    if id.len() != 48
        || !id.bytes().all(|b| b.is_ascii_hexdigit())
        || !matches!(ext, "mp4" | "webm")
    {
        return reply(&mut stream, "404 Not Found", "");
    }
    let entry = entries
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned();
    let Some(entry) = entry else {
        return reply(&mut stream, "404 Not Found", "");
    };
    if !entry.active.load(Ordering::Acquire) { return reply(&mut stream, "404 Not Found", ""); }
    if (entry.mime == "video/webm") != (ext == "webm") {
        return reply(&mut stream, "404 Not Found", "");
    }
    if method == "OPTIONS" {
        return reply(&mut stream, "204 No Content", "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\n");
    }
    // Файл мог исчезнуть или стать ссылкой после выбора; не выдаём ничего за
    // пределами исходного, канонического и проверенного видео.
    let Ok(media) = crate::wallpapers::media_at(&entry.path) else {
        return reply(&mut stream, "404 Not Found", "");
    };
    if media.kind != "video" || Path::new(&media.path) != entry.path {
        return reply(&mut stream, "404 Not Found", "");
    }
    let Ok(mut file) = std::fs::File::open(&entry.path) else {
        return reply(&mut stream, "404 Not Found", "");
    };
    let len = file.metadata()?.len();
    let (start, end, code) = match range {
        Some(value) => match parse_range(value, len) {
            Some((a, b)) => (a, b, "206 Partial Content"),
            None => {
                return reply(
                    &mut stream,
                    "416 Range Not Satisfiable",
                    &format!("Content-Range: bytes */{len}\r\n"),
                )
            }
        },
        None if len > 0 => (0, len - 1, "200 OK"),
        None => return reply(&mut stream, "404 Not Found", ""),
    };
    let count = end - start + 1;
    let content_range = if range.is_some() {
        format!("Content-Range: bytes {start}-{end}/{len}\r\n")
    } else {
        String::new()
    };
    write!(stream, "HTTP/1.1 {code}\r\nContent-Type: {}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\n{content_range}Access-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Range, Accept-Ranges\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", entry.mime)?;
    if method == "GET" {
        file.seek(SeekFrom::Start(start))?;
        copy_while_active(file, &mut stream, count, &entry.active)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(server: &VideoServer, uri: &str, headers: &str) -> Vec<u8> {
        let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        write!(
            stream,
            "GET {uri} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{headers}\r\n",
            server.port
        )
        .unwrap();
        let mut body = Vec::new();
        stream.read_to_end(&mut body).unwrap();
        body
    }
    #[test]
    fn only_custom_video_is_exposed_and_revocation_cancels_streams() {
        let dir = std::env::temp_dir().join(format!("omnispec-video-slots-{}-{}", std::process::id(), random_hex().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("movie.mp4");
        std::fs::write(&file, b"\x00\x00\x00\x18ftypisom01234567890123456789").unwrap();
        let server = VideoServer::new().unwrap();
        assert!(server.expose("workshop", &file).is_err());
        let custom = server.expose("custom", &file).unwrap();
        let custom_path = reqwest::Url::parse(&custom).unwrap().path().to_string();
        let old = server.entries.lock().unwrap().values().find(|e| e.slot == "custom").unwrap().clone();
        assert!(String::from_utf8_lossy(&request(&server, &custom_path, "")).starts_with("HTTP/1.1 200"));
        server.revoke("custom");
        assert!(!old.active.load(Ordering::Acquire), "already-open transfers are cancelled");
        assert!(String::from_utf8_lossy(&request(&server, &custom_path, "")).starts_with("HTTP/1.1 404"));
        assert!(server.is_empty());
        let port = server.port;
        drop(server);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while TcpStream::connect(("127.0.0.1", port)).is_ok() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err(), "unused listener must stop");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn copy_stops_as_soon_as_its_slot_is_revoked() {
        struct RevokeOnWrite<'a> { active: &'a AtomicBool, bytes: usize }
        impl Write for RevokeOnWrite<'_> {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.bytes += bytes.len();
                self.active.store(false, Ordering::Release);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let active = AtomicBool::new(true);
        let mut output = RevokeOnWrite { active: &active, bytes: 0 };
        let data = vec![1u8; 1024 * 1024];
        copy_while_active(&data[..], &mut output, data.len() as u64, &active).unwrap();
        assert_eq!(output.bytes, 64 * 1024);
    }

    #[test]
    fn range_and_secret_limit_access_to_selected_video() {
        let dir = std::env::temp_dir().join(format!(
            "omnispec-video-test-{}-{}",
            std::process::id(),
            random_hex().unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("movie.mp4");
        std::fs::write(&file, b"\x00\x00\x00\x18ftypisom01234567890123456789").unwrap();
        let server = VideoServer::new().unwrap();
        let url = server.expose("custom", &file).unwrap();
        let uri = reqwest::Url::parse(&url).unwrap().path().to_string();
        let bytes = request(&server, &uri, "Range: bytes=4-7\r\n");
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("HTTP/1.1 206"), "{text}");
        assert!(text.contains("Content-Range: bytes 4-7/"));
        assert!(text.ends_with("ftyp"));
        assert!(
            String::from_utf8_lossy(&request(&server, "/wrong/file.mp4", ""))
                .starts_with("HTTP/1.1 404")
        );
        assert!(
            String::from_utf8_lossy(&request(&server, &uri, "Range: bytes=10000-\r\n"))
                .starts_with("HTTP/1.1 416")
        );
        assert_eq!(parse_range("bytes=-4", 20), Some((16, 19)));
        assert_eq!(parse_range("bytes=0-1,2-3", 20), None);
        // Повторный выбор не ломает текущий поток; другой файл отзывает старый.
        assert_eq!(server.expose("custom", &file).unwrap(), url);
        let other = dir.join("other.mp4");
        std::fs::write(&other, b"\x00\x00\x00\x18ftypisom09876543210987654321").unwrap();
        let new_url = server.expose("custom", &other).unwrap();
        let new_uri = reqwest::Url::parse(&new_url).unwrap().path().to_string();
        assert_ne!(new_url, url);
        assert!(String::from_utf8_lossy(&request(&server, &uri, "")).starts_with("HTTP/1.1 404"));
        assert!(
            String::from_utf8_lossy(&request(&server, &new_uri, "")).starts_with("HTTP/1.1 200")
        );
        server.revoke("custom");
        assert!(
            String::from_utf8_lossy(&request(&server, &new_uri, "")).starts_with("HTTP/1.1 404")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
