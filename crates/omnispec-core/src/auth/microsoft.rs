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
}

/// Ответ может содержать токены даже при повреждённом JSON. Не возвращаем его
/// содержимое или произвольное error_description в интерфейс и логи.
fn token_response(text: &str) -> Result<TokenResponse> {
    serde_json::from_str(text).map_err(|_| Error::Other("Microsoft прислал некорректный ответ входа".into()))
}

fn device_response(text: &str) -> Result<DeviceCodeResponse> {
    serde_json::from_str(text).map_err(|_| Error::Other("Microsoft не выдал код устройства; проверь client id и сеть".into()))
}

fn oauth_error(context: &str, code: &str) -> Error {
    let detail = match code {
        "expired_token" => "код истёк — начни вход заново (expired_token)",
        "invalid_grant" => "вход истёк или отозван — войди заново (invalid_grant)",
        "invalid_client" | "unauthorized_client" => "идентификатор приложения не разрешён Microsoft",
        "invalid_scope" => "Microsoft не разрешил запрошенные права (invalid_scope)",
        "access_denied" | "authorization_declined" => "вход отклонён пользователем или Microsoft",
        "server_error" | "temporarily_unavailable" => "служба Microsoft временно недоступна",
        _ => "Microsoft отклонил запрос входа; проверь сеть и попробуй снова",
    };
    Error::Other(format!("{context}: {detail}"))
}

impl TokenResponse {
    /// Токен или внятная ошибка (вместо «missing field»).
    fn into_token(self, context: &str) -> Result<(String, String, u64)> {
        if let Some(error) = self.error.as_deref() {
            return Err(oauth_error(context, error));
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
    let parsed = device_response(&text)?;
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
    let token = token_response(&text)?;
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
        return Err(oauth_error("Microsoft", error));
    }
    let (access, refresh, expires_in) = token.into_token("вход через Microsoft")?;
    // Это срок MSA-токена, не токена Minecraft. Нужен только как безопасный
    // запасной вариант, если Minecraft не вернул expires_in.
    let fallback_expires_at = now_secs().saturating_add(expires_in);
    let session = chain(http, &access, &refresh, fallback_expires_at).await?;
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
    let token = token_response(&text)?;
    let (access, refresh, expires_in) = token.into_token("не удалось обновить вход")?;
    // OAuth-сервер вправе не вернуть новый refresh-токен. Не затираем старый
    // пустой строкой; если вернул новый, сохраняем именно его.
    let refresh = select_refresh_token(refresh, refresh_token);
    let fallback_expires_at = now_secs().saturating_add(expires_in);
    chain(http, &access, &refresh, fallback_expires_at).await
}

fn select_refresh_token(returned: String, previous: &str) -> String {
    if returned.trim().is_empty() { previous.to_string() } else { returned }
}

/// Срок относится именно к Minecraft access_token, который передаётся игре.
/// Начало запроса безопаснее времени его окончания при медленном соединении.
fn minecraft_credentials(login: &serde_json::Value, requested_at: u64, fallback: u64) -> Result<(String, u64)> {
    let token = login.get("access_token").and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::Other("Minecraft не выдал токен доступа".into()))?;
    let expires_at = login.get("expires_in").and_then(|value| value.as_u64())
        .filter(|seconds| *seconds > 0)
        .map(|seconds| requested_at.saturating_add(seconds))
        .unwrap_or(fallback);
    Ok((token.to_string(), expires_at))
}

fn profile_status_error(status: reqwest::StatusCode) -> Error {
    match status.as_u16() {
        401 => Error::Other("Minecraft отклонил токен входа. Повтори вход в Microsoft".into()),
        404 => Error::Other("у этого аккаунта нет профиля Minecraft: Java Edition (или профиль не создан)".into()),
        429 => Error::Other("Minecraft временно ограничил частоту запросов. Подожди и попробуй снова".into()),
        _ => Error::Other(format!("не удалось получить профиль Minecraft: HTTP {status}")),
    }
}

/// Xbox Live → XSTS → Minecraft. Общая часть для входа и обновления.
async fn chain(
    http: &Http,
    msa_token: &str,
    refresh_token: &str,
    fallback_expires_at: u64,
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
    let requested_at = now_secs();
    let login: serde_json::Value =
        serde_json::from_str(&http.post_json(MC_LOGIN_URL, &login_body).await?)?;
    let (access_token, expires_at) = minecraft_credentials(&login, requested_at, fallback_expires_at)?;

    // 6. Только 404 означает отсутствие профиля. Сбой сети, 401, 429 и 5xx
    // не должны превращаться в ложное сообщение «игра не куплена».
    let response = http.inner().get(MC_PROFILE_URL).bearer_auth(&access_token).send().await
        .map_err(|error| Error::http(MC_PROFILE_URL, error))?;
    if !response.status().is_success() { return Err(profile_status_error(response.status())); }
    let profile: serde_json::Value = response.json().await?;
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
    fn malformed_auth_responses_never_expose_tokens_or_device_codes() {
        let bad_token = r#"{"access_token":"TOP_SECRET_TOKEN","expires_in":"invalid"}"#;
        let bad_device = r#"{"device_code":"TOP_SECRET_DEVICE","expires_in":"invalid"}"#;
        assert!(!token_response(bad_token).unwrap_err().to_string().contains("TOP_SECRET"));
        assert!(!device_response(bad_device).unwrap_err().to_string().contains("TOP_SECRET"));
        let answer = token_response(r#"{"error":"invalid_grant","error_description":"TOP_SECRET_DESCRIPTION"}"#).unwrap();
        let error = answer.into_token("вход").unwrap_err().to_string();
        assert!(error.contains("invalid_grant"));
        assert!(!error.contains("TOP_SECRET"));
        let unknown = token_response(r#"{"error":"TOP_SECRET_UNKNOWN"}"#).unwrap();
        assert!(!unknown.into_token("вход").unwrap_err().to_string().contains("TOP_SECRET"));
    }

    #[test]
    fn xsts_errors_are_human() {
        let value = serde_json::json!({ "XErr": 2148916233u64 });
        assert!(xsts_error(&value).to_lowercase().contains("профил"));
    }

    #[test]
    fn minecraft_expiry_is_not_the_oauth_expiry() {
        let login = serde_json::json!({"access_token":"mc-test", "expires_in":86400});
        assert_eq!(minecraft_credentials(&login, 1_000, 4_600).unwrap(), ("mc-test".into(), 87_400));
        let missing = serde_json::json!({"access_token":"mc-test"});
        assert_eq!(minecraft_credentials(&missing, 1_000, 4_600).unwrap().1, 4_600);
        let zero = serde_json::json!({"access_token":"mc-test", "expires_in":0});
        assert_eq!(minecraft_credentials(&zero, 1_000, 4_600).unwrap().1, 4_600);
        assert!(minecraft_credentials(&serde_json::json!({"access_token":""}), 1, 2).is_err());
        assert_eq!(minecraft_credentials(&login, u64::MAX - 1, 2).unwrap().1, u64::MAX);
    }

    #[test]
    fn refresh_token_is_preserved_unless_a_new_one_is_returned() {
        assert_eq!(select_refresh_token(String::new(), "old"), "old");
        assert_eq!(select_refresh_token("  ".into(), "old"), "old");
        assert_eq!(select_refresh_token("new".into(), "old"), "new");
    }

    #[test]
    fn profile_errors_distinguish_missing_game_from_network_or_rate_limit() {
        assert!(profile_status_error(reqwest::StatusCode::NOT_FOUND).to_string().contains("нет профиля"));
        assert!(profile_status_error(reqwest::StatusCode::UNAUTHORIZED).to_string().contains("токен"));
        assert!(profile_status_error(reqwest::StatusCode::TOO_MANY_REQUESTS).to_string().contains("частоту"));
        assert!(profile_status_error(reqwest::StatusCode::SERVICE_UNAVAILABLE).to_string().contains("503"));
    }
}
