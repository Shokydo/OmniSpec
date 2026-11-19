//! Явная установка распознанной зависимости Fabric из диагностики.
//! Нельзя доверять одному имени файла или первой версии из каталога:
//! проверяем профиль сборки, метаданные JAR, ограничения версии и SHA-512.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Cursor, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::{SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use semver::{Version as SemVersion, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256, Sha512};
use zip::result::ZipError;

use crate::content::{self, ContentRecord};
use crate::error::{Error, Result};
use crate::instances::{self, InstanceMeta, Loader};
use crate::modrinth::{Modrinth, Version as ModVersion};
use crate::net::Reporter;
use crate::paths::Paths;

const MAX_FILE_BYTES: u64 = 96 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_NESTED_DEPTH: usize = 4;
const MAX_NESTED_FILES: usize = 4096;
const MAX_NESTED_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CANDIDATES: usize = 24;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallRequest {
    pub mod_id: String,
    pub minimum: Option<String>,
    pub mc_version: String,
    pub loader_version: String,
    pub java_major: Option<u32>,
    /// Имя единственного найденного файла, замену которого пользователь подтвердил.
    pub replace_file: Option<String>,
    /// Или включить совместимый выключенный файл, не скачивая второй.
    pub enable_file: Option<String>,
    /// Защита от подмены файла между показом диалога и подтверждением.
    pub expected_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExistingMod {
    pub name: String,
    pub version: String,
    pub disabled: bool,
    pub nested: bool,
    pub sha256: String,
    /// Доказуемая совместимость из manifest; для вложенных модов всегда false.
    pub compatible: bool,
    pub compatibility_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModDirSnapshot(Vec<(std::ffi::OsString, u64, SystemTime, bool)>);

/// Быстрый снимок имён, размеров и времени изменения: диагностику после
/// ручного изменения mods нельзя применять как будто это тот же запуск.
pub fn snapshot_mods(mods: &Path) -> Result<ModDirSnapshot> {
    let entries = match fs::read_dir(mods) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ModDirSnapshot(Vec::new()))
        }
        Err(error) => return Err(error.into()),
    };
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let lower = name.to_string_lossy().to_ascii_lowercase();
        if !lower.ends_with(".jar") && !lower.ends_with(".jar.disabled") {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        result.push((
            name,
            metadata.len(),
            metadata.modified()?,
            metadata.file_type().is_symlink(),
        ));
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(ModDirSnapshot(result))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallResult {
    /// `installed` | `enabled` | `existing`. При `existing` файловые изменения не выполнялись.
    pub status: String,
    pub filename: Option<String>,
    pub version: Option<String>,
    pub backup: Option<String>,
    pub existing: Vec<ExistingMod>,
    /// Самостоятельную загрузку других зависимостей мы не обещаем.
    pub has_other_dependencies: bool,
    pub record_saved: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    id: String,
    version: String,
    #[serde(default)]
    provides: Vec<String>,
    #[serde(default)]
    environment: String,
    #[serde(default)]
    depends: HashMap<String, Value>,
    #[serde(default)]
    jars: Vec<NestedJar>,
}

#[derive(Debug, Clone, Deserialize)]
struct NestedJar {
    file: String,
}

fn unique_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{}-{nanos}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, AtomicOrdering::Relaxed)
    )
}

/// Временные файлы не должны попасть в mods после отмены или неудачной проверки.
struct TempPath(PathBuf);
impl TempPath {
    fn create(path: PathBuf) -> io::Result<(Self, File)> {
        // Не создаём guard до успешного create_new: иначе при совпадении имён
        // его Drop мог бы удалить чужой, уже существовавший файл.
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok((Self(path), file))
    }
}
impl Drop for TempPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn valid_mod_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
}

fn valid_filename(name: &str) -> bool {
    // Разрешён один обычный JAR, без путей, ADS и специальных имён Windows.
    if name.len() < 5
        || name.len() > 180
        || !name.to_ascii_lowercase().ends_with(".jar")
        || name.chars().any(|c| {
            c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
    {
        return false;
    }
    let first = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    !matches!(
        first.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    )
}

fn parse_semver(raw: &str) -> Option<SemVersion> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 80 {
        return None;
    }
    let split = value.find(['-', '+']).unwrap_or(value.len());
    let (core, suffix) = value.split_at(split);
    let parts: Vec<&str> = core.split('.').collect();
    if parts.is_empty()
        || parts.len() > 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    // Fabric использует суффикс «-» как границу, включающую prerelease.
    let suffix = if suffix == "-" { "-0" } else { suffix };
    let normalized = match parts.len() {
        1 => format!("{}.0.0{suffix}", parts[0]),
        2 => format!("{}.{}.0{suffix}", parts[0], parts[1]),
        _ => format!("{core}{suffix}"),
    };
    SemVersion::parse(&normalized).ok()
}

/// Только доказуемое сравнение: неизвестный формат не считаем совместимым.
pub fn satisfies_minimum(version: &str, minimum: Option<&str>) -> bool {
    let Some(candidate) = parse_semver(version) else {
        return false;
    };
    let Some(minimum) = minimum.filter(|v| !v.is_empty()) else {
        return true;
    };
    parse_semver(minimum).is_some_and(|min| candidate.cmp_precedence(&min) != Ordering::Less)
}

fn predicate_branch(current: &SemVersion, predicate: &str) -> bool {
    let predicate = predicate.trim();
    if predicate.is_empty() {
        return false;
    }
    // Fabric задаёт конъюнкцию пробелами, альтернативы — массивом.
    predicate.split_whitespace().all(|part| {
        if part == "*" {
            return true;
        }
        let (op, value) = [">=", "<=", ">", "<", "=", "^", "~"]
            .iter()
            .find_map(|op| part.strip_prefix(op).map(|rest| (*op, rest)))
            .unwrap_or(("=", part));
        let value = if value.contains('*') || value.contains('x') || value.contains('X') {
            value.to_string()
        } else if let Some(version) = parse_semver(value) {
            version.to_string()
        } else {
            return false;
        };
        let req = format!("{op}{value}");
        VersionReq::parse(&req).is_ok_and(|parsed| parsed.matches(current))
    })
}

fn matches_predicate(value: &Value, actual: &str) -> bool {
    let Some(current) = parse_semver(actual) else {
        return false;
    };
    match value {
        Value::String(s) => predicate_branch(&current, s),
        Value::Array(values) => values
            .iter()
            .any(|v| v.as_str().is_some_and(|s| predicate_branch(&current, s))),
        _ => false,
    }
}

fn manifest_from_archive<R: Read + Seek>(zip: &mut zip::ZipArchive<R>) -> Result<Option<Manifest>> {
    let mut item = match zip.by_name("fabric.mod.json") {
        Ok(item) => item,
        Err(ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if item.size() > MAX_MANIFEST_BYTES {
        return Err(Error::other(
            "fabric.mod.json слишком большой для безопасной проверки",
        ));
    }
    let mut bytes = Vec::new();
    (&mut item)
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(Error::other("fabric.mod.json слишком большой"));
    }
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| Error::other("не удалось проверить fabric.mod.json в одном из модов"))?;
    Ok(Some(manifest))
}

fn identity_matches(manifest: &Manifest, id: &str) -> bool {
    manifest.id.eq_ignore_ascii_case(id)
        || manifest
            .provides
            .iter()
            .any(|provided| provided.eq_ignore_ascii_case(id))
}

#[derive(Default)]
struct ScanBudget {
    files: usize,
    bytes: u64,
}

/// Проверяем и вложенные JAR, иначе включённую зависимость можно продублировать.
fn find_in_archive<R: Read + Seek>(
    reader: R,
    id: &str,
    depth: usize,
    budget: &mut ScanBudget,
) -> Result<Option<(String, bool)>> {
    if depth > MAX_NESTED_DEPTH {
        return Err(Error::other(
            "слишком глубокая вложенность модов; проверь папку mods вручную",
        ));
    }
    let mut zip = zip::ZipArchive::new(reader)?;
    let Some(manifest) = manifest_from_archive(&mut zip)? else {
        return Ok(None);
    };
    if identity_matches(&manifest, id) {
        return Ok(Some((manifest.version, depth > 0)));
    }
    for nested in manifest.jars {
        budget.files += 1;
        if budget.files > MAX_NESTED_FILES {
            return Err(Error::other(
                "слишком много вложенных модов; проверь папку mods вручную",
            ));
        }
        let mut entry = zip.by_name(&nested.file).map_err(|_| {
            Error::other("не удалось проверить вложенную зависимость одного из модов")
        })?;
        budget.bytes = budget.bytes.saturating_add(entry.size());
        if entry.size() > MAX_FILE_BYTES || budget.bytes > MAX_NESTED_TOTAL_BYTES {
            return Err(Error::other(
                "вложенные моды слишком большие для безопасной проверки",
            ));
        }
        let mut bytes = Vec::new();
        (&mut entry)
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(Error::other("вложенный мод слишком большой"));
        }
        if let Some(found) = find_in_archive(Cursor::new(bytes), id, depth + 1, budget)? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn scan_existing(mods: &Path, request: &InstallRequest) -> Result<Vec<ExistingMod>> {
    let mut found = Vec::new();
    let entries = match fs::read_dir(mods) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(found),
        Err(error) => return Err(error.into()),
    };
    let mut budget = ScanBudget::default();
    for entry in entries {
        let entry = entry?;
        let name = entry
            .file_name()
            .to_str()
            .ok_or_else(|| Error::other("не удалось проверить имя файла в mods"))?
            .to_string();
        let lower = name.to_ascii_lowercase();
        if !lower.ends_with(".jar") && !lower.ends_with(".jar.disabled") {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.file_type().is_file() {
            return Err(Error::other(format!(
                "не удалось безопасно проверить файл {name} в mods"
            )));
        }
        let file = File::open(entry.path())
            .map_err(|_| Error::other(format!("не удалось прочитать мод {name}")))?;
        let hit = find_in_archive(file, &request.mod_id, 0, &mut budget)
            .map_err(|error| Error::other(format!("не удалось проверить мод {name}: {error}")))?;
        if let Some((version, nested)) = hit {
            let path = entry.path();
            let sha256 = file_sha256(&path)?;
            let compatibility = if nested {
                Err(Error::other("зависимость встроена в другой мод"))
            } else {
                candidate_manifest(&path, request).and_then(|manifest| {
                    if manifest.depends.contains_key("minecraft") {
                        Ok(())
                    } else {
                        Err(Error::other("в файле не указаны требования к Minecraft"))
                    }
                })
            };
            found.push(ExistingMod {
                name,
                version,
                disabled: lower.ends_with(".disabled"),
                nested,
                sha256,
                compatible: compatibility.is_ok(),
                compatibility_reason: compatibility.err().map(|e| e.to_string()),
            });
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

fn file_sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let count = file.read(&mut buf)?;
        if count == 0 {
            break;
        }
        hasher.update(&buf[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn verify_download(path: &Path, expected_size: u64, expected_sha512: &str) -> Result<()> {
    if expected_size == 0
        || expected_size > MAX_FILE_BYTES
        || expected_sha512.len() != 128
        || !expected_sha512.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err(Error::other("нет корректного размера или SHA-512 файла"));
    }
    let mut file = File::open(path)?;
    let mut hasher = Sha512::new();
    let mut size = 0u64;
    let mut buf = [0u8; 65536];
    loop {
        let count = file.read(&mut buf)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > MAX_FILE_BYTES {
            return Err(Error::other("скачанный файл слишком большой"));
        }
        hasher.update(&buf[..count]);
    }
    if size != expected_size
        || !hex::encode(hasher.finalize()).eq_ignore_ascii_case(expected_sha512)
    {
        return Err(Error::other(
            "размер или SHA-512 скачанного файла не совпадает",
        ));
    }
    Ok(())
}

fn candidate_manifest(path: &Path, request: &InstallRequest) -> Result<Manifest> {
    let mut zip = zip::ZipArchive::new(File::open(path)?)?;
    let manifest = manifest_from_archive(&mut zip)?
        .ok_or_else(|| Error::other("в файле нет fabric.mod.json"))?;
    if !identity_matches(&manifest, &request.mod_id) {
        return Err(Error::other(
            "id мода в файле не совпадает с зависимостью из лога",
        ));
    }
    if !satisfies_minimum(&manifest.version, request.minimum.as_deref()) {
        return Err(Error::other(
            "версия мода в файле не удовлетворяет требованию лога",
        ));
    }
    if !matches!(manifest.environment.as_str(), "" | "*" | "client") {
        return Err(Error::other("файл не предназначен для клиента"));
    }
    if let Some(required) = manifest.depends.get("minecraft") {
        if !matches_predicate(required, &request.mc_version) {
            return Err(Error::other(
                "версия Minecraft не удовлетворяет требованиям файла",
            ));
        }
    }
    if let Some(required) = manifest.depends.get("fabricloader") {
        if !matches_predicate(required, &request.loader_version) {
            return Err(Error::other(
                "версии Fabric Loader этой сборки не хватает для файла",
            ));
        }
    }
    if let Some(required) = manifest.depends.get("java") {
        let java = request.java_major.ok_or_else(|| {
            Error::other("не удалось определить Java последнего запуска; запусти сборку снова")
        })?;
        if !matches_predicate(required, &java.to_string()) {
            return Err(Error::other(
                "использованная Java не удовлетворяет требованиям файла",
            ));
        }
    }
    Ok(manifest)
}

fn allowed_file_url(url: &str) -> bool {
    reqwest::Url::parse(url).ok().is_some_and(|u| {
        u.scheme() == "https"
            && u.host_str() == Some("cdn.modrinth.com")
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
            && u.fragment().is_none()
    })
}

async fn download_bounded(
    modrinth: &Modrinth,
    url: &str,
    mut output: tokio::fs::File,
    size: u64,
    name: &str,
    reporter: &Reporter,
) -> Result<()> {
    if !allowed_file_url(url) || size == 0 || size > MAX_FILE_BYTES {
        return Err(Error::other("небезопасный адрес или размер файла"));
    }
    let response = modrinth
        .http()
        .inner()
        .get(url)
        .send()
        .await
        .map_err(|e| Error::http(url, e))?;
    if !response.status().is_success() {
        return Err(Error::other(format!(
            "сервер файла вернул HTTP {}",
            response.status()
        )));
    }
    if !allowed_file_url(response.url().as_str()) {
        return Err(Error::other(
            "сервер перенаправил загрузку на неподходящий адрес",
        ));
    }
    if response
        .content_length()
        .is_some_and(|actual| actual > size)
    {
        return Err(Error::other("размер ответа больше заявленного"));
    }
    use tokio::io::AsyncWriteExt;
    let mut stream = response.bytes_stream();
    let mut total = 0u64;
    let mut reported = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        if crate::net::is_cancelled() {
            return Err(Error::Cancelled);
        }
        let chunk = chunk.map_err(|e| Error::http(url, e))?;
        total = total
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| Error::other("файл слишком большой"))?;
        if total > size || total > MAX_FILE_BYTES {
            return Err(Error::other("размер файла превышает заявленный"));
        }
        output.write_all(&chunk).await?;
        if reported.elapsed().as_millis() >= 100 {
            reporter.emit_bytes("mods", name, total, size);
            reported = std::time::Instant::now();
        }
    }
    if total != size {
        return Err(Error::other(
            "скачивание завершилось до получения всего файла",
        ));
    }
    output.flush().await?;
    output.sync_all().await?;
    reporter.emit_bytes("mods", name, total, size);
    Ok(())
}

fn validate_profile(instance: &InstanceMeta, request: &InstallRequest) -> Result<()> {
    if !valid_mod_id(&request.mod_id) {
        return Err(Error::other("некорректный id зависимости"));
    }
    if let Some(minimum) = request.minimum.as_deref() {
        if parse_semver(minimum).is_none() {
            return Err(Error::other(
                "не удалось надёжно определить минимальную версию из лога",
            ));
        }
    }
    match &instance.loader {
        Loader::Fabric { version }
            if instance.mc_version == request.mc_version
                && version == &request.loader_version
                && parse_semver(version).is_some() =>
        {
            Ok(())
        }
        _ => Err(Error::other(
            "версия Minecraft или Fabric Loader изменилась после запуска; запусти сборку снова",
        )),
    }
}

fn acceptable_version(version: &ModVersion, project_id: &str, request: &InstallRequest) -> bool {
    // version_number в каталоге бывает произвольной строкой вроде
    // «mc1.21.1-0.8.13-fabric», отличающейся от версии внутри JAR.
    // Минимум обязательно проверяется по fabric.mod.json после загрузки.
    version.project_id == project_id
        && version
            .game_versions
            .iter()
            .any(|v| v == &request.mc_version)
        && version.loaders.iter().any(|v| v == "fabric")
}

fn copy_new(source: &Path, destination: &Path) -> io::Result<()> {
    let mut from = File::open(source)?;
    let mut to = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    if let Err(error) = (|| {
        io::copy(&mut from, &mut to)?;
        to.flush()?;
        to.sync_all()
    })() {
        drop(to);
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(())
}

/// Атомарное создание имени без перезаписи; запасной вариант для FAT и т.п.
fn publish_new(source: &Path, destination: &Path) -> io::Result<()> {
    match fs::hard_link(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(error),
        Err(_) => copy_new(source, destination),
    }
}

fn enable_existing(mods: &Path, item: &ExistingMod) -> Result<String> {
    if !item.disabled || item.nested || !item.compatible || item.name.len() <= ".disabled".len() {
        return Err(Error::other(
            "выключенный файл нельзя безопасно включить автоматически",
        ));
    }
    let original = mods.join(&item.name);
    let enabled_name = &item.name[..item.name.len() - ".disabled".len()];
    let destination = mods.join(enabled_name);
    if file_sha256(&original)? != item.sha256 {
        return Err(Error::other("файл изменился после подтверждения"));
    }
    publish_new(&original, &destination).map_err(|e| {
        Error::other(format!(
            "не удалось включить файл (возможно, имя уже занято): {e}"
        ))
    })?;
    if file_sha256(&destination).ok().as_deref() != Some(item.sha256.as_str())
        || file_sha256(&original).ok().as_deref() != Some(item.sha256.as_str())
    {
        let _ = fs::remove_file(&destination);
        return Err(Error::other(
            "файл изменился при включении; он остался выключенным",
        ));
    }
    if let Err(error) = fs::remove_file(&original) {
        let _ = fs::remove_file(&destination);
        return Err(Error::other(format!(
            "не удалось переименовать выключенный файл: {error}"
        )));
    }
    Ok(enabled_name.to_string())
}

fn commit_file(
    mods: &Path,
    downloaded: &Path,
    filename: &str,
    old: Option<&ExistingMod>,
) -> Result<Option<PathBuf>> {
    if !valid_filename(filename) {
        return Err(Error::other("небезопасное имя загружаемого файла"));
    }
    fs::create_dir_all(mods)?;
    let destination = mods.join(filename);
    let old_path = old.map(|item| mods.join(&item.name));
    if destination.exists() && old_path.as_deref() != Some(destination.as_path()) {
        return Err(Error::other(
            "файл с таким именем уже существует; ничего не заменено",
        ));
    }
    let (stage, mut staged) =
        TempPath::create(mods.join(format!(".omnispec-diagnostic-{}.tmp", unique_id())))?;
    let mut source = File::open(downloaded)?;
    io::copy(&mut source, &mut staged)?;
    staged.flush()?;
    staged.sync_all()?;
    drop(staged);

    let mut backup = None;
    if let (Some(item), Some(path)) = (old, old_path.as_ref()) {
        if item.nested {
            return Err(Error::other(
                "зависимость встроена в другой мод; автоматически заменить её нельзя",
            ));
        }
        let base = mods
            .parent()
            .ok_or_else(|| Error::other("не найдена папка сборки"))?;
        let backup_dir = base.join("omnispec-backups").join("mods");
        fs::create_dir_all(&backup_dir)?;
        let backup_path = backup_dir.join(format!("{}-{}.bak", item.name, unique_id()));
        // Копия создана и сброшена на диск до удаления исходного файла.
        let mut backup_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup_path)?;
        let mut old_file = match File::open(path) {
            Ok(file) => file,
            Err(error) => {
                drop(backup_file);
                let _ = fs::remove_file(&backup_path);
                return Err(error.into());
            }
        };
        let copied = (|| -> io::Result<()> {
            io::copy(&mut old_file, &mut backup_file)?;
            backup_file.flush()?;
            backup_file.sync_all()
        })();
        drop(old_file);
        drop(backup_file);
        if let Err(error) = copied {
            let _ = fs::remove_file(&backup_path);
            return Err(error.into());
        }
        if file_sha256(path).ok().as_deref() != Some(item.sha256.as_str())
            || file_sha256(&backup_path).ok().as_deref() != Some(item.sha256.as_str())
        {
            let _ = fs::remove_file(&backup_path);
            return Err(Error::other(
                "старый файл изменился при создании копии; замена отменена",
            ));
        }
        if let Err(error) = fs::remove_file(path) {
            return Err(Error::other(format!(
                "не удалось убрать прежний файл; его копия сохранена: {} ({error})",
                backup_path.display()
            )));
        }
        backup = Some(backup_path);
    }

    if let Err(error) = publish_new(&stage.0, &destination) {
        if let (Some(old_path), Some(backup_path)) = (old_path, backup.as_ref()) {
            if copy_new(backup_path, &old_path).is_err() {
                return Err(Error::other(format!("не удалось установить файл и восстановить старый автоматически; резервная копия: {}", backup_path.display())));
            }
        }
        return Err(Error::other(format!(
            "не удалось установить файл, старый сохранён: {error}"
        )));
    }
    Ok(backup)
}

/// Найти и установить точную зависимость; другие моды, миры и настройки не трогаем.
pub async fn install_missing(
    modrinth: &Modrinth,
    paths: &Paths,
    instance: &InstanceMeta,
    request: &InstallRequest,
    reporter: &Reporter,
) -> Result<InstallResult> {
    validate_profile(instance, request)?;
    if request.replace_file.is_some() && request.enable_file.is_some() {
        return Err(Error::other("нельзя одновременно включать и заменять файл"));
    }
    let mods = instances::game_dir_for(paths, instance).join("mods");
    let before_mods = snapshot_mods(&mods)?;
    let existing = scan_existing(&mods, request)?;
    if request.replace_file.is_none() && request.enable_file.is_none() && !existing.is_empty() {
        return Ok(InstallResult {
            status: "existing".into(),
            filename: None,
            version: None,
            backup: None,
            existing,
            has_other_dependencies: false,
            record_saved: false,
        });
    }
    if let Some(name) = request.enable_file.as_deref() {
        let item = existing
            .first()
            .filter(|item| {
                existing.len() == 1
                    && item.name == name
                    && item.disabled
                    && !item.nested
                    && item.compatible
                    && request.expected_sha256.as_deref() == Some(item.sha256.as_str())
            })
            .ok_or_else(|| {
                Error::other("выключенный файл изменился или его совместимость не подтверждена")
            })?;
        let current = instances::load(paths, &instance.id)?;
        validate_profile(&current, request)?;
        if instances::game_dir_for(paths, &current) != instances::game_dir_for(paths, instance)
            || snapshot_mods(&mods)? != before_mods
            || scan_existing(&mods, request)? != existing
        {
            return Err(Error::other("состав модов изменился; повтори проверку"));
        }
        let manifest = candidate_manifest(&mods.join(&item.name), request)?;
        let filename = enable_existing(&mods, item)?;
        reporter.emit_state("mods", "done", format!("включён {filename}"));
        return Ok(InstallResult {
            status: "enabled".into(),
            filename: Some(filename),
            version: Some(item.version.clone()),
            backup: None,
            existing: Vec::new(),
            has_other_dependencies: manifest
                .depends
                .keys()
                .any(|key| !["fabricloader", "minecraft", "java"].contains(&key.as_str())),
            record_saved: true,
        });
    }
    let old = match request.replace_file.as_deref() {
        None if existing.is_empty() => None,
        Some(name)
            if existing.len() == 1
                && existing[0].name == name
                && !existing[0].nested
                && request.expected_sha256.as_deref() == Some(existing[0].sha256.as_str()) =>
        {
            Some(existing[0].clone())
        }
        _ => {
            return Err(Error::other(
                "состав или содержимое модов изменилось; повтори проверку во вкладке «Ошибки»",
            ))
        }
    };

    // id Fabric не всегда совпадает со slug Modrinth. Не выбираем похожий
    // проект наугад: даже точный slug дополнительно проверяется по id внутри JAR.
    let refs: Vec<String> = if request.mod_id == "fabric-api" {
        vec!["P7dR8mSH".into()]
    } else if request.mod_id.contains('_') {
        vec![request.mod_id.clone(), request.mod_id.replace('_', "-")]
    } else {
        vec![request.mod_id.clone()]
    };
    let mut project = None;
    for reference in refs {
        match modrinth.project(&reference).await {
            Ok(found) if found.project_type == "mod" => {
                project = Some(found);
                break;
            }
            Ok(_) => continue,
            Err(error) if error.to_string().contains("HTTP 404") => continue,
            Err(error) => return Err(error),
        }
    }
    let project = project.ok_or_else(|| {
        Error::not_found(format!(
            "не найден однозначный проект для «{}»; открой встроенный поиск модов",
            request.mod_id
        ))
    })?;
    let versions = modrinth
        .project_versions(&project.id, Some(&request.mc_version), Some("fabric"))
        .await?;
    let candidates: Vec<&ModVersion> = versions
        .iter()
        .filter(|v| acceptable_version(v, &project.id, request))
        .collect();
    if candidates.is_empty() {
        return Err(Error::not_found(
            "нет версии мода для этой игры, Fabric и требования из лога",
        ));
    }
    let cache = paths.cache().join("diagnostic-downloads");
    fs::create_dir_all(&cache)?;
    let mut last_reason = String::new();
    let mut tried = 0usize;
    'search: for channel in ["release", "beta", "alpha", ""] {
        for version in candidates.iter().filter(|v| {
            if channel.is_empty() {
                !["release", "beta", "alpha"].contains(&v.version_type.as_str())
            } else {
                v.version_type == channel
            }
        }) {
            // У одной версии каталога иногда несколько файлов: основной
            // проверяем первым, но не игнорируем остальные варианты JAR.
            let mut files: Vec<_> = version.files.iter().collect();
            files.sort_by_key(|file| !file.primary);
            for file in files {
                if tried >= MAX_CANDIDATES {
                    break 'search;
                }
                tried += 1;
                let Some(sha512) = file.hashes.get("sha512") else {
                    continue;
                };
                if !valid_filename(&file.filename)
                    || !allowed_file_url(&file.url)
                    || file.size == 0
                    || file.size > MAX_FILE_BYTES
                {
                    continue;
                }
                reporter.emit("mods", 0, 0, format!("проверяем {}", file.filename));
                let (temp, file_handle) =
                    TempPath::create(cache.join(format!("{}.jar", unique_id())))?;
                download_bounded(
                    modrinth,
                    &file.url,
                    tokio::fs::File::from_std(file_handle),
                    file.size,
                    &file.filename,
                    reporter,
                )
                .await?;
                verify_download(&temp.0, file.size, sha512)?;
                let manifest = match candidate_manifest(&temp.0, request) {
                    Ok(manifest) => manifest,
                    Err(error) => {
                        last_reason = error.to_string();
                        continue;
                    }
                };
                let current = instances::load(paths, &instance.id)?;
                validate_profile(&current, request)?;
                if instances::game_dir_for(paths, &current)
                    != instances::game_dir_for(paths, instance)
                {
                    return Err(Error::other("папка сборки изменилась во время загрузки"));
                }
                let after = scan_existing(&mods, request)?;
                if snapshot_mods(&mods)? != before_mods || after != existing {
                    return Err(Error::other("состав или содержимое модов изменилось во время загрузки; повтори проверку"));
                }
                if crate::net::is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let backup = commit_file(&mods, &temp.0, &file.filename, old.as_ref())?;
                let mut store = content::load_store(paths, instance);
                if let Some(item) = &old {
                    store.files.remove(item.name.trim_end_matches(".disabled"));
                }
                store.files.insert(
                    file.filename.clone(),
                    ContentRecord {
                        filename: file.filename.clone(),
                        project_id: Some(project.id.clone()),
                        version_id: Some(version.id.clone()),
                        version_number: version.version_number.clone(),
                        title: project.title.clone(),
                        kind: "mod".into(),
                        sha1: file.hashes.get("sha1").cloned().unwrap_or_default(),
                    },
                );
                let record_saved = content::save_store(paths, instance, &store).is_ok();
                reporter.emit_state("mods", "done", format!("установлен {}", file.filename));
                let has_other_dependencies = manifest
                    .depends
                    .keys()
                    .any(|key| !["fabricloader", "minecraft", "java"].contains(&key.as_str()))
                    || version
                        .dependencies
                        .iter()
                        .any(|d| d.dependency_type == "required");
                return Ok(InstallResult {
                    status: "installed".into(),
                    filename: Some(file.filename.clone()),
                    version: Some(manifest.version),
                    backup: backup.map(|path| path.display().to_string()),
                    existing: Vec::new(),
                    has_other_dependencies,
                    record_saved,
                });
            }
        }
    }
    let prefix = if tried >= MAX_CANDIDATES {
        format!("среди {tried} проверенных файлов не найден совместимый вариант")
    } else {
        "не найден проверяемый совместимый файл мода".into()
    };
    Err(Error::not_found(if last_reason.is_empty() {
        prefix
    } else {
        format!("{prefix}: {last_reason}")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use zip::write::SimpleFileOptions;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("omnispec-diagnostic-test-{}", unique_id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn request() -> InstallRequest {
        InstallRequest {
            mod_id: "fabric-api".into(),
            minimum: Some("0.145.1".into()),
            mc_version: "26.3".into(),
            loader_version: "0.19.3".into(),
            java_major: Some(25),
            replace_file: None,
            enable_file: None,
            expected_sha256: None,
        }
    }

    fn instance() -> InstanceMeta {
        serde_json::from_value(json!({"id":"test", "name":"Test", "mc_version":"26.3", "loader":{"type":"fabric", "version":"0.19.3"}})).unwrap()
    }

    fn manifest(version: &str) -> Value {
        json!({"schemaVersion":1,"id":"fabric-api","version":version,"environment":"*",
            "depends":{"fabricloader":">=0.19.3","java":">=25","minecraft":"~26.3-"}})
    }

    fn jar_bytes(manifest: &Value, nested: Option<(&str, &[u8])>) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("fabric.mod.json", SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(serde_json::to_string(manifest).unwrap().as_bytes())
            .unwrap();
        if let Some((name, bytes)) = nested {
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn minimum_comparison_is_numeric_and_respects_prerelease() {
        assert!(satisfies_minimum("0.166.2+26.3", Some("0.145.1")));
        assert!(satisfies_minimum("0.145.1+26.3", Some("0.145.1+1.21")));
        assert!(!satisfies_minimum("0.99.9+26.3", Some("0.100.0")));
        assert!(!satisfies_minimum("0.145.1-beta.1", Some("0.145.1")));
        assert!(satisfies_minimum("0.145.1", Some("0.145.1-beta.1")));
        assert!(!satisfies_minimum("unknown", None));
        assert!(!satisfies_minimum("0.166.2", Some("???")));
    }

    #[test]
    fn fabric_predicates_cover_actual_fabric_api_ranges() {
        for (predicate, version, expected) in [
            ("~26.3-", "26.3", true),
            ("~26.3-", "26.4", false),
            (">=1.21- <1.21.2-", "1.21.1", true),
            (">=1.21- <1.21.2-", "1.21.2", false),
            (">=1.20 <1.20.2-", "1.20.1", true),
            ("1.19.2", "1.19.3", false),
            (">=0.19.3", "0.19.2", false),
            (">=0.19.3", "0.19.3", true),
            (">=25", "25", true),
            (">=25", "21", false),
            (">=bad", "25", false),
        ] {
            assert_eq!(
                matches_predicate(&json!(predicate), version),
                expected,
                "{predicate} / {version}"
            );
        }
        assert!(matches_predicate(&json!(["1.20.1", "1.21.1"]), "1.21.1"));
        assert!(!matches_predicate(&json!(["1.20.1", "1.21.1"]), "1.21.2"));
    }

    #[test]
    fn manifest_identity_minecraft_loader_java_and_minimum_are_required() {
        let tmp = TestDir::new();
        let path = tmp.0.join("example.jar");
        fs::write(&path, jar_bytes(&manifest("0.166.2+26.3"), None)).unwrap();
        let good = request();
        assert!(candidate_manifest(&path, &good).is_ok());
        let mut bad = good.clone();
        bad.java_major = Some(21);
        assert!(candidate_manifest(&path, &bad).is_err());
        let mut bad = good.clone();
        bad.java_major = None;
        assert!(candidate_manifest(&path, &bad).is_err());
        let mut bad = good.clone();
        bad.loader_version = "0.19.2".into();
        assert!(candidate_manifest(&path, &bad).is_err());
        let mut bad = good.clone();
        bad.mc_version = "26.4".into();
        assert!(candidate_manifest(&path, &bad).is_err());
        let mut bad = good.clone();
        bad.minimum = Some("0.200.0".into());
        assert!(candidate_manifest(&path, &bad).is_err());
        let mut bad = good.clone();
        bad.mod_id = "different-mod".into();
        assert!(candidate_manifest(&path, &bad).is_err());
        let mut server = manifest("0.166.2");
        server["environment"] = json!("server");
        fs::write(&path, jar_bytes(&server, None)).unwrap();
        assert!(candidate_manifest(&path, &good).is_err());
    }

    #[test]
    fn scans_disabled_and_nested_files_and_does_not_enable_unproven_files() {
        let tmp = TestDir::new();
        let mods = tmp.0.join("mods");
        fs::create_dir(&mods).unwrap();
        let disabled = mods.join("old.jar.disabled");
        let bytes = jar_bytes(&manifest("0.166.2+26.3"), None);
        fs::write(&disabled, &bytes).unwrap();
        let scan = scan_existing(&mods, &request()).unwrap();
        assert_eq!(scan.len(), 1);
        assert!(scan[0].disabled && scan[0].compatible && !scan[0].nested);
        assert_eq!(scan[0].sha256, file_sha256(&disabled).unwrap());
        let child = jar_bytes(&manifest("0.166.2+26.3"), None);
        let parent = json!({"schemaVersion":1,"id":"parent","version":"1.0.0","jars":[{"file":"nested/api.jar"}]});
        fs::write(
            mods.join("parent.jar"),
            jar_bytes(&parent, Some(("nested/api.jar", &child))),
        )
        .unwrap();
        let scan = scan_existing(&mods, &request()).unwrap();
        assert_eq!(scan.len(), 2);
        assert!(scan.iter().any(|item| item.nested && !item.compatible));
        fs::remove_file(mods.join("parent.jar")).unwrap();
        let mut no_mc = manifest("0.166.2+26.3");
        no_mc["depends"]
            .as_object_mut()
            .unwrap()
            .remove("minecraft");
        fs::write(&disabled, jar_bytes(&no_mc, None)).unwrap();
        assert!(!scan_existing(&mods, &request()).unwrap()[0].compatible);
    }

    #[test]
    fn enable_does_not_overwrite_existing_target_or_modified_file() {
        let tmp = TestDir::new();
        let mods = tmp.0.join("mods");
        fs::create_dir(&mods).unwrap();
        let disabled = mods.join("api.jar.disabled");
        let bytes = jar_bytes(&manifest("0.166.2+26.3"), None);
        fs::write(&disabled, &bytes).unwrap();
        let old = scan_existing(&mods, &request()).unwrap().remove(0);
        fs::write(mods.join("api.jar"), b"unrelated").unwrap();
        assert!(enable_existing(&mods, &old).is_err());
        assert_eq!(fs::read(mods.join("api.jar")).unwrap(), b"unrelated");
        assert_eq!(fs::read(&disabled).unwrap(), bytes);
        fs::remove_file(mods.join("api.jar")).unwrap();
        fs::write(&disabled, b"changed").unwrap();
        assert!(enable_existing(&mods, &old).is_err());
        fs::write(&disabled, &bytes).unwrap();
        assert_eq!(enable_existing(&mods, &old).unwrap(), "api.jar");
        assert!(!disabled.exists());
        assert_eq!(fs::read(mods.join("api.jar")).unwrap(), bytes);
    }

    #[test]
    fn replacement_makes_verified_backup_and_never_overwrites_unrelated_files() {
        let tmp = TestDir::new();
        let mods = tmp.0.join("minecraft").join("mods");
        fs::create_dir_all(&mods).unwrap();
        let old_path = mods.join("old.jar");
        let old_bytes = jar_bytes(&manifest("0.140.0+26.3"), None);
        fs::write(&old_path, &old_bytes).unwrap();
        let old = scan_existing(&mods, &request()).unwrap().remove(0);
        let download = tmp.0.join("new.jar");
        let new_bytes = jar_bytes(&manifest("0.166.2+26.3"), None);
        fs::write(&download, &new_bytes).unwrap();
        fs::write(mods.join("new.jar"), b"someone else").unwrap();
        assert!(commit_file(&mods, &download, "new.jar", Some(&old)).is_err());
        assert_eq!(fs::read(&old_path).unwrap(), old_bytes);
        assert_eq!(fs::read(mods.join("new.jar")).unwrap(), b"someone else");
        fs::remove_file(mods.join("new.jar")).unwrap();
        fs::write(&old_path, b"changed").unwrap();
        assert!(commit_file(&mods, &download, "new.jar", Some(&old)).is_err());
        assert_eq!(fs::read(&old_path).unwrap(), b"changed");
        fs::write(&old_path, &old_bytes).unwrap();
        let backup = commit_file(&mods, &download, "new.jar", Some(&old))
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(backup).unwrap(), old_bytes);
        assert!(!old_path.exists());
        assert_eq!(fs::read(mods.join("new.jar")).unwrap(), new_bytes);
    }

    #[test]
    fn temporary_guard_never_removes_an_existing_file() {
        let tmp = TestDir::new();
        let existing = tmp.0.join("collision.tmp");
        fs::write(&existing, b"not ours").unwrap();
        assert!(TempPath::create(existing.clone()).is_err());
        assert_eq!(fs::read(&existing).unwrap(), b"not ours");
        let owned = tmp.0.join("ours.tmp");
        let (guard, file) = TempPath::create(owned.clone()).unwrap();
        drop(file);
        drop(guard);
        assert!(!owned.exists());
    }

    #[test]
    fn sha512_size_and_untrusted_names_are_checked() {
        let tmp = TestDir::new();
        let path = tmp.0.join("file.jar");
        fs::write(&path, b"good file").unwrap();
        let hash = hex::encode(Sha512::digest(b"good file"));
        assert!(verify_download(&path, 9, &hash).is_ok());
        assert!(verify_download(&path, 8, &hash).is_err());
        assert!(verify_download(&path, 9, &"0".repeat(128)).is_err());
        assert!(valid_filename("fabric-api-0.166.2+26.3.jar"));
        assert!(valid_filename("Мод [1.21.1].jar"));
        for bad in [
            "../api.jar",
            "foo\\bar.jar",
            "CON.jar",
            "COM¹.jar",
            "api.jar:evil",
            "evil?.jar",
            "fake.zip",
        ] {
            assert!(!valid_filename(bad), "{bad}");
        }
        assert!(allowed_file_url(
            "https://cdn.modrinth.com/data/a/versions/b/api.jar"
        ));
        for bad in [
            "http://cdn.modrinth.com/test",
            "https://cdn.modrinth.com.evil.test/test",
            "https://user@cdn.modrinth.com/test",
        ] {
            assert!(!allowed_file_url(bad));
        }
    }

    #[test]
    fn changed_profile_and_unsupported_ids_are_rejected() {
        let meta = instance();
        let good = request();
        assert!(validate_profile(&meta, &good).is_ok());
        let mut bad = good.clone();
        bad.mc_version = "26.2".into();
        assert!(validate_profile(&meta, &bad).is_err());
        let mut bad = good.clone();
        bad.loader_version = "0.20.0".into();
        assert!(validate_profile(&meta, &bad).is_err());
        let mut bad = good.clone();
        bad.mod_id = "../evil".into();
        assert!(validate_profile(&meta, &bad).is_err());
        let mut bad = good.clone();
        bad.minimum = Some("invalid".into());
        assert!(validate_profile(&meta, &bad).is_err());
    }

    #[test]
    fn catalogue_version_label_is_not_the_version_inside_a_jar() {
        let version: ModVersion = serde_json::from_value(json!({
            "id":"v1", "project_id":"project", "version_number":"mc1.21.1-0.8.13-fabric",
            "game_versions":["1.21.1"], "loaders":["fabric"]
        }))
        .unwrap();
        let mut req = request();
        req.mc_version = "1.21.1".into();
        assert!(acceptable_version(&version, "project", &req));
        assert!(!acceptable_version(&version, "different-project", &req));
        req.mc_version = "1.20.1".into();
        assert!(!acceptable_version(&version, "project", &req));
    }

    #[test]
    fn snapshot_detects_mod_files_changed_after_launch() {
        let tmp = TestDir::new();
        let mods = tmp.0.join("mods");
        fs::create_dir(&mods).unwrap();
        let before = snapshot_mods(&mods).unwrap();
        fs::write(mods.join("api.jar.disabled"), b"1").unwrap();
        assert_ne!(snapshot_mods(&mods).unwrap(), before);
        let before = snapshot_mods(&mods).unwrap();
        fs::write(mods.join("api.jar.disabled"), b"new contents").unwrap();
        assert_ne!(snapshot_mods(&mods).unwrap(), before);
        let before = snapshot_mods(&mods).unwrap();
        fs::write(mods.join("not-a-mod.txt"), b"unrelated").unwrap();
        assert_eq!(snapshot_mods(&mods).unwrap(), before);
    }

    #[tokio::test]
    async fn explicit_confirmation_must_match_the_file_hash() {
        let tmp = TestDir::new();
        let paths = Paths::new(tmp.0.join("home")).unwrap();
        let meta = instance();
        instances::save(&paths, &meta).unwrap();
        let mods = instances::game_dir_for(&paths, &meta).join("mods");
        fs::create_dir_all(&mods).unwrap();
        let old = jar_bytes(&manifest("0.140.0+26.3"), None);
        fs::write(mods.join("old.jar"), &old).unwrap();
        let client = Modrinth::new(crate::net::Http::new());
        let reporter = Reporter::none();
        let mut req = request();
        let result = install_missing(&client, &paths, &meta, &req, &reporter)
            .await
            .unwrap();
        assert_eq!(result.status, "existing");
        assert_eq!(result.existing.len(), 1);
        req.replace_file = Some("old.jar".into());
        req.expected_sha256 = Some("wrong-hash".into());
        assert!(install_missing(&client, &paths, &meta, &req, &reporter)
            .await
            .is_err());
        assert_eq!(fs::read(mods.join("old.jar")).unwrap(), old);
        req.replace_file = None;
        req.enable_file = Some("old.jar".into());
        assert!(install_missing(&client, &paths, &meta, &req, &reporter)
            .await
            .is_err());
        assert_eq!(fs::read(mods.join("old.jar")).unwrap(), old);
    }

    #[tokio::test]
    #[ignore = "real Modrinth/CDN smoke test; run manually with network access"]
    async fn live_fabric_api_install_and_enable_without_duplicates() {
        crate::net::reset_cancel();
        let tmp = TestDir::new();
        let paths = Paths::new(tmp.0.join("home")).unwrap();
        let meta = instance();
        instances::save(&paths, &meta).unwrap();
        let client = Modrinth::new(crate::net::Http::new());
        let reporter = Reporter::none();
        let mut req = request();
        let installed = install_missing(&client, &paths, &meta, &req, &reporter)
            .await
            .unwrap();
        assert_eq!(installed.status, "installed");
        assert!(installed.record_saved);
        let mods = instances::game_dir_for(&paths, &meta).join("mods");
        let filename = installed.filename.unwrap();
        assert!(mods.join(&filename).exists());
        println!(
            "real Fabric API: {filename} / {}",
            installed.version.as_deref().unwrap_or("unknown")
        );
        let mut wrong_java = req.clone();
        wrong_java.java_major = Some(21);
        assert!(
            candidate_manifest(&mods.join(&filename), &wrong_java).is_err(),
            "real JAR rejects outdated Java"
        );
        let mut wrong_loader = req.clone();
        wrong_loader.loader_version = "0.19.2".into();
        assert!(
            candidate_manifest(&mods.join(&filename), &wrong_loader).is_err(),
            "real JAR rejects outdated Fabric Loader"
        );
        let existing = install_missing(&client, &paths, &meta, &req, &reporter)
            .await
            .unwrap();
        assert_eq!(existing.status, "existing");
        assert_eq!(existing.existing.len(), 1);
        assert!(existing.existing[0].compatible);
        fs::rename(
            mods.join(&filename),
            mods.join(format!("{filename}.disabled")),
        )
        .unwrap();
        let existing = install_missing(&client, &paths, &meta, &req, &reporter)
            .await
            .unwrap();
        let disabled = &existing.existing[0];
        assert!(disabled.disabled && disabled.compatible);
        req.enable_file = Some(disabled.name.clone());
        req.expected_sha256 = Some(disabled.sha256.clone());
        let enabled = install_missing(&client, &paths, &meta, &req, &reporter)
            .await
            .unwrap();
        assert_eq!(enabled.status, "enabled");
        assert!(mods.join(&filename).exists());
        assert!(!mods.join(format!("{filename}.disabled")).exists());
    }

    #[tokio::test]
    #[ignore = "real Modrinth/CDN smoke test; run manually with network access"]
    async fn live_sodium_uses_manifest_version_not_freeform_catalogue_label() {
        crate::net::reset_cancel();
        let tmp = TestDir::new();
        let paths = Paths::new(tmp.0.join("home")).unwrap();
        let mut meta = instance();
        meta.mc_version = "1.21.1".into();
        meta.loader = Loader::Fabric {
            version: "0.16.10".into(),
        };
        instances::save(&paths, &meta).unwrap();
        let mut req = request();
        req.mod_id = "sodium".into();
        req.minimum = Some("0.8.0".into());
        req.mc_version = "1.21.1".into();
        req.loader_version = "0.16.10".into();
        req.java_major = Some(21);
        let installed = install_missing(
            &Modrinth::new(crate::net::Http::new()),
            &paths,
            &meta,
            &req,
            &Reporter::none(),
        )
        .await
        .unwrap();
        assert_eq!(installed.status, "installed");
        assert!(installed.has_other_dependencies);
        assert!(satisfies_minimum(
            installed.version.as_deref().unwrap(),
            req.minimum.as_deref()
        ));
        println!(
            "real Sodium: {} / {}",
            installed.filename.unwrap(),
            installed.version.unwrap()
        );
    }
}
