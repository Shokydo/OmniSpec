//! Вшивает exe лаунчера в установщик и ставит на него иконку OmniSpec.
//!
//! CI собирает порядок: сначала `omnispec-app`, потом этот установщик с
//! переменной OMNISPEC_SETUP_PAYLOAD=target/release/omnispec-app.exe.
//! Если переменной нет (обычная разработка), полезной нагрузки нет и
//! установщик скачает последний релиз с GitHub.

use std::path::Path;

fn main() {
    println!("cargo:rerun-if-env-changed=OMNISPEC_SETUP_PAYLOAD");
    // Путь можно задать относительно корня workspace (так делает CI) — build.rs
    // запускается из каталога крейта, поэтому проверяем оба варианта.
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let resolve = |path: &str| -> Option<std::path::PathBuf> {
        let direct = Path::new(path).to_path_buf();
        if direct.is_file() {
            return Some(direct);
        }
        let from_root = workspace.join(path);
        if from_root.is_file() {
            return Some(from_root);
        }
        None
    };

    let payload = match std::env::var("OMNISPEC_SETUP_PAYLOAD") {
        Ok(path) if resolve(&path).is_some() => {
            let found = resolve(&path).expect("путь проверен");
            let absolute = std::fs::canonicalize(&found).unwrap_or(found);
            println!("cargo:rerun-if-changed={path}");
            println!("cargo:rerun-if-changed={}", absolute.display());
            format!("include_bytes!({:?})", absolute.to_string_lossy())
        }
        Ok(path) => {
            println!("cargo:warning=OMNISPEC_SETUP_PAYLOAD указан, но файла нет: {path}");
            "&[]".to_string()
        }
        Err(_) => "&[]".to_string(),
    };

    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"))
        .join("payload.rs");
    std::fs::write(out, format!("pub static PAYLOAD: &[u8] = {payload};\n"))
        .expect("не записался payload.rs");

    windows_resources();
}

/// Иконка и сведения о файле для Windows-сборки установщика.
///
/// Без секции ресурсов `OmniSpec-Setup.exe` показывается со стандартным
/// значком консоли — и в проводнике, и в «Панели задач», и в «Приложениях».
/// Иконки берём тот же `icons/icon.ico`, что и у лаунчера.
#[cfg(windows)]
fn windows_resources() {
    let icon = Path::new(env!("CARGO_MANIFEST_DIR")).join("../omnispec-app/icons/icon.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    if !icon.is_file() {
        println!(
            "cargo:warning=нет {} — установщик останется без иконки",
            icon.display()
        );
        return;
    }

    let version = env!("CARGO_PKG_VERSION");
    let numeric = format!("{version}.0"); // ресурс версии ждёт 4 числа
    let mut res = winresource::WindowsResource::new();
    res.set_icon(&icon.to_string_lossy());
    res.set("ProductName", "OmniSpec");
    res.set("FileDescription", "Установщик OmniSpec");
    res.set("CompanyName", "OmniSpec");
    res.set("LegalCopyright", "MIT");
    res.set("OriginalFilename", "OmniSpec-Setup.exe");
    res.set("InternalName", "omnispec-setup");
    res.set("FileVersion", &numeric);
    res.set("ProductVersion", &numeric);
    match res.compile() {
        Ok(()) => println!("cargo:warning=иконка установщика: {}", icon.display()),
        Err(err) => println!("cargo:warning=не удалось приложить ресурсы: {err}"),
    }
}

#[cfg(not(windows))]
fn windows_resources() { /* ресурсы нужны только exe-сборке под Windows */ }
