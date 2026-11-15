//! Аккаунты: офлайн (без лицензии) и Microsoft (лицензия).
//!
//! Вход через Microsoft живёт в [`microsoft`]: device code → Xbox Live → XSTS →
//! Minecraft. Офлайн-аккаунт не требует сети вообще.
//!
//! UUID офлайн-игрока — это UUID v3 (MD5) от строки `OfflinePlayer:<ник>`.
//! Именно так его считает сама игра и сервера (в т.ч. плагины с offline-mode),
//! поэтому скины через сторонние сервисы и права на сервере совпадают.

pub mod microsoft;

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

pub const OFFLINE_PREFIX: &str = "OfflinePlayer:";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Account {
    /// Ник игрока.
    pub username: String,
    /// UUID без дефисов или с ними (храним с дефисами, как в игре).
    pub uuid: String,
    /// "offline" | "elyby" | "microsoft"
    pub kind: String,
    /// Токен доступа (для офлайна — пустая строка).
    #[serde(default)]
    pub access_token: String,
    /// Refresh-токен Microsoft (только для лицензии).
    #[serde(default)]
    pub refresh_token: String,
    /// Когда истекает `access_token` (unix-время, для лицензии).
    #[serde(default)]
    pub expires_at: u64,
}

impl Account {
    pub fn offline(username: &str) -> Result<Self> {
        let username = username.trim().to_string();
        validate_username(&username)?;
        Ok(Self {
            uuid: offline_uuid(&username),
            username,
            kind: "offline".into(),
            access_token: String::new(),
            refresh_token: String::new(),
            expires_at: 0,
        })
    }

    pub fn is_offline(&self) -> bool {
        self.kind == "offline"
    }

    /// Лицензионный аккаунт (вход через Microsoft).
    pub fn is_microsoft(&self) -> bool {
        self.kind == "microsoft"
    }

    /// Пора обновить токен (запас — 2 минуты).
    pub fn needs_refresh(&self) -> bool {
        self.is_microsoft()
            && (self.access_token.is_empty()
                || self.expires_at <= std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|value| value.as_secs())
                    .unwrap_or(0)
                    + 120)
    }

    /// Аккаунт из сессии Microsoft.
    pub fn from_session(session: microsoft::MicrosoftSession) -> Self {
        Self {
            username: session.username,
            uuid: session.uuid,
            kind: "microsoft".into(),
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_at: session.expires_at,
        }
    }

    /// Тип пользователя для аргументов запуска.
    pub fn user_type(&self) -> &'static str {
        match self.kind.as_str() {
            "microsoft" => "msa",
            _ => "legacy",
        }
    }
}

/// UUID v3 от `OfflinePlayer:<ник>`.
pub fn offline_uuid(username: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(OFFLINE_PREFIX.as_bytes());
    hasher.update(username.as_bytes());
    let mut bytes = hasher.finalize();
    bytes[6] = (bytes[6] & 0x0f) | 0x30; // версия 3
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // вариант RFC 4122
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Оставляем только допустимые символы ника.
pub fn sanitize_username(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(16)
        .collect()
}

/// Ник в Minecraft: 3–16 символов, латиница, цифры и `_`.
pub fn validate_username(username: &str) -> Result<()> {
    if username.len() < 3 {
        return Err(Error::Other("ник должен быть не короче 3 символов".into()));
    }
    if username.len() > 16 {
        return Err(Error::Other("ник должен быть не длиннее 16 символов".into()));
    }
    if !username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(Error::Other(
            "в нике допустимы только латинские буквы, цифры и «_»".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_matches_offline_formula() {
        // Известное значение: OfflinePlayer:Notch
        assert_eq!(
            offline_uuid("Notch"),
            "b50ad385-829d-3141-a216-7e7d7539ba7f"
        );
    }

    #[test]
    fn uuid_is_version_3() {
        let uuid = offline_uuid("Steve");
        assert_eq!(&uuid[14..15], "3");
    }

    #[test]
    fn account_validation() {
        assert!(Account::offline("Player_1").is_ok());
        assert!(Account::offline("ab").is_err());
        assert!(Account::offline("Плохой ник").is_err());
        assert!(Account::offline("toolongnickname_1234").is_err());
        assert_eq!(sanitize_username("bad nick!!"), "badnick");
    }
}
