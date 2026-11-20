//! Только кадры выбранной пользователем сцены. Loopback + случайный URL;
//! пути и произвольный захват рабочего стола не поддерживаются.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Frames { sequence: u64, jpeg: Vec<u8>, active: bool }
type Shared = Arc<(Mutex<Frames>, Condvar)>;
type Registry = Arc<Mutex<HashMap<String, Weak<(Mutex<Frames>, Condvar)>>>>;

#[derive(Clone)]
pub struct Publisher { id: String, shared: Shared, registry: Registry }

pub struct SceneServer { port: u16, secret: String, registry: Registry, shutdown: Arc<AtomicBool> }

fn random_hex() -> Result<String, String> {
    let mut b = [0u8; 24];
    getrandom::fill(&mut b).map_err(|e| format!("не удалось создать адрес сцены: {e}"))?;
    Ok(hex::encode(b))
}

impl SceneServer {
    pub fn new() -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("не удалось открыть поток сцены: {e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let secret = random_hex()?;
        let registry: Registry = Arc::new(Mutex::new(HashMap::new()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let (token, streams, stopped) = (secret.clone(), registry.clone(), shutdown.clone());
        std::thread::Builder::new().name("omnispec-scene-stream".into()).spawn(move || {
            let active = Arc::new(AtomicUsize::new(0));
            while !stopped.load(Ordering::Acquire) {
                let stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(25)); continue;
                    }
                    Err(_) => break,
                };
                if active.fetch_add(1, Ordering::AcqRel) >= 4 {
                    active.fetch_sub(1, Ordering::AcqRel); continue;
                }
                let (streams, token, count) = (streams.clone(), token.clone(), active.clone());
                if std::thread::Builder::new().name("omnispec-scene-client".into()).spawn(move || {
                    struct Guard(Arc<AtomicUsize>);
                    impl Drop for Guard { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::AcqRel); } }
                    let _guard = Guard(count);
                    let _ = serve(stream, port, &token, &streams);
                }).is_err() { active.fetch_sub(1, Ordering::AcqRel); }
            }
        }).map_err(|e| format!("не удалось запустить поток сцены: {e}"))?;
        Ok(Self { port, secret, registry, shutdown })
    }

    /// Старая сцена остаётся живой, пока новая получает первый кадр и настройки
    /// не записаны. Каждый URL отзывается независимо.
    pub fn begin(&self) -> Result<(Publisher, String), String> {
        let id = random_hex()?;
        let shared: Shared = Arc::new((Mutex::new(Frames { active: true, ..Frames::default() }), Condvar::new()));
        self.registry.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), Arc::downgrade(&shared));
        Ok((Publisher { id: id.clone(), shared, registry: self.registry.clone() },
            format!("http://127.0.0.1:{}/{}/{}.mjpeg", self.port, self.secret, id)))
    }
}

impl Drop for SceneServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        let frames: Vec<_> = self.registry.lock().unwrap_or_else(|e| e.into_inner())
            .drain().filter_map(|(_, shared)| shared.upgrade()).collect();
        for shared in frames {
            let (lock, cv) = &*shared;
            let mut frame = lock.lock().unwrap_or_else(|e| e.into_inner());
            frame.active = false; frame.jpeg.clear(); cv.notify_all();
        }
    }
}

impl Publisher {
    pub fn publish(&self, jpeg: Vec<u8>) {
        if jpeg.len() < 4 || jpeg.len() > 4 * 1024 * 1024 || !jpeg.starts_with(b"\xff\xd8") { return; }
        let (lock, cv) = &*self.shared;
        let mut frame = lock.lock().unwrap_or_else(|e| e.into_inner());
        if !frame.active { return; }
        frame.jpeg = jpeg;
        frame.sequence = frame.sequence.wrapping_add(1);
        cv.notify_all();
    }
    /// Захват мог завершиться после первого кадра, но до записи настроек.
    pub fn is_open(&self) -> bool {
        let (lock, _) = &*self.shared;
        lock.lock().unwrap_or_else(|e| e.into_inner()).active
    }
    pub fn wait_first(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let (lock, cv) = &*self.shared;
        let mut frame = lock.lock().unwrap_or_else(|e| e.into_inner());
        while frame.active && frame.sequence == 0 {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else { break; };
            let (next, _) = cv.wait_timeout(frame, left).unwrap_or_else(|e| e.into_inner());
            frame = next;
        }
        frame.active && frame.sequence > 0
    }
    pub fn close(&self) {
        self.registry.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.id);
        let (lock, cv) = &*self.shared;
        let mut frame = lock.lock().unwrap_or_else(|e| e.into_inner());
        frame.active = false; frame.jpeg.clear(); cv.notify_all();
    }
}

fn reply(stream: &mut TcpStream, status: &str) -> std::io::Result<()> {
    stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes())
}

fn serve(mut stream: TcpStream, port: u16, secret: &str, registry: &Registry) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 1024];
    while raw.len() < 16 * 1024 && !raw.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut buf)?; if n == 0 { return Ok(()); } raw.extend_from_slice(&buf[..n]);
    }
    if raw.len() >= 16 * 1024 { return reply(&mut stream, "431 Request Header Fields Too Large"); }
    let Ok(text) = std::str::from_utf8(&raw) else { return reply(&mut stream, "400 Bad Request"); };
    let mut lines = text.split("\r\n");
    let mut start = lines.next().unwrap_or("").split_whitespace();
    let (Some(method), Some(uri), Some(version)) = (start.next(), start.next(), start.next()) else { return reply(&mut stream, "400 Bad Request"); };
    if method != "GET" || !version.starts_with("HTTP/1.") || start.next().is_some() { return reply(&mut stream, "405 Method Not Allowed"); }
    let mut hosts = lines.filter_map(|line| line.split_once(':')).filter(|(key,_)| key.eq_ignore_ascii_case("host")).map(|(_,v)| v.trim());
    if hosts.next() != Some(format!("127.0.0.1:{port}").as_str()) || hosts.next().is_some() { return reply(&mut stream, "403 Forbidden"); }
    let prefix = format!("/{secret}/");
    let Some(id) = uri.strip_prefix(&prefix).and_then(|s| s.strip_suffix(".mjpeg")) else { return reply(&mut stream, "404 Not Found"); };
    if id.len() != 48 || !id.bytes().all(|c| c.is_ascii_hexdigit()) { return reply(&mut stream, "404 Not Found"); }
    let shared = registry.lock().unwrap_or_else(|e| e.into_inner()).get(id).and_then(Weak::upgrade);
    let Some(shared) = shared else { return reply(&mut stream, "404 Not Found"); };
    let (lock, cv) = &*shared;
    let frame = lock.lock().unwrap_or_else(|e| e.into_inner());
    if !frame.active { drop(frame); return reply(&mut stream, "404 Not Found"); }
    drop(frame);
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=omnispecframe\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n")?;
    let mut last = 0;
    let mut frame = lock.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        while frame.active && frame.sequence == last {
            let (next, timeout) = cv.wait_timeout(frame, Duration::from_secs(5)).unwrap_or_else(|e| e.into_inner());
            frame = next;
            // Повтор последнего кадра обнаружит закрывшуюся вкладку даже у
            // статичной сцены, не превращая её в занятый навсегда слот.
            if timeout.timed_out() && !frame.jpeg.is_empty() { break; }
        }
        if !frame.active { return Ok(()); }
        last = frame.sequence;
        let jpeg = frame.jpeg.clone();
        drop(frame);
        stream.write_all(format!("--omnispecframe\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n", jpeg.len()).as_bytes())?;
        stream.write_all(&jpeg)?;
        stream.write_all(b"\r\n")?;
        stream.flush()?;
        frame = lock.lock().unwrap_or_else(|e| e.into_inner());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;
    fn request(addr: &str, path: &str, host: &str) -> std::io::BufReader<TcpStream> {
        let mut stream = TcpStream::connect(addr).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        write!(stream, "GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
        std::io::BufReader::new(stream)
    }
    fn status(reader: &mut std::io::BufReader<TcpStream>) -> String {
        let mut line = String::new(); reader.read_line(&mut line).unwrap(); line
    }
    #[test]
    fn replacement_and_failure_preserve_previous_stream_until_commit() {
        let server = SceneServer::new().unwrap();
        let (first, url) = server.begin().unwrap();
        assert!(first.is_open());
        let addr = format!("127.0.0.1:{}", server.port);
        let path = url.strip_prefix(&format!("http://{addr}")).unwrap();
        first.publish(vec![0xff,0xd8,1,2,0xff,0xd9]);
        assert!(first.wait_first(Duration::from_secs(1)));
        let mut reader = request(&addr, path, &addr);
        assert_eq!(status(&mut reader), "HTTP/1.1 200 OK\r\n");
        let (failed, _) = server.begin().unwrap();
        assert!(!failed.wait_first(Duration::from_millis(10)));
        failed.close();
        assert!(first.wait_first(Duration::from_millis(10)), "failed candidate must not revoke old scene");
        let (second, next_url) = server.begin().unwrap();
        let next_path = next_url.strip_prefix(&format!("http://{addr}")).unwrap();
        second.publish(vec![0xff,0xd8,5,6,0xff,0xd9]);
        assert!(second.wait_first(Duration::from_secs(1)));
        assert!(first.wait_first(Duration::from_millis(10)), "old scene stays active before commit");
        first.close(); // commit
        assert!(!first.is_open());
        assert!(second.is_open());
        assert_eq!(status(&mut request(&addr, path, &addr)), "HTTP/1.1 404 Not Found\r\n");
        assert_eq!(status(&mut request(&addr, next_path, &addr)), "HTTP/1.1 200 OK\r\n");
        assert_eq!(status(&mut request(&addr, next_path, "example.com")), "HTTP/1.1 403 Forbidden\r\n");
        assert_eq!(status(&mut request(&addr, "/not-a-secret/invalid.mjpeg", &addr)), "HTTP/1.1 404 Not Found\r\n");
        second.close();
    }
}
