/*
 * OmniSpec — установщик.
 *
 * Вид и поведение повторяют установщик OmniPanel (installer/installer.c):
 * чёрное окно консоли, шапка с правилами из «=», поля «Версия / Куда установится /
 * Внутри», нумерованный список «Что будет сделано» и ожидание Enter/Esc.
 *
 * Что делает:
 *   1. раскладывает лаунчер в папку пользователя (права админа не нужны);
 *   2. создаёт ярлыки на рабочем столе и в меню «Пуск»;
 *   3. запускает лаунчер — данные (Java, миры, моды) он держит отдельно,
 *      поэтому переустановка их не трогает;
 *   4. если лаунчер уже установлен, тот же файл просто запускает его.
 *
 * Полезная нагрузка (exe лаунчера) вшивается на этапе сборки, см. build.rs.
 * Если её нет (dev-сборка), установщик скачает последний релиз с GitHub.
 */

use std::io::Write;
use std::path::{Path, PathBuf};

mod payload {
    include!(concat!(env!("OUT_DIR"), "/payload.rs"));
}

/// Вшитый exe лаунчера (может быть пустым — тогда качаем с GitHub).
const PAYLOAD: &[u8] = payload::PAYLOAD;

/// Иконка приложения — кладём рядом с лаунчером, чтобы ярлык был с картинкой.
const ICON: &[u8] = include_bytes!("../../omnispec-app/icons/128x128.png");

const APP_NAME: &str = "OmniSpec";
const APP_EXE: &str = if cfg!(windows) {
    "OmniSpec.exe"
} else {
    "OmniSpec"
};
const UPDATE_REPO: &str = "Shokydo/OmniSpec";

fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/* ───────────────────────── вывод ───────────────────────── */

fn rule() {
    println!("  ==================================================================");
}

fn line(text: &str) {
    println!("{text}");
}

/// Включить ANSI-последовательности (на Windows — через консольный режим VT)
/// и UTF-8, иначе кириллица в консоли превращается в мусор.
fn prepare_console() {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetStdHandle(which: u32) -> *mut core::ffi::c_void;
            fn GetConsoleMode(handle: *mut core::ffi::c_void, mode: *mut u32) -> i32;
            fn SetConsoleMode(handle: *mut core::ffi::c_void, mode: u32) -> i32;
            fn SetConsoleOutputCP(page: u32) -> i32;
        }
        const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
        const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;
        unsafe {
            SetConsoleOutputCP(65001); // UTF-8, как в установщике OmniPanel
            let handle = GetStdHandle(STD_OUTPUT_HANDLE);
            let mut mode = 0u32;
            if GetConsoleMode(handle, &mut mode) != 0 {
                SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
            }
        }
    }
}

/// Заголовок (яркий), тело (обычное) — как в консоли OmniPanel.
fn header(lines: &[&str]) {
    for text in lines {
        println!("\u{1b}[1;97m{text}\u{1b}[0m");
    }
}

fn warn(text: &str) {
    println!("\u{1b}[1;97m{text}\u{1b}[0m");
}

/// Печатает «делаю … » и возвращает функцию, чтобы закрыть строку «готово».
fn progress(label: &str) -> impl FnOnce(&str) {
    print!("  {label} … ");
    let _ = std::io::stdout().flush();
    move |result: &str| {
        println!("{result}");
        let _ = std::io::stdout().flush();
    }
}

/* ───────────────────────── клавиатура ───────────────────────── */

/// Одна клавиша без Enter: на Unix — termios, на Windows — _getch.
#[cfg(unix)]
fn read_key() -> Option<u8> {
    use std::io::Read;
    use std::os::unix::io::AsRawFd;

    let mut tty = std::fs::File::open("/dev/tty")
        .or_else(|_| std::fs::File::open("/dev/stdin"))
        .ok()?;
    let fd = tty.as_raw_fd();
    unsafe {
        let mut original: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut original) != 0 {
            return None;
        }
        let mut raw = original;
        raw.c_lflag &= !(libc::ICANON | libc::ECHO);
        raw.c_cc[libc::VMIN] = 1;
        raw.c_cc[libc::VTIME] = 0;
        libc::tcsetattr(fd, libc::TCSANOW, &raw);
        let mut buf = [0u8; 1];
        let got = tty.read(&mut buf).unwrap_or(0);
        libc::tcsetattr(fd, libc::TCSANOW, &original);
        if got == 1 {
            Some(buf[0])
        } else {
            None
        }
    }
}

#[cfg(windows)]
fn read_key() -> Option<u8> {
    #[link(name = "msvcrt")]
    extern "C" {
        fn _getch() -> i32;
    }
    loop {
        let code = unsafe { _getch() };
        // 0 и 224 — начало служебных клавиш (стрелки, F1…): их пропускаем.
        if code == 0 || code == 224 {
            unsafe { _getch() };
            continue;
        }
        return if (0..=255).contains(&code) {
            Some(code as u8)
        } else {
            None
        };
    }
}

#[cfg(not(any(unix, windows)))]
fn read_key() -> Option<u8> {
    None
}

/// Ждёт Enter (да) или Esc (нет). Возвращает true, если нажали Enter.
fn ask_confirm() -> bool {
    print!("  Enter — установить,   Esc — отмена. ");
    let _ = std::io::stdout().flush();

    if let Some(key) = read_key() {
        println!();
        return match key {
            b'\r' | b'\n' | b'y' | b'Y' => true,
            _ => false, // Esc, n, q и любая другая клавиша — отмена
        };
    }

    // Терминала нет (ввод перенаправлен) — читаем строку.
    let mut answer = String::new();
    if std::io::stdin().read_line(&mut answer).is_err() {
        return false;
    }
    let answer = answer.trim().to_lowercase();
    !(answer.is_empty() || answer == "n" || answer == "no" || answer == "н" || answer == "нет")
}

/* ───────────────────────── пути ───────────────────────── */

/// Куда ставим: Windows → %LOCALAPPDATA%\OmniSpec, Unix → ~/.local/share/OmniSpec.
fn install_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("OMNISPEC_SETUP_DIR") {
        return PathBuf::from(custom);
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

fn dirs_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn desktop_dir() -> Option<PathBuf> {
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

fn write_launcher(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|error| format!("не создалась папка {}: {error}", dir.display()))?;
    let exe = dir.join(APP_EXE);

    let bytes: Vec<u8> = if PAYLOAD.is_empty() {
        // Полезной нагрузки в этой сборке нет — берём последний релиз с GitHub.
        download_latest()?
    } else {
        PAYLOAD.to_vec()
    };

    std::fs::write(&exe, &bytes).map_err(|error| format!("не записался {}: {error}", exe.display()))?;
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
    println!("  В этой сборке установщика нет встроенного лаунчера — качаю с GitHub.");

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

        // «Текущая версия» заведомо старая — получаем последний релиз.
        let info = update::check(&http, &config, "0.0.0")
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "на GitHub нет ни одного релиза".to_string())?;

        println!(
            "  Беру релиз {} — {} ({:.1} МБ)",
            info.version,
            info.asset_name,
            info.asset_size as f64 / 1_048_576.0
        );

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

fn launch(exe: &Path) {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new(exe);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let _ = command.spawn();
}

/* ───────────────────────── главное ───────────────────────── */

fn main() {
    let mut args = std::env::args().skip(1);
    let mut reinstall = false;
    let mut assume_yes = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--reinstall" | "--переустановить" => reinstall = true,
            "--yes" | "-y" => assume_yes = true,
            "--dir" => {
                if let Some(path) = args.next() {
                    std::env::set_var("OMNISPEC_SETUP_DIR", path);
                }
            }
            "--help" | "-h" => {
                println!("  omnispec-setup — установщик OmniSpec");
                println!("  --reinstall   переустановить поверх (сохранив данные)");
                println!("  --dir <путь>  своя папка установки");
                println!("  --yes         без вопросов (для скриптов)");
                return;
            }
            _ => {}
        }
    }

    prepare_console();

    let dir = install_dir();
    let exe = dir.join(APP_EXE);

    // ── уже установлен: просто запускаем ──
    if !reinstall && exe.is_file() {
        println!();
        header(&[&format!("  {APP_NAME}")]);
        line(" уже установлен — запускаю.");
        println!("  Папка: {}", dir.display());
        line("  Обновления проверяются автоматически при запуске.");
        println!();
        launch(&exe);
        return;
    }

    // ── установка ──
    println!();
    header(&[
        "  ==================================================================",
        "                          O m n i S p e c",
        "                лаунчер Minecraft · установка",
        "  ==================================================================",
    ]);
    println!();
    println!("  Версия:            {}", version());
    println!("  Куда установится:  {}", dir.display());
    let inside = if PAYLOAD.is_empty() {
        "лаунчер скачается с GitHub (один файл)"
    } else {
        &format!("лаунчер целиком, {:.1} МБ — ничего скачивать не нужно", PAYLOAD.len() as f64 / 1_048_576.0)
    };
    println!("  Внутри:            {inside}");
    println!();
    line("  Что будет сделано:");
    line("    1. лаунчер распакуется в папку пользователя (права админа не нужны)");
    line("    2. на рабочем столе и в меню «Пуск» появятся ярлыки");
    line("    3. при первом запуске лаунчер сам скачает Java и файлы игры");
    if dir.exists() {
        warn("");
        warn("  В папке уже есть лаунчер: файл обновится, а сборки, миры и");
        warn("  настройки (они лежат в %APPDATA%\\OmniSpec) останутся на месте.");
        warn("");
    }
    line("    4. лаунчер запустится");
    line("    5. обновляться он будет сам — из GitHub Releases");
    println!();
    rule();
    if !assume_yes && !ask_confirm() {
        println!();
        line("  Отменено.");
        println!();
        return;
    }

    println!();

    // 1. файл лаунчера
    let finish = progress("Раскладываю лаунчер");
    let exe = match write_launcher(&dir) {
        Ok(path) => {
            let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            finish(&format!("готово ({:.1} МБ)", size as f64 / 1_048_576.0));
            path
        }
        Err(error) => {
            finish("ошибка");
            warn(&format!("  {error}"));
            warn("  Скачай OmniSpec.exe вручную — он работает и без установки.");
            println!();
            pause();
            return;
        }
    };

    // 2. ярлыки
    let finish = progress("Создаю ярлыки");
    make_shortcuts(&exe, &dir);
    finish("готово");

    // 3. запуск
    println!();
    rule();
    line("  Установлено. Запускаю лаунчер…");
    println!();
    line("  Файл-установщик можно удалить — лаунчер уже на месте и");
    line("  запускается ярлыком. Если запустить установщик снова, он просто");
    line("  откроет установленный лаунчер.");
    rule();
    println!();

    launch(&exe);
    std::thread::sleep(std::time::Duration::from_millis(1200));
}

fn pause() {
    print!("  Нажми Enter, чтобы закрыть окно… ");
    let _ = std::io::stdout().flush();
    let mut buffer = String::new();
    let _ = std::io::stdin().read_line(&mut buffer);
}
