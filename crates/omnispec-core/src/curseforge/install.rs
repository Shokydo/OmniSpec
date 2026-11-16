//! Установка файлов CurseForge в конкретную сборку вместе с обязательными
//! зависимостями. Папка выбирается по типу проекта — как у Modrinth.

use std::collections::HashSet;

use crate::error::{Error, Result};
use crate::instances::InstanceMeta;
use crate::modrinth::install::target_dir;
// наружу отдаём тот же тип, что у Modrinth: интерфейсу не нужно различать источники
pub use crate::modrinth::install::InstallOutcome;
use crate::net::Reporter;
use crate::paths::Paths;

use super::CurseForge;

/// Поставить проект: конкретный файл (`file_id`) или самый свежий под версию
/// игры и загрузчик сборки.
pub async fn install(
    curseforge: &CurseForge,
    paths: &Paths,
    instance: &InstanceMeta,
    project_id: &str,
    file_id: Option<&str>,
    reporter: &Reporter,
) -> Result<InstallOutcome> {
    let mut outcome = InstallOutcome::default();
    let mut visited: HashSet<String> = HashSet::new();
    install_recursive(
        curseforge,
        paths,
        instance,
        project_id,
        file_id,
        &mut visited,
        reporter,
        &mut outcome,
    )
    .await?;
    Ok(outcome)
}

#[allow(clippy::too_many_arguments)]
async fn install_recursive(
    curseforge: &CurseForge,
    paths: &Paths,
    instance: &InstanceMeta,
    project_ref: &str,
    file_hint: Option<&str>,
    visited: &mut HashSet<String>,
    reporter: &Reporter,
    outcome: &mut InstallOutcome,
) -> Result<()> {
    let key = match file_hint {
        Some(file_id) => format!("{project_ref}#{file_id}"),
        None => project_ref.to_string(),
    };
    if !visited.insert(key) {
        return Ok(());
    }

    let project = curseforge.project(project_ref).await?;
    let project_type = if project.project_type.is_empty() {
        "mod".to_string()
    } else {
        project.project_type.clone()
    };
    // ресурспаки и шейдеры не привязаны к загрузчику
    let loader = match project_type.as_str() {
        "mod" => Some(instance.loader.kind()),
        _ => None,
    };

    let version = match file_hint {
        Some(file_id) => curseforge.file(project_ref, file_id).await?,
        None => curseforge
            .files(project_ref, Some(&instance.mc_version), loader)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| {
                Error::not_found(format!(
                    "у «{}» нет файлов для Minecraft {}",
                    project.title, instance.mc_version
                ))
            })?,
    };

    let file = version
        .primary_file()
        .cloned()
        .ok_or_else(|| Error::not_found(format!("у версии {} нет файлов", version.id)))?;

    let url = if file.url.trim().is_empty() {
        curseforge.download_url(project_ref, &version.id).await?
    } else {
        file.url.clone()
    };

    let dir = target_dir(paths, instance, &project_type);
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(&file.filename);

    if dest.exists() {
        outcome.skipped.push(file.filename.clone());
        reporter.emit("mods", 0, 0, format!("уже установлен: {}", file.filename));
    } else {
        reporter.emit("mods", 0, 0, format!("скачиваем {}", file.filename));
        let sha1 = file.hashes.get("sha1").cloned();
        curseforge
            .http()
            .download(&url, &dest, Some(file.size), sha1.as_deref(), true)
            .await?;
        outcome.installed.push(file.filename.clone());
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

    // Обязательные зависимости: у CurseForge это modId без номера файла,
    // поэтому для каждого берём самый свежий подходящий файл.
    for dependency in version.dependencies.iter() {
        if dependency.dependency_type != "required" {
            continue;
        }
        let Some(dep_project) = dependency.project_id.clone() else {
            continue;
        };
        if visited.contains(&dep_project) {
            continue;
        }
        Box::pin(install_recursive(
            curseforge,
            paths,
            instance,
            &dep_project,
            None,
            visited,
            reporter,
            outcome,
        ))
        .await?;
    }

    Ok(())
}

fn content_kind(project_type: &str) -> &'static str {
    match project_type {
        "resourcepack" => "resourcepack",
        "shader" => "shader",
        _ => "mod",
    }
}
