//! HTTP-клиент, загрузка файлов и отчёты о прогрессе.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{Error, Result};

/// Событие прогресса для UI.
#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    /// Этап: "version" | "libraries" | "assets" | "java" | "mods" | "modpack" | "launch"
    pub stage: String,
    /// Сколько уже сделано (файлов или байт).
    pub done: u64,
    /// Сколько всего (0 — неизвестно).
    pub total: u64,
    /// Что именно делаем прямо сейчас.
    pub detail: String,
}

pub type ProgressFn = Arc<dyn Fn(ProgressEvent) + Send + Sync>;

/// Обёртка над колбэком прогресса.
#[derive(Clone, Default)]
pub struct Reporter {
    callback: Option<ProgressFn>,
    stage: Option<String>,
}

impl Reporter {
    pub fn new(callback: impl Fn(ProgressEvent) + Send + Sync + 'static) -> Self {
        Self {
            callback: Some(Arc::new(callback)),
            stage: None,
        }
    }

    pub fn none() -> Self {
        Self::default()
    }

    /// Задать этап по умолчанию.
    pub fn with_stage(mut self, stage: &str) -> Self {
        self.stage = Some(stage.to_string());
        self
    }

    pub fn emit(&self, stage: &str, done: u64, total: u64, detail: impl Into<String>) {
        if let Some(cb) = &self.callback {
            cb(ProgressEvent {
                stage: stage.to_string(),
                done,
                total,
                detail: detail.into(),
            });
        }
    }

    /// Прогресс без явного этапа.
    pub fn tick(&self, done: u64, total: u64, detail: impl Into<String>) {
        let stage = self.stage.clone().unwrap_or_else(|| "progress".into());
        self.emit(&stage, done, total, detail);
    }

    pub fn has_listener(&self) -> bool {
        self.callback.is_some()
    }
}

#[derive(Clone)]
pub struct Http {
    client: reqwest::Client,
}

impl Default for Http {
    fn default() -> Self {
        Self::new()
    }
}

impl Http {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(format!(
                "{}/{} (+https://github.com/omnispec)",
                crate::APP_NAME,
                crate::APP_VERSION
            ))
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(300))
            .pool_max_idle_per_host(32)
            .build()
            .unwrap_or_default();
        Self { client }
    }

    /// Доступ к внутреннему reqwest-клиенту (нужен для query-параметров Modrinth).
    pub fn inner(&self) -> &reqwest::Client {
        &self.client
    }

    pub async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T> {
        let text = self.get_text(url).await?;
        serde_json::from_str(&text).map_err(Error::from)
    }

    pub async fn get_text(&self, url: &str) -> Result<String> {
        let response = self.client.get(url).send().await?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error::Other(format!("{url} → HTTP {status}")));
        }
        Ok(response.text().await?)
    }

    /// JSON-запрос с заголовками GitHub API (и токеном, если он задан).
    pub async fn get_json_with_token<T: DeserializeOwned>(
        &self,
        url: &str,
        token: Option<&str>,
    ) -> Result<T> {
        let mut request = self
            .client
            .get(url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(Error::Other(format!(
                "GitHub API {status}: {}",
                body.chars().take(300).collect::<String>()
            )));
        }
        Ok(response.json::<T>().await?)
    }

    pub async fn get_bytes(&self, url: &str) -> Result<Vec<u8>> {
        let response = self.client.get(url).send().await?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error::Other(format!("{url} → HTTP {status}")));
        }
        Ok(response.bytes().await?.to_vec())
    }

    /// Скачать файл. Если файл уже есть и совпадает по размеру — пропускаем.
    pub async fn download(
        &self,
        url: &str,
        dest: &Path,
        expected_size: Option<u64>,
        sha1: Option<&str>,
        force: bool,
    ) -> Result<bool> {
        self.download_inner(url, dest, expected_size, sha1, force, None)
            .await
    }

    /// Скачивание с заголовком `Authorization` (ассеты приватных релизов GitHub).
    pub async fn download_with_token(
        &self,
        url: &str,
        dest: &Path,
        expected_size: Option<u64>,
        token: Option<&str>,
    ) -> Result<bool> {
        self.download_inner(url, dest, expected_size, None, true, token)
            .await
    }

    async fn download_inner(
        &self,
        url: &str,
        dest: &Path,
        expected_size: Option<u64>,
        sha1: Option<&str>,
        force: bool,
        token: Option<&str>,
    ) -> Result<bool> {
        if !force && token.is_none() {
            if let Ok(meta) = tokio::fs::metadata(dest).await {
                let ok_size = match expected_size {
                    Some(size) => meta.len() == size,
                    None => meta.len() > 0,
                };
                if ok_size {
                    // файл уже есть — сверять SHA1 на каждом запуске дорого
                    return Ok(false);
                }
            }
        }

        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let tmp = dest.with_extension("omnispec-part");
        let mut request = self.client.get(url);
        if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
            request = request
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "application/octet-stream");
        }
        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error::Other(format!("{url} → HTTP {status}")));
        }
        let mut file = tokio::fs::File::create(&tmp).await?;
        let mut stream = response.bytes_stream();
        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        drop(file);
        tokio::fs::rename(&tmp, dest).await?;
        let _ = sha1;
        Ok(true)
    }

    /// Скачать много файлов параллельно с общим прогрессом.
    pub async fn download_all(
        &self,
        items: Vec<DownloadItem>,
        concurrency: usize,
        reporter: &Reporter,
        stage: &str,
    ) -> Result<()> {
        let total = items.len() as u64;
        if total == 0 {
            return Ok(());
        }
        let mut done = 0u64;
        reporter.emit(stage, 0, total, format!("файлов в очереди: {total}"));

        let client = self.clone();
        let reporter_clone = reporter.clone();
        let results: Vec<Result<()>> = futures::stream::iter(items)
            .map(|item| {
                let client = client.clone();
                let reporter = reporter_clone.clone();
                let stage = stage.to_string();
                async move {
                    let res = client
                        .download(&item.url, &item.dest, item.size, item.sha1.as_deref(), false)
                        .await
                        .map(|_| ());
                    reporter.emit(&stage, 0, 0, item.dest.display().to_string());
                    res
                }
            })
            .buffer_unordered(concurrency.max(1))
            .collect()
            .await;

        for result in results {
            done += 1;
            reporter.emit(stage, done, total, format!("{done}/{total}"));
            result?;
        }
        reporter.emit(stage, total, total, "готово");
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct DownloadItem {
    pub url: String,
    pub dest: PathBuf,
    pub size: Option<u64>,
    pub sha1: Option<String>,
}

impl DownloadItem {
    pub fn new(url: impl Into<String>, dest: impl Into<PathBuf>) -> Self {
        Self {
            url: url.into(),
            dest: dest.into(),
            size: None,
            sha1: None,
        }
    }

    pub fn with_size(mut self, size: Option<u64>) -> Self {
        self.size = size;
        self
    }

    pub fn with_sha1(mut self, sha1: Option<String>) -> Self {
        self.sha1 = sha1;
        self
    }
}
