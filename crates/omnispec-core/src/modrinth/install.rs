//! Установка модов/ресурспаков/шейдеров с Modrinth в конкретную сборку,
//! вместе с обязательными зависимостями.

use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::instances::InstanceMeta;
use crate::net::Reporter;
use crate::paths::Paths;

use super::Modrinth;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InstallOutcome {
    pub installed: Vec<String>,
    pub skipped: Vec<String>,
}

/// Папка сборки под тип проекта.
pub fn target_dir(paths: &Paths, instance: &InstanceMeta, project_type: &str) -> PathBuf {
    let base = paths.instance_game_dir(&instance.id);
    match project_type {
        "resourcepack" => base.join("resourcepacks"),
        "shader" => base.join("shaderpacks"),
        "modpack" => base.join("modpacks"),
        _ => base.join("mods"),
    }
}

/// Установить проект в сборку (выбирая версию под версию игры и загрузчик).
pub async fn install_project(
    modrinth: &Modrinth,
    paths: &Paths,
    instance: &InstanceMeta,
    project_id: &str,
    reporter: &Reporter,
) -> Result<InstallOutcome> {
    let mut outcome = InstallOutcome::default();
    let mut visited: HashSet<String> = HashSet::new();
    install_recursive(
        modrinth,
        paths,
        instance,
        project_id,
        None,
        &mut visited,
        reporter,
        &mut outcome,
    )
    .await?;
    Ok(outcome)
}

/// Установить конкретную версию проекта.
pub async fn install_version(
    modrinth: &Modrinth,
    paths: &Paths,
    instance: &InstanceMeta,
    version_id: &str,
    reporter: &Reporter,
) -> Result<InstallOutcome> {
    let mut outcome = InstallOutcome::default();
    let mut visited: HashSet<String> = HashSet::new();
    let version = modrinth.version(version_id).await?;
    install_recursive(
        modrinth,
        paths,
        instance,
        &version.project_id,
        Some(version_id),
        &mut visited,
        reporter,
        &mut outcome,
    )
    .await?;
    Ok(outcome)
}

#[allow(clippy::too_many_arguments)]
async fn install_recursive(
    modrinth: &Modrinth,
    paths: &Paths,
    instance: &InstanceMeta,
    project_ref: &str,
    version_hint: Option<&str>,
    visited: &mut HashSet<String>,
    reporter: &Reporter,
    outcome: &mut InstallOutcome,
) -> Result<()> {
    let key = version_hint.unwrap_or(project_ref).to_string();
    if !visited.insert(key.clone()) {
        return Ok(());
    }

    let version = match version_hint {
        Some(version_id) => modrinth.version(version_id).await?,
        None => {
            let versions = modrinth
                .project_versions(
                    project_ref,
                    Some(&instance.mc_version),
                    Some(instance.loader.kind()),
                )
                .await?;
            versions
                .into_iter()
                .next()
                .ok_or_else(|| {
                    Error::not_found(format!(
                        "у проекта «{project_ref}» нет версии для Minecraft {} ({})",
                        instance.mc_version,
                        instance.loader.label()
                    ))
                })?
        }
    };

    let project = modrinth.project(&version.project_id).await?;
    let project_type = if project.project_type.is_empty() {
        "mod".to_string()
    } else {
        project.project_type.clone()
    };

    let file = version
        .primary_file()
        .ok_or_else(|| Error::not_found(format!("у версии {} нет файлов", version.id)))?;

    let dir = target_dir(paths, instance, &project_type);
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(&file.filename);

    if dest.exists() {
        outcome.skipped.push(file.filename.clone());
        reporter.emit("mods", 0, 0, format!("уже установлен: {}", file.filename));
    } else {
        reporter.emit("mods", 0, 0, format!("скачиваем {}", file.filename));
        modrinth
            .http()
            .download(&file.url, &dest, Some(file.size), None, true)
            .await?;
        outcome.installed.push(file.filename.clone());
    }

    // Обязательные зависимости.
    for dependency in version.dependencies.iter() {
        if dependency.dependency_type != "required" {
            continue;
        }
        if let Some(dep_version) = &dependency.version_id {
            let dep_key = dep_version.clone();
            if visited.contains(&dep_key) {
                continue;
            }
            let dep = modrinth.version(dep_version).await?;
            let project_ref = dependency
                .project_id
                .clone()
                .unwrap_or_else(|| dep.project_id.clone());
            Box::pin(install_recursive(
                modrinth,
                paths,
                instance,
                &project_ref,
                Some(dep_version),
                visited,
                reporter,
                outcome,
            ))
            .await?;
        } else if let Some(dep_project) = &dependency.project_id {
            Box::pin(install_recursive(
                modrinth,
                paths,
                instance,
                dep_project,
                None,
                visited,
                reporter,
                outcome,
            ))
            .await?;
        }
    }

    Ok(())
}

/// Удалить мод из сборки по имени файла.
pub fn remove_mod(paths: &Paths, instance: &InstanceMeta, filename: &str) -> Result<()> {
    let file = PathBuf::from(filename);
    if file.components().count() != 1 {
        return Err(Error::Other("недопустимое имя файла".into()));
    }
    for sub in ["mods", "resourcepacks", "shaderpacks"] {
        let path = paths.instance_game_dir(&instance.id).join(sub).join(filename);
        if path.exists() {
            std::fs::remove_file(path)?;
            return Ok(());
        }
    }
    Err(Error::not_found(format!("файл «{filename}» не найден")))
}

/// Включить/выключить мод переименованием в `.disabled`.
pub fn toggle_mod(paths: &Paths, instance: &InstanceMeta, filename: &str) -> Result<String> {
    let dir = paths.instance_game_dir(&instance.id).join("mods");
    let active = dir.join(filename);
    if active.exists() {
        let disabled = dir.join(format!("{filename}.disabled"));
        std::fs::rename(&active, &disabled)?;
        return Ok(format!("{filename}.disabled"));
    }
    if let Some(stripped) = filename.strip_suffix(".disabled") {
        let enabled = dir.join(stripped);
        std::fs::rename(dir.join(filename), &enabled)?;
        return Ok(stripped.to_string());
    }
    Err(Error::not_found(format!("мод «{filename}» не найден")))
}
