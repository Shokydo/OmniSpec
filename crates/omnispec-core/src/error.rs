use std::path::PathBuf;

/// Единый тип ошибок ядра.
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("сетевая ошибка: {0}")]
    Http(#[from] reqwest::Error),

    #[error("ошибка файловой системы: {0}")]
    Io(#[from] std::io::Error),

    #[error("ошибка JSON: {0}")]
    Json(#[from] serde_json::Error),

    #[error("ошибка ZIP: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("не найдено: {0}")]
    NotFound(String),

    #[error("не хватает Java: {0}")]
    Java(String),

    #[error("{0}")]
    Other(String),
}

impl Error {
    pub fn other(msg: impl Into<String>) -> Self {
        Error::Other(msg.into())
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Error::NotFound(msg.into())
    }
}

impl From<String> for Error {
    fn from(value: String) -> Self {
        Error::Other(value)
    }
}

impl From<&str> for Error {
    fn from(value: &str) -> Self {
        Error::Other(value.to_string())
    }
}

/// Удобный контекст для ошибок ввода-вывода: «не удалось открыть <путь>».
pub fn io_context(path: &std::path::Path, err: std::io::Error) -> Error {
    Error::Other(format!("{}: {}", path.display(), err))
}

/// Путь → строка (для сообщений об ошибках).
pub fn p(path: &PathBuf) -> String {
    path.display().to_string()
}
