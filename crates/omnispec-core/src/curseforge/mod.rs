//! Клиент CurseForge API v1: поиск, проект, файлы и установка в сборку.
//!
//! Типы на выходе — те же, что у Modrinth ([`crate::modrinth::SearchHit`],
//! [`crate::modrinth::Project`], [`crate::modrinth::Version`]), поэтому интерфейс
//! рисует обе площадки одинаковыми карточками и панелями: источник — это только
//! набор полей рядом с `project_id`.
//!
//! Ключ берётся так: переменная окружения `CURSEFORGE_API_KEY`, иначе
//! [`DEFAULT_API_KEY`]. Запросы идут с заголовком `x-api-key`.

pub mod install;
pub mod modpack;

use std::collections::HashMap;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::modrinth::{
    Dependency, GalleryImage, Project, SearchHit, SearchQuery, SearchResults, Version, VersionFile,
};
use crate::net::Http;

pub const BASE_URL: &str = "https://api.curseforge.com/v1";

/// Игра Minecraft в терминах CurseForge.
pub const GAME_ID: u32 = 432;

pub const CLASS_MODS: u32 = 6;
pub const CLASS_MODPACKS: u32 = 4471;
pub const CLASS_RESOURCEPACKS: u32 = 12;
pub const CLASS_SHADERS: u32 = 6552;

/// Ключ по умолчанию. Переопределяется переменной окружения `CURSEFORGE_API_KEY`.
pub const DEFAULT_API_KEY: &str = "$2a$10$Zar/GcPjSHXx0Jp1qMZeMOPzP6efjqeLgRT9wlJNUi2cmntRRPrlK";

/// Откуда берём ключ: окружение важнее встроенного.
pub fn api_key() -> String {
    match std::env::var("CURSEFORGE_API_KEY") {
        Ok(key) if !key.trim().is_empty() => key.trim().to_string(),
        _ => DEFAULT_API_KEY.to_string(),
    }
}

#[derive(Clone)]
pub struct CurseForge {
    http: Http,
    key: String,
}

impl CurseForge {
    pub fn new(http: Http) -> Self {
        Self {
            http,
            key: api_key(),
        }
    }

    pub fn with_key(http: Http, key: impl Into<String>) -> Self {
        Self {
            http,
            key: key.into(),
        }
    }

    pub fn http(&self) -> &Http {
        &self.http
    }

    /// Есть ли ключ: без него вкладка честно скажет, что нужен ключ.
    pub fn has_key(&self) -> bool {
        !self.key.trim().is_empty()
    }

    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        params: &[(&str, String)],
    ) -> Result<T> {
        if !self.has_key() {
            return Err(Error::Other(
                "CurseForge: не задан API-ключ (переменная CURSEFORGE_API_KEY)".into(),
            ));
        }
        let response = self
            .http
            .inner()
            .get(url)
            .header("x-api-key", self.key.trim())
            .header("Accept", "application/json")
            .query(params)
            // Каталог не должен висеть несколько минут до автоповтора.
            .timeout(std::time::Duration::from_secs(25))
            .send()
            .await
            .map_err(|error| crate::error::Error::http(url, error))?;
        let status = response.status();
        if !status.is_success() {
            let hint = match status.as_u16() {
                401 | 403 => " — ключ CurseForge не принят",
                404 => " — не найдено на CurseForge",
                429 => " — слишком много запросов, подожди минуту",
                _ => "",
            };
            return Err(Error::Other(format!(
                "CurseForge {} → HTTP {status}{hint}",
                short(url)
            )));
        }
        let body = response.text().await?;
        serde_json::from_str(&body).map_err(|error| {
            Error::Other(format!(
                "CurseForge {}: непонятный ответ ({error})",
                short(url)
            ))
        })
    }

    async fn post<T: serde::de::DeserializeOwned>(
        &self, endpoint: &str, body: &serde_json::Value,
    ) -> Result<T> {
        if !self.has_key() { return Err(Error::other("CurseForge: не задан API-ключ")); }
        let url = format!("{BASE_URL}{endpoint}");
        let response = self.http.inner().post(&url).header("x-api-key", self.key.trim())
            .header("Accept", "application/json").json(body)
            .timeout(std::time::Duration::from_secs(25)).send().await
            .map_err(|error| Error::http(&url, error))?;
        if !response.status().is_success() {
            return Err(Error::other(format!("CurseForge {endpoint} → HTTP {}", response.status())));
        }
        Ok(response.json::<T>().await?)
    }

    /// Поиск модов, ресурспаков, шейдеров и модпаков.
    pub async fn search(&self, query: &SearchQuery) -> Result<SearchResults> {
        let project_type = if query.project_type.trim().is_empty() {
            "mod"
        } else {
            query.project_type.trim()
        };
        let page_size = query.limit.clamp(1, 50);
        let mut params: Vec<(&str, String)> = vec![
            ("gameId", GAME_ID.to_string()),
            ("classId", class_id_for(project_type).to_string()),
            ("index", query.offset.to_string()),
            ("pageSize", page_size.to_string()),
            ("sortField", sort_field(&query.sort).to_string()),
            ("sortOrder", "desc".into()),
        ];
        if !query.query.trim().is_empty() {
            params.push(("searchFilter", query.query.trim().to_string()));
        }
        if let Some(game_version) = &query.game_version {
            let value = game_version.trim();
            if !value.is_empty() && value != "любая" {
                params.push(("gameVersion", value.to_string()));
            }
        }
        if let Some(loader) = &query.loader {
            if let Some(kind) = loader_type(loader) {
                params.push(("modLoaderType", kind.to_string()));
            }
        }

        let url = format!("{BASE_URL}/mods/search");
        let response: SearchResponse = self.get(&url, &params).await?;
        let total = response.pagination.map(|page| page.total_count).unwrap_or(0);
        Ok(SearchResults {
            hits: response
                .data
                .iter()
                .map(|item| hit(item, project_type))
                .collect(),
            offset: query.offset,
            limit: page_size,
            total_hits: total,
        })
    }

    /// Один проект: иконка, скриншоты, категории, ссылки.
    pub async fn project(&self, id: &str) -> Result<Project> {
        let url = format!("{BASE_URL}/mods/{id}");
        let response: Envelope<CfMod> = self.get(&url, &[]).await?;
        Ok(project_of(&response.data))
    }

    /// Файлы (версии) проекта с фильтрами по версии игры и загрузчику.
    pub async fn files(
        &self,
        id: &str,
        game_version: Option<&str>,
        loader: Option<&str>,
    ) -> Result<Vec<Version>> {
        let mut params: Vec<(&str, String)> = vec![("pageSize", "50".into())];
        if let Some(game_version) = game_version {
            let value = game_version.trim();
            if !value.is_empty() && value != "любая" {
                params.push(("gameVersion", value.to_string()));
            }
        }
        if let Some(loader) = loader {
            if let Some(kind) = loader_type(loader) {
                params.push(("modLoaderType", kind.to_string()));
            }
        }
        let url = format!("{BASE_URL}/mods/{id}/files");
        let response: Envelope<Vec<CfFile>> = self.get(&url, &params).await?;
        Ok(response
            .data
            .iter()
            .map(|file| version_of(id, file))
            .collect())
    }

    /// Точные совпадения отпечатков; вызывающий код дополнительно сверяет SHA-1/MD5,
    /// потому что 32-битный fingerprint пропускает пробелы и может столкнуться.
    pub async fn fingerprint_matches(&self, fingerprints: &[u32]) -> Result<Vec<FingerprintMatch>> {
        let mut result = Vec::new();
        for chunk in fingerprints.chunks(500) {
            let response: Envelope<CfFingerprintResponse> = self.post(
                &format!("/fingerprints/{GAME_ID}"), &serde_json::json!({"fingerprints":chunk})
            ).await?;
            for item in response.data.exact_matches {
                let Some(fingerprint) = item.file.file_fingerprint else { continue; };
                if !chunk.contains(&fingerprint) || item.id == 0
                    || item.file.mod_id.is_some_and(|id| id != item.id)
                    || item.file.game_id.is_some_and(|id| id != GAME_ID) { continue; }
                result.push(FingerprintMatch {
                    fingerprint,
                    version: version_of(&item.id.to_string(), &item.file),
                });
            }
        }
        Ok(result)
    }

    /// Последний совместимый файл каждого проекта. Используем пакетные индексы
    /// и даты из полных файлов; ни filename, ни числовой порядок id не являются
    /// достоверным номером версии. Неполный ответ не подтверждает проект.
    pub async fn latest_compatible_files(
        &self, projects: &[u32], game_version: &str, loader: &str,
    ) -> Result<HashMap<String, String>> {
        let Some(loader_id) = loader_type(loader) else { return Ok(HashMap::new()); };
        let mut mods = Vec::new();
        for chunk in projects.chunks(100) {
            let response: Envelope<Vec<CfMod>> = self.post("/mods", &serde_json::json!({"modIds":chunk})).await?;
            mods.extend(response.data.into_iter().filter(|item| chunk.contains(&item.id)));
        }
        let indexes = compatible_indexes(&mods, game_version, loader_id);
        let mut file_ids: Vec<u32> = indexes.values().flatten().map(|(id, _)| *id).collect();
        file_ids.sort_unstable(); file_ids.dedup();
        let mut files = HashMap::new();
        for chunk in file_ids.chunks(100) {
            let response: Envelope<Vec<CfFile>> = self.post("/mods/files", &serde_json::json!({"fileIds":chunk})).await?;
            for file in response.data {
                if chunk.contains(&file.id) { files.insert(file.id, file); }
            }
        }
        Ok(choose_latest_compatible(indexes, &files, loader))
    }

    /// Один файл по id — когда версия выбрана вручную.
    pub async fn file(&self, mod_id: &str, file_id: &str) -> Result<Version> {
        let url = format!("{BASE_URL}/mods/{mod_id}/files/{file_id}");
        let response: Envelope<CfFile> = self.get(&url, &[]).await?;
        Ok(version_of(mod_id, &response.data))
    }

    /// Прямая ссылка на скачивание: у части проектов авторы её скрывают,
    /// тогда CurseForge отдаёт её отдельным запросом.
    pub async fn download_url(&self, mod_id: &str, file_id: &str) -> Result<String> {
        let url = format!("{BASE_URL}/mods/{mod_id}/files/{file_id}/download-url");
        let response: Envelope<String> = self.get(&url, &[]).await?;
        if response.data.trim().is_empty() {
            return Err(Error::Other(
                "CurseForge: автор запретил скачивание этого файла через лаунчеры".into(),
            ));
        }
        Ok(response.data)
    }
}

#[derive(Debug, Clone)]
pub struct FingerprintMatch {
    pub fingerprint: u32,
    pub version: Version,
}

// bool: индекс явно называет нужный загрузчик; остальные проверяем по полному файлу.
fn compatible_indexes(mods: &[CfMod], game_version: &str, loader: u32) -> HashMap<u32, Vec<(u32, bool)>> {
    let mut indexes = HashMap::new();
    for item in mods {
        if item.class_id.is_some_and(|id| id != CLASS_MODS) { continue; }
        let mut ids: HashMap<u32, bool> = HashMap::new();
        for index in item.latest_files_indexes.iter().filter(|index|
            index.game_version == game_version && index.file_id != 0
                && index.mod_loader.is_none_or(|kind| kind == 0 || kind == loader)
        ) {
            let explicit = index.mod_loader == Some(loader);
            ids.entry(index.file_id).and_modify(|value| *value |= explicit).or_insert(explicit);
        }
        if !ids.is_empty() {
            let mut ids: Vec<_> = ids.into_iter().collect();
            ids.sort_unstable_by_key(|(id, _)| *id);
            indexes.insert(item.id, ids);
        }
    }
    indexes
}

fn choose_latest_compatible(
    indexes: HashMap<u32, Vec<(u32, bool)>>, files: &HashMap<u32, CfFile>, loader: &str,
) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for (project, ids) in indexes {
        let mut latest = None;
        let mut complete = true;
        for (id, explicit) in ids {
            let Some(file) = files.get(&id) else { complete = false; break; };
            if file.mod_id != Some(project) || file.game_id.is_some_and(|game| game != GAME_ID) {
                complete = false; break;
            }
            let file_loaders: Vec<_> = file.game_versions.iter().filter(|value| is_loader_name(value))
                .map(normalize_loader).collect();
            if !file_loaders.is_empty() && !file_loaders.iter().any(|value| value == loader) {
                if explicit { complete = false; break; } // противоречие индекса и файла
                continue; // индекс без загрузчика относится к другому загрузчику
            }
            if !explicit && file_loaders.is_empty() {
                complete = false; break; // не знаем, не новее ли совместимый файл
            }
            let Some(date) = file.file_date.as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok()) else {
                complete = false; break;
            };
            let candidate = (date, id);
            if latest.as_ref().is_none_or(|current| candidate > *current) { latest = Some(candidate); }
        }
        if complete {
            if let Some((_, file_id)) = latest { result.insert(project.to_string(), file_id.to_string()); }
        }
    }
    result
}

/* ==================== преобразование в типы Modrinth ==================== */

fn project_of(item: &CfMod) -> Project {
    let project_type = project_type_of(item.class_id).to_string();
    Project {
        id: item.id.to_string(),
        slug: item.slug.clone(),
        title: item.name.clone(),
        description: item.summary.clone(),
        // тело описания CurseForge отдаёт отдельным запросом в виде HTML —
        // в окне сведений достаточно краткого описания и скриншотов
        body: item.summary.clone(),
        project_type,
        categories: item
            .categories
            .iter()
            .map(|category| category.name.clone())
            .collect(),
        downloads: item.download_count,
        followers: item.thumbs_up_count,
        icon_url: item.logo.as_ref().and_then(|logo| logo.thumbnail_url.clone()),
        source_url: item.links.as_ref().and_then(|links| links.website_url.clone()),
        issues_url: item.links.as_ref().and_then(|links| links.issues_url.clone()),
        wiki_url: item.links.as_ref().and_then(|links| links.wiki_url.clone()),
        discord_url: None,
        game_versions: {
            let mut versions: Vec<String> = item.latest_files.iter().flat_map(|file| {
                file.game_versions
                    .iter()
                    .filter(|value| !is_loader_name(value))
                    .cloned()
            }).collect();
            versions.sort();
            versions.dedup();
            versions.reverse();
            versions
        },
        loaders: {
            let mut loaders: Vec<String> = item
                .latest_files
                .iter()
                .flat_map(|file| file.game_versions.iter())
                .filter(|value| is_loader_name(value))
                .map(|value| normalize_loader(value))
                .collect();
            loaders.sort();
            loaders.dedup();
            loaders
        },
        gallery: item
            .screenshots
            .iter()
            .map(|shot| GalleryImage {
                url: shot
                    .thumbnail_url
                    .clone()
                    .filter(|value| !value.is_empty())
                    .or_else(|| shot.url.clone())
                    .unwrap_or_default(),
                featured: false,
                title: shot.title.clone(),
            })
            .filter(|shot| !shot.url.is_empty())
            .collect(),
        license: None,
    }
}

fn hit(item: &CfMod, project_type: &str) -> SearchHit {
    SearchHit {
        project_id: item.id.to_string(),
        project_type: project_type.to_string(),
        slug: item.slug.clone(),
        author: item
            .authors
            .first()
            .map(|author| author.name.clone())
            .unwrap_or_default(),
        title: item.name.clone(),
        description: item.summary.clone(),
        categories: item
            .categories
            .iter()
            .map(|category| category.name.to_lowercase())
            .collect(),
        display_categories: Vec::new(),
        versions: {
            let mut versions: Vec<String> = item
                .latest_files
                .iter()
                .flat_map(|file| file.game_versions.iter())
                .filter(|value| !is_loader_name(value))
                .cloned()
                .collect();
            versions.sort();
            versions.dedup();
            versions
        },
        downloads: item.download_count,
        follows: item.thumbs_up_count,
        icon_url: item.logo.as_ref().and_then(|logo| logo.thumbnail_url.clone()),
        date_modified: item.date_modified.clone(),
        latest_version: None,
        client_side: None,
        server_side: None,
    }
}

fn version_of(mod_id: &str, file: &CfFile) -> Version {
    let mut loaders: Vec<String> = file
        .game_versions
        .iter()
        .filter(|value| is_loader_name(value))
        .map(|value| normalize_loader(value))
        .collect();
    loaders.sort();
    loaders.dedup();
    let game_versions: Vec<String> = file
        .game_versions
        .iter()
        .filter(|value| !is_loader_name(value))
        .cloned()
        .collect();
    let mut hashes: HashMap<String, String> = HashMap::new();
    for hash in file.hashes.iter() {
        let name = match hash.algo {
            1 => "sha1",
            2 => "md5",
            _ => continue,
        };
        hashes.insert(name.to_string(), hash.value.clone());
    }
    Version {
        id: file.id.to_string(),
        project_id: mod_id.to_string(),
        name: if file.display_name.trim().is_empty() {
            file.file_name.clone()
        } else {
            file.display_name.clone()
        },
        version_number: file.file_name.clone(),
        version_type: match file.release_type {
            2 => "beta".to_string(),
            3 => "alpha".to_string(),
            _ => "release".to_string(),
        },
        game_versions,
        loaders,
        date_published: file.file_date.clone(),
        downloads: 0,
        files: vec![VersionFile {
            hashes,
            url: file.download_url.clone().unwrap_or_default(),
            filename: file.file_name.clone(),
            primary: true,
            size: file.file_length,
        }],
        dependencies: file
            .dependencies
            .iter()
            .map(|dependency| Dependency {
                version_id: None,
                project_id: Some(dependency.mod_id.to_string()),
                file_name: None,
                dependency_type: match dependency.relation_type {
                    3 => "required".to_string(),
                    2 => "optional".to_string(),
                    1 => "embedded".to_string(),
                    _ => "incompatible".to_string(),
                },
            })
            .collect(),
    }
}

/* ==================== мелочи ==================== */

/// classId в терминах лаунчера.
pub fn class_id_for(project_type: &str) -> u32 {
    match project_type {
        "resourcepack" | "resourcepack_pack" => CLASS_RESOURCEPACKS,
        "shader" | "shaders" => CLASS_SHADERS,
        "modpack" => CLASS_MODPACKS,
        _ => CLASS_MODS,
    }
}

fn project_type_of(class_id: Option<u32>) -> &'static str {
    match class_id {
        Some(CLASS_RESOURCEPACKS) => "resourcepack",
        Some(CLASS_SHADERS) => "shader",
        Some(CLASS_MODPACKS) => "modpack",
        _ => "mod",
    }
}

/// modLoaderType: 1 — Forge, 4 — Fabric, 5 — Quilt, 6 — NeoForge.
pub fn loader_type(loader: &str) -> Option<u32> {
    match loader.trim().to_lowercase().as_str() {
        "forge" => Some(1),
        "fabric" => Some(4),
        "quilt" => Some(5),
        "neoforge" => Some(6),
        _ => None,
    }
}

/// Сортировка CurseForge: 2 — популярность, 3 — обновлено, 6 — загрузки, 11 — новое.
pub fn sort_field(sort: &str) -> u32 {
    match sort.trim().to_lowercase().as_str() {
        "downloads" => 6,
        "updated" => 3,
        "newest" => 11,
        "follows" => 2,
        _ => 2,
    }
}

fn is_loader_name(value: impl AsRef<str>) -> bool {
    matches!(
        value.as_ref().trim().to_lowercase().as_str(),
        "forge" | "fabric" | "quilt" | "neoforge" | "neo-forge" | "rift" | "liteloader"
    )
}

fn normalize_loader(value: impl AsRef<str>) -> String {
    match value.as_ref().trim().to_lowercase().as_str() {
        "neo-forge" | "forgeneoforge" => "neoforge".to_string(),
        other => other.to_string(),
    }
}

fn short(url: &str) -> String {
    url.trim_start_matches(BASE_URL).to_string()
}

/* ==================== сырые ответы CurseForge ==================== */

#[derive(Debug, Clone, Deserialize)]
struct Envelope<T> {
    data: T,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResponse {
    #[serde(default)]
    data: Vec<CfMod>,
    #[serde(default)]
    pagination: Option<Pagination>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pagination {
    #[serde(default)]
    total_count: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfMod {
    id: u32,
    #[serde(default)]
    name: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    download_count: u64,
    #[serde(default)]
    thumbs_up_count: u64,
    #[serde(default)]
    class_id: Option<u32>,
    #[serde(default)]
    logo: Option<CfLogo>,
    #[serde(default)]
    categories: Vec<CfCategory>,
    #[serde(default)]
    authors: Vec<CfAuthor>,
    #[serde(default)]
    date_modified: Option<String>,
    #[serde(default)]
    latest_files: Vec<CfFile>,
    #[serde(default)]
    latest_files_indexes: Vec<CfFileIndex>,
    #[serde(default)]
    screenshots: Vec<CfScreenshot>,
    #[serde(default)]
    links: Option<CfLinks>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfLogo {
    #[serde(default)]
    thumbnail_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CfCategory {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CfAuthor {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfScreenshot {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    thumbnail_url: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CfLinks {
    #[serde(default)]
    website_url: Option<String>,
    #[serde(default)]
    issues_url: Option<String>,
    #[serde(default)]
    wiki_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfFileIndex {
    #[serde(default)]
    game_version: String,
    #[serde(default)]
    file_id: u32,
    #[serde(default)]
    mod_loader: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfFingerprintResponse {
    #[serde(default)]
    exact_matches: Vec<CfFingerprintMatch>,
}

#[derive(Debug, Clone, Deserialize)]
struct CfFingerprintMatch {
    id: u32,
    file: CfFile,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfFile {
    pub id: u32,
    #[serde(default)]
    mod_id: Option<u32>,
    #[serde(default)]
    game_id: Option<u32>,
    #[serde(default)]
    file_fingerprint: Option<u32>,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    release_type: u32,
    #[serde(default)]
    file_date: Option<String>,
    #[serde(default)]
    file_length: u64,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    hashes: Vec<CfHash>,
    #[serde(default)]
    dependencies: Vec<CfDependency>,
}

#[derive(Debug, Clone, Deserialize)]
struct CfHash {
    #[serde(default)]
    value: String,
    #[serde(default)]
    algo: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfDependency {
    #[serde(default)]
    mod_id: u32,
    #[serde(default)]
    relation_type: u32,
}

#[cfg(test)]
mod catalog_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn latest_index_selection_is_compatible_complete_and_uses_dates() {
        let mods: Vec<CfMod> = serde_json::from_value(json!([
            {"id":10,"classId":6,"latestFilesIndexes":[
                {"gameVersion":"1.21.1","fileId":100,"modLoader":4},
                {"gameVersion":"1.21.1","fileId":90,"modLoader":4},
                {"gameVersion":"1.21.1","fileId":999,"modLoader":1},
                {"gameVersion":"1.20.1","fileId":998,"modLoader":4}
            ]},
            {"id":11,"classId":6,"latestFilesIndexes":[
                {"gameVersion":"1.21.1","fileId":101,"modLoader":4},
                {"gameVersion":"1.21.1","fileId":102,"modLoader":4}
            ]},
            {"id":12,"classId":12,"latestFilesIndexes":[
                {"gameVersion":"1.21.1","fileId":103,"modLoader":4}
            ]},
            {"id":13,"classId":6,"latestFilesIndexes":[
                {"gameVersion":"1.21.1","fileId":110,"modLoader":4},
                {"gameVersion":"1.21.1","fileId":111}
            ]},
            {"id":14,"classId":6,"latestFilesIndexes":[
                {"gameVersion":"1.21.1","fileId":120,"modLoader":4},
                {"gameVersion":"1.21.1","fileId":121,"modLoader":0}
            ]},
            {"id":15,"classId":6,"latestFilesIndexes":[
                {"gameVersion":"1.21.1","fileId":130,"modLoader":4},
                {"gameVersion":"1.21.1","fileId":131}
            ]},
            {"id":16,"classId":6,"latestFilesIndexes":[
                {"gameVersion":"1.21.1","fileId":140,"modLoader":4}
            ]}
        ])).unwrap();
        let indexes = compatible_indexes(&mods, "1.21.1", 4);
        assert_eq!(indexes.get(&10), Some(&vec![(90,true),(100,true)]));
        assert!(!indexes.contains_key(&12));
        let files: Vec<CfFile> = serde_json::from_value(json!([
            {"id":100,"modId":10,"gameId":432,"fileDate":"2026-01-01T00:00:00.1Z"},
            {"id":90,"modId":10,"gameId":432,"fileDate":"2026-01-01T00:00:00.14Z"},
            {"id":101,"modId":11,"gameId":432,"fileDate":"2026-01-01T00:00:00Z"},
            {"id":110,"modId":13,"gameId":432,"fileDate":"2026-01-01T00:00:00Z"},
            {"id":111,"modId":13,"gameId":432,"fileDate":"2026-02-01T00:00:00Z","gameVersions":["Forge","1.21.1"]},
            {"id":120,"modId":14,"gameId":432,"fileDate":"2026-01-01T00:00:00Z"},
            {"id":121,"modId":14,"gameId":432,"fileDate":"2026-02-01T00:00:00Z","gameVersions":["1.21.1"]},
            {"id":130,"modId":15,"gameId":432,"fileDate":"2026-01-01T00:00:00Z"},
            {"id":131,"modId":15,"gameId":432,"fileDate":"2026-02-01T00:00:00Z","gameVersions":["Fabric","1.21.1"]},
            {"id":140,"modId":16,"gameId":432,"fileDate":"2026-01-01T00:00:00Z","gameVersions":["NeoForge","1.21.1"]}
        ])).unwrap();
        let files: HashMap<_,_> = files.into_iter().map(|file| (file.id,file)).collect();
        let result = choose_latest_compatible(indexes, &files, "fabric");
        assert_eq!(result.get("10").map(String::as_str), Some("90"), "время важнее числа fileId");
        assert!(!result.contains_key("11"), "неполный ответ не подтверждает актуальность");
        assert_eq!(result.get("13").map(String::as_str), Some("110"), "новый Forge-файл не считается Fabric");
        assert!(!result.contains_key("14"), "индекс без загрузчика может быть новее");
        assert_eq!(result.get("15").map(String::as_str), Some("131"), "загрузчик можно подтвердить по полному файлу");
        assert!(!result.contains_key("16"), "противоречие индекса и файла не подтверждает версию");
    }
}
