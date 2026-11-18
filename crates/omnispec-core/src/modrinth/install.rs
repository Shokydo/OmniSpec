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
    let base = crate::instances::game_dir_for(paths, instance);
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

    // Тип проекта нужен ДО поиска версии: ресурспаки и шейдеры не привязаны
    // к загрузчику, и фильтр по fabric/forge у них ничего не находит.
    let project = modrinth.project(project_ref).await?;
    let project_type = if project.project_type.is_empty() {
        "mod".to_string()
    } else {
        project.project_type.clone()
    };
    let loader_filter = match project_type.as_str() {
        "mod" | "modpack" => Some(instance.loader.kind()),
        _ => None,
    };

    let version = match version_hint {
        Some(version_id) => modrinth.version(version_id).await?,
        None => {
            let versions = modrinth
                .project_versions(project_ref, Some(&instance.mc_version), loader_filter)
                .await?;
            versions.into_iter().next().ok_or_else(|| {
                Error::not_found(format!(
                    "у проекта «{project_ref}» нет версии для Minecraft {}",
                    instance.mc_version
                ))
            })?
        }
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
        let reporter_progress = reporter.clone();
        let file_name = file.filename.clone();
        modrinth
            .http()
            .download_tracked(
                &file.url,
                &dest,
                Some(file.size),
                None,
                true,
                &|done, total| {
                    reporter_progress.emit_bytes("mods", &file_name, done, total);
                },
            )
            .await?;
        outcome.installed.push(file.filename.clone());
        // картотека: по ней потом ищутся обновления и зависимости
        crate::content::remember(
            paths,
            instance,
            crate::content::ContentRecord {
                filename: file.filename.clone(),
                project_id: Some(version.project_id.clone()),
                version_id: Some(version.id.clone()),
                version_number: version.version_number.clone(),
                title: if project.title.is_empty() {
                    version.name.clone()
                } else {
                    project.title.clone()
                },
                kind: content_kind(&project_type).to_string(),
                sha1: file.hashes.get("sha1").cloned().unwrap_or_default(),
            },
        );
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

/// Вид содержимого по типу проекта Modrinth.
fn content_kind(project_type: &str) -> &'static str {
    match project_type {
        "resourcepack" => "resourcepack",
        "shader" => "shader",
        _ => "mod",
    }
}

/// Докачать обязательные зависимости для уже установленных модов.
///
/// Версии берутся из картотеки `content.json`, поэтому лишний раз проекты
/// не перезапрашиваются, а уже лежащие файлы пропускаются.
pub async fn ensure_dependencies(
    modrinth: &Modrinth,
    paths: &Paths,
    instance: &InstanceMeta,
    reporter: &Reporter,
) -> Result<InstallOutcome> {
    let mut outcome = InstallOutcome::default();
    let mut visited: HashSet<String> = HashSet::new();
    let targets = crate::content::installed_projects(paths, instance, "mod");
    if targets.is_empty() {
        return Ok(outcome);
    }
    reporter.emit("mods", 0, 0, "проверяем зависимости модов");
    for (project_id, version_id) in targets {
        let Some(version_id) = version_id else {
            continue;
        };
        let Ok(version) = modrinth.version(&version_id).await else {
            continue;
        };
        for dependency in version.dependencies.iter() {
            if dependency.dependency_type != "required" {
                continue;
            }
            if let Some(dep_version) = &dependency.version_id {
                let project_ref = dependency
                    .project_id
                    .clone()
                    .unwrap_or_else(|| project_id.clone());
                Box::pin(install_recursive(
                    modrinth,
                    paths,
                    instance,
                    &project_ref,
                    Some(dep_version),
                    &mut visited,
                    reporter,
                    &mut outcome,
                ))
                .await?;
            } else if let Some(dep_project) = &dependency.project_id {
                Box::pin(install_recursive(
                    modrinth,
                    paths,
                    instance,
                    dep_project,
                    None,
                    &mut visited,
                    reporter,
                    &mut outcome,
                ))
                .await?;
            }
        }
    }
    let total = outcome.installed.len() as u64;
    let detail = if outcome.installed.is_empty() {
        "все зависимости на месте".to_string()
    } else {
        format!("докачано: {}", outcome.installed.join(", "))
    };
    reporter.emit("mods", total, total, detail);
    Ok(outcome)
}

/// Удалить мод из сборки по имени файла.
pub fn remove_mod(paths: &Paths, instance: &InstanceMeta, filename: &str) -> Result<()> {
    let file = PathBuf::from(filename);
    if file.components().count() != 1 {
        return Err(Error::Other("недопустимое имя файла".into()));
    }
    for sub in ["mods", "resourcepacks", "shaderpacks"] {
        let path = crate::instances::game_dir_for(paths, instance)
            .join(sub)
            .join(filename);
        if path.exists() {
            std::fs::remove_file(path)?;
            return Ok(());
        }
    }
    Err(Error::not_found(format!("файл «{filename}» не найден")))
}

/// Включить/выключить мод переименованием в `.disabled`.
pub fn toggle_mod(paths: &Paths, instance: &InstanceMeta, filename: &str) -> Result<String> {
    let dir = crate::instances::game_dir_for(paths, instance).join("mods");
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
