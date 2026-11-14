use std::path::{Path, PathBuf};

use crate::error::Result;

/// Все пути лаунчера. Один корень (`OMNISPEC_HOME` либо системная папка данных).
///
/// Раскладка:
/// ```text
/// <root>/
///   settings.json
///   meta/versions/<id>/<id>.json        — версии игры и профили загрузчиков
///   meta/libraries/                     — Maven-библиотеки
///   meta/assets/                        — ресурсы (objects/, indexes/)
///   meta/natives/<id>/                  — распакованные нативные библиотеки
///   instances/<id>/instance.json        — описание сборки
///   instances/<id>/minecraft/           — игровая папка сборки (mods, saves, config…)
///   java/<component>/<version>/         — скачанные рантаймы Java от Mojang
///   logs/                               — логи запусков
/// ```
#[derive(Debug, Clone)]
pub struct Paths {
    pub root: PathBuf,
}

impl Paths {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        let paths = Self { root };
        paths.ensure()?;
        Ok(paths)
    }

    /// Корень данных: `OMNISPEC_HOME` → portable.txt рядом с exe → системная папка.
    pub fn discover() -> Result<Self> {
        if let Ok(dir) = std::env::var("OMNISPEC_HOME") {
            if !dir.trim().is_empty() {
                return Self::new(dir);
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                if dir.join("portable.txt").exists() {
                    return Self::new(dir.join("OmniSpecData"));
                }
            }
        }
        let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
        Self::new(base.join(crate::APP_NAME))
    }

    pub fn meta(&self) -> PathBuf {
        self.root.join("meta")
    }
    pub fn versions(&self) -> PathBuf {
        self.meta().join("versions")
    }
    pub fn libraries(&self) -> PathBuf {
        self.meta().join("libraries")
    }
    pub fn assets(&self) -> PathBuf {
        self.meta().join("assets")
    }
    pub fn asset_objects(&self) -> PathBuf {
        self.assets().join("objects")
    }
    pub fn asset_indexes(&self) -> PathBuf {
        self.assets().join("indexes")
    }
    pub fn natives(&self) -> PathBuf {
        self.meta().join("natives")
    }
    pub fn instances(&self) -> PathBuf {
        self.root.join("instances")
    }
    pub fn java_dir(&self) -> PathBuf {
        self.root.join("java")
    }
    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }
    pub fn cache(&self) -> PathBuf {
        self.root.join("cache")
    }
    pub fn settings_file(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    pub fn instance_dir(&self, id: &str) -> PathBuf {
        self.instances().join(id)
    }
    pub fn instance_file(&self, id: &str) -> PathBuf {
        self.instance_dir(id).join("instance.json")
    }
    pub fn instance_game_dir(&self, id: &str) -> PathBuf {
        self.instance_dir(id).join("minecraft")
    }
    pub fn version_dir(&self, id: &str) -> PathBuf {
        self.versions().join(id)
    }
    pub fn version_file(&self, id: &str) -> PathBuf {
        self.version_dir(id).join(format!("{id}.json"))
    }
    pub fn version_jar(&self, id: &str) -> PathBuf {
        self.version_dir(id).join(format!("{id}.jar"))
    }
    pub fn natives_dir(&self, id: &str) -> PathBuf {
        self.natives().join(id)
    }

    pub fn ensure(&self) -> Result<()> {
        for dir in [
            self.meta(),
            self.versions(),
            self.libraries(),
            self.assets(),
            self.asset_objects(),
            self.asset_indexes(),
            self.natives(),
            self.instances(),
            self.java_dir(),
            self.logs(),
            self.cache(),
        ] {
            std::fs::create_dir_all(&dir)?;
        }
        Ok(())
    }

    /// Свободное место в корне данных (в байтах), если ОС умеет его сообщить.
    pub fn free_space(&self) -> Option<u64> {
        free_space_of(&self.root)
    }
}

#[cfg(windows)]
fn free_space_of(_path: &Path) -> Option<u64> {
    None
}

#[cfg(not(windows))]
fn free_space_of(_path: &Path) -> Option<u64> {
    None
}

/// Безопасное имя папки из произвольной строки (для id сборок).
/// Кириллица транслитерируется, чтобы папки оставались латиницей.
pub fn slugify(input: &str) -> String {
    let mut out = String::new();
    for ch in input.chars() {
        let lower = ch.to_lowercase().next().unwrap_or(ch);
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            continue;
        }
        if let Some(latin) = translit(lower) {
            out.push_str(latin);
            continue;
        }
        if (lower == '-' || lower == '_' || lower.is_whitespace() || lower == '.') && !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "instance".into()
    } else {
        trimmed
    }
}

fn translit(ch: char) -> Option<&'static str> {
    Some(match ch {
        'а' => "a",  'б' => "b",  'в' => "v",  'г' => "g",  'д' => "d",
        'е' => "e",  'ё' => "e",  'ж' => "zh", 'з' => "z",  'и' => "i",
        'й' => "y",  'к' => "k",  'л' => "l",  'м' => "m",  'н' => "n",
        'о' => "o",  'п' => "p",  'р' => "r",  'с' => "s",  'т' => "t",
        'у' => "u",  'ф' => "f",  'х' => "h",  'ц' => "c",  'ч' => "ch",
        'ш' => "sh", 'щ' => "sch",'ъ' => "",   'ы' => "y",  'ь' => "",
        'э' => "e",  'ю' => "yu", 'я' => "ya",
        'і' => "i",  'ї' => "i",  'є' => "e",  'ґ' => "g",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slugify("Моя сборка"), "moya-sborka");
        assert_eq!(slugify("All the Mods 9"), "all-the-mods-9");
        assert_eq!(slugify("!!!"), "instance");
        assert_eq!(slugify("Fabric 1.21.4"), "fabric-1-21-4");
    }
}
