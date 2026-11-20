//! Сцены рендерит установленный Wallpaper Engine; в WebView попадают только
//! JPEG-кадры его отдельного окна. Никакой Workshop JavaScript в WebView.
//! Окно ищем по случайному имени И пути владеющего процесса, не по имени одного окна.
#![cfg(windows)]

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use image::{codecs::jpeg::JpegEncoder, ExtendedColorType};
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings};
use windows_capture::window::Window;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE};

use crate::scene_stream::{Publisher, SceneServer};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
type CaptureError = Box<dyn std::error::Error + Send + Sync>;
type Control = CaptureControl<FrameHandler, CaptureError>;

/// Физические координаты окна лаунчера; окно рендерера располагаем под ним,
/// но не скрываем/сворачиваем: WGC может не обновлять скрытое окно.
#[derive(Clone, Copy)]
pub struct Bounds { pub x: i32, pub y: i32, pub width: u32, pub height: u32 }
impl Default for Bounds {
    fn default() -> Self { Self { x: 0, y: 0, width: 1280, height: 720 } }
}
impl Bounds {
    fn capture_size(self) -> (i32, i32) {
        let w = self.width.clamp(64, 16384);
        let h = self.height.clamp(64, 16384);
        let scale = (1280.0 / w as f64).min(720.0 / h as f64).min(1.0);
        ((w as f64 * scale).round().max(64.0) as i32, (h as f64 * scale).round().max(64.0) as i32)
    }
}

fn random_title() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("нет случайного имени окна: {e}"))?;
    Ok(format!("OmniSpec Scene {}", hex::encode(bytes)))
}

/// Путь из библиотеки Steam сам по себе не доказывает, что это WE. Проверяем
/// Authenticode встроенными средствами Windows до запуска exe. Скрипт постоянный,
/// путь передаётся через окружение и не интерпретируется как код PowerShell.
pub fn verify_signature(engine: &Path, sequence: &AtomicU64, epoch: u64) -> Result<(), String> {
    let name = engine.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if !name.eq_ignore_ascii_case("wallpaper64.exe") && !name.eq_ignore_ascii_case("wallpaper32.exe") {
        return Err("недопустимый файл Wallpaper Engine".into());
    }
    let root = std::env::var_os("SystemRoot").ok_or("не найдена папка Windows для проверки подписи")?;
    let powershell = PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let script = r#"$ErrorActionPreference='Stop';
      $module=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1';
      Import-Module $module -ErrorAction Stop;
      $s=Get-AuthenticodeSignature -LiteralPath $env:OMNISPEC_WE_EXE;
      if ($s.Status -ne 'Valid' -or !$s.SignerCertificate) { exit 1 }
      $n=$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false);
      if ($n -notmatch '^(Skutta Software GmbH|Kristjan Skutta|Skutta, Kristjan)$') { exit 2 }
      exit 0"#;
    let mut child = std::process::Command::new(powershell).creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("OMNISPEC_WE_EXE", engine).stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().map_err(|e| format!("не удалось проверить цифровую подпись Wallpaper Engine: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err("цифровая подпись Wallpaper Engine не прошла проверку Windows или подписант неизвестен".into()),
            Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(format!("ошибка проверки подписи Wallpaper Engine: {e}")); }
            _ => {}
        }
        if Instant::now() >= deadline || sequence.load(Ordering::Acquire) != epoch {
            let _ = child.kill(); let _ = child.wait();
            return Err(if sequence.load(Ordering::Acquire) != epoch { "выбор фона изменился" }
                else { "истекло время проверки подписи Wallpaper Engine" }.into());
        }
        std::thread::sleep(Duration::from_millis(75));
    }
}

fn control(engine: &Path, args: &[&str], file: Option<&Path>) -> Result<(), String> {
    let mut cmd = std::process::Command::new(engine);
    cmd.creation_flags(CREATE_NO_WINDOW).stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    cmd.args(args);
    if let Some(file) = file { cmd.arg(dunce::simplified(file)); }
    cmd.spawn().map(|_| ()).map_err(|e| format!("не удалось отправить команду Wallpaper Engine: {e}"))
}

/// Владелец должен быть одним из двух бинарников в том же установленном
/// каталоге, что обнаруженный Wallpaper Engine. Другой HWND игнорируется.
fn verified_window_owner(window: Window, engine: &Path) -> Option<PathBuf> {
    let pid = window.process_id().ok()?;
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() { return None; }
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe { CloseHandle(handle); }
    if ok == 0 || length == 0 { return None; }
    let owner = PathBuf::from(String::from_utf16(&buffer[..length as usize]).ok()?).canonicalize().ok()?;
    let allowed_name = owner.file_name().and_then(|x| x.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("wallpaper64.exe") || s.eq_ignore_ascii_case("wallpaper32.exe"));
    (allowed_name && owner.parent().is_some() && owner.parent() == engine.parent()).then_some(owner)
}

fn place(window: isize, bounds: Bounds) {
    let (width, height) = bounds.capture_size();
    // Не активируем и не сворачиваем окно. Оно может быть видно при некоторых
    // сочетаниях размеров, DPI и настроек Windows/Wallpaper Engine.
    unsafe { SetWindowPos(window as _, HWND_BOTTOM, bounds.x, bounds.y, width, height, SWP_NOACTIVATE); }
}

struct EngineWindow { engine: PathBuf, title: String }
impl Drop for EngineWindow {
    fn drop(&mut self) {
        // Команда адресована только уникальному имени этого окна, не всем обоям.
        let _ = control(&self.engine, &["-control", "closeWallpaper", "-location", &self.title], None);
    }
}

struct FrameHandler { publisher: Publisher, last: Option<Instant> }
impl GraphicsCaptureApiHandler for FrameHandler {
    type Flags = Publisher;
    type Error = CaptureError;
    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { publisher: ctx.flags, last: None })
    }
    fn on_frame_arrived(&mut self, frame: &mut Frame, _control: InternalCaptureControl) -> Result<(), Self::Error> {
        // Ограничиваем нагрузку CPU и сети. Всегда храним только последний кадр.
        if self.last.is_some_and(|t| t.elapsed() < Duration::from_millis(100)) { return Ok(()); }
        self.last = Some(Instant::now());
        let (width, height) = (frame.width(), frame.height());
        if width == 0 || height == 0 || width > 4096 || height > 4096 { return Ok(()); }
        let mut raw = frame.buffer()?;
        let bytes = raw.as_nopadding_buffer()?;
        if bytes.len() != width as usize * height as usize * 4 { return Ok(()); }
        let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
        for pixel in bytes.chunks_exact(4) { rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]); }
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 72).encode(&rgb, width, height, ExtendedColorType::Rgb8)?;
        self.publisher.publish(jpeg);
        Ok(())
    }
    fn on_closed(&mut self) -> Result<(), Self::Error> { self.publisher.close(); Ok(()) }
}
impl Drop for FrameHandler {
    fn drop(&mut self) { self.publisher.close(); }
}

struct ActiveScene {
    epoch: u64,
    project: PathBuf,
    url: String,
    publisher: Publisher,
    window: isize,
    capture: Option<Control>,
    _engine_window: EngineWindow,
}
impl ActiveScene {
    fn is_alive(&self) -> bool {
        self.publisher.is_open() && self.capture.as_ref().is_some_and(|capture| !capture.is_finished())
    }
}
impl Drop for ActiveScene {
    fn drop(&mut self) {
        self.publisher.close();
        if let Some(capture) = self.capture.take() { let _ = capture.stop(); }
    }
}

pub struct SceneManager {
    server: SceneServer,
    active: Option<ActiveScene>,
    pending: Option<ActiveScene>,
    reuse_epoch: Option<u64>,
}
impl SceneManager {
    pub fn new() -> Result<Self, String> {
        Ok(Self { server: SceneServer::new()?, active: None, pending: None, reuse_epoch: None })
    }
    pub fn stop(&mut self) {
        self.pending.take(); self.reuse_epoch = None; self.active.take();
    }
    /// Отмена ещё не применённого выбора никогда не закрывает прежний фон.
    pub fn abort(&mut self, epoch: u64) {
        if self.pending.as_ref().is_some_and(|scene| scene.epoch == epoch) { self.pending.take(); }
        if self.reuse_epoch == Some(epoch) { self.reuse_epoch = None; }
    }
    /// Вызывается после успешной записи настроек под блокировкой операции.
    pub fn commit(&mut self, epoch: u64) -> Result<(), String> {
        if self.reuse_epoch == Some(epoch) {
            self.reuse_epoch = None;
            let active = self.active.as_mut().ok_or("сцена больше не доступна")?;
            if !active.is_alive() { return Err("поток сцены остановился до сохранения. Запусти Wallpaper Engine и попробуй снова".into()); }
            active.epoch = epoch;
            return Ok(());
        }
        let candidate = self.pending.as_ref().filter(|scene| scene.epoch == epoch)
            .ok_or("подготовленная сцена больше не доступна")?;
        // Первый кадр ещё не гарантирует, что окно пережило запись настроек.
        // Не закрываем старый фон, если новый захват уже остановился.
        if !candidate.is_alive() { return Err("новая сцена остановилась до сохранения. Проверь Wallpaper Engine и попробуй снова".into()); }
        let next = self.pending.take().ok_or("подготовленная сцена больше не доступна")?;
        self.active = Some(next); // только теперь старая сцена отзывается
        Ok(())
    }
    pub fn place(&self, bounds: Bounds) {
        if let Some(scene) = &self.active { place(scene.window, bounds); }
    }
    pub fn is_alive(&self) -> bool {
        self.active.as_ref().is_some_and(ActiveScene::is_alive)
    }

    pub fn prepare(&mut self, engine: &Path, project: &Path, bounds: Bounds,
        sequence: Arc<AtomicU64>, epoch: u64) -> Result<String, String> {
        if sequence.load(Ordering::Acquire) != epoch { return Err("выбор фона изменился".into()); }
        let engine = engine.canonicalize().map_err(|_| "Wallpaper Engine не найден".to_string())?;
        let project = project.canonicalize().map_err(|_| "сцена Workshop недоступна".to_string())?;
        self.pending.take();
        self.reuse_epoch = None;
        if let Some(active) = &self.active {
            if active.project == project && active._engine_window.engine == engine && active.is_alive() {
                self.reuse_epoch = Some(epoch);
                place(active.window, bounds);
                return Ok(active.url.clone());
            }
        }
        if sequence.load(Ordering::Acquire) != epoch { return Err("выбор фона изменился".into()); }
        verify_signature(&engine, &sequence, epoch)?;
        let title = random_title()?;
        let guard = EngineWindow { engine: engine.clone(), title: title.clone() };
        let project_file = project.join("project.json").canonicalize().map_err(|_| "project.json не найден".to_string())?;
        if project_file.parent() != Some(project.as_path()) { return Err("project.json находится вне папки сцены".into()); }
        let (width, height) = bounds.capture_size();
        std::process::Command::new(&engine).creation_flags(CREATE_NO_WINDOW)
            .args(["-control", "openWallpaper", "-file"]).arg(dunce::simplified(&project_file))
            .args(["-playInWindow", &title, "-width", &width.to_string(), "-height", &height.to_string(),
                "-x", &bounds.x.to_string(), "-y", &bounds.y.to_string(), "-borderless"])
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .spawn().map_err(|e| format!("не удалось открыть сцену Wallpaper Engine: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(18);
        let (window, owner) = loop {
            if sequence.load(Ordering::Acquire) != epoch { return Err("выбор фона изменился".into()); }
            if let Ok(window) = Window::from_name(&title) {
                if let Some(owner) = verified_window_owner(window, &engine) { break (window, owner); }
            }
            if Instant::now() >= deadline {
                return Err("Wallpaper Engine не открыл окно сцены. Запусти Wallpaper Engine и проверь проект".into());
            }
            std::thread::sleep(Duration::from_millis(150));
        };
        if owner != engine { verify_signature(&owner, &sequence, epoch)?; }
        // После проверки подписи ещё раз сверяем владельца: HWND мог исчезнуть
        // или быть переиспользован между поиском и запуском захвата.
        if verified_window_owner(window, &engine).as_ref() != Some(&owner)
            || window.title().ok().as_deref() != Some(title.as_str()) {
            return Err("окно Wallpaper Engine изменилось до начала захвата".into());
        }
        let hwnd = window.as_raw_hwnd() as isize;
        place(hwnd, bounds);
        let (publisher, url) = self.server.begin()?;
        let settings = Settings::new(window, CursorCaptureSettings::Default, DrawBorderSettings::Default,
            SecondaryWindowSettings::Default, MinimumUpdateIntervalSettings::Default, DirtyRegionSettings::Default,
            ColorFormat::Bgra8, publisher.clone());
        let capture = match FrameHandler::start_free_threaded(settings) {
            Ok(value) => value,
            Err(error) => { publisher.close(); return Err(format!("Windows Graphics Capture недоступен: {error}")); }
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut received = false;
        while Instant::now() < deadline && sequence.load(Ordering::Acquire) == epoch && !capture.is_finished() {
            if publisher.wait_first(Duration::from_millis(150)) { received = true; break; }
        }
        if !received || sequence.load(Ordering::Acquire) != epoch {
            publisher.close(); let _ = capture.stop();
            return Err(if sequence.load(Ordering::Acquire) != epoch { "выбор фона изменился" }
                else { "не удалось получить кадры сцены. Проверь разрешения захвата и настройки паузы Wallpaper Engine" }.into());
        }
        self.pending = Some(ActiveScene { epoch, project, url: url.clone(), publisher, window: hwnd,
            capture: Some(capture), _engine_window: guard });
        Ok(url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires interactive Windows/D3D11 and an isolated signed test fixture"]
    fn signed_fixture_capture_and_transaction() {
        use std::io::{BufRead, Read, Write};
        use std::net::TcpStream;
        let exe = PathBuf::from(std::env::var_os("OMNISPEC_TEST_SIGNED_ENGINE").expect("signed GUI fixture"));
        let root = std::env::temp_dir().join(format!("omnispec-scene-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for name in ["one", "two"] {
            let dir = root.join(name); std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("project.json"), br#"{"type":"scene"}"#).unwrap();
        }
        fn connect(url: &str) -> std::io::BufReader<TcpStream> {
            let rest = url.strip_prefix("http://").unwrap();
            let (host, path) = rest.split_once('/').unwrap();
            let mut stream = TcpStream::connect(host).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
            write!(stream, "GET /{path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
            std::io::BufReader::new(stream)
        }
        fn line(reader: &mut std::io::BufReader<TcpStream>) -> String {
            let mut s = String::new();
            assert!(reader.read_line(&mut s).unwrap() > 0, "unexpected EOF from scene stream");
            s
        }
        fn status(url: &str) -> String {
            let mut reader = connect(url);
            let result = line(&mut reader);
            drop(reader);
            // Give a streaming client time to observe the closed socket before
            // opening the next; the server deliberately caps concurrent clients.
            std::thread::sleep(Duration::from_millis(500));
            result
        }
        let revision = Arc::new(AtomicU64::new(1));
        let bounds = Bounds { x:40, y:40, width:320, height:240 };
        let mut manager = SceneManager::new().unwrap();
        let url = manager.prepare(&exe, &root.join("one"), bounds, revision.clone(), 1).unwrap();
        manager.commit(1).unwrap();
        let mut stream = connect(&url);
        assert_eq!(line(&mut stream), "HTTP/1.1 200 OK\r\n");
        while line(&mut stream) != "\r\n" {}
        let (mut red, mut blue) = (false, false);
        for _ in 0..35 {
            assert!(line(&mut stream).starts_with("--omnispecframe"));
            let mut length = 0usize;
            loop {
                let header = line(&mut stream);
                if header == "\r\n" { break; }
                if let Some(n) = header.strip_prefix("Content-Length: ") { length = n.trim().parse().unwrap(); }
            }
            assert!(length > 0 && length <= 4 * 1024 * 1024);
            let mut jpeg = vec![0; length]; stream.read_exact(&mut jpeg).unwrap();
            assert_eq!(line(&mut stream), "\r\n");
            let image = image::load_from_memory(&jpeg).unwrap().to_rgb8();
            let px = image.get_pixel(image.width()/2, image.height()/2).0;
            red |= i32::from(px[0]) - i32::from(px[2]) > 40;
            blue |= i32::from(px[2]) - i32::from(px[0]) > 40;
            if red && blue { break; }
        }
        assert!(red && blue, "WGC fixture must deliver changing red and blue JPEG frames");
        revision.store(2, Ordering::Release);
        assert!(manager.prepare(&exe, &root.join("missing"), bounds, revision.clone(), 2).is_err());
        assert_eq!(status(&url), "HTTP/1.1 200 OK\r\n", "failed choice keeps previous scene");
        let reused = manager.prepare(&exe, &root.join("one"), bounds, revision.clone(), 2).unwrap();
        assert_eq!(reused, url, "reselecting an active scene reuses its stream");
        manager.abort(2);
        assert_eq!(status(&url), "HTTP/1.1 200 OK\r\n", "aborting reuse must keep the active scene");
        let cancelled = manager.prepare(&exe, &root.join("two"), bounds, revision.clone(), 2).unwrap();
        assert_eq!(status(&url), "HTTP/1.1 200 OK\r\n", "old scene survives while a candidate is pending");
        assert_eq!(status(&cancelled), "HTTP/1.1 200 OK\r\n");
        assert!(manager.commit(99).is_err(), "a stale operation cannot commit");
        manager.abort(2);
        assert_eq!(status(&cancelled), "HTTP/1.1 404 Not Found\r\n", "aborted candidate is revoked");
        assert_eq!(status(&url), "HTTP/1.1 200 OK\r\n", "aborting a candidate keeps the old scene");
        let broken = manager.prepare(&exe, &root.join("two"), bounds, revision.clone(), 2).unwrap();
        let title = manager.pending.as_ref().unwrap()._engine_window.title.clone();
        control(&exe, &["-control", "closeWallpaper", "-location", &title], None).unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        while manager.pending.as_ref().unwrap().is_alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(!manager.pending.as_ref().unwrap().is_alive(), "closed fixture must stop capture");
        assert!(manager.commit(2).is_err(), "dead candidate cannot replace the old scene");
        manager.abort(2);
        assert_eq!(status(&broken), "HTTP/1.1 404 Not Found\r\n");
        assert_eq!(status(&url), "HTTP/1.1 200 OK\r\n", "dead candidate leaves old scene active");
        let next = manager.prepare(&exe, &root.join("two"), bounds, revision.clone(), 2).unwrap();
        manager.commit(2).unwrap();
        assert_eq!(status(&url), "HTTP/1.1 404 Not Found\r\n");
        assert_eq!(status(&next), "HTTP/1.1 200 OK\r\n");
        revision.store(3, Ordering::Release);
        assert!(manager.prepare(&exe, &root.join("one"), bounds, revision.clone(), 2).is_err());
        assert_eq!(status(&next), "HTTP/1.1 200 OK\r\n", "cancelled operation keeps committed scene");
        manager.stop();
        assert_eq!(status(&next), "HTTP/1.1 404 Not Found\r\n");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_unsigned_engine_before_execution() {
        let root = std::env::temp_dir().join(format!("omnispec-unsigned-engine-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let exe = root.join("wallpaper64.exe");
        std::fs::copy(std::env::current_exe().unwrap(), &exe).unwrap();
        let result = verify_signature(&exe, &AtomicU64::new(1), 1);
        assert!(result.is_err(), "unsigned executable must never be trusted as Wallpaper Engine");
        let _ = std::fs::remove_dir_all(root);
    }
}
