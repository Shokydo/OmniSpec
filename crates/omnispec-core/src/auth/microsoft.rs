//! Вход через Microsoft (лицензия) — цепочка как у официального лаунчера:
//!
//! 1. **device code** на `login.live.com` — пользователь вводит короткий код на
//!    `microsoft.com/link`, ничего никуда не редиректится и окно лаунчера не нужно;
//! 2. `device_code` → **токен MSA**;
//! 3. MSA → **Xbox Live** (`user.auth.xboxlive.com`);
//! 4. Xbox Live → **XSTS** (`xsts.auth.xboxlive.com`);
//! 5. XSTS → **Minecraft Services** (`login_with_xbox`);
//! 6. профиль игрока (ник + UUID) и проверка владения игрой.
//!
//! Client ID по умолчанию — публичный ID официального лаунчера
//! `00000000402b5328`: он не требует регистрации приложения в Azure, им
//! пользуется большинство сторонних лаунчеров. Свой client id можно задать в
//! настройках (тогда его должен одобрить Mojang — <https://aka.ms/mce-reviewappid>).

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::net::Http;

/// Публичный client id официального лаунчера Minecraft.
pub const DEFAULT_CLIENT_ID: &str = "00000000402b5328";
const SCOPE: &str = "service::user.auth.xboxlive.com::MBI_SSL";
const DEVICE_CODE_URL: &str = "https://login.live.com/oauth20_connect.srf";
const TOKEN_URL: &str = "https://login.live.com/oauth20_token.srf";
const XBL_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN_URL: &str = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";

/// Что показать пользователю, чтобы он вошёл.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCode {
    /// Короткий код, который вводят на сайте.
    pub user_code: String,
    /// Длинный код — нужен только для опроса, в UI не показываем.
    pub device_code: String,
    /// Куда идти: `https://www.microsoft.com/link`.
    pub verification_uri: String,
    /// Сколько живёт код, секунды.
    pub expires_in: u64,
    /// Как часто опрашивать, секунды.
    pub interval: u64,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    user_code: String,
    device_code: String,
    verification_uri: String,
    #[serde(default = "default_expires")]
    expires_in: u64,
    #[serde(default = "default_interval")]
    interval: u64,
}

fn default_expires() -> u64 {
    900
}
fn default_interval() -> u64 {
    5
}

/// Ответ `oauth20_token.srf`. Пока пользователь не подтвердил вход, Microsoft
/// присылает **только** `{"error": "authorization_pending"}`, без `access_token`,
/// поэтому все поля необязательные — иначе разбор падает вместо «ждём дальше».
#[derive(Debug, Default, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

impl TokenResponse {
    /// Токен или внятная ошибка (вместо «missing field»).
    fn into_token(self, context: &str) -> Result<(String, String, u64)> {
        if let Some(error) = self.error.clone() {
            let detail = self
                .error_description
                .or(self.error)
                .unwrap_or_else(|| context.to_string());
            return Err(Error::Other(format!("{context}: {detail}")));
        }
        let token = self
            .access_token
            .ok_or_else(|| Error::Other(format!("{context}: Microsoft не выдал токен доступа")))?;
        Ok((
            token,
            self.refresh_token.unwrap_or_default(),
            self.expires_in.unwrap_or(3600),
        ))
    }
}

/// Итог входа: то, что нужно для запуска игры и для карточки аккаунта.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MicrosoftSession {
    pub username: String,
    pub uuid: String,
    pub access_token: String,
    pub refresh_token: String,
    /// Когда истечёт `access_token` (unix-время).
    pub expires_at: u64,
}

/// Первые 200 символов ответа — чтобы ошибка была читаемой, а не простынёй.
fn clip(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 200 {
        return trimmed.to_string();
    }
    let short: String = trimmed.chars().take(200).collect();
    format!("{short}…")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

/// Шаг 1: запросить код у Microsoft.
pub async fn start_device_code(http: &Http, client_id: &str) -> Result<DeviceCode> {
    let client_id = if client_id.trim().is_empty() {
        DEFAULT_CLIENT_ID
    } else {
        client_id.trim()
    };
    let text = http
        .post_form(
            DEVICE_CODE_URL,
            &[
                ("client_id", client_id),
                ("scope", SCOPE),
                ("response_type", "device_code"),
            ],
        )
        .await?;
    let parsed: DeviceCodeResponse = serde_json::from_str(&text).map_err(|_| {
        Error::Other(format!(
            "Microsoft не выдал код устройства (проверь client id в настройках). Ответ: {}",
            clip(&text)
        ))
    })?;
    Ok(DeviceCode {
        user_code: parsed.user_code,
        device_code: parsed.device_code,
        verification_uri: parsed.verification_uri,
        expires_in: parsed.expires_in,
        interval: parsed.interval.max(2),
    })
}

/// Шаг 2: один опрос. `Ok(None)` — пользователь ещё не вошёл, продолжаем ждать.
pub async fn poll_device_code(
    http: &Http,
    client_id: &str,
    device_code: &str,
) -> Result<Option<MicrosoftSession>> {
    let client_id = if client_id.trim().is_empty() {
        DEFAULT_CLIENT_ID
    } else {
        client_id.trim()
    };
    let text = http
        .post_form(
            TOKEN_URL,
            &[
                ("client_id", client_id),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
        )
        .await?;
    let token: TokenResponse = serde_json::from_str(&text).map_err(|_| {
        Error::Other(format!("Microsoft ответил неожиданным JSON: {}", clip(&text)))
    })?;
    if let Some(error) = &token.error {
        // Штатные состояния опроса — не ошибки, просто ждём дальше.
        if error == "authorization_pending" || error == "slow_down" {
            return Ok(None);
        }
        if error == "expired_token" {
            return Err(Error::Other(
                "код истёк — нажми «Добавить аккаунт» и получи новый".into(),
            ));
        }
        let detail = token
            .error_description
            .clone()
            .unwrap_or_else(|| error.clone());
        return Err(Error::Other(format!("Microsoft: {detail}")));
    }
    let (access, refresh, expires_in) = token.into_token("вход через Microsoft")?;
    let expires_at = now_secs() + expires_in.max(60);
    let session = chain(http, &access, &refresh, expires_at).await?;
    Ok(Some(session))
}

/// Обновить сессию по refresh-токену (без повторного входа).
pub async fn refresh(http: &Http, client_id: &str, refresh_token: &str) -> Result<MicrosoftSession> {
    let client_id = if client_id.trim().is_empty() {
        DEFAULT_CLIENT_ID
    } else {
        client_id.trim()
    };
    let text = http
        .post_form(
            TOKEN_URL,
            &[
                ("client_id", client_id),
                ("refresh_token", refresh_token),
                ("grant_type", "refresh_token"),
                ("scope", SCOPE),
            ],
        )
        .await?;
    let token: TokenResponse = serde_json::from_str(&text).map_err(|_| {
        Error::Other(format!("Microsoft ответил неожиданным JSON: {}", clip(&text)))
    })?;
    let (access, refresh, expires_in) = token.into_token("не удалось обновить вход")?;
    let expires_at = now_secs() + expires_in.max(60);
    chain(http, &access, &refresh, expires_at).await
}

/// Xbox Live → XSTS → Minecraft. Общая часть для входа и обновления.
async fn chain(
    http: &Http,
    msa_token: &str,
    refresh_token: &str,
    expires_at: u64,
) -> Result<MicrosoftSession> {
    // 3. Xbox Live
    let xbl_body = serde_json::json!({
        "Properties": { "AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": msa_token },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT"
    });
    let xbl: serde_json::Value = serde_json::from_str(&http.post_json(XBL_URL, &xbl_body).await?)?;
    let xbl_token = xbl
        .get("Token")
        .and_then(|value| value.as_str())
        .ok_or_else(|| Error::Other("Xbox Live не выдал токен".into()))?
        .to_string();

    // 4. XSTS
    let xsts_body = serde_json::json!({
        "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
        "RelyingParty": "rp://api.minecraftservices.com/",
        "TokenType": "JWT"
    });
    let xsts_text = http.post_json(XSTS_URL, &xsts_body).await?;
    let xsts: serde_json::Value = serde_json::from_str(&xsts_text)?;
    let xsts_token = xsts
        .get("Token")
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            // Самая частая причина — у аккаунта нет Xbox-профиля или он детский.
            Error::Other(xsts_error(&xsts))
        })?
        .to_string();
    let user_hash = xsts
        .get("DisplayClaims")
        .and_then(|value| value.get("xui"))
        .and_then(|value| value.get(0))
        .and_then(|value| value.get("uhs"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| Error::Other("XSTS не вернул идентификатор пользователя".into()))?
        .to_string();

    // 5. Minecraft Services
    let login_body = serde_json::json!({
        "identityToken": format!("XBL3.0 x={user_hash};{xsts_token}")
    });
    let login: serde_json::Value =
        serde_json::from_str(&http.post_json(MC_LOGIN_URL, &login_body).await?)?;
    let access_token = login
        .get("access_token")
        .and_then(|value| value.as_str())
        .ok_or_else(|| Error::Other("Minecraft не выдал токен доступа".into()))?
        .to_string();

    // 6. Профиль: ник и UUID. Если игры нет — здесь будет 404.
    let profile_text = http
        .get_with_bearer(MC_PROFILE_URL, &access_token)
        .await
        .map_err(|_| {
            Error::Other(
                "у этого аккаунта нет Minecraft: Java Edition (или профиль не создан)".into(),
            )
        })?;
    let profile: serde_json::Value = serde_json::from_str(&profile_text)?;
    let name = profile
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let uuid = profile
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    if name.is_empty() || uuid.is_empty() {
        return Err(Error::Other("Minecraft вернул пустой профиль".into()));
    }

    Ok(MicrosoftSession {
        username: name,
        uuid: format_uuid(&uuid),
        access_token,
        refresh_token: refresh_token.to_string(),
        expires_at,
    })
}

/// Понятное объяснение ошибки XSTS (XErr).
fn xsts_error(xsts: &serde_json::Value) -> String {
    let code = xsts
        .get("XErr")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    match code {
        2148916233 => "у аккаунта Microsoft нет профиля Xbox — создай его на xbox.com, потом повтори".into(),
        2148916235 => "Xbox Live недоступен в стране аккаунта — нужен VPN".into(),
        2148916236 | 2148916237 => "аккаунт требует подтверждения совершеннолетия (детский аккаунт)".into(),
        2148916238 => "аккаунт ребёнка: его должен добавить в семью взрослый".into(),
        _ => format!("XSTS отклонил вход (XErr {code})"),
    }
}

/// UUID с дефисами — как в игре.
fn format_uuid(raw: &str) -> String {
    let clean: String = raw.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if clean.len() != 32 {
        return raw.to_string();
    }
    format!(
        "{}-{}-{}-{}-{}",
        &clean[0..8],
        &clean[8..12],
        &clean[12..16],
        &clean[16..20],
        &clean[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_gets_dashes() {
        assert_eq!(
            format_uuid("069a79f444e94726a5befca90e38aaf5"),
            "069a79f4-44e9-4726-a5be-fca90e38aaf5"
        );
    }

    #[test]
    fn uuid_stays_when_short() {
        assert_eq!(format_uuid("123"), "123");
    }

    #[test]
    fn pending_without_token_is_not_an_error() {
        let text = r#"{"error":"authorization_pending","error_description":"AADSTS70016"}"#;
        let parsed: TokenResponse = serde_json::from_str(text).unwrap();
        assert_eq!(parsed.error.as_deref(), Some("authorization_pending"));
        assert!(parsed.access_token.is_none());
    }

    #[test]
    fn token_answer_without_token_explains_itself() {
        let text = r#"{"error":"expired_token","error_description":"код истёк"}"#;
        let parsed: TokenResponse = serde_json::from_str(text).unwrap();
        let error = parsed.into_token("вход").unwrap_err().to_string();
        assert!(error.contains("код истёк"));
    }

    #[test]
    fn xsts_errors_are_human() {
        let value = serde_json::json!({ "XErr": 2148916233u64 });
        assert!(xsts_error(&value).to_lowercase().contains("профил"));
    }
}
