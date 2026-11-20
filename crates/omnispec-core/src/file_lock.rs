//! Межпроцессная advisory-блокировка данных одного профиля.
//!
//! Файл блокировки не удаляется после освобождения: иначе два процесса могли бы
//! открыть разные inode/handle с одинаковым именем и одновременно писать данные.
//! Закрытие дескриптора (в том числе при аварийном завершении) снимает блокировку.
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

pub struct FileLock {
    _file: File,
}

impl FileLock {
    pub fn acquire(path: &Path) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let contended = fs2::lock_contended_error().raw_os_error();
        loop {
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => return Ok(Self { _file: file }),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.raw_os_error() == contended => {
                    if std::time::Instant::now() >= deadline {
                        return Err(io::Error::new(io::ErrorKind::WouldBlock, "другая копия OmniSpec слишком долго удерживает блокировку данных"));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn lock_holder_process() {
        let Ok(root) = std::env::var("OMNISPEC_FILE_LOCK_CHILD") else { return; };
        let root = std::path::PathBuf::from(root);
        let _lock = FileLock::acquire(&root.join("test.lock")).unwrap();
        std::fs::write(root.join("ready"), b"ready").unwrap();
        std::thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn lock_is_released_after_process_exit() {
        let root = std::env::temp_dir().join(format!("omnispec-process-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "file_lock::tests::lock_holder_process", "--nocapture"])
            .env("OMNISPEC_FILE_LOCK_CHILD", &root)
            .stdout(std::process::Stdio::null())
            .spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !root.join("ready").exists() && Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() { break; }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !root.join("ready").exists() {
            let _ = child.kill(); let _ = child.wait();
            panic!("lock-holder process did not start");
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let start = Instant::now();
        let guard = FileLock::acquire(&root.join("test.lock")).unwrap();
        assert!(start.elapsed() < Duration::from_secs(5), "dead process held the lock");
        drop(guard);
        let _ = std::fs::remove_dir_all(root);
    }
}
