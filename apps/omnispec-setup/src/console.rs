/*
 * OmniSpec — консольный установщик (запасной вариант).
 *
 * Тот же вид, что и раньше: чёрное окно, шапка из «=», поля «Версия / Куда
 * установится / Внутри», список «Что будет сделано» и Enter/Esc.
 *
 * Запускается флагом `--console` или сам, если графическое окно открыть не
 * удалось (нет OpenGL, нет дисплея).
 */

use std::io::Write;
use std::path::Path;

use crate::common::{self, APP_EXE, APP_NAME};

/* ───────────────────────── вывод ───────────────────────── */

fn rule() {
    println!("  ==================================================================");
}

fn line(text: &str) {
    println!("{text}");
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
        return matches!(key, b'\r' | b'\n' | b'y' | b'Y');
    }

    // Терминала нет (ввод перенаправлен) — читаем строку.
    let mut answer = String::new();
    if std::io::stdin().read_line(&mut answer).is_err() {
        return false;
    }
    let answer = answer.trim().to_lowercase();
    !(answer.is_empty() || answer == "n" || answer == "no" || answer == "н" || answer == "нет")
}

fn pause() {
    print!("  Нажми Enter, чтобы закрыть окно… ");
    let _ = std::io::stdout().flush();
    let mut buffer = String::new();
    let _ = std::io::stdin().read_line(&mut buffer);
}

/* ───────────────────────── сценарий ───────────────────────── */

pub fn run(reinstall: bool, assume_yes: bool, dir_override: Option<String>) {
    let dir = match dir_override {
        // как в окне: D: → D:\OmniSpec
        Some(path) => common::with_app_folder(&common::expand_path(&path)),
        None => common::install_dir(),
    };
    let exe = dir.join(APP_EXE);

    // ── уже установлен: просто запускаем ──
    if !reinstall && common::installed_in(&dir) {
        println!();
        header(&[&format!("  {APP_NAME}")]);
        line(" уже установлен — запускаю.");
        println!("  Папка: {}", dir.display());
        line("  Обновления проверяются автоматически при запуске.");
        println!();
        common::launch(&exe);
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
    println!("  Версия:            {}", common::version());
    println!("  Куда установится:  {}", dir.display());
    println!("  Внутри:            {}", common::inside_text());
    println!();
    line("  Что будет сделано:");
    line("    1. лаунчер распакуется ровно в эту папку (права админа не нужны)");
    line("    2. рядом появится uninstall.exe — удалить можно в любой момент");
    line("    3. на рабочем столе и в меню «Пуск» появятся ярлыки");
    line("    4. при первом запуске лаунчер сам скачает Java и файлы игры");
    if dir.exists() {
        warn("");
        warn("  В папке уже есть лаунчер: файл обновится, а сборки, миры и");
        warn("  настройки (они лежат в %APPDATA%\\OmniSpec) останутся на месте.");
        warn("");
    }
    line("    5. лаунчер запустится");
    line("    6. обновляться он будет сам — из GitHub Releases");
    println!();
    rule();
    if !assume_yes && !ask_confirm() {
        println!();
        line("  Отменено.");
        println!();
        return;
    }

    println!();

    // Шаги печатаем по мере отчёта из common::install.
    let mut closers: Vec<Option<Box<dyn FnOnce(&str)>>> =
        common::STEPS.iter().map(|_| None).collect();
    let mut report = |event: common::Progress| match event {
        common::Progress::Begin { step } => {
            let label = common::STEPS[step];
            closers[step] = Some(Box::new(progress(label)));
        }
        common::Progress::Ok { step, note } => {
            if let Some(finish) = closers[step].take() {
                finish(&note);
            }
        }
        common::Progress::Fail { step, error } => {
            if let Some(finish) = closers[step].take() {
                finish("ошибка");
            }
            warn(&format!("  {error}"));
            if common::installed_in(&dir) {
                warn("  Файл лаунчера уже находится в выбранной папке. Проверь ошибку и повтори.");
            } else {
                warn("  Скачай OmniSpec.exe вручную — он работает и без установки.");
            }
            println!();
            pause();
        }
    };
    let exe = match common::install(&dir, true, &mut report) {
        Ok(path) => path,
        Err(_) => return,
    };

    println!();
    rule();
    line("  Установлено. Запускаю лаунчер…");
    println!();
    line("  Файл-установщик можно удалить — лаунчер уже на месте и");
    line("  запускается ярлыком. Если запустить установщик снова, он просто");
    line("  откроет установленный лаунчер.");
    rule();
    println!();

    common::launch(&exe);
    std::thread::sleep(std::time::Duration::from_millis(1200));
}

/// Тихая установка без вопросов (`--yes`) — для скриптов и проверок в CI.
/// Данные остаются рядом с лаунчером.
pub fn run_quiet(dir: &Path) -> Result<std::path::PathBuf, String> {
    common::install(dir, true, &mut |_| {})
}

/// Тихая установка без портативного режима (данные в профиле пользователя).
pub fn run_quiet_shared(dir: &Path) -> Result<std::path::PathBuf, String> {
    common::install(dir, false, &mut |_| {})
}

/// Тихий деинсталлятор: `uninstall --yes` / `uninstall --yes --purge`.
pub fn uninstall_quiet(dir: &Path, remove_data: bool) -> Result<(), String> {
    common::uninstall(dir, remove_data, &mut |_| {})
}
