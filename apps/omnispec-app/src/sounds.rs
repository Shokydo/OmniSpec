//! Ограниченный импорт звуков интерфейса без общего доступа WebView к файловой системе.
use std::io::{Read, Write};
use std::path::{Component, Path};

const MAX_SOUND: u64 = 5 * 1024 * 1024;

pub fn valid_event(event: &str) -> bool {
    matches!(event, "click" | "toggle" | "tab" | "open" | "close" | "success" | "error")
}

fn sound_format(data: &[u8], ext: &str) -> Result<&'static str, String> {
    let mime = match ext.to_ascii_lowercase().as_str() {
        "wav" if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WAVE" => "audio/wav",
        "ogg" | "oga" if data.starts_with(b"OggS") => "audio/ogg",
        "flac" if data.starts_with(b"fLaC") => "audio/flac",
        "mp3" if data.starts_with(b"ID3") || (data.len() >= 2 && data[0] == 0xff && data[1] & 0xe0 == 0xe0) => "audio/mpeg",
        _ => return Err("нужен WAV, MP3, OGG или FLAC с правильным расширением".into()),
    };
    Ok(mime)
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("не удалось открыть звук: {e}"))?;
    let meta = file.metadata().map_err(|e| format!("не удалось открыть звук: {e}"))?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_SOUND {
        return Err("звуковой файл пустой или больше 5 МБ".into());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_SOUND + 1).read_to_end(&mut bytes).map_err(|e| format!("не удалось прочитать звук: {e}"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_SOUND {
        return Err("звуковой файл пустой или больше 5 МБ".into());
    }
    Ok(bytes)
}

/// Импортированная копия не зависит от исходного файла и не перезаписывает другие.
pub fn copy_sound(source: &Path, dir: &Path) -> Result<String, String> {
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let bytes = read_bounded(source)?;
    sound_format(&bytes, &ext)?;
    let stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("sound");
    let (target, mut file) = super::wallpapers::create_unique(dir, stem, &ext)?;
    let result = file.write_all(&bytes).and_then(|_| file.flush());
    drop(file);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&target);
        return Err(format!("не удалось сохранить звук: {error}"));
    }
    Ok(target.file_name().unwrap_or_default().to_string_lossy().into_owned())
}

/// Только ранее импортированный единичный файл внутри каталога звуков.
pub fn read_copy(dir: &Path, name: &str) -> Result<(&'static str, Vec<u8>), String> {
    let name = Path::new(name);
    if name.components().count() != 1 || !matches!(name.components().next(), Some(Component::Normal(_))) {
        return Err("недопустимое имя звука".into());
    }
    let root = dir.canonicalize().map_err(|_| "папка звуков не найдена".to_string())?;
    let path = dir.join(name).canonicalize().map_err(|_| "звук не найден".to_string())?;
    if !path.starts_with(&root) { return Err("звук находится вне папки лаунчера".into()); }
    let bytes = read_bounded(&path)?;
    let mime = sound_format(&bytes, name.extension().and_then(|e| e.to_str()).unwrap_or(""))?;
    Ok((mime, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_sounds_are_bounded_validated_and_independent() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("my tone.wav");
        let wav = b"RIFF\x04\x00\x00\x00WAVEfmt ";
        std::fs::write(&original, wav).unwrap();
        let copies = dir.path().join("sounds");
        let first = copy_sound(&original, &copies).unwrap();
        let second = copy_sound(&original, &copies).unwrap();
        assert_ne!(first, second);
        std::fs::remove_file(&original).unwrap();
        let (mime, bytes) = read_copy(&copies, &first).unwrap();
        assert_eq!(mime, "audio/wav");
        assert_eq!(bytes, wav);
        assert!(read_copy(&copies, "../my tone.wav").is_err());
        assert!(read_copy(&copies, "/etc/passwd").is_err());
        let fake = dir.path().join("fake.mp3");
        std::fs::write(&fake, b"<script>not music</script>").unwrap();
        assert!(copy_sound(&fake, &copies).is_err());
        let large = dir.path().join("large.wav");
        let file = std::fs::File::create(&large).unwrap();
        file.set_len(MAX_SOUND + 1).unwrap();
        assert!(copy_sound(&large, &copies).is_err());
        for (event, allowed) in [("click", true), ("close", true), ("../secret", false), ("launch", false)] {
            assert_eq!(valid_event(event), allowed);
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_outside_import_directory_is_rejected() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sounds");
        std::fs::create_dir(&root).unwrap();
        let outside = dir.path().join("outside.wav");
        std::fs::write(&outside, b"RIFF\x04\x00\x00\x00WAVE").unwrap();
        symlink(&outside, root.join("escape.wav")).unwrap();
        assert!(read_copy(&root, "escape.wav").is_err());
    }
}
