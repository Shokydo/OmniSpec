//! Вшивает exe лаунчера в установщик.
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
}
