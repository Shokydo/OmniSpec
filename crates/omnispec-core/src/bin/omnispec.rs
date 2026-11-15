//! Консольный интерфейс OmniSpec — для проверки ядра без GUI.
//!
//! Примеры:
//!   omnispec versions
//!   omnispec search sodium --mc 1.21.4 --loader fabric
//!   omnispec create "Моя сборка" --mc 1.21.4 --loader fabric
//!   omnispec install moya-sborka
//!   omnispec launch moya-sborka --user Steve
//!   omnispec modpack cobblemon --mc 1.21.1

use std::path::PathBuf;

use omnispec_core::auth::Account;
use omnispec_core::game::{self, java};
use omnispec_core::instances::{self, CreateInstanceRequest, Loader};
use omnispec_core::modrinth::{self, SearchQuery};
use omnispec_core::net::{Http, Reporter};
use omnispec_core::paths::Paths;
use omnispec_core::settings::Settings;

fn usage() {
    println!(
        "OmniSpec {}\n\
        Использование:\n\
        \x20 omnispec home                       — показать папку данных\n\
        \x20 omnispec versions [--snapshots]     — версии Minecraft\n\
        \x20 omnispec java                       — найденные Java\n\
        \x20 omnispec list                       — сборки\n\
        \x20 omnispec create <название> --mc <версия> [--loader fabric|quilt|vanilla] [--loader-version X]\n\
        \x20 omnispec install <сборка>            — скачать файлы игры\n\
        \x20 omnispec launch <сборка> [--user ник] [--dry-run]\n\
        \x20 omnispec search <запрос> [--mc версия] [--loader fabric] [--type mod|modpack|shader|resourcepack]\n\
        \x20 omnispec modpack <slug|id> [--install]  — поставить модпак с Modrinth\n\
        \x20 omnispec addmod <сборка> <slug|id>  — поставить мод с Modrinth\n\
        \x20 omnispec update-check [--repo владелец/репозиторий] [--current X.Y.Z]\n",
        omnispec_core::APP_VERSION
    );
}

struct Args {
    positional: Vec<String>,
    flags: Vec<(String, Option<String>)>,
}

impl Args {
    fn parse(items: Vec<String>) -> Self {
        let mut positional = Vec::new();
        let mut flags = Vec::new();
        let mut iter = items.into_iter();
        while let Some(item) = iter.next() {
            if let Some(name) = item.strip_prefix("--") {
                let mut name = name.to_string();
                let mut value = None;
                if let Some((key, val)) = name.clone().split_once('=') {
                    name = key.to_string();
                    value = Some(val.to_string());
                } else if let Some(next) = flags_value_hint(iter.clone().next()) {
                    if next {
                        value = iter.next();
                    }
                }
                flags.push((name, value));
            } else {
                positional.push(item);
            }
        }
        Self { positional, flags }
    }

    fn flag(&self, name: &str) -> Option<&str> {
        self.flags
            .iter()
            .find(|(key, _)| key == name)
            .and_then(|(_, value)| value.as_deref())
    }

    fn has(&self, name: &str) -> bool {
        self.flags.iter().any(|(key, _)| key == name)
    }
}

/// Подсказка парсеру: следующее слово — это значение флага (а не позиционный аргумент).
fn flags_value_hint(next: Option<String>) -> Option<bool> {
    match next {
        Some(value) => Some(!value.starts_with("--")),
        None => Some(false),
    }
}

fn progress_reporter() -> Reporter {
    let last_stage = std::sync::Mutex::new(String::new());
    Reporter::new(move |event| {
        let label = format!("[{}]", event.stage);
        {
            let mut guard = last_stage.lock().unwrap();
            if event.stage != *guard {
                println!();
                *guard = event.stage.clone();
            }
        }
        if event.total > 0 {
            print!("\r{} {}/{} {}", label, event.done, event.total, event.detail);
        } else {
            print!("\r{} {}", label, event.detail);
        }
        use std::io::Write;
        let _ = std::io::stdout().flush();
    })
}

#[tokio::main]
async fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.is_empty() {
        usage();
        return;
    }
    let command = raw[0].clone();
    let args = Args::parse(raw[1..].to_vec());

    if let Err(err) = run(&command, args).await {
        eprintln!("\nОшибка: {err}");
        std::process::exit(1);
    }
}

async fn run(command: &str, args: Args) -> omnispec_core::Result<()> {
    let paths = Paths::discover()?;
    let http = Http::new();
    let reporter = progress_reporter();

    match command {
        "home" => {
            println!("{}", paths.root.display());
        }
        "versions" => {
            let manifest = game::fetch_manifest(&http, &paths, std::time::Duration::from_secs(60)).await?;
            println!("Последний релиз: {}", manifest.latest.release);
            for entry in game::filter_versions(&manifest, args.has("snapshots")).iter().take(30) {
                println!("{:>12}  {}", entry.id, entry.kind);
            }
        }
        "java" => {
            let installs = java::detect_all(&paths).await;
            if installs.is_empty() {
                println!("Java не найдена (лаунчер сможет скачать рантайм сам)");
            }
            for install in installs {
                println!("{}", install.display());
            }
        }
        "list" => {
            let list = instances::list(&paths)?;
            if list.is_empty() {
                println!("Сборок нет");
            }
            for meta in list {
                println!(
                    "{:<24} {:<10} {:<24} {}",
                    meta.id,
                    meta.mc_version,
                    meta.loader.label(),
                    meta.name
                );
            }
        }
        "create" => {
            let name = args
                .positional
                .first()
                .cloned()
                .ok_or("укажите название сборки")?;
            let mc_version = args.flag("mc").unwrap_or("1.21.4").to_string();
            let loader_kind = args.flag("loader").unwrap_or("vanilla").to_string();
            let loader = if loader_kind == "vanilla" {
                Loader::Vanilla
            } else {
                let version = match args.flag("loader-version") {
                    Some(version) => version.to_string(),
                    None => omnispec_core::loaders::latest_loader(&http, &loader_kind, &mc_version)
                        .await?
                        .ok_or_else(|| {
                            omnispec_core::Error::Other(format!(
                                "нет версий {loader_kind} для {mc_version}"
                            ))
                        })?,
                };
                match loader_kind.as_str() {
                    "fabric" => Loader::Fabric { version },
                    "quilt" => Loader::Quilt { version },
                    "forge" => Loader::Forge { version },
                    "neoforge" => Loader::NeoForge { version },
                    other => return Err(format!("неизвестный загрузчик: {other}").into()),
                }
            };
            let meta = instances::create(
                &paths,
                CreateInstanceRequest {
                    name,
                    mc_version,
                    loader,
                    icon: None,
                    notes: String::new(),
                    source: None,
                    source_url: None,
                    id: None,
                    category: None,
                },
            )?;
            println!(
                "Создана сборка «{}» (id={}, версия профиля {})",
                meta.name,
                meta.id,
                meta.version_id()
            );
        }
        "install" => {
            let id = args.positional.first().ok_or("укажите сборку")?;
            let meta = instances::load(&paths, id)?;
            omnispec_core::loaders::ensure_profile(&http, &paths, &meta, &reporter).await?;
            let report = game::install::ensure_installed(
                &http,
                &paths,
                &meta.version_id(),
                &reporter,
            )
            .await?;
            println!(
                "\nГотово: {} файлов в classpath, ресурсы: {:?}",
                report.classpath.len(),
                report.asset_index_id
            );
        }
        "launch" => {
            let id = args.positional.first().ok_or("укажите сборку")?;
            let meta = instances::load(&paths, id)?;
            let mut settings = Settings::load(&paths)?;
            let username = args.flag("user").unwrap_or(&settings.username).to_string();
            settings.username = username.clone();
            let account = Account::offline(&username)?;
            let plan = game::launch::prepare(&http, &paths, &meta, &settings, &account, &reporter).await?;
            println!("\nJava {}: {}", plan.java_major, plan.java);
            println!("Память: {} МБ", plan.memory_mb);
            println!("Команда: {}", plan.command_line());
            if args.has("dry-run") {
                return Ok(());
            }
            instances::touch_play(&paths, &meta.id)?;
            let log_path = PathBuf::from(format!(
                "{}/launch-{}.log",
                paths.logs().display(),
                meta.id
            ));
            let started = std::time::Instant::now();
            println!("Лог: {}", log_path.display());
            let sink = std::sync::Arc::new(|line: String| println!("{line}"));
            let code = game::launch::run_and_stream(&plan, &log_path, Some(sink)).await?;
            instances::add_playtime(&paths, &meta.id, started.elapsed().as_secs());
            println!("Игра завершилась с кодом {code}");
        }
        "search" => {
            let query = args.positional.first().cloned().unwrap_or_default();
            let modrinth = modrinth::Modrinth::new(http.clone());
            let results = modrinth
                .search(&SearchQuery {
                    query,
                    project_type: args.flag("type").unwrap_or("mod").to_string(),
                    game_version: args.flag("mc").map(|value| value.to_string()),
                    loader: args.flag("loader").map(|value| value.to_string()),
                    categories: Vec::new(),
                    limit: 10,
                    offset: 0,
                    sort: "relevance".into(),
                })
                .await?;
            println!("Найдено: {}", results.total_hits);
            for hit in results.hits {
                println!(
                    "- {} ({}) ⬇ {}  [{}]",
                    hit.title,
                    hit.slug,
                    hit.downloads,
                    hit.categories.join(", ")
                );
                println!("  {}", hit.description);
            }
        }
        "modpack" => {
            let project = args.positional.first().ok_or("укажите slug модпака")?;
            let modrinth = modrinth::Modrinth::new(http.clone());
            let versions = modrinth.modpack_versions(project).await?;
            println!("Версий модпака: {}", versions.len());
            for version in versions.iter().take(10) {
                println!(
                    "- {} ({}) {} / {}",
                    version.name,
                    version.version_number,
                    version.game_versions.join(","),
                    version.loaders.join(",")
                );
            }
            if args.has("install") {
                let version = versions.first().ok_or("у модпака нет версий")?;
                let meta = modrinth::mrpack::install(&modrinth, &paths, version, &reporter).await?;
                println!(
                    "\nСборка «{}» создана (id={}, MC {}, {})",
                    meta.name,
                    meta.id,
                    meta.mc_version,
                    meta.loader.label()
                );
            }
        }
        "update-check" => {
            use omnispec_core::update::{self, UpdateConfig};
            let settings = Settings::load(&paths)?;
            let repo = args
                .flag("repo")
                .map(|value| value.to_string())
                .or_else(|| settings.update_repo.clone())
                .ok_or("не указан репозиторий обновлений")?;
            let mut config: UpdateConfig = settings
                .update_config()
                .unwrap_or_else(|| UpdateConfig::new("Shokydo", "OmniSpec"));
            // --repo важнее настроек, но токен и «бета-версии» берём из settings.json
            if args.flag("repo").is_some() {
                let parsed = UpdateConfig::from_slug(&repo)
                    .ok_or_else(|| omnispec_core::Error::Other(format!("неверный репозиторий: {repo}")))?;
                config.owner = parsed.owner;
                config.repo = parsed.repo;
            }
            let current = args
                .flag("current")
                .map(|value| value.to_string())
                .unwrap_or_else(|| omnispec_core::APP_VERSION.to_string());
            println!("Репозиторий: {}", config.slug());
            println!("Текущая версия: {current}");
            match update::check(&http, &config, &current).await? {
                Some(info) => {
                    println!("Доступно обновление: {}", info.version);
                    println!("Файл: {} ({} байт)", info.asset_name, info.asset_size);
                    println!("Ссылка: {}", info.asset_url);
                    if let Some(date) = &info.published_at {
                        println!("Опубликовано: {date}");
                    }
                    if info.notes.trim().is_empty() {
                        println!("(описание релиза пустое)");
                    } else {
                        println!("--- описание релиза ---\n{}", info.notes);
                    }
                }
                None => println!("Обновлений нет — установлена последняя версия"),
            }
        }
        "addmod" => {
            let id = args.positional.first().ok_or("укажите сборку")?;
            let project = args.positional.get(1).ok_or("укажите мод")?;
            let meta = instances::load(&paths, id)?;
            let modrinth = modrinth::Modrinth::new(http.clone());
            let outcome =
                modrinth::install::install_project(&modrinth, &paths, &meta, project, &reporter).await?;
            println!("\nПоставлено: {:?}", outcome.installed);
            if !outcome.skipped.is_empty() {
                println!("Уже было: {:?}", outcome.skipped);
            }
        }
        other => {
            eprintln!("Неизвестная команда: {other}");
            usage();
        }
    }
    Ok(())
}
