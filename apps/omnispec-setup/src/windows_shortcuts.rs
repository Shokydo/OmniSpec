//! Настоящие .lnk через Windows Shell, без cmd/PowerShell и экранирования путей.

use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use windows::core::{Interface, GUID, PCWSTR};
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Programs, IShellLinkW, SHGetKnownFolderPath, SHParseDisplayName,
    ShellLink, KF_FLAG_DONT_VERIFY,
};

use crate::common::APP_NAME;

/// COM инициализируется в вызывающем потоке и освобождается ровно один раз.
struct ComApartment {
    initialized: bool,
}

impl ComApartment {
    fn enter() -> Result<Self, String> {
        // S_FALSE также требует CoUninitialize. Если поток уже инициализирован
        // в другой модели, используем существующий COM, не снимая чужую ссылку.
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if result == RPC_E_CHANGED_MODE {
            return Ok(Self { initialized: false });
        }
        result
            .ok()
            .map_err(|error| format!("не удалось инициализировать COM для ярлыков: {error}"))?;
        Ok(Self { initialized: true })
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { CoUninitialize() };
        }
    }
}

fn known_folder(id: &GUID, label: &str) -> Result<PathBuf, String> {
    // Windows сама знает перенаправленные папки, включая OneDrive и другие диски.
    let value = unsafe { SHGetKnownFolderPath(id, KF_FLAG_DONT_VERIFY, None) }
        .map_err(|error| format!("не удалось найти {label}: {error}"))?;
    if value.is_null() {
        return Err(format!("Windows вернула пустой путь для {label}"));
    }
    // SHGetKnownFolderPath выделяет UTF-16 через CoTaskMemAlloc.
    let folder = PathBuf::from(OsString::from_wide(unsafe { value.as_wide() }));
    unsafe { CoTaskMemFree(Some(value.as_ptr().cast())) };
    if folder.as_os_str().is_empty() {
        Err(format!("Windows вернула пустой путь для {label}"))
    } else {
        Ok(folder)
    }
}

pub fn desktop_folder() -> Result<PathBuf, String> {
    known_folder(&FOLDERID_Desktop, "рабочий стол")
}

pub fn programs_folder() -> Result<PathBuf, String> {
    known_folder(&FOLDERID_Programs, "меню «Пуск»")
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn create_shortcut(link_path: &Path, exe: &Path, dir: &Path) -> Result<(), String> {
    let path_wide = wide(link_path);
    let exe_wide = wide(exe);
    let dir_wide = wide(dir);
    let context = |stage: &str, error: windows::core::Error| {
        format!(
            "не создался ярлык {} ({stage}): {error}",
            link_path.display()
        )
    };
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| context("объект Shell", error))?;
        // SetPath интерпретирует %ИМЯ% в буквальном пути как переменную
        // окружения. Для уже записанного exe передаём объект Shell (PIDL),
        // чтобы путь с такими символами не изменился.
        let mut target = std::ptr::null_mut();
        SHParseDisplayName(PCWSTR(exe_wide.as_ptr()), None, &mut target, 0, None)
            .map_err(|error| context("поиск лаунчера", error))?;
        if target.is_null() {
            return Err(format!("не найден объект Shell для {}", exe.display()));
        }
        let set_target = link.SetIDList(target);
        CoTaskMemFree(Some(target.cast()));
        set_target.map_err(|error| context("путь к лаунчеру", error))?;
        link.SetWorkingDirectory(PCWSTR(dir_wide.as_ptr()))
            .map_err(|error| context("рабочая папка", error))?;
        link.SetIconLocation(PCWSTR(exe_wide.as_ptr()), 0)
            .map_err(|error| context("иконка", error))?;
        link.SetDescription(windows::core::w!("OmniSpec"))
            .map_err(|error| context("описание", error))?;
        let file: IPersistFile = link.cast().map_err(|error| context("файл", error))?;
        file.Save(PCWSTR(path_wide.as_ptr()), true)
            .map_err(|error| context("сохранение", error))?;
    }
    if !link_path.is_file() {
        return Err(format!(
            "ярлык {} не появился после сохранения",
            link_path.display()
        ));
    }
    Ok(())
}

fn make_in_folders(exe: &Path, dir: &Path, desktop: &Path, programs: &Path) -> Result<(), String> {
    let _com = ComApartment::enter()?;
    let start = programs.join(APP_NAME);
    for folder in [desktop, start.as_path()] {
        std::fs::create_dir_all(folder)
            .map_err(|error| format!("не создалась папка ярлыков {}: {error}", folder.display()))?;
    }
    create_shortcut(&desktop.join(format!("{APP_NAME}.lnk")), exe, dir)?;
    create_shortcut(&start.join(format!("{APP_NAME}.lnk")), exe, dir)?;
    Ok(())
}

pub fn make_shortcuts(exe: &Path, dir: &Path) -> Result<(), String> {
    let desktop = desktop_folder()?;
    let programs = programs_folder()?;
    make_in_folders(exe, dir, &desktop, &programs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::Win32::System::Com::STGM_READ;
    use windows::Win32::UI::Shell::SLGP_RAWPATH;

    fn read_wide(buffer: &[u16]) -> OsString {
        let end = buffer
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(buffer.len());
        OsString::from_wide(&buffer[..end])
    }

    fn assert_properties(path: &Path, exe: &Path, dir: &Path) {
        let _com = ComApartment::enter().unwrap();
        let (mut target, mut work, mut icon, mut description) = (
            vec![0u16; 32768],
            vec![0u16; 32768],
            vec![0u16; 32768],
            vec![0u16; 256],
        );
        let mut icon_index = -1;
        unsafe {
            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            let file: IPersistFile = link.cast().unwrap();
            file.Load(PCWSTR(wide(path).as_ptr()), STGM_READ).unwrap();
            link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
                .unwrap();
            link.GetWorkingDirectory(&mut work).unwrap();
            link.GetIconLocation(&mut icon, &mut icon_index).unwrap();
            link.GetDescription(&mut description).unwrap();
        }
        // Shell может развернуть короткое имя профиля RUNNER~1 в runneradmin.
        // Сравниваем реальные пути, а не их разные строковые представления.
        for (actual, expected) in [(&target, exe), (&work, dir), (&icon, exe)] {
            let actual = PathBuf::from(read_wide(actual));
            assert_eq!(
                std::fs::canonicalize(&actual).unwrap(),
                std::fs::canonicalize(expected).unwrap(),
                "путь ярлыка {}",
                actual.display()
            );
        }
        assert_eq!(icon_index, 0);
        assert_eq!(read_wide(&description), APP_NAME);
    }

    #[test]
    fn creates_both_shortcuts_with_unicode_and_shell_metacharacters_and_reports_errors() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("omnispec-{}-{unique}", std::process::id()));
        let desktop = root.join("Рабочий стол ' $(test) & 100%");
        let programs = root.join("Меню, программы");
        let dir = root.join("Сборка ' $(name) & 100%PATH% (тест), 🛠");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("OmniSpec.exe");
        std::fs::write(&exe, b"test payload").unwrap();

        make_in_folders(&exe, &dir, &desktop, &programs).unwrap();
        for link in [
            desktop.join("OmniSpec.lnk"),
            programs.join("OmniSpec/OmniSpec.lnk"),
        ] {
            assert!(link.is_file(), "{}", link.display());
            assert_properties(&link, &exe, &dir);
        }
        // Повторная установка обновляет ссылки, а не создаёт дубликаты.
        make_in_folders(&exe, &dir, &desktop, &programs).unwrap();
        assert_properties(&desktop.join("OmniSpec.lnk"), &exe, &dir);

        // Ошибка файловой системы не должна становиться ложным успехом.
        std::fs::remove_file(desktop.join("OmniSpec.lnk")).unwrap();
        std::fs::create_dir(desktop.join("OmniSpec.lnk")).unwrap();
        let error = make_in_folders(&exe, &dir, &desktop, &programs).unwrap_err();
        assert!(error.contains("OmniSpec.lnk"), "{error}");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
