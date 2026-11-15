/*
 * OmniSpec — общая часть установщика.
 *
 * Здесь всё, что не зависит от того, как установщик выглядит: пути, раскладка
 * файлов, ярлыки и запуск лаунчера. Этим пользуются и графическое окно
 * (gui.rs), и консольный вариант (console.rs).
 */

use std::path::{Path, PathBuf};

pub const APP_NAME: &str = "OmniSpec";
pub const APP_EXE: &str = if cfg!(windows) {
    "OmniSpec.exe"
} else {
    "OmniSpec"
};
pub const UPDATE_REPO: &str = "Shokydo/OmniSpec";

/// Что именно установщик делает — эти же строки показывает окно.
pub const STEPS: [&str; 2] = ["Раскладываю лаунчер", "Создаю ярлыки"];

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

/// Куда ставим: Windows → %LOCALAPPDATA%\OmniSpec, Unix → ~/.local/share/OmniSpec.
pub fn install_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("OMNISPEC_SETUP_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
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

pub fn dirs_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
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

/// Полная установка. Отчёт о шагах — через `report`, чтобы окно и консоль
/// показывали одно и то же.
pub fn install(dir: &Path, report: &mut dyn FnMut(Progress)) -> Result<PathBuf, String> {
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
    let size = std::fs::metadata(&exe).map(|meta| meta.len()).unwrap_or(0);
    report(Progress::Ok {
        step: 0,
        note: format!("готово ({:.1} МБ)", size as f64 / 1_048_576.0),
    });

    report(Progress::Begin { step: 1 });
    make_shortcuts(&exe, dir);
    report(Progress::Ok {
        step: 1,
        note: "готово".to_string(),
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

/// Ярлыки: рабочий стол + меню «Пуск». Windows — через PowerShell (WScript.Shell).
fn make_shortcuts(exe: &Path, dir: &Path) {
    #[cfg(windows)]
    {
        let script = |lnk: &Path| {
            format!(
                "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \
                 \"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');\
                 $s.TargetPath='{}';$s.WorkingDirectory='{}';$s.IconLocation='{},0';$s.Description='{}';$s.Save()\"",
                lnk.display(),
                exe.display(),
                dir.display(),
                exe.display(),
                APP_NAME
            )
        };
        let run = |command: String| {
            let _ = std::process::Command::new("cmd")
                .args(["/C", &command])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW — без мигания консоли
                .status();
        };

        if let Some(desktop) = desktop_dir() {
            run(script(&desktop.join(format!("{APP_NAME}.lnk"))));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            let programs = PathBuf::from(appdata)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs");
            let folder = programs.join(APP_NAME);
            let _ = std::fs::create_dir_all(&folder);
            run(script(&folder.join(format!("{APP_NAME}.lnk"))));
        }
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
    }

    #[cfg(not(any(windows, unix)))]
    {
        let _ = (exe, dir);
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
