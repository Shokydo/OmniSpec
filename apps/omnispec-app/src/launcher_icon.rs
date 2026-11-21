//! Иконка заголовка, нативного окна и большого изображения Discord.
//! Исходники встроены в бинарник: выбор работает без доступа к сети.

use omnispec_core::settings::LauncherIcon;

const DEFAULT_RPC: &str = "https://raw.githubusercontent.com/Shokydo/OmniSpec/main/apps/omnispec-app/icons/icon-512.png";

/// Discord получает только фиксированные публичные URL встроенных картинок.
/// После публикации исходников на main эти адреса доступны Discord, не
/// требуют согласия на загрузку пользовательских файлов и не меняют small_image.
pub fn presence_url(icon: LauncherIcon) -> &'static str {
    match icon {
        LauncherIcon::Ru => "https://raw.githubusercontent.com/Shokydo/OmniSpec/main/apps/omnispec-app/ui/assets/launcher-icons/ru.png",
        LauncherIcon::By => "https://raw.githubusercontent.com/Shokydo/OmniSpec/main/apps/omnispec-app/ui/assets/launcher-icons/by.png",
        LauncherIcon::Kz => "https://raw.githubusercontent.com/Shokydo/OmniSpec/main/apps/omnispec-app/ui/assets/launcher-icons/kz.png",
        LauncherIcon::Ua => "https://raw.githubusercontent.com/Shokydo/OmniSpec/main/apps/omnispec-app/ui/assets/launcher-icons/ua.png",
        LauncherIcon::Us => "https://raw.githubusercontent.com/Shokydo/OmniSpec/main/apps/omnispec-app/ui/assets/launcher-icons/us.png",
        LauncherIcon::StarBoom => "https://raw.githubusercontent.com/Shokydo/OmniSpec/main/apps/omnispec-app/ui/assets/launcher-icons/icon_star_boom.png",
        LauncherIcon::StarEye => "https://raw.githubusercontent.com/Shokydo/OmniSpec/main/apps/omnispec-app/ui/assets/launcher-icons/icon_star_eye.png",
        LauncherIcon::Default => DEFAULT_RPC,
    }
}

fn png(icon: LauncherIcon) -> &'static [u8] {
    match icon {
        LauncherIcon::Ru => include_bytes!("../ui/assets/launcher-icons/ru.png"),
        LauncherIcon::By => include_bytes!("../ui/assets/launcher-icons/by.png"),
        LauncherIcon::Kz => include_bytes!("../ui/assets/launcher-icons/kz.png"),
        LauncherIcon::Ua => include_bytes!("../ui/assets/launcher-icons/ua.png"),
        LauncherIcon::Us => include_bytes!("../ui/assets/launcher-icons/us.png"),
        LauncherIcon::StarBoom => include_bytes!("../ui/assets/launcher-icons/icon_star_boom.png"),
        LauncherIcon::StarEye => include_bytes!("../ui/assets/launcher-icons/icon_star_eye.png"),
        LauncherIcon::Default => include_bytes!("../icons/icon-512.png"),
    }
}

fn pixels(icon: LauncherIcon) -> Result<image::RgbaImage, String> {
    let original = image::load_from_memory_with_format(png(icon), image::ImageFormat::Png)
        .map_err(|error| format!("не удалось прочитать встроенную иконку: {error}"))?;
    // Квадрат 256 px даёт Windows запас для высокой плотности экрана.
    Ok(original.resize_exact(256, 256, image::imageops::FilterType::Lanczos3).to_rgba8())
}

#[cfg(windows)]
#[path = "launcher_icon_windows.rs"]
mod windows;
#[cfg(windows)]
pub use windows::NativeIconState;
#[cfg(not(windows))]
#[derive(Default)]
pub struct NativeIconState;

/// Применяем до записи настроек; при ошибке записи вызывающий код восстановит
/// прежний вариант. На Windows меняем и ICON_SMALL, и ICON_BIG: обычный
/// Tauri set_icon меняет только ICON_SMALL и не обновляет панель задач.
pub fn apply(window: &tauri::WebviewWindow, state: &NativeIconState, icon: LauncherIcon) -> Result<(), String> {
    let rgba = pixels(icon)?;
    #[cfg(not(windows))]
    {
        let _ = state;
        window.set_icon(tauri::image::Image::new_owned(rgba.into_raw(), 256, 256))
            .map_err(|error| format!("не удалось обновить значок окна: {error}"))
    }
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|error| format!("окно недоступно: {error}"))?.0 as usize;
        windows::apply(hwnd, state, 256, 256, rgba.into_raw())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_embedded_icons_are_decodable_distinct_and_publicly_addressed() {
        use std::collections::HashSet;
        let mut hashes = HashSet::new();
        let mut urls = HashSet::new();
        for icon in [LauncherIcon::Default, LauncherIcon::Ru, LauncherIcon::By,
                     LauncherIcon::Kz, LauncherIcon::Ua, LauncherIcon::Us,
                     LauncherIcon::StarBoom, LauncherIcon::StarEye] {
            assert!(hashes.insert(png(icon)));
            assert!(urls.insert(presence_url(icon)));
            assert!(super::super::presence::valid_image_url(presence_url(icon)));
            let image = pixels(icon).unwrap();
            assert_eq!(image.dimensions(), (256, 256));
        }
    }
}
