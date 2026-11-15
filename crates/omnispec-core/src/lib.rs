//! OmniSpec — ядро лаунчера Minecraft.
//!
//! Ядро ничего не знает про GUI: его использует и Tauri‑приложение (`apps/omnispec-app`),
//! и консольная утилита `omnispec`. Всё, что связано с Minecraft, лежит здесь.

pub mod accounts;
pub mod auth;
pub mod error;
pub mod game;
pub mod instances;
pub mod loaders;
pub mod modrinth;
pub mod net;
pub mod paths;
pub mod settings;
pub mod update;

pub use error::{Error, Result};
pub use net::{Http, ProgressEvent, Reporter};
pub use paths::Paths;

/// Имя приложения (используется в путях, логах и аргументах запуска).
pub const APP_NAME: &str = "OmniSpec";
/// Версия ядра.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Значение `--versionType` и `-Dminecraft.launcher.brand`.
pub const LAUNCHER_BRAND: &str = "OmniSpec";
