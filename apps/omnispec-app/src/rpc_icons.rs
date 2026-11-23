//! Публичные картинки для Discord RPC. Локальные файлы никогда не отправляются
//! без отдельного согласия `discord_upload_local_icon` в настройках.
//!
//! Сначала ищем исходную картинку Modrinth/CurseForge и сравниваем её с
//! локальной побайтно. Свои изображения по желанию пользователя уменьшаем,
//! перекодируем без метаданных и размещаем на временном публичном tmpfile.link.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Component, Path};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use omnispec_core::curseforge::CurseForge;
use omnispec_core::instances::InstanceMeta;
use omnispec_core::modrinth::{Modrinth, SearchQuery};
use omnispec_core::net::Http;
use omnispec_core::paths::Paths;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const CACHE_SECS: u64 = 6 * 24 * 60 * 60; // хостинг заявляет семь суток
const TF_UPLOAD: &str = "https://tmpfile.link/api/upload";

pub struct LocalImage {
    bytes: Vec<u8>,
    hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedImage {
    url: String,
    uploaded: bool,
    expires_at: u64,
}

type IconCache = HashMap<String, CachedImage>;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0)
}

fn cache_file(paths: &Paths) -> std::path::PathBuf {
    paths.cache().join("discord-icon-cache.json")
}

fn read_cache(paths: &Paths) -> IconCache {
    std::fs::read(cache_file(paths)).ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}

/// Читаем только файл внутри папки сборки, не выходя через `..` или symlink.
pub fn read_local(paths: &Paths, meta: &InstanceMeta) -> Result<Option<LocalImage>, String> {
    let Some(icon) = meta.icon.as_deref() else { return Ok(None); };
    let path = Path::new(icon);
    if path.components().count() != 1 || !matches!(path.components().next(), Some(Component::Normal(_))) {
        return Ok(None);
    }
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") {
        return Ok(None);
    }
    let dir = paths.instance_dir(&meta.id);
    let Ok(root) = dir.canonicalize() else { return Ok(None); };
    let Ok(file) = dir.join(path).canonicalize() else { return Ok(None); };
    if !file.starts_with(&root) || !file.is_file() {
        return Err("иконка должна находиться внутри папки сборки".into());
    }
    let size = std::fs::metadata(&file).map_err(|e| e.to_string())?.len();
    if size == 0 || size > MAX_FILE_BYTES {
        return Err("файл иконки пустой или больше 16 МБ".into());
    }
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err("иконка больше 16 МБ".into()); }
    let hash = hex::encode(Sha256::digest(&bytes));
    Ok(Some(LocalImage { bytes, hash }))
}

/// Кэш загруженного изображения не используется при отозванном разрешении.
pub fn cached(paths: &Paths, image: &LocalImage, allow_upload: bool) -> Option<String> {
    let entry = read_cache(paths).get(&image.hash)?.clone();
    if entry.expires_at <= now() || (entry.uploaded && !allow_upload)
        || !crate::presence::valid_image_url(&entry.url)
    {
        return None;
    }
    Some(entry.url)
}

pub fn remember(paths: &Paths, image: &LocalImage, url: &str, uploaded: bool) {
    if !crate::presence::valid_image_url(url) { return; }
    let mut cache = read_cache(paths);
    cache.retain(|_, entry| entry.expires_at > now());
    if cache.len() >= 256 { cache.clear(); }
    cache.insert(image.hash.clone(), CachedImage {
        url: url.to_string(), uploaded, expires_at: now().saturating_add(CACHE_SECS),
    });
    let path = cache_file(paths);
    if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
    if let Ok(data) = serde_json::to_vec(&cache) { let _ = std::fs::write(path, data); }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Source { Modrinth, CurseForge }

fn source_project(meta: &InstanceMeta) -> Option<(Source, String)> {
    let url = reqwest::Url::parse(meta.source_url.as_deref()?).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() { return None; }
    let parts: Vec<_> = url.path_segments()?.collect();
    let (source, slug) = match (url.host_str()?, parts.as_slice()) {
        ("modrinth.com" | "www.modrinth.com", ["modpack", slug, ..]) => (Source::Modrinth, *slug),
        ("curseforge.com" | "www.curseforge.com", ["minecraft", "modpacks", slug, ..]) => (Source::CurseForge, *slug),
        _ => return None,
    };
    if slug.is_empty() || slug.len() > 100 || !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    Some((source, slug.to_string()))
}

fn source_image_url_allowed(source: Source, value: &str) -> bool {
    if !crate::presence::valid_image_url(value) { return false; }
    let Ok(url) = reqwest::Url::parse(value) else { return false; };
    match (source, url.host_str().unwrap_or("")) {
        (Source::Modrinth, "cdn.modrinth.com") => true,
        (Source::CurseForge, host) if host == "forgecdn.net" || host.ends_with(".forgecdn.net") => true,
        _ => false,
    }
}

/// URL официального проекта показываем только если байты совпадают с текущей
/// иконкой. Иначе пользователь мог заменить её на свою картинку под тем же именем.
pub async fn find_public(
    http: &Http, modrinth: &Modrinth, curseforge: &CurseForge,
    meta: &InstanceMeta, image: &LocalImage,
) -> Option<String> {
    let (source, slug) = source_project(meta)?;
    let lookup = async {
        match source {
            Source::Modrinth => modrinth.project(&slug).await.ok()?.icon_url,
            Source::CurseForge => {
                if slug.chars().all(|c| c.is_ascii_digit()) {
                    curseforge.project(&slug).await.ok()?.icon_url
                } else {
                    let result = curseforge.search(&SearchQuery {
                        query: slug.replace('-', " "), project_type: "modpack".into(),
                        game_version: None, loader: None, categories: Vec::new(),
                        limit: 50, offset: 0, sort: "relevance".into(),
                    }).await.ok()?;
                    result.hits.into_iter().find(|hit| hit.slug.eq_ignore_ascii_case(&slug))?.icon_url
                }
            }
        }
    };
    let url = tokio::time::timeout(Duration::from_secs(12), lookup).await.ok()??;
    if !source_image_url_allowed(source, &url) { return None; }
    let response = http.inner().get(&url).timeout(Duration::from_secs(12)).send().await.ok()?;
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > MAX_FILE_BYTES) {
        return None;
    }
    let mut stream = response.bytes_stream();
    let mut data = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if data.len().saturating_add(chunk.len()) as u64 > MAX_FILE_BYTES { return None; }
        data.extend_from_slice(&chunk);
    }
    (data == image.bytes).then_some(url)
}

fn png_thumbnail(image: &LocalImage) -> Result<Vec<u8>, String> {
    let mut reader = image::ImageReader::new(Cursor::new(&image.bytes))
        .with_guessed_format().map_err(|e| format!("не удалось прочитать иконку: {e}"))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let original = reader.decode().map_err(|e| format!("не удалось открыть иконку: {e}"))?;
    let thumb = original.thumbnail(256, 256);
    let mut data = Cursor::new(Vec::new());
    // Новая PNG не содержит EXIF, имя исходного файла тоже не передаём.
    thumb.write_to(&mut data, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(data.into_inner())
}

/// Прерываем ещё незавершённую отправку при отзыве согласия. Данные, уже
/// полученные сервером, отозвать нельзя — об этом предупреждаем в настройках.
pub async fn until_revoked<F: std::future::Future>(
    mut permission: tokio::sync::watch::Receiver<bool>,
    future: F,
) -> Option<F::Output> {
    if !*permission.borrow_and_update() { return None; }
    tokio::select! {
        biased;
        _ = async {
            loop {
                if permission.changed().await.is_err() || !*permission.borrow_and_update() { break; }
            }
        } => None,
        result = future => Some(result),
    }
}

/// Вызывается только после проверки актуального согласия пользователя.
pub async fn upload_temporary(http: &Http, image: &LocalImage) -> Result<String, String> {
    let png = png_thumbnail(image)?;
    let part = reqwest::multipart::Part::bytes(png)
        .file_name("instance-icon.png")
        .mime_str("image/png").map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part);
    let response = http.inner().post(TF_UPLOAD).multipart(form)
        .timeout(Duration::from_secs(25)).send().await
        .map_err(|e| format!("временный хостинг недоступен: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("временный хостинг вернул HTTP {}", response.status()));
    }
    let data: serde_json::Value = response.json().await.map_err(|_| "непонятный ответ временного хостинга".to_string())?;
    let url = data.get("downloadLinkEncoded").or_else(|| data.get("downloadLink"))
        .and_then(|v| v.as_str()).ok_or_else(|| "хостинг не вернул ссылку".to_string())?;
    let parsed = reqwest::Url::parse(url).map_err(|_| "хостинг вернул неверную ссылку".to_string())?;
    if parsed.host_str() != Some("d.tmpfile.link") || !crate::presence::valid_image_url(url) {
        return Err("хостинг вернул небезопасную ссылку".into());
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnispec_core::instances::Loader;

    fn meta() -> InstanceMeta {
        InstanceMeta { id: "sample".into(), renamed_from: None, renamed_froms: Vec::new(), name: "Sample".into(), mc_version: "1.21.1".into(),
            loader: Loader::Vanilla, created: 0, last_played: None, playtime_secs: 0,
            memory_mb: None, java_path: None, jvm_args: None, icon: None,
            notes: String::new(), version_override: None, source: "manual".into(), source_url: None,
            category: None, game_dir: None }
    }

    #[test]
    fn untrusted_project_urls_are_rejected() {
        let mut m = meta();
        m.source_url = Some("https://modrinth.com/modpack/example".into());
        assert_eq!(source_project(&m), Some((Source::Modrinth, "example".into())));
        m.source_url = Some("https://modrinth.com.evil.test/modpack/example".into());
        assert!(source_project(&m).is_none());
        assert!(!source_image_url_allowed(Source::Modrinth, "https://cdn.modrinth.com.evil.test/x"));
    }

    #[test]
    fn thumbnail_discards_original_metadata_and_limits_size() {
        let source = image::DynamicImage::new_rgba8(600, 400);
        let mut bytes = Cursor::new(Vec::new());
        source.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let original = LocalImage { bytes: bytes.into_inner(), hash: "x".into() };
        let png = png_thumbnail(&original).unwrap();
        let thumb = image::load_from_memory(&png).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (256, 171));
    }

    #[test]
    fn gif_icon_is_read_for_rpc_without_changing_the_original_bytes() {
        let root = std::env::temp_dir().join(format!("omnispec-rpc-gif-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        let mut m = meta();
        m.icon = Some("icon.gif".into());
        std::fs::create_dir_all(paths.instance_dir(&m.id)).unwrap();
        let gif = b"GIF89a-fixture";
        std::fs::write(paths.instance_dir(&m.id).join("icon.gif"), gif).unwrap();
        let local = read_local(&paths, &m).unwrap().unwrap();
        assert_eq!(local.bytes, gif);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[ignore = "требует живого Modrinth API"]
    async fn real_project_icon_matches_downloaded_bytes() {
        let root = std::env::temp_dir().join(format!("omnispec-rpc-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        let http = Http::new();
        let modrinth = Modrinth::new(http.clone());
        let curseforge = CurseForge::new(http.clone());
        let project = modrinth.project("fabulously-optimized").await.unwrap();
        let url = project.icon_url.unwrap();
        let bytes = http.get_bytes(&url).await.unwrap();
        let mut m = meta();
        m.icon = Some("icon.webp".into());
        m.source_url = Some("https://modrinth.com/modpack/fabulously-optimized".into());
        std::fs::create_dir_all(paths.instance_dir(&m.id)).unwrap();
        std::fs::write(paths.instance_dir(&m.id).join("icon.webp"), &bytes).unwrap();
        let local = read_local(&paths, &m).unwrap().unwrap();
        assert_eq!(find_public(&http, &modrinth, &curseforge, &m, &local).await.as_deref(), Some(url.as_str()));
        let changed = LocalImage { bytes: vec![0, 1, 2], hash: hex::encode(Sha256::digest([0, 1, 2])) };
        assert!(find_public(&http, &modrinth, &curseforge, &m, &changed).await.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    #[ignore = "требует живого CurseForge API"]
    async fn real_curseforge_slug_and_id_match_downloaded_bytes() {
        let root = std::env::temp_dir().join(format!("omnispec-rpc-cf-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        let http = Http::new();
        let modrinth = Modrinth::new(http.clone());
        let curseforge = CurseForge::new(http.clone());
        let page = curseforge.search(&omnispec_core::modrinth::SearchQuery {
            query: "all the mods 10".into(), project_type: "modpack".into(), limit: 10, ..Default::default()
        }).await.unwrap();
        let project = page.hits.into_iter().find(|h| h.slug == "all-the-mods-10").unwrap();
        let url = project.icon_url.unwrap();
        let bytes = http.get_bytes(&url).await.unwrap();
        let mut m = meta();
        m.icon = Some("icon.png".into());
        m.source = "curseforge".into();
        std::fs::create_dir_all(paths.instance_dir(&m.id)).unwrap();
        std::fs::write(paths.instance_dir(&m.id).join("icon.png"), bytes).unwrap();
        let local = read_local(&paths, &m).unwrap().unwrap();
        for project_name in [project.slug.as_str(), project.project_id.as_str()] {
            m.source_url = Some(format!("https://www.curseforge.com/minecraft/modpacks/{project_name}"));
            assert_eq!(find_public(&http, &modrinth, &curseforge, &m, &local).await.as_deref(), Some(url.as_str()));
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    #[ignore = "публикует синтетическую картинку на временном хостинге"]
    async fn temporary_host_returns_a_public_png() {
        let img = image::DynamicImage::new_rgb8(8, 8);
        let mut buffer = Cursor::new(Vec::new());
        img.write_to(&mut buffer, image::ImageFormat::Png).unwrap();
        let local = LocalImage { bytes: buffer.into_inner(), hash: "fixture".into() };
        let http = Http::new();
        let url = upload_temporary(&http, &local).await.unwrap();
        assert!(url.starts_with("https://d.tmpfile.link/"));
        let published = http.get_bytes(&url).await.unwrap();
        assert!(image::load_from_memory(&published).is_ok());
    }

    #[tokio::test]
    async fn revoking_permission_cancels_an_unfinished_upload() {
        let (sender, receiver) = tokio::sync::watch::channel(true);
        let upload = tokio::spawn(async move {
            until_revoked(receiver, async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                42
            }).await
        });
        tokio::task::yield_now().await;
        sender.send_replace(false);
        assert!(tokio::time::timeout(Duration::from_secs(1), upload).await.unwrap().unwrap().is_none());
        let (_, denied) = tokio::sync::watch::channel(false);
        assert!(until_revoked(denied, async { 42 }).await.is_none());
    }

    #[test]
    fn uploaded_cache_requires_active_consent() {
        let dir = std::env::temp_dir().join(format!("omnispec-rpc-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = Paths::new(&dir).unwrap();
        let image = LocalImage { bytes: vec![1], hash: "test-hash".into() };
        let url = "https://d.tmpfile.link/public/icon.png";
        remember(&paths, &image, url, true);
        assert_eq!(cached(&paths, &image, true).as_deref(), Some(url));
        assert!(cached(&paths, &image, false).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
