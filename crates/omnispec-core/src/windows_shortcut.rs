//! Запасной способ задать рабочую папку при запуске из Windows-ярлыка.
//!
//! Shell разворачивает `%ИМЯ%` в поле «Рабочая папка» ярлыка. Если безопасного
//! короткого имени пути нет, установщик оставляет поле пустым и добавляет этот
//! аргумент. Лаунчер устанавливает папку своего exe напрямую через Win32.

use std::ffi::{OsStr, OsString};
use std::io;

pub const SHORTCUT_CWD_ARG: &str = "--omnispec-shortcut-cwd";

fn is_shortcut_launch(mut args: impl Iterator<Item = OsString>) -> bool {
    args.next().as_deref() == Some(OsStr::new(SHORTCUT_CWD_ARG)) && args.next().is_none()
}

/// Возвращает true, если папка изменена; обычные аргументы не затрагиваются.
pub fn enter_shortcut_directory() -> io::Result<bool> {
    if !is_shortcut_launch(std::env::args_os().skip(1)) {
        return Ok(false);
    }
    let executable = std::env::current_exe()?;
    let directory = executable.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "executable has no parent directory",
        )
    })?;
    std::env::set_current_dir(directory)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_dedicated_single_argument_changes_the_working_directory() {
        let args = |values: &[&str]| {
            values
                .iter()
                .map(OsString::from)
                .collect::<Vec<_>>()
                .into_iter()
        };
        assert!(is_shortcut_launch(args(&[SHORTCUT_CWD_ARG])));
        assert!(!is_shortcut_launch(args(&[])));
        assert!(!is_shortcut_launch(args(&["example.mrpack"])));
        assert!(!is_shortcut_launch(args(&[
            SHORTCUT_CWD_ARG,
            "example.mrpack"
        ])));
        assert!(!is_shortcut_launch(args(&[
            "--update-helper",
            SHORTCUT_CWD_ARG
        ])));
    }
}
