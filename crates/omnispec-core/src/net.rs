//! HTTP-клиент, загрузка файлов и отчёты о прогрессе.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{Error, Result};

/// Глобальный флаг отмены текущей загрузки (панель загрузок в UI).
/// Операции идут по одной, поэтому одного флага достаточно: он сбрасывается
/// в начале каждой крупной операции и проверяется в циклах скачивания.
static CANCELLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Сбросить флаг отмены (вызывать перед стартом новой операции).
pub fn reset_cancel() {
    CANCELLED.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Отменить текущую загрузку (кнопка в панели загрузок).
pub fn cancel_current() {
    CANCELLED.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Проверен ли флаг отмены.
pub fn is_cancelled() -> bool {
    CANCELLED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Ошибка, если загрузку отменили.
fn check_cancel() -> Result<()> {
    if is_cancelled() {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

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
    /// Байт скачано в текущем файле (0 — не байтовый прогресс).
    #[serde(default)]
    pub bytes_done: u64,
    /// Размер текущего файла в байтах (0 — неизвестен).
    #[serde(default)]
    pub bytes_total: u64,
    /// Имя текущего файла (для построчного прогресса в панели загрузок).
    #[serde(default)]
    pub file: String,
    /// Состояние операции: "active" | "done" | "cancelled" | "error".
    #[serde(default)]
    pub state: String,
    /// Идентификатор операции (панель загрузок группирует события по нему).
    #[serde(default)]
    pub op: String,
}

pub type ProgressFn = Arc<dyn Fn(ProgressEvent) + Send + Sync>;

/// Обёртка над колбэком прогресса.
#[derive(Clone, Default)]
pub struct Reporter {
    callback: Option<ProgressFn>,
    stage: Option<String>,
    op: Option<String>,
}

impl Reporter {
    pub fn new(callback: impl Fn(ProgressEvent) + Send + Sync + 'static) -> Self {
        Self {
            callback: Some(Arc::new(callback)),
            stage: None,
            op: None,
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

    /// Идентификатор операции (для панели загрузок и отмены).
    pub fn with_op(mut self, op: impl Into<String>) -> Self {
        self.op = Some(op.into());
        self
    }

    pub fn op(&self) -> Option<&str> {
        self.op.as_deref()
    }

    pub fn emit(&self, stage: &str, done: u64, total: u64, detail: impl Into<String>) {
        if let Some(cb) = &self.callback {
            cb(ProgressEvent {
                stage: stage.to_string(),
                done,
                total,
                detail: detail.into(),
                bytes_done: 0,
                bytes_total: 0,
                file: String::new(),
                state: "active".to_string(),
                op: self.op.clone().unwrap_or_default(),
            });
        }
    }

    /// Байтовый прогресс одного файла: `done` из `total` байт.
    pub fn emit_bytes(&self, stage: &str, file: &str, done: u64, total: u64) {
        if let Some(cb) = &self.callback {
            cb(ProgressEvent {
                stage: stage.to_string(),
                done,
                total,
                detail: format!("{file}: {done}/{total} байт"),
                bytes_done: done,
                bytes_total: total,
                file: file.to_string(),
                state: "active".to_string(),
                op: self.op.clone().unwrap_or_default(),
            });
        }
    }

    /// Финальное состояние операции ("done" | "cancelled" | "error").
    pub fn emit_state(&self, stage: &str, state: &str, detail: impl Into<String>) {
        if let Some(cb) = &self.callback {
            cb(ProgressEvent {
                stage: stage.to_string(),
                done: 0,
                total: 0,
                detail: detail.into(),
                bytes_done: 0,
                bytes_total: 0,
                file: String::new(),
                state: state.to_string(),
                op: self.op.clone().unwrap_or_default(),
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
    /// Запасной клиент: только HTTP/1.1, без пула соединений.
    /// Нужен, когда сеть/прокси/антивирус ломают HTTP/2 — самая частая причина
    /// «error sending request» на Windows.
    fallback: reqwest::Client,
}

impl Default for Http {
    fn default() -> Self {
        Self::new()
    }
}

fn base_builder(proxy: Option<&str>) -> reqwest::ClientBuilder {
    let mut builder = reqwest::Client::builder()
        .user_agent(format!(
            "{}/{} (+https://github.com/omnispec)",
            crate::APP_NAME,
            crate::APP_VERSION
        ))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .pool_max_idle_per_host(32);
    if let Some(proxy) = proxy.map(str::trim).filter(|value| !value.is_empty()) {
        if let Ok(parsed) = reqwest::Proxy::all(proxy) {
            builder = builder.proxy(parsed);
        }
    }
    builder
}

impl Http {
    pub fn new() -> Self {
        Self::with_proxy(None)
    }

    /// Клиент с необязательным прокси (`http://host:port`, `socks5://…`).
    pub fn with_proxy(proxy: Option<&str>) -> Self {
        let client = base_builder(proxy).build().unwrap_or_default();
        let fallback = base_builder(proxy)
            .http1_only()
            .pool_max_idle_per_host(0)
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_default();
        Self { client, fallback }
    }

    /// GET с повторами: первая попытка обычная, дальше — запасной HTTP/1.1-клиент.
    async fn send_get(&self, url: &str) -> Result<reqwest::Response> {
        let mut last: Option<reqwest::Error> = None;
        for attempt in 0..3u64 {
            let client = if attempt == 0 { &self.client } else { &self.fallback };
            match client.get(url).send().await {
                Ok(response) => return Ok(response),
                Err(error) => {
                    // повторяем только транспортные сбои: таймаут, обрыв, DNS
                    let retriable = error.is_timeout() || error.is_connect() || error.is_request();
                    last = Some(error);
                    if !retriable {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * (attempt + 1))).await;
                }
            }
        }
        match last {
            Some(error) => Err(Error::http(url, error)),
            None => Err(Error::Other(format!("не удалось выполнить запрос к {url}"))),
        }
    }

    /// Проверка связи: возвращает HTTP-код или понятную ошибку.
    pub async fn probe(&self, url: &str) -> Result<u16> {
        let response = self.send_get(url).await?;
        Ok(response.status().as_u16())
    }

    /// Доступ к внутреннему reqwest-клиенту (нужен для query-параметров Modrinth).
    pub fn inner(&self) -> &reqwest::Client {
        &self.client
    }

    pub async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T> {
        let text = self.get_text(url).await?;
        serde_json::from_str(&text).map_err(Error::from)
    }

    /// POST с телом `application/x-www-form-urlencoded` (OAuth-обмен токенов).
    pub async fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<String> {
        let response = self
            .client
            .post(url)
            .form(form)
            .send()
            .await
            .map_err(|error| Error::http(url, error))?;
        Ok(response.text().await?)
    }

    /// POST с JSON-телом; возвращает текст ответа (даже при 4xx — его разбирает вызывающий).
    pub async fn post_json(&self, url: &str, body: &serde_json::Value) -> Result<String> {
        let response = self
            .client
            .post(url)
            .json(body)
            .send()
            .await
            .map_err(|error| Error::http(url, error))?;
        Ok(response.text().await?)
    }

    /// GET с заголовком `Authorization: Bearer`.
    pub async fn get_with_bearer(&self, url: &str, token: &str) -> Result<String> {
        let response = self
            .client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| Error::http(url, error))?;
        if !response.status().is_success() {
            return Err(Error::Other(format!("{url} → HTTP {}", response.status())));
        }
        Ok(response.text().await?)
    }

    pub async fn get_text(&self, url: &str) -> Result<String> {
        let response = self.send_get(url).await?;
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
        // Тело читаем внутри цикла: обрыв соединения посреди стрима
        // («error decoding response body») не должен ронять скачивание —
        // повторяем, дальше — запасным HTTP/1.1-клиентом.
        let mut last: Option<Error> = None;
        for attempt in 0..3u64 {
            let client = if attempt == 0 { &self.client } else { &self.fallback };
            let bytes = async {
                let response = client.get(url).send().await?;
                let status = response.status();
                if !status.is_success() {
                    return Err(Error::Other(format!("{url} → HTTP {status}")));
                }
                Ok::<Vec<u8>, Error>(response.bytes().await?.to_vec())
            }
            .await;
            match bytes {
                Ok(bytes) => return Ok(bytes),
                Err(error) => {
                    last = Some(error);
                    tokio::time::sleep(Duration::from_millis(300 * (attempt + 1))).await;
                }
            }
        }
        Err(last.unwrap_or_else(|| Error::Other(format!("не удалось скачать {url}"))))
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
        self.download_inner(url, dest, expected_size, sha1, force, None, None)
            .await
    }

    /// Скачать файл с байтовым прогрессом: `on_progress(скачано, всего)`.
    pub async fn download_tracked(
        &self,
        url: &str,
        dest: &Path,
        expected_size: Option<u64>,
        sha1: Option<&str>,
        force: bool,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<bool> {
        self.download_inner(url, dest, expected_size, sha1, force, None, Some(on_progress))
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
        self.download_inner(url, dest, expected_size, None, true, token, None)
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
        on_progress: Option<&(dyn Fn(u64, u64) + Send + Sync)>,
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
        // Повторы: обрыв тела ответа посреди стрима («error decoding response
        // body») — частая беда на Windows-сетях. Первая попытка обычным
        // клиентом, дальше — запасной HTTP/1.1 без пула.
        let mut last: Option<Error> = None;
        for attempt in 0..3u64 {
            check_cancel()?;
            let client = if attempt == 0 { &self.client } else { &self.fallback };
            match self
                .download_once(client, url, dest, sha1, token, on_progress)
                .await
            {
                Ok(downloaded) => return Ok(downloaded),
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(error) => {
                    let _ = tokio::fs::remove_file(dest.with_extension("omnispec-part")).await;
                    last = Some(error);
                    tokio::time::sleep(Duration::from_millis(300 * (attempt + 1))).await;
                }
            }
        }
        Err(last.unwrap_or_else(|| Error::Other(format!("не удалось скачать {url}"))))
    }

    /// Одна попытка скачивания файла во временный `.omnispec-part` + rename.
    /// `on_progress` получает (скачано_байт, всего_байт) — для панели загрузок.
    async fn download_once(
        &self,
        client: &reqwest::Client,
        url: &str,
        dest: &Path,
        sha1: Option<&str>,
        token: Option<&str>,
        on_progress: Option<&(dyn Fn(u64, u64) + Send + Sync)>,
    ) -> Result<bool> {
        check_cancel()?;
        let tmp = dest.with_extension("omnispec-part");
        let mut request = client.get(url);
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
        let total = response.content_length().unwrap_or(0);
        let mut file = tokio::fs::File::create(&tmp).await?;
        let mut stream = response.bytes_stream();
        use tokio::io::AsyncWriteExt;
        let mut downloaded: u64 = 0;
        let mut last_report = std::time::Instant::now();
        while let Some(chunk) = stream.next().await {
            check_cancel()?;
            let chunk = chunk?;
            downloaded += chunk.len() as u64;
            file.write_all(&chunk).await?;
            // Троттлим события прогресса: не чаще раза в 100 мс.
            if let Some(cb) = on_progress {
                if last_report.elapsed() >= Duration::from_millis(100) {
                    cb(downloaded, total);
                    last_report = std::time::Instant::now();
                }
            }
        }
        if let Some(cb) = on_progress {
            cb(downloaded, total);
        }
        file.flush().await?;
        drop(file);
        tokio::fs::rename(&tmp, dest).await?;
        let _ = sha1;
        Ok(true)
    }

    /// Скачать много файлов параллельно с общим прогрессом.
    ///
    /// Сначала проверяем, что уже лежит на диске (по размеру): качаем только
    /// недостающее и честно докладываем «уже есть X, качаем Y». Во время
    /// загрузки шлём общий байтовый прогресс и построчные события по файлам.
    pub async fn download_all(
        &self,
        items: Vec<DownloadItem>,
        concurrency: usize,
        reporter: &Reporter,
        stage: &str,
    ) -> Result<()> {
        check_cancel()?;
        let total_files = items.len() as u64;
        if total_files == 0 {
            return Ok(());
        }

        // Предпроверка: что уже скачано (файл есть и размер совпал).
        let mut missing: Vec<DownloadItem> = Vec::new();
        let mut present: u64 = 0;
        for item in items {
            let ok = match (item.size, std::fs::metadata(&item.dest)) {
                (Some(size), Ok(meta)) => meta.len() == size,
                (None, Ok(meta)) => meta.len() > 0,
                _ => false,
            };
            if ok {
                present += 1;
            } else {
                missing.push(item);
            }
        }
        let total_bytes: u64 = missing.iter().filter_map(|item| item.size).sum();
        reporter.emit(
            stage,
            present,
            total_files,
            format!("проверка: уже есть {present}, скачиваем {}", missing.len()),
        );
        if missing.is_empty() {
            reporter.emit(stage, total_files, total_files, "все файлы на месте");
            return Ok(());
        }

        let client = self.clone();
        let reporter_clone = reporter.clone();
        let results: Vec<Result<()>> = futures::stream::iter(missing)
            .map(|item| {
                let client = client.clone();
                let reporter = reporter_clone.clone();
                let stage = stage.to_string();
                async move {
                    let file_name = item
                        .dest
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_else(|| item.dest.display().to_string());
                    // Построчный байтовый прогресс — UI рисует полосу по файлу.
                    let res = client
                        .download_tracked(
                            &item.url,
                            &item.dest,
                            item.size,
                            item.sha1.as_deref(),
                            false,
                            &|done, total| {
                                reporter.emit_bytes(&stage, &file_name, done, total);
                            },
                        )
                        .await
                        .map(|_| ());
                    reporter.emit(&stage, 0, 0, format!("файл: {file_name}"));
                    res
                }
            })
            .buffer_unordered(concurrency.max(1))
            .collect()
            .await;

        let mut done_files = present;
        for result in results {
            if let Err(Error::Cancelled) = result {
                reporter.emit_state(stage, "cancelled", "загрузка отменена");
                return Err(Error::Cancelled);
            }
            check_cancel().map_err(|_| {
                reporter.emit_state(stage, "cancelled", "загрузка отменена");
                Error::Cancelled
            })?;
            done_files += 1;
            reporter.emit(
                stage,
                done_files,
                total_files,
                format!("файлов {done_files}/{total_files}"),
            );
            result?;
        }
        reporter.emit(stage, total_files, total_files, "готово");
        reporter.emit_state(stage, "done", "готово");
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
