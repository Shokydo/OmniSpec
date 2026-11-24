//! Non-destructive check of configuration-directory writes before launching.
//! This cannot detect locks acquired later by the game itself.
use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;

/// Creates and removes only a private temporary directory. Never opens existing
/// config files for writing or changes them.
pub fn check_config_directory(game_dir: &Path) -> std::io::Result<()> {
    let config = game_dir.join("config");
    if !config.exists() { return Ok(()); }
    let temp = tempfile::Builder::new().prefix(".omnispec-write-test-").tempdir_in(&config)?;
    let first = temp.path().join("test.tmp");
    let second = temp.path().join("test.json");
    std::fs::write(&first, b"omnispec write test")?;
    std::fs::rename(&first, &second)?;
    std::fs::remove_file(&second)?;
    temp.close()
}

/// On Windows, ask the OS whether an existing config can be opened for write.
/// No bytes are written and files are never truncated. Avoid traversing links.
#[cfg(windows)]
pub fn blocked_configs(game_dir: &Path) -> Vec<(PathBuf, String)> {
    use std::os::windows::fs::OpenOptionsExt;
    let mut blocked = Vec::new();
    let mut dirs = vec![game_dir.join("config")];
    let mut scanned = 0;
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(dir) else { continue; };
        for entry in entries.flatten() {
            if scanned >= 5000 { return blocked; }
            let Ok(kind) = entry.file_type() else { continue; };
            if kind.is_symlink() { continue; }
            if kind.is_dir() { dirs.push(entry.path()); continue; }
            if !kind.is_file() { continue; }
            let path = entry.path();
            let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
            if !["toml", "json", "cfg", "properties"].iter().any(|x| extension.eq_ignore_ascii_case(x)) { continue; }
            scanned += 1;
            // Match a normal Java file open while allowing others to read, write,
            // and delete. Unlike an exclusive open this does not reject readers.
            let check = || std::fs::OpenOptions::new().write(true).share_mode(0x7).open(&path);
            let result = match check() {
                Err(e) if matches!(e.raw_os_error(), Some(32 | 33)) => {
                    std::thread::sleep(std::time::Duration::from_millis(150)); check()
                }
                other => other,
            };
            if let Err(e) = result {
                if matches!(e.raw_os_error(), Some(5 | 32 | 33)) {
                    blocked.push((path, e.to_string()));
                    if blocked.len() >= 5 { return blocked; }
                }
            }
        }
    }
    blocked
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn probe_preserves_existing_config() {
        let game = tempfile::tempdir().unwrap();
        let config = game.path().join("config");
        std::fs::create_dir(&config).unwrap();
        std::fs::write(config.join("quark-common.toml"), b"important data").unwrap();
        check_config_directory(game.path()).unwrap();
        assert_eq!(std::fs::read(config.join("quark-common.toml")).unwrap(), b"important data");
        assert_eq!(std::fs::read_dir(config).unwrap().count(), 1);
    }
    #[test]
    fn missing_config_is_not_an_error() {
        let game = tempfile::tempdir().unwrap();
        check_config_directory(game.path()).unwrap();
        assert!(!game.path().join("config").exists());
    }
    #[cfg(windows)]
    #[test]
    fn reports_locked_file_without_modifying_it() {
        use std::os::windows::fs::OpenOptionsExt;
        let game = tempfile::tempdir().unwrap();
        let config = game.path().join("config");
        std::fs::create_dir(&config).unwrap();
        let path = config.join("locked.toml");
        std::fs::write(&path, b"keep me").unwrap();
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
        assert!(blocked_configs(game.path()).iter().any(|(p, _)| p == &path));
        drop(lock);
        assert!(blocked_configs(game.path()).is_empty());
        assert_eq!(std::fs::read(path).unwrap(), b"keep me");
    }
}
