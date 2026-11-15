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
 *   1. раскладывает лаунчер ровно в ту папку, которую выбрали (права админа не
 *      нужны), и запоминает её для следующих запусков;
 *   2. кладёт рядом деинсталлятор `uninstall.exe`, `install-info.txt` и, если
 *      данные держим рядом с лаунчером, `portable.txt`;
 *   3. создаёт ярлыки на рабочем столе и в меню «Пуск»;
 *   4. запускает лаунчер;
 *   5. если лаунчер уже установлен, окно предлагает запустить его,
 *      переустановить или удалить.
 *
 * Тот же файл работает и деинсталлятором: запуск под именем `uninstall.exe`
 * (или с флагом `--uninstall`) открывает экран удаления.
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
    let mut uninstall = false;
    let mut purge = false;
    let mut shared = false;
    let mut dir: Option<String> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--reinstall" | "--переустановить" => reinstall = true,
            "--yes" | "-y" | "--silent" => assume_yes = true,
            "--console" | "--terminal" => force_console = true,
            "--uninstall" | "--удалить" => uninstall = true,
            "--purge" | "--всё" => purge = true,
            "--shared" => shared = true,
            "--portable" => shared = false,
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

    // Запущены как uninstall.exe в папке установки? Значит, мы деинсталлятор.
    if !uninstall {
        if let Ok(exe) = std::env::current_exe() {
            let name = exe
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_lowercase();
            if name.starts_with("uninstall") && common::installed_in(&exe_dir(&exe)) {
                uninstall = true;
            }
        }
    }

    if uninstall {
        let target = dir
            .as_deref()
            .map(common::expand_path)
            .or_else(|| std::env::current_exe().ok().map(|exe| exe_dir(&exe)))
            .unwrap_or_else(common::install_dir);
        if assume_yes {
            match console::uninstall_quiet(&target, purge) {
                Ok(()) => println!("удалено: {}", target.display()),
                Err(error) => {
                    eprintln!("ошибка: {error}");
                    std::process::exit(1);
                }
            }
            return;
        }
        if let Err(error) = gui::run_with(true, Some(target.clone())) {
            // Без окна не удаляем молча — только подсказываем, как попросить об этом явно.
            eprintln!("  Не открылось окно деинсталлятора: {error}");
            eprintln!("  Чтобы удалить без окна, запусти:");
            eprintln!("    uninstall --yes{}", if purge { " --purge" } else { "" });
        }
        return;
    }

    // Для скриптов и CI: без окон и вопросов, только результат в stderr.
    if assume_yes {
        let target = dir
            .as_deref()
            .map(common::expand_path)
            .unwrap_or_else(common::install_dir);
        let result = if shared {
            console::run_quiet_shared(&target)
        } else {
            console::run_quiet(&target)
        };
        match result {
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

/// Папка, в которой лежит исполняемый файл.
fn exe_dir(exe: &std::path::Path) -> std::path::PathBuf {
    exe.parent()
        .map(|path| path.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn help() {
    println!("  omnispec-setup — установщик OmniSpec");
    println!("  --reinstall      переустановить поверх (сохранив сборки и миры)");
    println!("  --dir <путь>     папка установки (запоминается для следующих запусков)");
    println!("  --console        без окна, визард в консоли");
    println!("  --yes, --silent  установить без вопросов (для скриптов)");
    println!("  --shared         данные (java, сборки) в профиле, не рядом с лаунчером");
    println!("  --portable       данные рядом с лаунчером (по умолчанию)");
    println!("  --uninstall      удалить лаунчер (то же самое делает uninstall.exe)");
    println!("  --purge          при удалении стереть ещё и сборки с настройками");
}
