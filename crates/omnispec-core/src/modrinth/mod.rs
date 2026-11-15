//! Клиент Modrinth API v2: поиск, проекты, версии, установка модов и модпаков.
//!
//! CurseForge здесь намеренно отсутствует: его API требует ключ и подпись
//! каждого запроса. Интерфейс ядра (`search`, `versions`, `install`) сделан так,
//! чтобы позже добавить его как второй источник рядом с Modrinth.

pub mod install;
pub mod mrpack;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::net::Http;

pub const BASE_URL: &str = "https://api.modrinth.com/v2";

#[derive(Clone)]
pub struct Modrinth {
    http: Http,
}

impl Modrinth {
    pub fn new(http: Http) -> Self {
        Self { http }
    }

    pub fn http(&self) -> &Http {
        &self.http
    }

    /// Поиск проектов (моды, модпаки, шейдеры, ресурспаки).
    pub async fn search(&self, query: &SearchQuery) -> Result<SearchResults> {
        let mut facets: Vec<Vec<String>> = Vec::new();
        if !query.project_type.trim().is_empty() {
            facets.push(vec![format!("project_type:{}", query.project_type)]);
        }
        // загрузчик (fabric/forge/…) имеет смысл только для модов и модпаков:
        // у ресурспаков и шейдеров такого тега нет, и фильтр по нему возвращал моды
        let loader_matters = matches!(query.project_type.trim(), "" | "mod" | "modpack");
        if loader_matters {
            if let Some(loader) = &query.loader {
                if !loader.trim().is_empty() && loader != "vanilla" {
                    facets.push(vec![format!("categories:{loader}")]);
                }
            }
        }
        if let Some(game_version) = &query.game_version {
            if !game_version.trim().is_empty() {
                facets.push(vec![format!("versions:{game_version}")]);
            }
        }
        for category in &query.categories {
            facets.push(vec![format!("categories:{category}")]);
        }

        let facets_json = serde_json::to_string(&facets)?;
        let limit = query.limit.clamp(1, 100).to_string();
        let offset = query.offset.to_string();
        let index = if query.sort.trim().is_empty() {
            "relevance".to_string()
        } else {
            query.sort.clone()
        };

        let params: Vec<(&str, &str)> = vec![
            ("query", query.query.as_str()),
            ("limit", limit.as_str()),
            ("offset", offset.as_str()),
            ("index", index.as_str()),
            ("facets", facets_json.as_str()),
        ];

        let url = format!("{BASE_URL}/search");
        let response = self
            .http
            .inner()
            .get(&url)
            .query(&params)
            .send()
            .await
            .map_err(|error| crate::error::Error::http(&url, error))?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error::Other(format!("Modrinth /search → HTTP {status}")));
        }
        Ok(response.json::<SearchResults>().await?)
    }

    pub async fn project(&self, id_or_slug: &str) -> Result<Project> {
        let url = format!("{BASE_URL}/project/{id_or_slug}");
        self.http.get_json(&url).await
    }

    /// Версии проекта с фильтрами по версии игры и загрузчику.
    pub async fn project_versions(
        &self,
        id_or_slug: &str,
        game_version: Option<&str>,
        loader: Option<&str>,
    ) -> Result<Vec<Version>> {
        let url = format!("{BASE_URL}/project/{id_or_slug}/version");
        let mut params: Vec<(&str, String)> = Vec::new();
        if let Some(game_version) = game_version {
            if !game_version.trim().is_empty() {
                params.push(("game_versions", serde_json::to_string(&vec![game_version])?));
            }
        }
        if let Some(loader) = loader {
            let loaders: Vec<String> = match loader {
                "fabric" => vec!["fabric".into()],
                "quilt" => vec!["quilt".into(), "fabric".into()],
                "forge" => vec!["forge".into()],
                "neoforge" => vec!["neoforge".into(), "forge".into()],
                _ => vec![],
            };
            if !loaders.is_empty() {
                params.push(("loaders", serde_json::to_string(&loaders)?));
            }
        }
        let response = self
            .http
            .inner()
            .get(&url)
            .query(&params)
            .send()
            .await
            .map_err(|error| crate::error::Error::http(&url, error))?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error::Other(format!(
                "Modrinth /project/{id_or_slug}/version → HTTP {status}"
            )));
        }
        Ok(response.json::<Vec<Version>>().await?)
    }

    /// Версия по SHA-1 файла: так узнаём, что за мод уже лежит в папке.
    pub async fn version_file_by_hash(&self, hash: &str) -> Result<Version> {
        let url = format!("{BASE_URL}/version_file/{hash}?algorithm=sha1");
        self.http.get_json(&url).await
    }

    pub async fn version(&self, version_id: &str) -> Result<Version> {
        let url = format!("{BASE_URL}/version/{version_id}");
        self.http.get_json(&url).await
    }

    /// Версии модпака для конкретной загрузки в удобном виде.
    pub async fn modpack_versions(&self, id_or_slug: &str) -> Result<Vec<Version>> {
        self.project_versions(id_or_slug, None, None).await
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SearchQuery {
    pub query: String,
    /// "mod" | "modpack" | "resourcepack" | "shader" | "datapack"
    pub project_type: String,
    pub game_version: Option<String>,
    pub loader: Option<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub sort: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub limit: u32,
    #[serde(default)]
    pub total_hits: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub project_id: String,
    #[serde(default)]
    pub project_type: String,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub author: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub display_categories: Vec<String>,
    #[serde(default)]
    pub versions: Vec<String>,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub follows: u64,
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub date_modified: Option<String>,
    #[serde(default)]
    pub latest_version: Option<String>,
    #[serde(default)]
    pub client_side: Option<String>,
    #[serde(default)]
    pub server_side: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    #[serde(default)]
    pub slug: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub project_type: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub followers: u64,
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub issues_url: Option<String>,
    #[serde(default)]
    pub wiki_url: Option<String>,
    #[serde(default)]
    pub discord_url: Option<String>,
    #[serde(default)]
    pub game_versions: Vec<String>,
    #[serde(default)]
    pub loaders: Vec<String>,
    #[serde(default)]
    pub gallery: Vec<GalleryImage>,
    #[serde(default)]
    pub license: Option<License>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GalleryImage {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub featured: bool,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct License {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Version {
    pub id: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version_number: String,
    #[serde(default)]
    pub version_type: String,
    #[serde(default)]
    pub game_versions: Vec<String>,
    #[serde(default)]
    pub loaders: Vec<String>,
    #[serde(default)]
    pub date_published: Option<String>,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub files: Vec<VersionFile>,
    #[serde(default)]
    pub dependencies: Vec<Dependency>,
}

impl Version {
    pub fn primary_file(&self) -> Option<&VersionFile> {
        self.files
            .iter()
            .find(|file| file.primary)
            .or_else(|| self.files.first())
    }

    pub fn modpack_file(&self) -> Option<&VersionFile> {
        self.files
            .iter()
            .find(|file| file.filename.ends_with(".mrpack"))
            .or_else(|| self.primary_file())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionFile {
    #[serde(default)]
    pub hashes: HashMap<String, String>,
    pub url: String,
    pub filename: String,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dependency {
    #[serde(default)]
    pub version_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    /// "required" | "optional" | "incompatible" | "embedded"
    #[serde(default)]
    pub dependency_type: String,
}
