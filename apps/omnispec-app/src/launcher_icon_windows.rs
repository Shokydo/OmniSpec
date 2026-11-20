//! Собственный ICON_BIG для панели задач Windows. Tauri set_icon обновляет
//! только ICON_SMALL, поэтому оба размера устанавливаются вместе через HWND.
use std::sync::Mutex;
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateIcon, DestroyIcon, IsWindow, SendMessageW, HICON, ICON_BIG, ICON_SMALL, WM_SETICON,
};

#[derive(Default)]
pub struct NativeIconState {
    current: Mutex<Option<OwnedWindowsIcon>>,
}

// Windows не копирует HICON при WM_SETICON. Храним только созданные нами
// дескрипторы; usize позволяет управляемому состоянию Tauri быть Send+Sync.
struct OwnedWindowsIcon(usize);
impl Drop for OwnedWindowsIcon {
    fn drop(&mut self) {
        unsafe { DestroyIcon(self.0 as HICON); }
    }
}

pub fn apply(hwnd: usize, state: &NativeIconState, width: u32, height: u32, mut bgra: Vec<u8>) -> Result<(), String> {
    let hwnd = hwnd as HWND;
    if unsafe { IsWindow(hwnd) } == 0 { return Err("окно уже закрыто".into()); }
    if width == 0 || height == 0 || (width as usize).checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4)) != Some(bgra.len()) {
        return Err("неверный размер иконки Windows".into());
    }
    // 1-битная AND-маска дополнена до границы 16 бит для CreateIcon.
    let row_bytes = ((width as usize + 15) / 16) * 2;
    let mut mask = vec![0u8; row_bytes * height as usize];
    for (i, pixel) in bgra.chunks_exact_mut(4).enumerate() {
        if pixel[3] == 0 {
            let x = i % width as usize;
            let y = i / width as usize;
            mask[y * row_bytes + x / 8] |= 0x80 >> (x % 8);
        }
        pixel.swap(0, 2); // RGBA → BGRA
    }
    let handle = unsafe {
        CreateIcon(std::ptr::null_mut(), width as i32, height as i32, 1, 32, mask.as_ptr(), bgra.as_ptr())
    };
    if handle.is_null() {
        return Err(format!("не удалось создать значок Windows: {}", std::io::Error::last_os_error()));
    }
    let replacement = OwnedWindowsIcon(handle as usize);
    let mut current = state.current.lock().unwrap_or_else(|error| error.into_inner());
    // SendMessage синхронен: старый собственный HICON уничтожаем только после
    // установки обоих размеров. Быстрые переключения не оставляют HWND с
    // недействительным дескриптором и не накапливают объекты GDI.
    unsafe {
        SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, handle as isize);
        SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, handle as isize);
    }
    *current = Some(replacement);
    Ok(())
}
