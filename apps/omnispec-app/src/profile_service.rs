//! Получение официального профиля и текстур Minecraft. Токены не попадают в
//! сообщения об ошибках; ссылки текстур проверяются до сетевого запроса.

use std::time::Duration;

use omnispec_core::net::Http;
use serde_json::Value;

pub const PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";
const MAX_TEXTURE: usize = 4 * 1024 * 1024;

#[derive(Debug)]
pub enum ProfileError {
    Unauthorized,
    Other(String),
}

pub async fn profile(http: &Http, url: &str, token: &str) -> Result<Value, ProfileError> {
    let response = http.inner().get(url).bearer_auth(token).timeout(Duration::from_secs(20))
        .send().await.map_err(|error| ProfileError::Other(format!("не удалось связаться с Minecraft: {error}")))?;
    let status = response.status();
    if status.as_u16() == 401 { return Err(ProfileError::Unauthorized); }
    if !status.is_success() {
        let message = match status.as_u16() {
            404 => "профиль Minecraft не найден".to_string(),
            429 => "Minecraft временно ограничил частоту запросов; попробуй позже".to_string(),
            _ => format!("Minecraft не отдал профиль: HTTP {status}"),
        };
        return Err(ProfileError::Other(message));
    }
    let profile: Value = response.json().await
        .map_err(|_| ProfileError::Other("Minecraft прислал некорректный профиль".into()))?;
    if !profile.is_object() || profile.get("id").and_then(Value::as_str).is_none() {
        return Err(ProfileError::Other("Minecraft прислал неполный профиль".into()));
    }
    Ok(profile)
}

pub fn same_profile_id(expected: &str, returned: &str) -> bool {
    let expected = expected.replace('-', "");
    let returned = returned.replace('-', "");
    !expected.is_empty() && expected.eq_ignore_ascii_case(&returned)
}

pub fn verify_profile_identity(profile: &Value, account_uuid: &str) -> Result<(), String> {
    if profile.get("id").and_then(Value::as_str).is_some_and(|id| same_profile_id(account_uuid, id)) {
        Ok(())
    } else {
        Err("Minecraft вернул профиль другого аккаунта; переключись на нужный аккаунт и попробуй снова".into())
    }
}

/// Mojang нередко возвращает http://textures.minecraft.net; этот конкретный
/// адрес безопасно повышаем до HTTPS. Перенаправления не разрешаем.
fn texture_url(raw: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(raw).map_err(|_| "некорректный адрес текстуры Minecraft".to_string())?;
    let hash = url.path().strip_prefix("/texture/").unwrap_or("");
    if url.host_str() != Some("textures.minecraft.net") || url.port().is_some()
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some()
        || url.fragment().is_some() || hash.is_empty() || hash.len() > 128
        || !hash.bytes().all(|c| c.is_ascii_hexdigit())
        || !matches!(url.scheme(), "http" | "https") {
        return Err("Minecraft вернул недопустимый адрес текстуры".into());
    }
    url.set_scheme("https").map_err(|_| "не удалось защитить адрес текстуры".to_string())?;
    Ok(url)
}

pub async fn texture_png(http: &Http, raw: &str) -> Result<Vec<u8>, String> {
    let url = texture_url(raw)?;
    texture_png_from_url(http, url).await
}

async fn texture_png_from_url(http: &Http, url: reqwest::Url) -> Result<Vec<u8>, String> {
    let client = http.without_redirect().ok_or("не удалось создать защищённый клиент текстур")?;
    let mut response = client.get(url).timeout(Duration::from_secs(20)).send().await
        .map_err(|error| format!("не удалось скачать текстуру Minecraft: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("сервер текстур Minecraft ответил HTTP {}", response.status()));
    }
    if response.content_length().is_some_and(|size| size > MAX_TEXTURE as u64) {
        return Err("текстура Minecraft слишком большая".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "не удалось прочитать текстуру Minecraft".to_string())? {
        if bytes.len().saturating_add(chunk.len()) > MAX_TEXTURE {
            return Err("текстура Minecraft слишком большая".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    // Размер проверяем до декодирования, чтобы повреждённый PNG не выделил
    // неограниченный объём памяти; официальные скины и плащи обычно 64×64/32.
    if bytes.len() < 33 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return Err("сервер Minecraft прислал не PNG".into());
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if width == 0 || height == 0 || width > 1024 || height > 1024 {
        return Err("недопустимый размер текстуры Minecraft".into());
    }
    image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|_| "сервер Minecraft прислал повреждённый PNG".to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn mock(status: &str, content_type: &str, body: Vec<u8>) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/profile", listener.local_addr().unwrap());
        let status = status.to_owned();
        let content_type = content_type.to_owned();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let n = stream.read(&mut request).await.unwrap();
            let location = if status.starts_with("302") { "Location: http://127.0.0.1:1/untrusted\r\n" } else { "" };
            let header = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\n{location}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            stream.write_all(header.as_bytes()).await.unwrap();
            // Клиент вправе закрыть соединение сразу по слишком большому Content-Length.
            let _ = stream.write_all(&body).await;
            String::from_utf8_lossy(&request[..n]).to_string()
        });
        (url, task)
    }

    #[tokio::test]
    async fn profile_status_and_identity_are_not_silently_treated_as_success() {
        let http = Http::new();
        let (url, server) = mock("200 OK", "application/json", br#"{"id":"aabbcc","skins":[]}"#.to_vec()).await;
        let value = profile(&http, &url, "dummy-secret").await.unwrap();
        let request = server.await.unwrap();
        assert!(request.to_ascii_lowercase().contains("authorization: bearer dummy-secret"));
        assert!(verify_profile_identity(&value, "AA-BB-CC").is_ok());
        assert!(verify_profile_identity(&value, "different").is_err());
        for (status, expected) in [("401 Unauthorized", "unauthorized"), ("404 Not Found", "не найден"),
            ("429 Too Many Requests", "частоту"), ("503 Service Unavailable", "503")] {
            let (url, server) = mock(status, "application/json", b"{}".to_vec()).await;
            let error = profile(&http, &url, "dummy-secret").await.unwrap_err();
            let text = match error { ProfileError::Unauthorized => "unauthorized".to_string(), ProfileError::Other(message) => message };
            assert!(text.contains(expected), "{status}: {text}");
            assert!(!text.contains("dummy-secret"));
            server.await.unwrap();
        }
        let (url, server) = mock("200 OK", "application/json", b"{\"error\":\"failure\"}".to_vec()).await;
        assert!(matches!(profile(&http, &url, "dummy-secret").await, Err(ProfileError::Other(_))));
        server.await.unwrap();
    }

    #[test]
    fn only_official_textures_are_allowed_and_http_is_upgraded() {
        assert_eq!(texture_url("http://textures.minecraft.net/texture/abc123").unwrap().as_str(),
            "https://textures.minecraft.net/texture/abc123");
        for url in ["http://localhost/texture/abc", "https://textures.minecraft.net.evil/texture/abc",
            "https://textures.minecraft.net:444/texture/abc", "https://textures.minecraft.net/texture/abc?x=1",
            "https://textures.minecraft.net/texture/../../private", "file:///texture/abc"] {
            assert!(texture_url(url).is_err(), "must reject {url}");
        }
    }

    #[tokio::test]
    async fn texture_rejects_error_pages_corrupt_png_oversize_and_redirects() {
        let http = Http::new();
        for (status, body) in [("404 Not Found", b"not found".to_vec()),
            ("200 OK", b"<html>not an image</html>".to_vec()),
            ("200 OK", vec![0; MAX_TEXTURE + 1])] {
            let (url, server) = mock(status, "image/png", body).await;
            assert!(texture_png_from_url(&http, url.parse().unwrap()).await.is_err());
            server.await.unwrap();
        }
        let (url, server) = mock("302 Found", "text/plain", vec![]).await;
        let error = texture_png_from_url(&http, url.parse().unwrap()).await.unwrap_err();
        assert!(error.contains("302"), "redirect must not be followed: {error}");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn texture_accepts_a_complete_valid_png() {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(64, 64).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let (url, server) = mock("200 OK", "image/png", bytes.into_inner()).await;
        let png = texture_png_from_url(&Http::new(), url.parse().unwrap()).await.unwrap();
        assert!(crate::validate_skin_png(&png).is_ok());
        server.await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires public network; downloads a public example skin, not a Microsoft login"]
    async fn public_mojang_texture_can_be_loaded_over_https() {
        let http = Http::new();
        let bytes = texture_png(&http, "http://textures.minecraft.net/texture/7fd9ba42a7c81eeea22f1524271ae85a8e045ce0af5a6ae16c6406ae917e68b5").await.unwrap();
        assert!(crate::validate_skin_png(&bytes).is_ok());
    }
}
