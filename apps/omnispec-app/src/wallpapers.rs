//! Безопасный импорт собственных изображений, GIF и видеофонов.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

const MAX_MEDIA: u64 = 512 * 1024 * 1024;
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize)]
pub struct Media {
    pub path: String,
    /// image | gif | video
    pub kind: String,
    /// Потоковый loopback URL только для видео; для картинок — asset protocol.
    pub src: Option<String>,
}

/// Только новые файлы: даже одинаковые имена в одном пакетном импорте никогда
/// не перезапишут старый скин или обои.
pub fn create_unique(
    dir: &Path,
    stem: &str,
    ext: &str,
) -> Result<(PathBuf, std::fs::File), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("не удалось создать папку: {e}"))?;
    let safe: String = stem
        .chars()
        .take(64)
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = if safe.is_empty() { "file" } else { &safe };
    for _ in 0..100 {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let serial = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!("{safe}-{nanos:x}-{serial:x}.{ext}"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("не удалось создать файл: {e}")),
        }
    }
    Err("не удалось подобрать уникальное имя файла".into())
}

/// Проверяем расширение и сигнатуру: HTML/JS не могут открыться как медиа.
fn sniff(data: &[u8]) -> Option<(&'static str, &'static str)> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(("image", "png"));
    }
    if data.starts_with(b"\xff\xd8\xff") {
        return Some(("image", "jpg"));
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some(("image", "webp"));
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some(("gif", "gif"));
    }
    if data.len() >= 12 && &data[4..8] == b"ftyp" {
        return Some(("video", "mp4"));
    }
    if data.starts_with(b"\x1a\x45\xdf\xa3") {
        return Some(("video", "webm"));
    }
    None
}

pub fn media_at(path: &Path) -> Result<Media, String> {
    let path = path
        .canonicalize()
        .map_err(|_| "файл обоев не найден".to_string())?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("не удалось открыть обои: {e}"))?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_MEDIA {
        return Err("файл обоев пустой или больше 512 МБ".into());
    }
    let mut head = [0u8; 32];
    let count = std::fs::File::open(&path)
        .and_then(|mut f| f.read(&mut head))
        .map_err(|e| format!("не удалось прочитать обои: {e}"))?;
    let (kind, format) = sniff(&head[..count])
        .ok_or_else(|| "нужен PNG, JPG, WebP, GIF, MP4 или WebM".to_string())?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let matches =
        ext == format || (format == "jpg" && ext == "jpeg") || (format == "mp4" && ext == "m4v");
    if !matches {
        return Err("расширение файла не соответствует его содержимому".into());
    }
    Ok(Media {
        path: path.to_string_lossy().into_owned(),
        kind: kind.into(),
        src: None,
    })
}

pub fn copy_media(source: &Path, dir: &Path) -> Result<String, String> {
    let media = media_at(source)?;
    let original = Path::new(&media.path);
    let ext = original
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    let (target, mut output) = create_unique(dir, "custom", &ext)?;
    let result = (|| -> Result<(), String> {
        let input =
            std::fs::File::open(original).map_err(|e| format!("не удалось открыть обои: {e}"))?;
        let size = std::io::copy(&mut input.take(MAX_MEDIA + 1), &mut output)
            .map_err(|e| format!("не удалось скопировать обои: {e}"))?;
        if size == 0 || size > MAX_MEDIA {
            return Err("файл обоев пустой или больше 512 МБ".into());
        }
        output.flush().map_err(|e| e.to_string())?;
        Ok(())
    })();
    drop(output);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&target);
        return Err(error);
    }
    if let Err(error) = media_at(&target) {
        let _ = std::fs::remove_file(&target);
        return Err(error);
    }
    Ok(target
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned())
}

/// Только один компонент имени; старые custom.png/custom.jpg остаются доступны.
pub fn custom_media(dir: &Path, name: &str) -> Result<Media, String> {
    let p = Path::new(name);
    if p.components().count() != 1 || !matches!(p.components().next(), Some(Component::Normal(_))) {
        return Err("недопустимое имя файла обоев".into());
    }
    let root = dir
        .canonicalize()
        .map_err(|_| "папка обоев не найдена".to_string())?;
    let file = dir
        .join(p)
        .canonicalize()
        .map_err(|_| "файл обоев не найден".to_string())?;
    if !file.starts_with(root) {
        return Err("файл находится вне папки обоев".into());
    }
    media_at(&file)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => public_v4(a),
        IpAddr::V6(a) => public_v6(a),
    }
}
fn public_v4(a: Ipv4Addr) -> bool {
    let o = a.octets();
    !(a.is_unspecified()
        || a.is_loopback()
        || a.is_private()
        || a.is_link_local()
        || a.is_multicast()
        || a.is_broadcast()
        || o[0] == 0
        || o[0] >= 224
        || (o[0] == 100 && (64..=127).contains(&o[1]))
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19)))
}
fn public_v6(a: Ipv6Addr) -> bool {
    if let Some(v4) = a.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let s = a.segments();
    !(a.is_unspecified()
        || a.is_loopback()
        || a.is_multicast()
        || (s[0] & 0xfe00) == 0xfc00
        || (s[0] & 0xffc0) == 0xfe80)
}

/// Каждое перенаправление проверяется заново; DNS закреплён на проверенных
/// публичных IP, без автоматического перехода к localhost/частной сети.
async fn direct_response(mut url: reqwest::Url) -> Result<reqwest::Response, String> {
    for redirects in 0..=5 {
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("нужна публичная HTTP(S)-ссылка без логина и пароля".into());
        }
        let host = url
            .host_str()
            .ok_or_else(|| "в ссылке нет адреса сервера".to_string())?;
        if host.eq_ignore_ascii_case("localhost")
            || host.to_ascii_lowercase().ends_with(".localhost")
        {
            return Err("локальные и частные адреса для загрузки не разрешены".into());
        }
        let port = url
            .port_or_known_default()
            .ok_or_else(|| "неизвестный порт".to_string())?;
        let addresses: Vec<_> = tokio::time::timeout(
            Duration::from_secs(12),
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| "сервер не отвечает".to_string())?
        .map_err(|e| format!("не удалось найти сервер: {e}"))?
        .collect();
        if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
            return Err("локальные и частные адреса для загрузки не разрешены".into());
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!(
                "OmniSpec/",
                env!("CARGO_PKG_VERSION"),
                " (+https://github.com/Shokydo/OmniSpec)"
            ))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|e| e.to_string())?;
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| format!("не удалось загрузить обои: {e}"))?;
        if response.status().is_redirection() {
            if redirects == 5 {
                return Err("слишком много перенаправлений".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "сервер не указал адрес перенаправления".to_string())?;
            url = url
                .join(location)
                .map_err(|_| "неверный адрес перенаправления".to_string())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("сервер вернул HTTP {}", response.status()));
        }
        return Ok(response);
    }
    Err("слишком много перенаправлений".into())
}

/// Только метаданные самой страницы Imgur. В привилегированный WebView HTML
/// не попадает; найденный CDN-адрес скачивается тем же проверенным способом.
fn imgur_metadata_media(html: &str) -> Option<reqwest::Url> {
    use std::sync::OnceLock;
    static TAG: OnceLock<regex::Regex> = OnceLock::new();
    static ATTR: OnceLock<regex::Regex> = OnceLock::new();
    let tags = TAG.get_or_init(|| regex::Regex::new(r"(?is)<meta\b[^>]{0,4096}>").unwrap());
    let attrs = ATTR.get_or_init(|| regex::Regex::new(
        r#"(?is)\b(property|name|content)\s*=\s*(?:"([^"]*)"|'([^']*)')"#
    ).unwrap());
    let mut candidates: Vec<(u8, reqwest::Url)> = Vec::new();
    for tag in tags.find_iter(html) {
        let mut property = "";
        let mut content = "";
        for capture in attrs.captures_iter(tag.as_str()) {
            let value = capture.get(2).or_else(|| capture.get(3)).map_or("", |m| m.as_str());
            match capture.get(1).map_or("", |m| m.as_str()).to_ascii_lowercase().as_str() {
                "property" | "name" => property = value,
                "content" => content = value,
                _ => {}
            }
        }
        let priority = match property.to_ascii_lowercase().as_str() {
            "og:video:secure_url" => 0,
            "og:video" => 1,
            "og:image:secure_url" => 2,
            "og:image" => 3,
            _ => continue,
        };
        // Не доверяем ссылкам на другие серверы, учётным данным, портам или
        // внешним ресурсам без поддерживаемого расширения. Query не нужен.
        let Ok(mut url) = reqwest::Url::parse(&content.replace("&amp;", "&")) else { continue; };
        if url.scheme() != "https" || url.host_str() != Some("i.imgur.com")
            || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
            continue;
        }
        let ext = url.path().rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "mp4" | "m4v" | "webm") { continue; }
        url.set_query(None);
        url.set_fragment(None);
        candidates.push((priority, url));
    }
    candidates.into_iter().min_by_key(|(priority, _)| *priority).map(|(_, url)| url)
}

fn is_imgur_html(response: &reqwest::Response) -> bool {
    let host = response.url().host_str().unwrap_or("");
    matches!(host, "imgur.com" | "www.imgur.com" | "m.imgur.com" | "i.imgur.com")
        && response.headers().get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("text/html"))
}

async fn resolve_imgur_page(response: reqwest::Response) -> Result<reqwest::Response, String> {
    if !is_imgur_html(&response) { return Ok(response); }
    const MAX_PAGE: usize = 1024 * 1024;
    if response.content_length().is_some_and(|n| n > MAX_PAGE as u64) {
        return Err("страница Imgur слишком большая".into());
    }
    let mut stream = response.bytes_stream();
    let mut html = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("ошибка загрузки страницы Imgur: {e}"))?;
        if html.len().saturating_add(chunk.len()) > MAX_PAGE {
            return Err("страница Imgur слишком большая".into());
        }
        html.extend_from_slice(&chunk);
    }
    let text = std::str::from_utf8(&html).map_err(|_| "не удалось прочитать страницу Imgur".to_string())?;
    let media = imgur_metadata_media(text).ok_or_else(||
        "на странице Imgur не найден поддерживаемый файл. Попробуй прямую ссылку на изображение или видео".to_string())?;
    direct_response(media).await
}

pub async fn download_media(value: &str, dir: &Path) -> Result<String, String> {
    let url =
        reqwest::Url::parse(value.trim()).map_err(|_| "неверная ссылка на файл".to_string())?;
    let response = resolve_imgur_page(direct_response(url).await?).await?;
    if response.content_length().is_some_and(|n| n > MAX_MEDIA) {
        return Err("файл больше 512 МБ".into());
    }
    let mut stream = response.bytes_stream();
    let mut head = Vec::new();
    let mut total = 0u64;
    let mut output: Option<(PathBuf, tokio::fs::File)> = None;
    let result = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("ошибка загрузки: {e}"))?;
            total = total.saturating_add(chunk.len() as u64);
            if total > MAX_MEDIA {
                return Err("файл больше 512 МБ".to_string());
            }
            if let Some((_, file)) = output.as_mut() {
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("ошибка записи: {e}"))?;
            } else {
                head.extend_from_slice(&chunk);
                if head.len() >= 32 {
                    let (_, ext) = sniff(&head).ok_or_else(|| {
                        "ссылка ведёт не на PNG, JPG, WebP, GIF, MP4 или WebM".to_string()
                    })?;
                    let (path, file) = create_unique(dir, "custom", ext)?;
                    output = Some((path, tokio::fs::File::from_std(file)));
                    output
                        .as_mut()
                        .unwrap()
                        .1
                        .write_all(&head)
                        .await
                        .map_err(|e| format!("ошибка записи: {e}"))?;
                    head.clear();
                }
            }
        }
        if let Some((_, file)) = output.as_mut() {
            file.flush()
                .await
                .map_err(|e| format!("ошибка записи: {e}"))?;
            Ok(())
        } else {
            Err("файл пустой или ссылка ведёт не на поддерживаемое медиа".into())
        }
    }
    .await;
    if let Err(error) = result {
        if let Some((path, file)) = output.take() {
            drop(file);
            let _ = std::fs::remove_file(path);
        }
        return Err(error);
    }
    let (path, file) = output.unwrap();
    drop(file);
    if let Err(error) = media_at(&path) {
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "omnispec-wall-test-{label}-{}-{}",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn write(path: &Path, value: &[u8]) {
        std::fs::write(path, value).unwrap();
    }
    #[test]
    fn media_and_unique_copy_do_not_replace_previous_files() {
        let root = temp_dir("media");
        let source = root.join("original.gif");
        write(&source, b"GIF89a000000000000000000000000000000");
        let dir = root.join("wallpapers");
        let a = copy_media(&source, &dir).unwrap();
        let b = copy_media(&source, &dir).unwrap();
        assert_ne!(a, b);
        assert_eq!(custom_media(&dir, &a).unwrap().kind, "gif");
        assert!(custom_media(&dir, "../original.gif").is_err());
        write(&root.join("fake.mp4"), b"<html>not a movie</html>");
        assert!(media_at(&root.join("fake.mp4")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_private_and_mapped_addresses() {
        for raw in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "192.168.1.2",
            "100.64.1.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!public_ip(raw.parse().unwrap()), "{raw}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }
    #[test]
    fn imgur_metadata_is_whitelisted_and_preserves_animation() {
        let html = r#"<meta content='https://i.imgur.com/Example.jpg?fb' property='og:image'>
            <meta property="og:video" content="https://i.imgur.com/Animated.gif?noredirect&amp;x=1">"#;
        assert_eq!(imgur_metadata_media(html).unwrap().as_str(), "https://i.imgur.com/Animated.gif");
        for malicious in [
            "https://i.imgur.com.evil.invalid/a.gif", "https://i.imgur.com@127.0.0.1/a.gif",
            "http://i.imgur.com/a.gif", "https://i.imgur.com:444/a.gif",
            "https://i.imgur.com/a.gifv", "file:///etc/passwd",
        ] {
            let html = format!(r#"<meta property="og:image" content="{malicious}">"#);
            assert!(imgur_metadata_media(&html).is_none(), "{malicious}");
        }
        assert!(imgur_metadata_media("<script>alert(1)</script>").is_none());
    }

    // Opt-in live test: never makes the regular unit suite depend on network.
    #[tokio::test]
    async fn live_imgur_single_image_and_gif() {
        if std::env::var("OMNISPEC_TEST_IMGUR_NETWORK").is_err() { return; }
        let root = temp_dir("imgur-network");
        for (url, kind) in [
            ("https://imgur.com/YobcUsr", "image"),
            ("https://imgur.com/5yS6GCZ", "gif"),
            ("https://i.imgur.com/5yS6GCZ.gifv", "gif"),
            ("https://i.imgur.com/5yS6GCZ.mp4", "video"),
        ] {
            let name = download_media(url, &root).await.unwrap_or_else(|e| panic!("{url}: {e}"));
            assert_eq!(custom_media(&root, &name).unwrap().kind, kind, "{url}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn direct_links_do_not_access_local_addresses() {
        let root = temp_dir("private");
        for url in [
            "http://127.0.0.1:9/movie.mp4",
            "http://localhost:9/movie.mp4",
            "file:///etc/passwd",
            "http://user:pass@example.com/image.gif",
        ] {
            assert!(download_media(url, &root).await.is_err(), "{url}");
        }
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}
