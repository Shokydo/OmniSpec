//! Сборка командной строки запуска и сам запуск процесса игры.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::auth::Account;
use crate::error::{Error, Result};
use crate::instances::InstanceMeta;
use crate::net::{Http, Reporter};
use crate::paths::Paths;
use crate::settings::Settings;

use super::{install, java, version};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchPlan {
    pub version_id: String,
    pub instance_id: String,
    pub java: String,
    pub java_major: u32,
    pub memory_mb: u32,
    pub args: Vec<String>,
    pub game_dir: String,
    pub natives_dir: String,
    pub classpath_entries: usize,
    /// Сколько заняла подготовка запуска, мс (для лога и профилирования).
    #[serde(default)]
    pub prepare_ms: u64,
}

impl LaunchPlan {
    /// Человекочитаемая команда (для логов и отладки).
    pub fn command_line(&self) -> String {
        let mut parts = vec![self.java.clone()];
        for arg in &self.args {
            if arg.contains(' ') {
                parts.push(format!("\"{arg}\""));
            } else {
                parts.push(arg.clone());
            }
        }
        parts.join(" ")
    }
}

pub fn classpath_separator() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

/// Полный цикл подготовки: загрузчик → файлы игры → Java → аргументы.
pub async fn prepare(
    http: &Http,
    paths: &Paths,
    instance: &InstanceMeta,
    settings: &Settings,
    account: &Account,
    reporter: &Reporter,
) -> Result<LaunchPlan> {
    // Тайминги этапов: в консоли видно, сколько заняла подготовка.
    let started = std::time::Instant::now();
    reporter.emit("launch", 0, 5, "проверяем профиль версии");

    // ensure_profile возвращает id, по которому профиль реально лежит на диске:
    // инсталлятор мог назвать папку иначе, чем version_id() ожидает.
    let version_id =
        crate::loaders::ensure_profile(http, paths, instance, reporter).await?;

    reporter.emit("launch", 1, 5, "проверяем файлы игры");
    // Профиль разбираем один раз и передаём в установку: раньше его разбирали
    // дважды (манифест Mojang — 400 КБ json на каждый запуск).
    let resolved = super::resolve(http, paths, &version_id).await?;
    let report = install::ensure_installed_resolved(http, paths, &resolved, reporter).await?;
    let features = version::default_features();

    reporter.emit("launch", 3, 5, "ищем Java");
    let mut effective_settings = settings.clone();
    if let Some(java_path) = instance
        .java_path
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        effective_settings.java_path = Some(java_path.clone());
    }
    // Для версий до 1.17 нужна Java 8: у неё свой путь в настройках.
    if effective_settings.java_path.is_none() && resolved.java_major <= 8 {
        if let Some(legacy) = effective_settings
            .java_path_legacy
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            effective_settings.java_path = Some(legacy.clone());
        }
    }
    let java_install = java::find_java(
        http,
        paths,
        &effective_settings,
        resolved.java_major,
        reporter,
    )
    .await?;

    let memory_mb = instance.memory_or(settings.memory_clamped());
    let game_dir = crate::instances::ensure_game_dir(paths, instance)?;

    let classpath: Vec<String> = report
        .classpath
        .iter()
        .map(|path| path.display().to_string())
        .collect();
    let classpath_str = classpath.join(classpath_separator());

    let mut vars: HashMap<&str, String> = HashMap::new();
    vars.insert("auth_player_name", account.username.clone());
    vars.insert("version_name", resolved.id.clone());
    vars.insert("version_type", super::install::version_type(&resolved));
    vars.insert("game_directory", game_dir.display().to_string());
    vars.insert("assets_root", report.assets_root.display().to_string());
    vars.insert(
        "game_assets",
        paths
            .assets()
            .join("virtual")
            .join("legacy")
            .display()
            .to_string(),
    );
    vars.insert(
        "assets_index_name",
        report
            .asset_index_id
            .clone()
            .unwrap_or_else(|| resolved.assets.clone().unwrap_or_else(|| "legacy".into())),
    );
    vars.insert(
        "auth_uuid",
        account.uuid.replace('-', "").to_lowercase(),
    );
    vars.insert(
        "auth_access_token",
        if account.access_token.is_empty() {
            "0".to_string()
        } else {
            account.access_token.clone()
        },
    );
    vars.insert("auth_session", vars["auth_access_token"].clone());
    vars.insert("clientid", String::new());
    vars.insert("auth_xuid", String::new());
    vars.insert("user_type", account.user_type().to_string());
    vars.insert("user_properties", "{}".to_string());
    vars.insert("natives_directory", report.natives_dir.display().to_string());
    vars.insert("launcher_name", crate::LAUNCHER_BRAND.to_string());
    vars.insert("launcher_version", crate::APP_VERSION.to_string());
    vars.insert("classpath", classpath_str.clone());
    vars.insert(
        "classpath_separator",
        classpath_separator().to_string(),
    );
    vars.insert(
        "library_directory",
        paths.libraries().display().to_string(),
    );
    vars.insert("resolution_width", "854".to_string());
    vars.insert("resolution_height", "480".to_string());

    // ---- JVM-аргументы ----
    let mut jvm_args: Vec<String> = Vec::new();
    jvm_args.push(format!("-Xmx{memory_mb}M"));
    jvm_args.push(format!("-Xms{}M", memory_mb.min(1024)));
    for extra in split_args(instance.jvm_args.as_deref().unwrap_or(&settings.jvm_args)) {
        jvm_args.push(extra);
    }
    jvm_args.push(format!("-Dminecraft.launcher.brand={}", crate::LAUNCHER_BRAND));
    jvm_args.push(format!("-Dminecraft.launcher.version={}", crate::APP_VERSION));

    for arg in &resolved.jvm_args {
        if let Some(values) = arg.expand(&features) {
            for value in values {
                jvm_args.push(substitute(&value, &vars));
            }
        }
    }

    // Профили без блока arguments.jvm (очень старые версии) — добавим обязательное сами.
    if !jvm_args.iter().any(|arg| arg.contains("java.library.path")) {
        jvm_args.push(format!(
            "-Djava.library.path={}",
            report.natives_dir.display()
        ));
    }
    if let Some(log_config) = &report.log_config {
        jvm_args.push(format!(
            "-Dlog4j.configurationFile={}",
            log_config.display()
        ));
    }

    // ---- Аргументы игре ----
    let mut game_args: Vec<String> = Vec::new();
    for arg in &resolved.game_args {
        if let Some(values) = arg.expand(&features) {
            for value in values {
                game_args.push(substitute(&value, &vars));
            }
        }
    }
    if game_args.is_empty() {
        // Совсем старые профили: минимальный набор аргументов.
        game_args = vec![
            "--username".into(),
            account.username.clone(),
            "--session".into(),
            vars["auth_access_token"].clone(),
            "--gameDir".into(),
            game_dir.display().to_string(),
            "--assetsDir".into(),
            report.assets_root.display().to_string(),
            "--assetIndex".into(),
            vars["assets_index_name"].clone(),
            "--uuid".into(),
            vars["auth_uuid"].clone(),
            "--accessToken".into(),
            vars["auth_access_token"].clone(),
            "--userType".into(),
            "legacy".into(),
            "--version".into(),
            resolved.id.clone(),
        ];
    }
    for extra in split_args(&settings.game_args) {
        game_args.push(extra);
    }

    let mut args = jvm_args;
    args.push(resolved.main_class.clone());
    args.append(&mut game_args);

    let prepare_ms = started.elapsed().as_millis() as u64;
    reporter.emit(
        "launch",
        5,
        5,
        format!("готово к запуску за {} мс", prepare_ms),
    );

    Ok(LaunchPlan {
        version_id: resolved.id.clone(),
        instance_id: instance.id.clone(),
        java: java_install.path.display().to_string(),
        java_major: java_install.major,
        memory_mb,
        args,
        game_dir: game_dir.display().to_string(),
        natives_dir: report.natives_dir.display().to_string(),
        classpath_entries: classpath.len(),
        prepare_ms,
    })
}

fn substitute(template: &str, vars: &HashMap<&str, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('}') {
            Some(end) => {
                let key = &after[..end];
                match vars.get(key) {
                    Some(value) => out.push_str(value),
                    None => {
                        // Неизвестный плейсхолдер — оставляем как есть (не ломаем запуск).
                        out.push_str("${");
                        out.push_str(key);
                        out.push('}');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str("${");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Разбить строку аргументов на список (с поддержкой кавычек).
pub fn split_args(input: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in input.chars() {
        match quote {
            Some(q) => {
                if ch == q {
                    quote = None;
                } else {
                    current.push(ch);
                }
            }
            None => match ch {
                '"' | '\'' => quote = Some(ch),
                c if c.is_whitespace() => {
                    if !current.is_empty() {
                        result.push(std::mem::take(&mut current));
                    }
                }
                c => current.push(c),
            },
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

/// Запустить игру. Возвращает дочерний процесс (его можно убить из UI).
pub fn spawn(plan: &LaunchPlan) -> Result<tokio::process::Child> {
    let mut command = tokio::process::Command::new(&plan.java);
    command
        .args(&plan.args)
        .current_dir(&plan.game_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        // Не мигать консольным окном при старте.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .spawn()
        .map_err(|err| Error::Other(format!("не удалось запустить Java: {err}")))
}

/// Читать построчно вывод процесса и складывать в канал.
async fn pump<R>(reader: R, tx: tokio::sync::mpsc::UnboundedSender<String>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if tx.send(line).is_err() {
            break;
        }
    }
}

/// Запустить игру и передавать вывод в колбэк + лог-файл.
pub async fn run_and_stream(
    plan: &LaunchPlan,
    log_path: &PathBuf,
    sink: Option<Arc<dyn Fn(String) + Send + Sync>>,
) -> Result<i32> {
    let mut child = spawn(plan)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Other("нет stdout у процесса игры".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::Other("нет stderr у процесса игры".into()))?;

    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut log = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .await?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(pump(stdout, tx.clone()));
    tokio::spawn(pump(stderr, tx.clone()));
    drop(tx);

    let header = format!(
        "\n=== OmniSpec: запуск {} ({}) ===\n[cmd] {}\n",
        plan.instance_id,
        plan.version_id,
        plan.command_line()
    );
    log.write_all(header.as_bytes()).await?;

    while let Some(line) = rx.recv().await {
        log.write_all(format!("{line}\n").as_bytes()).await?;
        if let Some(sink) = &sink {
            sink(line);
        }
    }

    let status = child.wait().await?;
    let code = status.code().unwrap_or(-1);
    log.write_all(format!("=== игра завершилась с кодом {code} ===\n").as_bytes())
        .await?;
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitution() {
        let mut vars = HashMap::new();
        vars.insert("auth_player_name", "Steve".to_string());
        vars.insert("game_directory", "/games/inst".to_string());
        assert_eq!(
            substitute("--username ${auth_player_name} --gameDir ${game_directory}", &vars),
            "--username Steve --gameDir /games/inst"
        );
        assert_eq!(substitute("${unknown_var}", &vars), "${unknown_var}");
    }

    #[test]
    fn args_splitting() {
        assert_eq!(
            split_args("-XX:+UseG1GC \"-Dfoo=bar baz\" "),
            vec!["-XX:+UseG1GC".to_string(), "-Dfoo=bar baz".to_string()]
        );
    }
}
