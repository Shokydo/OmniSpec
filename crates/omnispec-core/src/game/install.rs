//! Установка файлов игры: клиентский jar, библиотеки, нативные библиотеки, ресурсы.

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;

use futures::StreamExt;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::net::{DownloadItem, Http, Reporter};
use crate::paths::Paths;

use super::version::{self, ResolvedVersion};

/// Что получилось после установки — используется запуском.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallReport {
    pub version_id: String,
    pub client_jar: PathBuf,
    pub classpath: Vec<PathBuf>,
    pub natives_dir: PathBuf,
    pub asset_index_id: Option<String>,
    pub assets_root: PathBuf,
    pub log_config: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
struct AssetObject {
    hash: String,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct AssetIndex {
    #[serde(default)]
    objects: HashMap<String, AssetObject>,
}

/// Гарантировать, что все файлы версии на месте (повторный вызов — быстрый).
pub async fn ensure_installed(
    http: &Http,
    paths: &Paths,
    version_id: &str,
    reporter: &Reporter,
) -> Result<InstallReport> {
    let resolved = super::resolve(http, paths, version_id).await?;
    ensure_installed_resolved(http, paths, &resolved, reporter).await
}

/// То же, но профиль уже разобран вызывающим — не разбираем его дважды.
/// Запуск игры идёт именно этим путём: `resolve` вызывается один раз.
pub async fn ensure_installed_resolved(
    http: &Http,
    paths: &Paths,
    resolved: &ResolvedVersion,
    reporter: &Reporter,
) -> Result<InstallReport> {
    let features = version::default_features();

    // 1. Клиентский jar
    reporter.emit("version", 0, 3, format!("профиль {}", resolved.id));
    let client_jar = paths.version_jar(&resolved.jar_id);
    // Forge/NeoForge не наследуют ванильный клиент (см. merge_chain): их
    // клиентский JAR (SRG/client-extra) ставит инсталлятор в папку библиотек,
    // а ModLauncher находит его сам. Ванильный JAR на classpath не нужен —
    // он даёт дубль модулей (_1._x и minecraft) и ResolutionException.
    let forge_like = resolved.id.to_lowercase().contains("forge");
    let has_client = resolved.client.is_some();
    if let Some(client) = resolved.client.clone() {
        http.download(
            &client.url,
            &client_jar,
            Some(client.size),
            client.sha1.as_deref(),
            false,
        )
        .await?;
        reporter.emit("version", 1, 3, "клиент игры загружен");
    } else if forge_like {
        reporter.emit("version", 1, 3, "клиент загрузчика (ванильный не нужен)");
    } else {
        return Err(Error::Other("в профиле нет ссылки на клиент игры".into()));
    }

    // 2. Библиотеки + нативные библиотеки
    let mut downloads: Vec<DownloadItem> = Vec::new();
    let mut classpath: Vec<PathBuf> = Vec::new();
    let natives_dir = paths.natives_dir(&resolved.id);
    std::fs::create_dir_all(&natives_dir)?;
    let mut native_jars: Vec<(PathBuf, Vec<String>)> = Vec::new();

    for library in resolved.libraries.iter() {
        if !library.applies(&features) {
            continue;
        }
        let relative = library.maven_path();
        let dest = paths.libraries().join(&relative);

        if let Some(artifact) = library.artifact() {
            downloads.push(
                DownloadItem::new(artifact.url.clone(), dest.clone())
                    .with_size(Some(artifact.size))
                    .with_sha1(artifact.sha1.clone()),
            );
            classpath.push(dest.clone());
        } else if let (Some(url), Some(base)) = (&library.url, maven_base(library)) {
            downloads.push(DownloadItem::new(
                format!("{}/{}", url.trim_end_matches('/'), base),
                dest.clone(),
            ));
            classpath.push(dest.clone());
        }

        // Старый формат нативных библиотек (до 1.19): отдельный classifier + распаковка.
        if let Some(classifier) = library.native_classifier() {
            if let Some(classifiers) = library
                .downloads
                .as_ref()
                .and_then(|d| d.classifiers.as_ref())
            {
                if let Some(artifact) = classifiers.get(&classifier) {
                    let native_dest = match &artifact.path {
                        Some(path) => paths.libraries().join(path),
                        None => paths.libraries().join(version::maven_coords_to_path(
                            &format!("{}:{}", library.name, classifier),
                        )),
                    };
                    downloads.push(
                        DownloadItem::new(artifact.url.clone(), native_dest.clone())
                            .with_size(Some(artifact.size))
                            .with_sha1(artifact.sha1.clone()),
                    );
                    let excludes = library
                        .extract
                        .as_ref()
                        .map(|extract| extract.exclude.clone())
                        .unwrap_or_default();
                    native_jars.push((native_dest, excludes));
                }
            }
        }
    }

    reporter.emit(
        "libraries",
        0,
        downloads.len() as u64,
        format!("библиотек: {}", downloads.len()),
    );
    // Больше параллельных запросов — быстрее первая установка (клиент, библиотеки).
    download_parallel(http, downloads, 24, reporter, "libraries").await?;

    // Распаковка нативных библиотек — только если набор jar'ов изменился.
    // Раньше файлы перезаписывались на каждом запуске.
    let footprint = natives_footprint(&native_jars);
    let stamp = natives_dir.join(".omnispec-natives");
    let stamp_ok = std::fs::read_to_string(&stamp)
        .map(|text| text.trim() == footprint)
        .unwrap_or(false);
    if !stamp_ok {
        for (jar, excludes) in &native_jars {
            if jar.exists() {
                if let Err(err) = extract_natives(jar, &natives_dir, excludes) {
                    eprintln!("[omnispec] не удалось распаковать {}: {err}", jar.display());
                }
            }
        }
        let _ = std::fs::write(&stamp, format!("{footprint}\n"));
    }
    reporter.emit("libraries", 1, 3, "библиотеки готовы");

    // 3. Ресурсы (assets)
    let mut asset_index_id = None;
    if let Some(index_ref) = &resolved.asset_index {
        asset_index_id = Some(index_ref.id.clone());
        let index_file = paths.asset_indexes().join(format!("{}.json", index_ref.id));
        http.download(
            &index_ref.url,
            &index_file,
            Some(index_ref.size),
            index_ref.sha1.as_deref(),
            false,
        )
        .await?;

        // Быстрый путь: индекс не менялся с прошлой полной проверки — файлы
        // ресурсов уже на месте, пересчитывать тысячи объектов не нужно.
        let stamp_file = paths.asset_indexes().join(format!("{}.ready", index_ref.id));
        let index_stamp = file_fingerprint(&index_file);
        let stamp_ok = !index_stamp.is_empty()
            && std::fs::read_to_string(&stamp_file)
                .map(|text| text.trim() == index_stamp)
                .unwrap_or(false);
    if !stamp_ok {
        let text = std::fs::read_to_string(&index_file)?;
        let index: AssetIndex = serde_json::from_str(&text)?;
        let mut items = Vec::new();
        for object in index.objects.values() {
            if object.hash.len() < 2 {
                continue;
            }
            let prefix = &object.hash[..2];
            let dest = paths
                .asset_objects()
                .join(prefix)
                .join(&object.hash);
            if dest.exists() {
                continue;
            }
            items.push(
                DownloadItem::new(
                    format!("{}/{}/{}", super::RESOURCES_URL, prefix, object.hash),
                    dest,
                )
                .with_size(Some(object.size)),
            );
        }
        reporter.emit(
            "assets",
            0,
            items.len() as u64,
            format!("ресурсов к загрузке: {}", items.len()),
        );
        download_parallel(http, items, 32, reporter, "assets").await?;
        let _ = std::fs::write(&stamp_file, format!("{index_stamp}\n"));
    } else {
        reporter.emit("assets", 1, 1, "ресурсы уже проверены");
    }
    }
    reporter.emit("assets", 1, 1, "ресурсы готовы");

    // 4. Конфиг логирования (log4j).
    // Официальный конфиг Mojang пишет в консоль XML (`LegacyXMLLayout`) — он нужен
    // лаунчеру Mojang, а нам нужен читаемый текст. Поэтому генерируем свой.
    let log_config = if resolved.logging.is_some() {
        Some(write_log_config(paths)?)
    } else {
        None
    };

    // Ванильный клиентский JAR — только если он реально есть (не для Forge/NeoForge).
    if has_client {
        classpath.push(client_jar.clone());
    }

    Ok(InstallReport {
        version_id: resolved.id.clone(),
        client_jar,
        classpath,
        natives_dir,
        asset_index_id,
        assets_root: paths.assets(),
        log_config,
    })
}

/// Свой конфиг log4j: читаемый консольный вывод + `logs/latest.log` в папке сборки.
fn write_log_config(paths: &Paths) -> Result<PathBuf> {
    const TEMPLATE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Configuration status="WARN">
    <Appenders>
        <Console name="SysOut" target="SYSTEM_OUT">
            <PatternLayout pattern="[%d{HH:mm:ss}] [%t/%level]: %msg%n" />
        </Console>
        <RollingRandomAccessFile name="File" fileName="logs/latest.log"
                                 filePattern="logs/%d{yyyy-MM-dd}-%i.log.gz">
            <PatternLayout pattern="[%d{HH:mm:ss}] [%t/%level]: %msg%n" />
            <Policies>
                <TimeBasedTriggeringPolicy />
                <OnStartupTriggeringPolicy />
            </Policies>
        </RollingRandomAccessFile>
    </Appenders>
    <Loggers>
        <Root level="info">
            <filters>
                <MarkerFilter marker="NETWORK_PACKETS" onMatch="DENY" onMismatch="NEUTRAL" />
            </filters>
            <AppenderRef ref="SysOut" />
            <AppenderRef ref="File" />
        </Root>
    </Loggers>
</Configuration>
"#;
    let file = paths.cache().join("omnispec-log4j.xml");
    let needs_write = std::fs::read_to_string(&file)
        .map(|existing| existing != TEMPLATE)
        .unwrap_or(true);
    if needs_write {
        std::fs::create_dir_all(paths.cache())?;
        std::fs::write(&file, TEMPLATE)?;
    }
    Ok(file)
}

/// Отпечаток файла «время изменения|размер» — по нему понимаем, менялся ли он.
fn file_fingerprint(path: &std::path::Path) -> String {
    let Ok(meta) = std::fs::metadata(path) else {
        return String::new();
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|age| age.as_secs())
        .unwrap_or(0);
    format!("{mtime}|{}", meta.len())
}

/// Отпечаток набора нативных jar'ов: имена + время изменения + размер.
fn natives_footprint(jars: &[(PathBuf, Vec<String>)]) -> String {
    let mut parts = Vec::with_capacity(jars.len());
    for (jar, _) in jars {
        parts.push(format!(
            "{}#{}",
            jar.file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default(),
            file_fingerprint(jar)
        ));
    }
    parts.sort();
    parts.join(",")
}

/// `group:artifact:version` → относительный maven-путь для библиотек без `downloads`.
fn maven_base(library: &version::Library) -> Option<String> {
    let path = library.maven_path();
    if path.contains('/') {
        Some(path)
    } else {
        None
    }
}

async fn download_parallel(
    http: &Http,
    items: Vec<DownloadItem>,
    concurrency: usize,
    reporter: &Reporter,
    stage: &str,
) -> Result<()> {
    let total = items.len() as u64;
    if total == 0 {
        return Ok(());
    }
    let http = http.clone();
    let reporter_clone = reporter.clone();
    let stage_owned = stage.to_string();

    let mut done = 0u64;
    let mut stream = futures::stream::iter(items.into_iter().map(|item| {
        let http = http.clone();
        async move {
            let res = http
                .download(&item.url, &item.dest, item.size, item.sha1.as_deref(), false)
                .await;
            (res, item.dest)
        }
    }))
    .buffer_unordered(concurrency)
    .boxed();

    while let Some((result, dest)) = stream.next().await {
        done += 1;
        match result {
            Ok(_) => {}
            Err(err) => {
                return Err(Error::Other(format!("{}: {err}", dest.display())));
            }
        }
        reporter_clone.emit(&stage_owned, done, total, format!("{done}/{total}"));
    }
    Ok(())
}

/// Распаковать `.jar` нативных библиотек, исключая META-INF и `extract.exclude`.
pub fn extract_natives(jar: &std::path::Path, dest: &std::path::Path, excludes: &[String]) -> Result<()> {
    let file = std::fs::File::open(jar)?;
    let mut archive = zip::ZipArchive::new(file)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if name.starts_with("META-INF/") {
            continue;
        }
        if excludes.iter().any(|exclude| name.starts_with(exclude)) {
            continue;
        }
        let out_path = dest.join(&name);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut buffer = Vec::new();
        entry.read_to_end(&mut buffer)?;
        std::fs::write(&out_path, buffer)?;
    }
    Ok(())
}

/// Ярлык `--versionType` для аргументов запуска.
pub fn version_type(resolved: &ResolvedVersion) -> String {
    if resolved.kind.is_empty() {
        "release".into()
    } else {
        resolved.kind.clone()
    }
}
