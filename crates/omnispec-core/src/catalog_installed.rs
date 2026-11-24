//! Установленные моды для карточек каталога, независимо от версии.
//!
//! Доверяем содержимому реальных файлов в mods, а не имени файла или старой
//! картотеке. Это работает и для импортированных/переименованных JAR, включая
//! выключенные. Отметка означает только наличие файла, а не его актуальность
//! или совместимость с Minecraft и загрузчиком выбранной сборки.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use md5::Md5;
use sha1::{Digest, Sha1};

use crate::curseforge::CurseForge;
use crate::error::{Error, Result};
use crate::instances::InstanceMeta;
use crate::modrinth::{Modrinth, Version};
use crate::paths::Paths;

#[derive(Debug, Clone)]
struct LocalMod {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    sha1: String,
    md5: String,
    fingerprint: Option<u32>,
}

impl LocalMod {
    /// Не используем результат для удалённого или изменённого во время запроса файла.
    fn still_matches(&self) -> bool {
        std::fs::metadata(&self.path).ok().is_some_and(|metadata| {
            metadata.is_file() && metadata.len() == self.size
                && metadata.modified().ok() == self.modified
        })
    }

    fn matches_hashes(&self, hashes: &HashMap<String, String>) -> bool {
        let mut found = false;
        for (algorithm, actual) in [("sha1", &self.sha1), ("md5", &self.md5)] {
            if let Some(expected) = hashes.get(algorithm).filter(|value| !value.is_empty()) {
                found = true;
                if !expected.eq_ignore_ascii_case(actual) { return false; }
            }
        }
        found
    }
}

fn is_cf_whitespace(byte: u8) -> bool { matches!(byte, b'\t' | b'\n' | b'\r' | b' ') }

/// CurseForge: MurmurHash2 (seed 1) от байтов без табуляции, переводов строк
/// и пробелов. Вторая потоковая проходка нужна, поскольку длина входит в seed.
fn cf_fingerprint(reader: &mut impl Read, normalized_len: u32) -> std::io::Result<u32> {
    const M: u32 = 0x5bd1e995;
    let mut hash = 1 ^ normalized_len;
    let mut word = 0u32;
    let mut shift = 0u32;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 { break; }
        for &byte in &buffer[..n] {
            if is_cf_whitespace(byte) { continue; }
            word |= (byte as u32) << shift;
            shift += 8;
            if shift == 32 {
                word = word.wrapping_mul(M);
                word ^= word >> 24;
                word = word.wrapping_mul(M);
                hash = hash.wrapping_mul(M) ^ word;
                word = 0;
                shift = 0;
            }
        }
    }
    if shift > 0 { hash = (hash ^ word).wrapping_mul(M); }
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(M);
    Ok(hash ^ (hash >> 15))
}

fn hash_file(path: &Path, curseforge: bool) -> Result<LocalMod> {
    let mut file = std::fs::File::open(path)?;
    let before = file.metadata()?;
    if !before.is_file() { return Err(Error::other("не файл мода")); }
    let mut sha1 = Sha1::new();
    let mut md5 = Md5::new();
    let mut normalized_len = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 { break; }
        let bytes = &buffer[..n];
        sha1.update(bytes);
        if curseforge {
            md5.update(bytes);
            normalized_len += bytes.iter().filter(|&&byte| !is_cf_whitespace(byte)).count() as u64;
        }
    }
    let fingerprint = if curseforge {
        let len = u32::try_from(normalized_len).map_err(|_| Error::other("слишком большой файл мода"))?;
        file.seek(SeekFrom::Start(0))?;
        Some(cf_fingerprint(&mut file, len)?)
    } else { None };
    let local = LocalMod {
        path: path.to_owned(), size: before.len(), modified: before.modified().ok(),
        sha1: hex::encode(sha1.finalize()),
        md5: if curseforge { hex::encode(md5.finalize()) } else { String::new() },
        fingerprint,
    };
    let after = file.metadata()?;
    if after.len() != local.size || after.modified().ok() != local.modified || !local.still_matches() {
        return Err(Error::other("файл мода изменился во время проверки"));
    }
    Ok(local)
}

fn scan_mods(dir: &Path, curseforge: bool) -> Result<Vec<LocalMod>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else { continue; };
        if !crate::content::matches_kind(name, "mod") { continue; }
        if let Ok(file) = hash_file(&path, curseforge) { result.push(file); }
    }
    Ok(result)
}

fn installed_modrinth(files: &[LocalMod], versions: &HashMap<String, Version>) -> HashSet<String> {
    let mut result = HashSet::new();
    for file in files {
        let Some(version) = versions.get(&file.sha1) else { continue; };
        if version.project_id.is_empty() { continue; }
        if version.files.iter().any(|item| item.hashes.get("sha1")
            .is_some_and(|hash| hash.eq_ignore_ascii_case(&file.sha1))) && file.still_matches() {
            result.insert(version.project_id.clone());
        }
    }
    result
}

fn installed_curseforge(files: &[LocalMod], matches: &[crate::curseforge::FingerprintMatch]) -> HashSet<String> {
    let mut result = HashSet::new();
    for item in matches {
        let Ok(project) = item.version.project_id.parse::<u32>() else { continue; };
        if project == 0 { continue; }
        let Some(remote) = item.version.primary_file() else { continue; };
        if files.iter().any(|local| local.fingerprint == Some(item.fingerprint)
            && local.matches_hashes(&remote.hashes) && local.still_matches()) {
            result.insert(project.to_string());
        }
    }
    result
}

/// Вернуть только подтверждённые id установленных проектов. Если сервис
/// недоступен, не угадываем проект по одному имени или старому content.json.
pub async fn installed_projects(
    paths: &Paths, instance: &InstanceMeta, source: &str,
    modrinth: &Modrinth, curseforge: &CurseForge,
) -> Result<Vec<String>> {
    if !matches!(source, "modrinth" | "curseforge") {
        return Err(Error::other("неизвестный каталог"));
    }
    let folder = crate::instances::game_dir_for(paths, instance).join("mods");
    let cf = source == "curseforge";
    let files = tokio::task::spawn_blocking(move || scan_mods(&folder, cf)).await
        .map_err(|error| Error::other(format!("не удалось проверить моды: {error}")))??;
    if files.is_empty() { return Ok(Vec::new()); }
    let mut installed = if !cf {
        let mut hashes: Vec<_> = files.iter().map(|file| file.sha1.clone()).collect();
        hashes.sort(); hashes.dedup();
        let versions = modrinth.versions_for_hashes(&hashes).await?;
        installed_modrinth(&files, &versions)
    } else {
        let mut fingerprints: Vec<_> = files.iter().filter_map(|file| file.fingerprint).collect();
        fingerprints.sort_unstable(); fingerprints.dedup();
        let matches = curseforge.fingerprint_matches(&fingerprints).await?;
        installed_curseforge(&files, &matches)
    }.into_iter().collect::<Vec<_>>();
    installed.sort();
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn fingerprint_matches_known_murmur2_vectors_and_ignores_cf_whitespace() {
        // Independent reference values: MurmurHash2 seed 1 over normalized bytes.
        for (bytes, expected) in [
            (b"".as_slice(), 0x5bd15e36),
            (b"foo".as_slice(), 0x0bcc2e5a),
            (b"f \to\r\no".as_slice(), 0x0bcc2e5a),
            (b"hello".as_slice(), 0xa631918e),
        ] {
            let len = bytes.iter().filter(|&&byte| !is_cf_whitespace(byte)).count() as u32;
            assert_eq!(cf_fingerprint(&mut Cursor::new(bytes), len).unwrap(), expected);
        }
    }

    #[test]
    fn checks_real_files_not_names_or_stale_metadata() {
        let root = std::env::temp_dir().join(format!("omnispec-hash-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("renamed.jar.disabled"), b"current bytes").unwrap();
        std::fs::write(root.join("old.jar"), b"old bytes").unwrap();
        std::fs::write(root.join("ignore.zip"), b"not a mod").unwrap();
        let files = scan_mods(&root, true).unwrap();
        assert_eq!(files.len(), 2);
        let current = files.iter().find(|file| file.path.ends_with("renamed.jar.disabled")).unwrap();
        let old = files.iter().find(|file| file.path.ends_with("old.jar")).unwrap();
        let version: Version = serde_json::from_value(serde_json::json!({
            "id":"new","project_id":"project","game_versions":["1.21.1"],"loaders":["fabric"],
            "files":[{"url":"","filename":"not-local-name.jar","hashes":{"sha1":current.sha1}}]
        })).unwrap();
        // Сервер не должен подтверждать старый файл чужой версией с другим хешем.
        let versions = HashMap::from([(current.sha1.clone(), version.clone()), (old.sha1.clone(), version)]);
        assert_eq!(installed_modrinth(&files, &versions), HashSet::from(["project".into()]));
        std::fs::remove_file(&current.path).unwrap();
        assert!(installed_modrinth(&files, &versions).is_empty(), "удалённый файл и несовпадающий хеш не подтверждают проект");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[ignore = "requires real Modrinth, CurseForge and CDN"]
    async fn live_imported_files_match_both_catalogs_at_any_version() {
        let root = std::env::temp_dir().join(format!("omnispec-live-current-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = Paths::new(&root).unwrap();
        let meta = crate::instances::create(&paths, crate::instances::CreateInstanceRequest {
            name: "Imported".into(), mc_version: "1.21.1".into(),
            loader: crate::instances::Loader::Fabric { version: "0.16.10".into() },
            icon: None, icon_background: None, notes: String::new(), source: Some("import".into()), source_url: None,
            id: None, category: None, memory_mb: None, java_path: None, game_dir: None,
        }).unwrap();
        let http = crate::net::Http::new();
        let mr = Modrinth::new(http.clone());
        let cf = CurseForge::new(http.clone());
        let versions = mr.project_versions("AANobbMI", Some("1.21.1"), Some("fabric")).await.unwrap();
        assert!(versions.len() > 1);
        let latest = versions[0].primary_file().unwrap();
        let old = versions[1].primary_file().unwrap();
        let download = |url: String| { let client = http.inner().clone(); async move {
            client.get(&url).send().await.unwrap().error_for_status().unwrap().bytes().await.unwrap().to_vec()
        }};
        let (current_bytes, old_bytes) = tokio::join!(download(latest.url.clone()), download(old.url.clone()));
        let dir = crate::instances::game_dir_for(&paths, &meta).join("mods");
        assert!(!paths.instance_dir(&meta.id).join("content.json").exists());
        std::fs::write(dir.join("renamed-old.jar"), &old_bytes).unwrap();
        for (source, id) in [("modrinth", "AANobbMI"), ("curseforge", "394468")] {
            let ids = installed_projects(&paths, &meta, source, &mr, &cf).await.unwrap();
            assert!(ids.iter().any(|item| item == id), "старая импортированная версия отмечается: {source} {ids:?}");
        }
        std::fs::remove_file(dir.join("renamed-old.jar")).unwrap();
        std::fs::write(dir.join("imported-latest.jar.disabled"), &current_bytes).unwrap();
        for (source, id) in [("modrinth", "AANobbMI"), ("curseforge", "394468")] {
            let ids = installed_projects(&paths, &meta, source, &mr, &cf).await.unwrap();
            assert!(ids.iter().any(|item| item == id), "выключенная версия тоже отмечается: {source} {ids:?}");
        }
        for loader in [crate::instances::Loader::NeoForge { version: "1".into() }, crate::instances::Loader::Quilt { version: "1".into() }] {
            let mut other = meta.clone();
            other.loader = loader;
            other.mc_version = "1.19.4".into();
            for (source, id) in [("modrinth", "AANobbMI"), ("curseforge", "394468")] {
                let ids = installed_projects(&paths, &other, source, &mr, &cf).await.unwrap();
                assert!(ids.iter().any(|item| item == id), "наличие JAR отмечается даже при несовпадении загрузчика: {source} {:?} {ids:?}", other.loader);
            }
        }
        std::fs::remove_file(dir.join("imported-latest.jar.disabled")).unwrap();
        let mut altered = current_bytes;
        altered.push(b' '); // тот же CurseForge fingerprint, но уже другие байты и SHA-1
        std::fs::write(dir.join("altered.jar"), &altered).unwrap();
        for (source, id) in [("modrinth", "AANobbMI"), ("curseforge", "394468")] {
            let ids = installed_projects(&paths, &meta, source, &mr, &cf).await.unwrap();
            assert!(!ids.iter().any(|item| item == id), "изменённый файл не подтверждается: {source} {ids:?}");
        }
        assert!(!paths.instance_dir(&meta.id).join("content.json").exists());
        println!("REAL_CATALOG: Modrinth + CurseForge, imported/disabled/current/old/tampered — OK");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cf_fingerprint_collision_must_not_bypass_cryptographic_hashes() {
        let root = std::env::temp_dir().join(format!("omnispec-fingerprint-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("one.jar"), b"foo").unwrap();
        std::fs::write(root.join("two.jar"), b"f o o").unwrap();
        let one = hash_file(&root.join("one.jar"), true).unwrap();
        let two = hash_file(&root.join("two.jar"), true).unwrap();
        assert_eq!(one.fingerprint, two.fingerprint);
        assert_ne!(one.sha1, two.sha1);
        let hashes = HashMap::from([("sha1".into(), one.sha1.clone()), ("md5".into(), one.md5.clone())]);
        assert!(one.matches_hashes(&hashes));
        assert!(!two.matches_hashes(&hashes));
        assert!(!one.matches_hashes(&HashMap::new()));
        let version: Version = serde_json::from_value(serde_json::json!({
            "id":"old-file", "project_id":"394468", "game_versions":["1.16.5"], "loaders":["forge"],
            "files":[{"url":"", "filename":"other-name.jar", "hashes":hashes}]
        })).unwrap();
        let matches = vec![crate::curseforge::FingerprintMatch { fingerprint: one.fingerprint.unwrap(), version }];
        assert_eq!(installed_curseforge(&[one.clone(), two.clone()], &matches), HashSet::from(["394468".into()]));
        std::fs::remove_file(&one.path).unwrap();
        assert!(installed_curseforge(&[one, two], &matches).is_empty(), "коллизия или удалённый файл не подтверждают проект");
        let _ = std::fs::remove_dir_all(root);
    }
}
