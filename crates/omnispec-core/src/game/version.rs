//! Структуры `version.json` Mojang, правила совместимости (rules) и сборка
//! итогового профиля из цепочки `inheritsFrom` (ваниль + загрузчик).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Имя ОС в терминах Mojang.
pub fn os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

/// Разрядность в терминах Mojang ("x86" для 32-бит).
pub fn os_arch() -> &'static str {
    if cfg!(target_arch = "x86") {
        "x86"
    } else {
        "x64"
    }
}

/// Признаки (`features`) для вычисления правил: по умолчанию всё выключено,
/// как у обычного запуска без демо-режима и быстрых подключений.
pub fn default_features() -> HashMap<String, bool> {
    let mut map = HashMap::new();
    map.insert("is_demo_user".to_string(), false);
    map.insert("has_custom_resolution".to_string(), false);
    map.insert("has_quick_plays_support".to_string(), false);
    map.insert("is_quick_play_singleplayer".to_string(), false);
    map.insert("is_quick_play_multiplayer".to_string(), false);
    map.insert("is_quick_play_realms".to_string(), false);
    map
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct OsRule {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arch: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Rule {
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub os: Option<OsRule>,
    #[serde(default)]
    pub features: Option<HashMap<String, bool>>,
}

impl Rule {
    fn matches(&self, features: &HashMap<String, bool>) -> bool {
        if let Some(os) = &self.os {
            if let Some(name) = &os.name {
                if name != os_name() {
                    return false;
                }
            }
            if let Some(arch) = &os.arch {
                if arch != os_arch() {
                    return false;
                }
            }
            // os.version (регулярка по версии ядра) на практике не встречается
            // в актуальных версиях игры — игнорируем.
        }
        if let Some(required) = &self.features {
            for (key, value) in required {
                if features.get(key).copied().unwrap_or(false) != *value {
                    return false;
                }
            }
        }
        true
    }
}

/// Правила Mojang: пустой список — разрешено; иначе действует последнее совпавшее.
pub fn rules_allow(rules: &Option<Vec<Rule>>, features: &HashMap<String, bool>) -> bool {
    let Some(rules) = rules else {
        return true;
    };
    if rules.is_empty() {
        return true;
    }
    let mut allowed = false;
    for rule in rules {
        if rule.matches(features) {
            allowed = rule.action == "allow";
        }
    }
    allowed
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Artifact {
    #[serde(default)]
    pub path: Option<String>,
    pub url: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub sha1: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LibDownloads {
    #[serde(default)]
    pub artifact: Option<Artifact>,
    #[serde(default)]
    pub classifiers: Option<HashMap<String, Artifact>>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Extract {
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Library {
    pub name: String,
    #[serde(default)]
    pub downloads: Option<LibDownloads>,
    #[serde(default)]
    pub natives: Option<HashMap<String, String>>,
    #[serde(default)]
    pub rules: Option<Vec<Rule>>,
    #[serde(default)]
    pub extract: Option<Extract>,
    #[serde(default)]
    pub url: Option<String>,
    /// Некоторые лоадеры (Fabric) помечают библиотеку так.
    #[serde(default)]
    pub clientreq: Option<bool>,
}

impl Library {
    pub fn applies(&self, features: &HashMap<String, bool>) -> bool {
        rules_allow(&self.rules, features)
    }

    /// Классификатор нативной библиотеки для текущей ОС, если он есть.
    /// В значении бывает `${arch}` → 32/64.
    pub fn native_classifier(&self) -> Option<String> {
        let natives = self.natives.as_ref()?;
        let raw = natives.get(os_name())?;
        let arch = if cfg!(target_arch = "x86") { "32" } else { "64" };
        Some(raw.replace("${arch}", arch))
    }

    pub fn artifact(&self) -> Option<&Artifact> {
        self.downloads.as_ref()?.artifact.as_ref()
    }

    /// Относительный путь в `libraries/`, посчитанный из Maven-координат.
    pub fn maven_path(&self) -> String {
        if let Some(artifact) = self.artifact() {
            if let Some(path) = &artifact.path {
                return path.clone();
            }
        }
        if let Some(classifier) = self.native_classifier() {
            if let Some(downloads) = &self.downloads {
                if let Some(classifiers) = &downloads.classifiers {
                    if let Some(artifact) = classifiers.get(&classifier) {
                        if let Some(path) = &artifact.path {
                            return path.clone();
                        }
                    }
                }
            }
        }
        maven_coords_to_path(&self.name)
    }
}

/// `org.lwjgl:lwjgl:3.3.3:natives-windows` → `org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar`
pub fn maven_coords_to_path(name: &str) -> String {
    let (coords, ext) = match name.split_once('@') {
        Some((coords, ext)) => (coords, ext.to_string()),
        None => (name, "jar".to_string()),
    };
    let parts: Vec<&str> = coords.split(':').collect();
    match parts.len() {
        3 => {
            let (group, artifact, version) = (parts[0], parts[1], parts[2]);
            format!(
                "{}/{}/{}/{}-{}.{}",
                group.replace('.', "/"),
                artifact,
                version,
                artifact,
                version,
                ext
            )
        }
        4 => {
            let (group, artifact, version, classifier) = (parts[0], parts[1], parts[2], parts[3]);
            format!(
                "{}/{}/{}/{}-{}-{}.{}",
                group.replace('.', "/"),
                artifact,
                version,
                artifact,
                version,
                classifier,
                ext
            )
        }
        _ => format!("{}.{}", name.replace(':', "/"), ext),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct AssetIndexRef {
    pub id: String,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub total_size: u64,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Downloads {
    #[serde(default)]
    pub client: Option<Artifact>,
    #[serde(default)]
    pub server: Option<Artifact>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct JavaVersion {
    #[serde(default)]
    pub component: Option<String>,
    #[serde(default, rename = "majorVersion")]
    pub major_version: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ArgStr {
    One(String),
    Many(Vec<String>),
}

impl ArgStr {
    pub fn into_vec(self) -> Vec<String> {
        match self {
            ArgStr::One(s) => vec![s],
            ArgStr::Many(v) => v,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConditionalArg {
    #[serde(default)]
    pub rules: Option<Vec<Rule>>,
    pub value: ArgStr,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ArgValue {
    Plain(String),
    Conditional(ConditionalArg),
}

impl ArgValue {
    /// Значение аргумента с учётом правил; `None` — аргумент отфильтрован.
    pub fn expand(&self, features: &HashMap<String, bool>) -> Option<Vec<String>> {
        match self {
            ArgValue::Plain(value) => Some(vec![value.clone()]),
            ArgValue::Conditional(arg) => {
                if rules_allow(&arg.rules, features) {
                    Some(arg.value.clone().into_vec())
                } else {
                    None
                }
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Arguments {
    #[serde(default)]
    pub game: Vec<ArgValue>,
    #[serde(default)]
    pub jvm: Vec<ArgValue>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LoggingFile {
    #[serde(default)]
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub sha1: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LoggingClient {
    #[serde(default)]
    pub argument: Option<String>,
    #[serde(default)]
    pub file: Option<LoggingFile>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Logging {
    #[serde(default)]
    pub client: Option<LoggingClient>,
}

/// Сырой `version.json`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct VersionJson {
    pub id: String,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default, rename = "mainClass")]
    pub main_class: Option<String>,
    #[serde(default)]
    pub assets: Option<String>,
    #[serde(default, rename = "assetIndex")]
    pub asset_index: Option<AssetIndexRef>,
    #[serde(default)]
    pub downloads: Option<Downloads>,
    #[serde(default)]
    pub libraries: Vec<Library>,
    #[serde(default, rename = "javaVersion")]
    pub java_version: Option<JavaVersion>,
    #[serde(default, rename = "minecraftArguments")]
    pub minecraft_arguments: Option<String>,
    #[serde(default)]
    pub arguments: Option<Arguments>,
    #[serde(default, rename = "inheritsFrom")]
    pub inherits_from: Option<String>,
    #[serde(default, rename = "releaseTime")]
    pub release_time: Option<String>,
    #[serde(default)]
    pub logging: Option<Logging>,
}

/// Итоговый профиль после склейки ванили и загрузчика.
#[derive(Debug, Clone, Default)]
pub struct ResolvedVersion {
    /// id, под которым профиль сохранён (например `fabric-loader-0.16.9-1.21.4`).
    pub id: String,
    /// Версия, в папке которой лежит клиентский .jar (обычно ванильная).
    pub jar_id: String,
    pub main_class: String,
    pub asset_index: Option<AssetIndexRef>,
    pub assets: Option<String>,
    pub client: Option<Artifact>,
    pub libraries: Vec<Library>,
    pub jvm_args: Vec<ArgValue>,
    pub game_args: Vec<ArgValue>,
    pub java_major: u32,
    pub kind: String,
    pub logging: Option<LoggingClient>,
}

/// Склеить цепочку: `chain[0]` — запрошенная версия, дальше — родители.
pub fn merge_chain(chain: Vec<VersionJson>) -> ResolvedVersion {
    let mut resolved = ResolvedVersion {
        java_major: 8,
        kind: "release".into(),
        ..Default::default()
    };
    if chain.is_empty() {
        return resolved;
    }
    resolved.id = chain[0].id.clone();

    // Идём от родителя к ребёнку: так библиотеки и аргументы идут в правильном порядке.
    let mut libraries = Vec::new();
    for version in chain.iter().rev() {
        libraries.extend(version.libraries.iter().cloned());
    }

    for version in chain.iter() {
        if resolved.main_class.is_empty() {
            if let Some(main_class) = &version.main_class {
                resolved.main_class = main_class.clone();
            }
        }
        if resolved.client.is_none() {
            if let Some(downloads) = &version.downloads {
                if let Some(client) = &downloads.client {
                    resolved.client = Some(client.clone());
                    resolved.jar_id = version.id.clone();
                }
            }
        }
        if resolved.asset_index.is_none() {
            if let Some(asset_index) = &version.asset_index {
                resolved.asset_index = Some(asset_index.clone());
                resolved.assets = version.assets.clone();
            }
        }
        if let Some(java) = &version.java_version {
            if let Some(major) = java.major_version {
                resolved.java_major = resolved.java_major.max(major);
            }
        }
        if let Some(kind) = &version.kind {
            if version.id == resolved.jar_id || resolved.kind == "release" {
                resolved.kind = kind.clone();
            }
        }
        if resolved.logging.is_none() {
            if let Some(logging) = &version.logging {
                if let Some(client) = &logging.client {
                    if client.argument.is_some() && client.file.is_some() {
                        resolved.logging = Some(client.clone());
                    }
                }
            }
        }
        if let Some(arguments) = &version.arguments {
            resolved.jvm_args.extend(arguments.jvm.iter().cloned());
            resolved.game_args.extend(arguments.game.iter().cloned());
        }
        if let Some(legacy) = &version.minecraft_arguments {
            for piece in legacy.split_whitespace() {
                resolved
                    .game_args
                    .push(ArgValue::Plain(piece.to_string()));
            }
        }
    }

    resolved.libraries = dedupe_libraries(libraries);
    resolved
}

/// Ключ библиотеки для поиска дублей: `group:artifact[:classifier]@ext`.
fn library_key(name: &str) -> String {
    let (coords, ext) = match name.split_once('@') {
        Some((coords, ext)) => (coords, ext),
        None => (name, "jar"),
    };
    let parts: Vec<&str> = coords.split(':').collect();
    let mut key = String::new();
    if parts.len() >= 2 {
        key.push_str(parts[0]);
        key.push(':');
        key.push_str(parts[1]);
    } else {
        key.push_str(coords);
    }
    if parts.len() >= 4 {
        key.push(':');
        key.push_str(parts[3]);
    }
    key.push('@');
    key.push_str(ext);
    key
}

/// Убрать дубли библиотек: если загрузчик принёс свою версию той же библиотеки
/// (например, ASM 9.10.1 вместо 9.6 из ванили), нужна именно его версия.
/// Иначе JVM падает с `duplicate ASM classes found on classpath`.
fn dedupe_libraries(libraries: Vec<Library>) -> Vec<Library> {
    let keys: Vec<String> = libraries.iter().map(|library| library_key(&library.name)).collect();
    let mut last_index: HashMap<String, usize> = HashMap::new();
    for (index, key) in keys.iter().enumerate() {
        last_index.insert(key.clone(), index);
    }
    libraries
        .into_iter()
        .enumerate()
        .filter(|(index, _)| last_index.get(&keys[*index]).copied() == Some(*index))
        .map(|(_, library)| library)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maven_paths() {
        assert_eq!(
            maven_coords_to_path("org.lwjgl:lwjgl:3.3.3:natives-windows"),
            "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar"
        );
        assert_eq!(
            maven_coords_to_path("com.mojang:brigadier:1.0.18"),
            "com/mojang/brigadier/1.0.18/brigadier-1.0.18.jar"
        );
    }

    #[test]
    fn rules_default_allow() {
        let features = default_features();
        assert!(rules_allow(&None, &features));
        let only_windows = Some(vec![Rule {
            action: "allow".into(),
            os: Some(OsRule {
                name: Some("windows".into()),
                ..Default::default()
            }),
            features: None,
        }]);
        let expected = cfg!(target_os = "windows");
        assert_eq!(rules_allow(&only_windows, &features), expected);
    }

    #[test]
    fn loader_library_overrides_vanilla() {
        let vanilla: VersionJson = serde_json::from_str(
            r#"{"id":"1.21.4","mainClass":"a.B","libraries":[
                 {"name":"org.ow2.asm:asm:9.6","downloads":{"artifact":{"url":"u","size":1}}},
                 {"name":"com.mojang:brigadier:1.0.18","downloads":{"artifact":{"url":"u","size":1}}}]}"#,
        )
        .unwrap();
        let fabric: VersionJson = serde_json::from_str(
            r#"{"id":"fabric-loader-0.20.1-1.21.4","inheritsFrom":"1.21.4","mainClass":"k.Knot",
                 "libraries":[{"name":"org.ow2.asm:asm:9.10.1","downloads":{"artifact":{"url":"u","size":1}}}]}"#,
        )
        .unwrap();
        let resolved = merge_chain(vec![fabric, vanilla]);
        assert_eq!(resolved.main_class, "k.Knot");
        assert_eq!(resolved.libraries.len(), 2);
        assert!(resolved
            .libraries
            .iter()
            .any(|library| library.name == "org.ow2.asm:asm:9.10.1"));
        assert!(!resolved
            .libraries
            .iter()
            .any(|library| library.name == "org.ow2.asm:asm:9.6"));
    }

    #[test]
    fn disallow_wins_when_last() {
        let features = default_features();
        let rules = Some(vec![
            Rule {
                action: "allow".into(),
                os: None,
                features: None,
            },
            Rule {
                action: "disallow".into(),
                os: Some(OsRule {
                    name: Some(os_name().to_string()),
                    ..Default::default()
                }),
                features: None,
            },
        ]);
        assert!(!rules_allow(&rules, &features));
    }
}
