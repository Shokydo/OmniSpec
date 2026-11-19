// Исполняется только из тестовых .lnk в изолированном Windows CI.
// Пишет рядом с exe, какой файл и рабочая папка получились после запуска.
#![windows_subsystem = "windows"]

// Это тот же код, который выполняет настоящий лаунчер, а не тестовая копия.
#[path = "../../crates/omnispec-core/src/windows_shortcut.rs"]
mod windows_shortcut;

fn main() {
    windows_shortcut::enter_shortcut_directory().expect("shortcut working directory");
    let exe = std::env::current_exe().expect("current exe");
    let cwd = std::env::current_dir().expect("working directory");
    let result = format!("{}\n{}\n", exe.display(), cwd.display());
    std::fs::write(exe.parent().unwrap().join("shortcut-probe.txt"), result)
        .expect("write probe result");
}
