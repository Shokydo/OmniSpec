/*
 * OmniSpec — общая часть установщика.
 *
 * Здесь всё, что не зависит от того, как установщик выглядит: пути, раскладка
 * файлов, ярлыки, деинсталлятор и запуск лаунчера. Этим пользуются и
 * графическое окно (gui.rs), и консольный вариант (console.rs).
 */

use std::path::{Path, PathBuf};

pub const APP_NAME: &str = "OmniSpec";
pub const APP_EXE: &str = if cfg!(windows) {
    "OmniSpec.exe"
} else {
    "OmniSpec"
};
/// Деинсталлятор в папке установки — это копия самого установщика.
pub const UNINST_EXE: &str = if cfg!(windows) {
    "uninstall.exe"
} else {
    "uninstall"
};
/// Что и куда поставили — чтобы лаунчер и человек могли посмотреть.
pub const INFO_FILE: &str = "install-info.txt";
/// Данные лежат рядом с лаунчером (лаунчер читает этот файл сам).
pub const PORTABLE_FILE: &str = "portable.txt";
pub const UPDATE_REPO: &str = "Shokydo/OmniSpec";

/// Что именно установщик делает — эти же строки показывает окно.
pub const STEPS: [&str; 3] = [
    "Раскладываю лаунчер",
    "Кладу деинсталлятор",
    "Создаю ярлыки",
];

mod payload {
    include!(concat!(env!("OUT_DIR"), "/payload.rs"));
}

/// Вшитый exe лаунчера (может быть пустым — тогда качаем с GitHub).
const PAYLOAD: &[u8] = payload::PAYLOAD;

/// Иконка приложения — кладём рядом с лаунчером, чтобы ярлык был с картинкой.
const ICON: &[u8] = include_bytes!("../../omnispec-app/icons/128x128.png");

/// Картинка для заголовка окна и значка на панели задач.
pub const ICON_PNG: &[u8] = ICON;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Есть ли внутри готовый лаунчер (иначе придётся качать с GitHub).
pub fn has_payload() -> bool {
    !PAYLOAD.is_empty()
}

pub fn payload_mb() -> f64 {
    PAYLOAD.len() as f64 / 1_048_576.0
}

/// Что будет лежать в папке — строка «Внутри:» из шапки.
pub fn inside_text() -> String {
    if has_payload() {
        format!(
            "лаунчер целиком, {:.1} МБ — ничего скачивать не нужно",
            payload_mb()
        )
    } else {
        "лаунчер скачается с GitHub (один файл)".to_string()
    }
}

/// Сообщения о ходе установки — одинаковые для окна и для консоли.
pub enum Progress {
    /// Шаг начался.
    Begin { step: usize },
    /// Шаг успешно закончился, `note` — что дописать в строку.
    Ok { step: usize, note: String },
    /// Шаг сорвался.
    Fail { step: usize, error: String },
}

/* ───────────────────────── пути ───────────────────────── */

/// Куда ставим: `OMNISPEC_SETUP_DIR` → запомненный путь → стандартная папка.
///
/// Стандартная: Windows → %LOCALAPPDATA%\OmniSpec, Unix → ~/.local/share/OmniSpec.
pub fn install_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("OMNISPEC_SETUP_DIR") {
        if !custom.trim().is_empty() {
            return expand_path(&custom);
        }
    }
    // Прошлый запуск установщика уже спрашивал папку — не заставляем вводить снова.
    if let Some(saved) = remembered_location() {
        return saved;
    }
    if cfg!(windows) {
        if let Ok(base) = std::env::var("LOCALAPPDATA") {
            if !base.trim().is_empty() {
                return PathBuf::from(base).join(APP_NAME);
            }
        }
        if let Some(home) = dirs_home() {
            return home.join("AppData").join("Local").join(APP_NAME);
        }
    }
    if let Ok(base) = std::env::var("XDG_DATA_HOME") {
        if !base.trim().is_empty() {
            return PathBuf::from(base).join(APP_NAME);
        }
    }
    dirs_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local")
        .join("share")
        .join(APP_NAME)
}

/// Папка установки внутри выбранной пользователем папки: `D:` → `D:\OmniSpec`.
/// Если путь уже заканчивается на `OmniSpec` — оставляем как есть.
pub fn with_app_folder(dir: &Path) -> PathBuf {
    let is_app = dir
        .file_name()
        .map(|name| name.to_string_lossy().eq_ignore_ascii_case(APP_NAME))
        .unwrap_or(false);
    if is_app {
        dir.to_path_buf()
    } else {
        dir.join(APP_NAME)
    }
}

pub fn dirs_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

/// Файл, в котором установщик запоминает выбранную папку.
fn location_file() -> Option<PathBuf> {
    if cfg!(windows) {
        if let Ok(base) = std::env::var("LOCALAPPDATA") {
            if !base.trim().is_empty() {
                return Some(PathBuf::from(base).join("OmniSpec-install-location.txt"));
            }
        }
        return dirs_home().map(|home| {
            home.join("AppData")
                .join("Local")
                .join("OmniSpec-install-location.txt")
        });
    }
    if let Ok(base) = std::env::var("XDG_CONFIG_HOME") {
        if !base.trim().is_empty() {
            return Some(PathBuf::from(base).join("omnispec-install-location.txt"));
        }
    }
    dirs_home().map(|home| {
        home.join(".config")
            .join("omnispec-install-location.txt")
    })
}

/// Запомнить папку установки, чтобы следующий запуск предложил её же.
pub fn remember_location(dir: &Path) {
    let Some(file) = location_file() else { return };
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&file, dir.display().to_string());
}

/// Папка, выбранная в прошлый раз (если файл есть и путь не пустой).
pub fn remembered_location() -> Option<PathBuf> {
    let file = location_file()?;
    let text = std::fs::read_to_string(&file).ok()?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(PathBuf::from(text))
}

/// Где лежат данные лаунчера: рядом с ним (портативно) или в профиле.
pub fn data_dir(dir: &Path, portable: bool) -> PathBuf {
    if portable {
        return dir.join("OmniSpecData");
    }
    if cfg!(windows) {
        if let Ok(base) = std::env::var("APPDATA") {
            if !base.trim().is_empty() {
                return PathBuf::from(base).join(APP_NAME);
            }
        }
        if let Some(home) = dirs_home() {
            return home.join("AppData").join("Roaming").join(APP_NAME);
        }
    }
    if let Ok(base) = std::env::var("XDG_DATA_HOME") {
        if !base.trim().is_empty() {
            return PathBuf::from(base).join(APP_NAME);
        }
    }
    dirs_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local")
        .join("share")
        .join(APP_NAME)
}

/// Развернуть `~` и относительный путь в абсолютный — чтобы в окне был понятный адрес.
pub fn expand_path(text: &str) -> PathBuf {
    let text = text.trim();
    if let Some(rest) = text.strip_prefix('~') {
        let rest = rest.trim_start_matches(['/', '\\']);
        if let Some(home) = dirs_home() {
            return if rest.is_empty() {
                home
            } else {
                home.join(rest)
            };
        }
    }
    let path = PathBuf::from(text);
    if path.is_absolute() {
        return path;
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(&path))
        .unwrap_or(path)
}

#[cfg(not(windows))]
pub fn desktop_dir() -> Option<PathBuf> {
    if let Some(home) = dirs_home() {
        let one_drive = home.join("OneDrive").join("Desktop");
        if one_drive.is_dir() {
            return Some(one_drive);
        }
        for name in ["Desktop", "Рабочий стол"] {
            let path = home.join(name);
            if path.is_dir() {
                return Some(path);
            }
        }
    }
    None
}

/* ───────────────────────── установка ───────────────────────── */

/// Полная установка ровно в `dir`. Отчёт о шагах — через `report`, чтобы окно
/// и консоль показывали одно и то же.
pub fn install(dir: &Path, portable: bool, report: &mut dyn FnMut(Progress)) -> Result<PathBuf, String> {
    report(Progress::Begin { step: 0 });
    let exe = match write_launcher(dir) {
        Ok(path) => path,
        Err(error) => {
            report(Progress::Fail {
                step: 0,
                error: error.clone(),
            });
            return Err(error);
        }
    };
    // Портативный режим — файл рядом с лаунчером: сам лаунчер его читает.
    let flag = dir.join(PORTABLE_FILE);
    if portable {
        let _ = std::fs::write(&flag, "данные лежат рядом с лаунчером\n");
    } else if flag.exists() {
        let _ = std::fs::remove_file(&flag);
    }
    let data = data_dir(dir, portable);
    let info = format!(
        "version={}\ndir={}\nportable={}\ndata={}\ninstalled=\n",
        version(),
        dir.display(),
        portable,
        data.display()
    );
    let _ = std::fs::write(dir.join(INFO_FILE), info);
    // Папку запоминаем: следующий запуск установщика предложит её же.
    remember_location(dir);

    let size = std::fs::metadata(&exe).map(|meta| meta.len()).unwrap_or(0);
    report(Progress::Ok {
        step: 0,
        note: format!("готово ({:.1} МБ)", size as f64 / 1_048_576.0),
    });

    report(Progress::Begin { step: 1 });
    match write_uninstaller(dir) {
        Ok(()) => report(Progress::Ok {
            step: 1,
            note: UNINST_EXE.to_string(),
        }),
        Err(error) => {
            report(Progress::Fail {
                step: 1,
                error: error.clone(),
            });
            return Err(error);
        }
    }

    report(Progress::Begin { step: 2 });
    if let Err(error) = make_shortcuts(&exe, dir) {
        let error = format!("Файлы уже лежат в {}. {error}", dir.display());
        report(Progress::Fail {
            step: 2,
            error: error.clone(),
        });
        return Err(error);
    }
    report(Progress::Ok {
        step: 2,
        note: "рабочий стол и «Пуск»".to_string(),
    });

    Ok(exe)
}

pub fn write_launcher(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("не создалась папка {}: {error}", dir.display()))?;
    let exe = dir.join(APP_EXE);

    let bytes: Vec<u8> = if PAYLOAD.is_empty() {
        // Полезной нагрузки в этой сборке нет — берём последний релиз с GitHub.
        download_latest()?
    } else {
        PAYLOAD.to_vec()
    };

    std::fs::write(&exe, &bytes)
        .map_err(|error| format!("не записался {}: {error}", exe.display()))?;
    let _ = std::fs::write(dir.join("icon.png"), ICON);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
    }

    Ok(exe)
}

/// Положить в папку установки деинсталлятор — копию этого самого установщика.
pub fn write_uninstaller(dir: &Path) -> Result<(), String> {
    let current = std::env::current_exe()
        .map_err(|error| format!("не понял, откуда запущен: {error}"))?;
    let target = dir.join(UNINST_EXE);
    if current == target {
        return Ok(()); // уже запущены из папки установки как деинсталлятор
    }
    std::fs::copy(&current, &target)
        .map_err(|error| format!("не скопировался {UNINST_EXE}: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

/// Скачать последний `OmniSpec.exe` из GitHub Releases (если payload не вшит).
fn download_latest() -> Result<Vec<u8>, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("не запустился рантайм: {error}"))?;

    runtime.block_on(async {
        use omnispec_core::update::{self, UpdateConfig};
        use omnispec_core::{Http, Paths, Reporter};

        let paths = Paths::discover().map_err(|error| error.to_string())?;
        let http = Http::new();
        let config = UpdateConfig::from_slug(UPDATE_REPO)
            .ok_or_else(|| "неверный репозиторий обновлений".to_string())?;

        let info = update::check(&http, &config, "0.0.0")
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "на GitHub нет ни одного релиза".to_string())?;

        let reporter = Reporter::none();
        let file = update::download(&http, &paths, &info, config.token.as_deref(), &reporter)
            .await
            .map_err(|error| error.to_string())?;

        let bytes = std::fs::read(&file).map_err(|error| format!("не прочитался файл: {error}"))?;
        let _ = std::fs::remove_file(&file);
        Ok(bytes)
    })
}

/* ───────────────────────── удаление ───────────────────────── */

/// Полное удаление: файлы, ярлыки, (по желанию) сборки и настройки.
pub fn uninstall(dir: &Path, remove_data: bool, report: &mut dyn FnMut(Progress)) -> Result<(), String> {
    report(Progress::Begin { step: 0 });

    let portable = dir.join(PORTABLE_FILE).exists();
    let data = data_dir(dir, portable);
    let mut failures: Vec<String> = Vec::new();
    if let Err(error) = remove_shortcuts() {
        failures.push(error);
    }
    for name in [APP_EXE, "icon.png", INFO_FILE, PORTABLE_FILE] {
        let path = dir.join(name);
        if path.exists() {
            if let Err(error) = std::fs::remove_file(&path) {
                failures.push(format!("{name}: {error}"));
            }
        }
    }
    if remove_data && data.exists() {
        if let Err(error) = std::fs::remove_dir_all(&data) {
            failures.push(format!("{}: {error}", data.display()));
        }
    }
    if failures.is_empty() {
        report(Progress::Ok {
            step: 0,
            note: if remove_data {
                "файлы и данные удалены".to_string()
            } else {
                "файлы удалены, сборки оставлены".to_string()
            },
        });
    } else {
        report(Progress::Fail {
            step: 0,
            error: failures.join("; "),
        });
    }

    report(Progress::Begin { step: 1 });
    // сам деинсталлятор занят нами — удаляем его после выхода
    let self_path = dir.join(UNINST_EXE);
    schedule_self_delete(&self_path);
    report(Progress::Ok {
        step: 1,
        note: "готово".to_string(),
    });

    report(Progress::Begin { step: 2 });
    // папку убираем, если в ней ничего не осталось
    let _ = std::fs::remove_dir(dir);
    report(Progress::Ok {
        step: 2,
        note: "готово".to_string(),
    });

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

/// Удалить себя после завершения процесса (Windows не даёт удалить запущенный exe).
fn schedule_self_delete(path: &Path) {
    #[cfg(windows)]
    {
        // Ждём, пока процесс выйдет: удаляем exe и, если папка опустела, её саму.
        let folder = path
            .parent()
            .map(|dir| dir.display().to_string())
            .unwrap_or_default();
        let command = if folder.is_empty() {
            format!("ping -n 3 127.0.0.1 >nul & del /f /q \"{}\"", path.display())
        } else {
            format!(
                "ping -n 3 127.0.0.1 >nul & del /f /q \"{}\" & rmdir /q \"{folder}\"",
                path.display()
            )
        };
        let _ = std::process::Command::new("cmd")
            .args(["/C", &command])
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::fs::remove_file(path);
    }
}

/// Убрать только наши ярлыки из тех же системных папок, в которые ставили.
fn remove_shortcuts() -> Result<(), String> {
    #[allow(unused_mut)]
    let mut failures: Vec<String> = Vec::new();
    #[cfg(windows)]
    {
        let mut links = Vec::new();
        match crate::windows_shortcuts::desktop_folder() {
            Ok(folder) => links.push(folder.join(format!("{APP_NAME}.lnk"))),
            Err(error) => failures.push(error),
        }
        let start = match crate::windows_shortcuts::programs_folder() {
            Ok(folder) => {
                let folder = folder.join(APP_NAME);
                links.push(folder.join(format!("{APP_NAME}.lnk")));
                Some(folder)
            }
            Err(error) => {
                failures.push(error);
                None
            }
        };
        for link in links {
            if let Err(error) = std::fs::remove_file(&link) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    failures.push(format!("не удалился ярлык {}: {error}", link.display()));
                }
            }
        }
        if let Some(folder) = start {
            // Чужие файлы в папке пользователя не трогаем.
            let _ = std::fs::remove_dir(folder);
        }
    }

    #[cfg(unix)]
    {
        if let Some(home) = dirs_home() {
            let _ = std::fs::remove_file(
                home.join(".local")
                    .join("share")
                    .join("applications")
                    .join("omnispec.desktop"),
            );
        }
        if let Some(desktop) = desktop_dir() {
            let _ = std::fs::remove_file(desktop.join("OmniSpec.desktop"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

/* ───────────────────────── ярлыки и запуск ───────────────────────── */

/// Ярлыки: рабочий стол + меню «Пуск».
fn make_shortcuts(exe: &Path, dir: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        crate::windows_shortcuts::make_shortcuts(exe, dir)
    }

    #[cfg(unix)]
    {
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName={APP_NAME}\nComment=Лаунчер Minecraft для оффлайн-аккаунтов\n\
             Exec=\"{}\"\nPath={}\nIcon={}\nTerminal=false\nCategories=Game;\n",
            exe.display(),
            dir.display(),
            dir.join("icon.png").display()
        );
        let apps = dirs_home()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".local")
            .join("share")
            .join("applications");
        let _ = std::fs::create_dir_all(&apps);
        let _ = std::fs::write(apps.join("omnispec.desktop"), &entry);
        if let Some(desktop) = desktop_dir() {
            let _ = std::fs::write(desktop.join("OmniSpec.desktop"), &entry);
        }
        Ok(())
    }

    #[cfg(not(any(windows, unix)))]
    {
        let _ = (exe, dir);
        Ok(())
    }
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub fn launch(exe: &Path) {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new(exe);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let _ = command.spawn();
}

/// Открыть папку установки в проводнике / файловом менеджере.
pub fn open_folder(dir: &Path) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("explorer")
            .arg(dir)
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(dir).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = dir;
    }
}

/// Уже стоит в этой папке?
pub fn installed_in(dir: &Path) -> bool {
    dir.join(APP_EXE).is_file()
}
