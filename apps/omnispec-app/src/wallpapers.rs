//! Безопасное чтение локальной библиотеки Wallpaper Engine и медиафонов.
//! Workshop-проекты не выполняются в WebView: только их метаданные, превью и
//! обычное видео. Сцены/web/application можно отдельно открыть в официальном WE.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

const MAX_MEDIA: u64 = 512 * 1024 * 1024;
const MAX_MANIFEST: u64 = 256 * 1024;
const MAX_PREVIEW: u64 = 8 * 1024 * 1024;
const MAX_PROJECTS: usize = 1500;
const MAX_DIRECTORIES: usize = 12_000;
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize)]
pub struct Media {
    pub path: String,
    /// image | gif | video
    pub kind: String,
    /// Потоковый loopback URL только для видео; для картинок — asset protocol.
    pub src: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Project {
    pub directory: String,
    pub title: String,
    /// video | scene | web | application | unknown
    pub kind: String,
    pub workshop_id: Option<String>,
    pub preview: Option<String>,
    /// Можно ли применить как фон непосредственно в OmniSpec.
    pub playable: bool,
}

#[derive(Debug, Serialize)]
pub struct Library {
    pub projects: Vec<Project>,
    pub searched: Vec<String>,
    pub engine: Option<String>,
    pub truncated: bool,
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

/// Проверяем не только расширение, но и сигнатуру: HTML/JS из Workshop нельзя
/// заставить открыться как картинку или видео в привилегированном окне Tauri.
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

fn valid_relative(dir: &Path, raw: &str) -> Option<PathBuf> {
    if raw.is_empty() || raw.len() > 4096 {
        return None;
    }
    // Файлы Workshop часто описаны Windows-разделителями даже в Linux.
    let normal = raw.replace('\\', "/");
    let path = Path::new(&normal);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return None;
    }
    let root = dir.canonicalize().ok()?;
    let file = root.join(path).canonicalize().ok()?;
    (file.starts_with(&root) && file.is_file()).then_some(file)
}

fn project_document(dir: &Path) -> Option<(PathBuf, Value)> {
    let dir = dir.canonicalize().ok()?;
    if !dir.is_dir() {
        return None;
    }
    let manifest = valid_relative(&dir, "project.json")?;
    if std::fs::metadata(&manifest).ok()?.len() > MAX_MANIFEST {
        return None;
    }
    let raw = std::fs::read_to_string(manifest).ok()?;
    let doc = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')).ok()?;
    if !doc.is_object() {
        return None;
    }
    Some((dir, doc))
}

fn workshop_id(doc: &Value, dir: &Path) -> Option<String> {
    let from_doc = doc.get("workshopid").and_then(|v| {
        v.as_str()
            .map(str::to_string)
            .or_else(|| v.as_u64().map(|n| n.to_string()))
    });
    let from_dir = dir.file_name().and_then(|s| s.to_str()).map(str::to_string);
    from_doc.into_iter().chain(from_dir).find(|s| {
        !s.is_empty() && s != "0" && s.len() <= 20 && s.bytes().all(|c| c.is_ascii_digit())
    })
}

pub fn project(dir: &Path) -> Option<Project> {
    let (dir, doc) = project_document(dir)?;
    let kind = doc
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_ascii_lowercase();
    let kind = if matches!(kind.as_str(), "video" | "scene" | "web" | "application") {
        kind
    } else {
        "unknown".into()
    };
    let title = doc
        .get("title")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| dir.file_name().and_then(|s| s.to_str()).unwrap_or("Обои"));
    let title: String = title.chars().take(200).collect();
    let preview = doc
        .get("preview")
        .and_then(Value::as_str)
        .and_then(|p| valid_relative(&dir, p))
        .filter(|p| {
            std::fs::metadata(p)
                .map(|m| m.len() > 0 && m.len() <= MAX_PREVIEW)
                .unwrap_or(false)
        })
        .filter(|p| {
            media_at(p)
                .map(|m| m.kind == "image" || m.kind == "gif")
                .unwrap_or(false)
        })
        .map(|p| p.to_string_lossy().into_owned());
    let playable = kind == "video" && project_media(&dir).is_ok();
    Some(Project {
        directory: dir.to_string_lossy().into_owned(),
        title,
        kind,
        workshop_id: workshop_id(&doc, &dir),
        preview,
        playable,
    })
}

pub fn project_media(dir: &Path) -> Result<Media, String> {
    let (dir, doc) = project_document(dir)
        .ok_or_else(|| "проект Wallpaper Engine не найден или повреждён".to_string())?;
    if doc
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase()
        != "video"
    {
        return Err("сцены, web и приложения нельзя встроить в OmniSpec; открой их отдельно через Wallpaper Engine".into());
    }
    let name = doc
        .get("file")
        .and_then(Value::as_str)
        .ok_or_else(|| "в проекте не указан видеофайл".to_string())?;
    let path = valid_relative(&dir, name)
        .ok_or_else(|| "видеофайл проекта не найден или выходит за его папку".to_string())?;
    let media = media_at(&path)?;
    if media.kind != "video" && media.kind != "gif" {
        return Err("проект не содержит поддерживаемого видео".into());
    }
    Ok(media)
}

// Минимальный разбор Valve KeyValues: строки, фигурные скобки, комментарии и
// экранированные обратные слэши. Поддерживаются старый и новый libraryfolders.vdf.
fn vdf_tokens(input: &str) -> Vec<String> {
    let mut chars = input.chars().peekable();
    let mut result = Vec::new();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                let mut s = String::new();
                while let Some(ch) = chars.next() {
                    if ch == '"' {
                        break;
                    }
                    if ch == '\\' {
                        match chars.peek().copied() {
                            Some('\\' | '"') => s.push(chars.next().unwrap()),
                            _ => s.push('\\'),
                        }
                    } else {
                        s.push(ch);
                    }
                }
                result.push(s);
            }
            '{' | '}' => result.push(c.to_string()),
            '/' if chars.peek() == Some(&'/') => {
                for ch in chars.by_ref() {
                    if ch == '\n' {
                        break;
                    }
                }
            }
            _ => {}
        }
        if result.len() > 100_000 {
            break;
        }
    }
    result
}

fn vdf_library_paths(input: &str) -> Vec<PathBuf> {
    let tokens = vdf_tokens(input);
    let mut paths = Vec::new();
    for pair in tokens.windows(2) {
        let key = &pair[0];
        let val = &pair[1];
        if (key.eq_ignore_ascii_case("path")
            || (!key.is_empty() && key.bytes().all(|b| b.is_ascii_digit())))
            && val != "{"
            && val != "}"
            && !val.is_empty()
        {
            paths.push(PathBuf::from(val));
        }
    }
    paths
}

#[cfg(windows)]
fn registry_steam_path() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let key: Vec<u16> = "Software\\Valve\\Steam\0".encode_utf16().collect();
    let name: Vec<u16> = "SteamPath\0".encode_utf16().collect();
    let mut data = vec![0u16; 32768];
    let mut len = (data.len() * 2) as u32;
    let code = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            data.as_mut_ptr().cast(),
            &mut len,
        )
    };
    if code != 0 {
        return None;
    }
    let end = data.iter().position(|x| *x == 0).unwrap_or(data.len());
    let text = String::from_utf16(&data[..end]).ok()?;
    (!text.is_empty()).then(|| PathBuf::from(text))
}

fn default_steam_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    {
        if let Some(path) = registry_steam_path() {
            roots.push(path);
        }
        for key in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Some(value) = std::env::var_os(key) {
                roots.push(PathBuf::from(value).join("Steam"));
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".steam/steam"));
        roots.push(home.join(".local/share/Steam"));
        roots.push(home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"));
        roots.push(home.join("Library/Application Support/Steam"));
    }
    roots
}

fn add_existing(list: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, p: PathBuf) {
    if let Ok(canonical) = p.canonicalize() {
        if canonical.is_dir() && seen.insert(canonical.clone()) {
            list.push(canonical);
        }
    }
}

pub fn scan_library(manual: Option<&str>) -> Result<Library, String> {
    let mut seeds = default_steam_roots();
    if let Some(raw) = manual.filter(|s| !s.trim().is_empty()) {
        let path = PathBuf::from(raw);
        if !path.is_dir() {
            return Err("выбранная папка Steam или Wallpaper Engine недоступна".into());
        }
        seeds.push(path);
    }
    let mut libraries = Vec::new();
    let mut seen = HashSet::new();
    for seed in seeds {
        add_existing(&mut libraries, &mut seen, seed);
    }
    // Каждая библиотека Steam может быть на другом диске.
    let initial = libraries.clone();
    for root in initial {
        for file in [
            root.join("steamapps/libraryfolders.vdf"),
            root.join("libraryfolders.vdf"),
        ] {
            if std::fs::metadata(&file)
                .map(|m| m.len() <= 1024 * 1024)
                .unwrap_or(false)
            {
                if let Ok(text) = std::fs::read_to_string(file) {
                    for path in vdf_library_paths(&text) {
                        add_existing(&mut libraries, &mut seen, path);
                    }
                }
            }
        }
    }
    let mut search = Vec::new();
    let mut searched = HashSet::new();
    let mut engine = None;
    for root in &libraries {
        let steamapps = if root.file_name().is_some_and(|n| n == "steamapps") {
            root.clone()
        } else {
            root.join("steamapps")
        };
        for path in [
            steamapps.join("workshop/content/431960"),
            steamapps.join("common/wallpaper_engine/projects"),
            root.join("projects"),
        ] {
            add_existing(&mut search, &mut searched, path);
        }
        for folder in [steamapps.join("common/wallpaper_engine"), root.clone()] {
            for name in ["wallpaper64.exe", "wallpaper32.exe"] {
                let exe = folder.join(name);
                if engine.is_none() && exe.is_file() {
                    engine = Some(exe.to_string_lossy().into_owned());
                }
            }
        }
    }
    // Можно выбрать саму папку проекта, projects или workshop/content/431960.
    if let Some(raw) = manual.filter(|s| !s.trim().is_empty()) {
        let root = PathBuf::from(raw);
        let known_steam = root.join("steamapps").is_dir()
            || root.join("workshop/content/431960").is_dir()
            || root.join("projects").is_dir();
        if !known_steam {
            add_existing(&mut search, &mut searched, root.clone());
        }
        for ancestor in root.ancestors().take(5) {
            for name in ["wallpaper64.exe", "wallpaper32.exe"] {
                let exe = ancestor.join(name);
                if engine.is_none() && exe.is_file() {
                    engine = Some(exe.to_string_lossy().into_owned());
                }
            }
        }
    }
    let mut projects = Vec::new();
    let mut visited = HashSet::new();
    let mut truncated = false;
    let mut pending: Vec<(PathBuf, usize, PathBuf)> = search
        .iter()
        .rev()
        .map(|p| (p.clone(), 0, p.clone()))
        .collect();
    while let Some((dir, depth, root)) = pending.pop() {
        if visited.len() >= MAX_DIRECTORIES || projects.len() >= MAX_PROJECTS {
            truncated = true;
            break;
        }
        let Ok(canonical) = dir.canonicalize() else {
            continue;
        };
        if !canonical.starts_with(&root) || !visited.insert(canonical.clone()) {
            continue;
        }
        if let Some(item) = project(&canonical) {
            projects.push(item);
            continue;
        }
        if depth >= 3 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&canonical) else {
            continue;
        };
        let mut subdirs: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        subdirs.sort();
        pending.extend(
            subdirs
                .into_iter()
                .rev()
                .map(|p| (p, depth + 1, root.clone())),
        );
    }
    projects.sort_by(|a, b| {
        a.title
            .to_lowercase()
            .cmp(&b.title.to_lowercase())
            .then(a.directory.cmp(&b.directory))
    });
    Ok(Library {
        projects,
        searched: search
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        engine,
        truncated,
    })
}

pub fn workshop_link(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(
            url.host_str(),
            Some("steamcommunity.com" | "www.steamcommunity.com")
        )
        || !matches!(
            url.path().trim_end_matches('/'),
            "/sharedfiles/filedetails" | "/workshop/filedetails"
        )
    {
        return None;
    }
    let ids: Vec<_> = url
        .query_pairs()
        .filter(|(k, _)| k == "id")
        .map(|(_, v)| v.into_owned())
        .collect();
    if ids.len() != 1
        || ids[0].is_empty()
        || ids[0].len() > 20
        || !ids[0].bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some(ids[0].clone())
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

pub async fn download_media(value: &str, dir: &Path) -> Result<String, String> {
    let url =
        reqwest::Url::parse(value.trim()).map_err(|_| "неверная ссылка на файл".to_string())?;
    let response = direct_response(url).await?;
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
    fn old_and_new_steam_library_paths_are_parsed() {
        let vdf = r#""libraryfolders" { "0" { "path" "C:\\Program Files (x86)\\Steam" "apps" { "431960" "42" } } "1" "D:\\Games\\SteamLibrary" // comment
        "2" { "path" "/media/disk/Steam" } }"#;
        let paths = vdf_library_paths(vdf);
        assert!(paths.contains(&PathBuf::from(r"C:\Program Files (x86)\Steam")));
        assert!(paths.contains(&PathBuf::from(r"D:\Games\SteamLibrary")));
        assert!(paths.contains(&PathBuf::from("/media/disk/Steam")));
    }
    #[test]
    fn workshop_link_is_strict_and_rejects_tricks() {
        assert_eq!(
            workshop_link(
                "https://steamcommunity.com/sharedfiles/filedetails/?id=123&searchtext=x"
            )
            .as_deref(),
            Some("123")
        );
        assert_eq!(
            workshop_link("https://steamcommunity.com/workshop/filedetails/?id=999").as_deref(),
            Some("999")
        );
        for url in [
            "https://steamcommunity.com.evil.test/sharedfiles/filedetails/?id=1",
            "https://steamcommunity.com@evil.test/sharedfiles/filedetails/?id=1",
            "file:///etc/passwd",
            "https://steamcommunity.com/sharedfiles/filedetails/?id=1&id=2",
            "https://steamcommunity.com/sharedfiles/filedetails/?id=1%26x",
        ] {
            assert!(workshop_link(url).is_none(), "{url}");
        }
    }
    #[test]
    fn scan_finds_video_and_scenes_without_trusting_project_paths() {
        let root = temp_dir("steam");
        let content = root.join("steamapps/workshop/content/431960");
        let one = content.join("123");
        let two = content.join("456");
        let bad = content.join("789");
        for dir in [&one, &two, &bad] {
            std::fs::create_dir_all(dir).unwrap();
        }
        write(&one.join("project.json"), br#"{"title":"Video <one>","type":"video","file":"movie.mp4","preview":"preview.gif","workshopid":123}"#);
        write(
            &one.join("movie.mp4"),
            b"\x00\x00\x00\x18ftypisom000000000000000000000000",
        );
        write(
            &one.join("preview.gif"),
            b"GIF89a0000000000000000000000000000",
        );
        write(
            &two.join("project.json"),
            br#"{"title":"Scene","type":"scene","file":"scene.pkg"}"#,
        );
        write(&bad.join("project.json"), br#"{"title":"Escape","type":"video","file":"../123/movie.mp4","preview":"../123/preview.gif"}"#);
        let library = scan_library(Some(root.to_str().unwrap())).unwrap();
        assert_eq!(library.projects.len(), 3);
        let video = library
            .projects
            .iter()
            .find(|p| p.workshop_id.as_deref() == Some("123"))
            .unwrap();
        assert!(video.playable && video.preview.is_some());
        assert!(
            !library
                .projects
                .iter()
                .find(|p| p.title == "Scene")
                .unwrap()
                .playable
        );
        let escaped = library
            .projects
            .iter()
            .find(|p| p.title == "Escape")
            .unwrap();
        assert!(!escaped.playable && escaped.preview.is_none());
        assert!(project_media(&bad).is_err());
        std::fs::remove_dir_all(root).unwrap();
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
    #[cfg(unix)]
    #[test]
    fn project_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = temp_dir("symlink");
        let project_dir = root.join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        write(
            &root.join("outside.mp4"),
            b"\x00\x00\x00\x18ftypisom000000000000000000000000",
        );
        symlink(root.join("outside.mp4"), project_dir.join("movie.mp4")).unwrap();
        write(
            &project_dir.join("project.json"),
            br#"{"title":"escape","type":"video","file":"movie.mp4"}"#,
        );
        assert!(!project(&project_dir).unwrap().playable);
        assert!(project_media(&project_dir).is_err());
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
