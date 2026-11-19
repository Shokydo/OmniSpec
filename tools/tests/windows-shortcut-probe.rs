// Исполняется только из тестовых .lnk в изолированном Windows CI.
// Пишет рядом с exe, какой файл и рабочую папку передала оболочка.
#![windows_subsystem = "windows"]

fn main() {
    let exe = std::env::current_exe().expect("current exe");
    let cwd = std::env::current_dir().expect("working directory");
    let result = format!("{}\n{}\n", exe.display(), cwd.display());
    std::fs::write(exe.parent().unwrap().join("shortcut-probe.txt"), result)
        .expect("write probe result");
}
