/*
 * OmniSpec — установщик.
 *
 * Два вида одного и того же сценария:
 *   * обычный запуск — окно с кнопками (gui.rs), вид при этом консольный:
 *     чёрный фон, моноширинный шрифт, шапка из «=», поля и список шагов;
 *   * `--console` — тот же визард в настоящей консоли (console.rs), на случай
 *     систем без OpenGL.
 *
 * Что делает установщик:
 *   1. раскладывает лаунчер в папку пользователя (права админа не нужны) —
 *      папку можно поменять кнопкой «Изменить путь»;
 *   2. создаёт ярлыки на рабочем столе и в меню «Пуск»;
 *   3. запускает лаунчер — данные (Java, миры, моды) он держит отдельно,
 *      поэтому переустановка их не трогает;
 *   4. если лаунчер уже установлен, окно предлагает запустить его или
 *      переустановить.
 *
 * Полезная нагрузка (exe лаунчера) вшивается на этапе сборки, см. build.rs.
 * Если её нет (dev-сборка), установщик скачает последний релиз с GitHub.
 */

// Без этого атрибута рядом с окном открывалась бы ещё и консоль.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod common;
mod console;
mod gui;

fn main() {
    let mut args = std::env::args().skip(1);
    let mut reinstall = false;
    let mut assume_yes = false;
    let mut force_console = false;
    let mut dir: Option<String> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--reinstall" | "--переустановить" => reinstall = true,
            "--yes" | "-y" | "--silent" => assume_yes = true,
            "--console" | "--terminal" => force_console = true,
            "--dir" => {
                if let Some(path) = args.next() {
                    std::env::set_var("OMNISPEC_SETUP_DIR", &path);
                    dir = Some(path);
                }
            }
            "--help" | "-h" => {
                help();
                return;
            }
            _ => {}
        }
    }

    // Для скриптов и CI: без окон и вопросов, только результат в stderr.
    if assume_yes {
        let dir = common::install_dir();
        match console::run_quiet(&dir) {
            Ok(exe) => println!("{}", exe.display()),
            Err(error) => {
                eprintln!("ошибка: {error}");
                std::process::exit(1);
            }
        }
        return;
    }

    if force_console {
        console::run(reinstall, assume_yes, dir);
        return;
    }

    // Окно. Если его не удалось открыть (нет OpenGL/дисплея) — консольный вид.
    if let Err(error) = gui::run(reinstall) {
        eprintln!("  Не открылось окно установщика: {error}");
        eprintln!("  Показываю тот же установщик в консоли.");
        console::run(reinstall, true, dir);
    }
}

fn help() {
    println!("  omnispec-setup — установщик OmniSpec");
    println!("  --reinstall      переустановить поверх (сохранив сборки и миры)");
    println!("  --dir <путь>     своя папка установки");
    println!("  --console        без окна, визард в консоли");
    println!("  --yes, --silent  установить без вопросов (для скриптов)");
}
