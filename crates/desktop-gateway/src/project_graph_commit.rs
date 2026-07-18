use local_first_memory::ProjectGraphImportReport;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectGraphCommitError {
    Stage(String),
    Build(String),
    MissingGraph,
    InvalidJson(String),
    Import(String),
    Publish(String),
    Fingerprint(String),
}

impl fmt::Display for ProjectGraphCommitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stage(error) => write!(formatter, "project graph staging failed: {error}"),
            Self::Build(error) => write!(formatter, "project graph extraction failed: {error}"),
            Self::MissingGraph => formatter.write_str("staged project graph is missing graph.json"),
            Self::InvalidJson(error) => {
                write!(formatter, "staged project graph is invalid: {error}")
            }
            Self::Import(error) => write!(formatter, "project graph import failed: {error}"),
            Self::Publish(error) => write!(formatter, "project graph publish failed: {error}"),
            Self::Fingerprint(error) => {
                write!(formatter, "project graph fingerprint write failed: {error}")
            }
        }
    }
}

impl std::error::Error for ProjectGraphCommitError {}

pub fn stage_project_graph_build<Build, Import>(
    published_dir: &Path,
    fingerprint: &str,
    build: Build,
    import: Import,
) -> Result<ProjectGraphImportReport, ProjectGraphCommitError>
where
    Build: FnOnce(&Path) -> Result<(), String>,
    Import: FnOnce(&serde_json::Value) -> Result<ProjectGraphImportReport, ProjectGraphCommitError>,
{
    let parent = published_dir.parent().ok_or_else(|| {
        ProjectGraphCommitError::Stage("published directory has no parent".to_string())
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| ProjectGraphCommitError::Stage(error.to_string()))?;
    let label = published_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace");
    let nonce = uuid::Uuid::new_v4();
    let staging = parent.join(format!(".staging-{label}-{nonce}"));
    let previous = parent.join(format!(".previous-{label}-{nonce}"));

    fs::create_dir(&staging).map_err(|error| ProjectGraphCommitError::Stage(error.to_string()))?;
    if let Err(error) = build(&staging) {
        remove_dir_if_exists(&staging);
        return Err(ProjectGraphCommitError::Build(error));
    }
    let graph_path = staging.join("graph.json");
    if !graph_path.is_file() {
        remove_dir_if_exists(&staging);
        return Err(ProjectGraphCommitError::MissingGraph);
    }
    let raw = match fs::read_to_string(&graph_path) {
        Ok(raw) => raw,
        Err(error) => {
            remove_dir_if_exists(&staging);
            return Err(ProjectGraphCommitError::InvalidJson(error.to_string()));
        }
    };
    let graph = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(graph) => graph,
        Err(error) => {
            remove_dir_if_exists(&staging);
            return Err(ProjectGraphCommitError::InvalidJson(error.to_string()));
        }
    };
    let report = match import(&graph) {
        Ok(report) => report,
        Err(error) => {
            remove_dir_if_exists(&staging);
            return Err(error);
        }
    };

    let had_previous = published_dir.exists();
    if had_previous {
        fs::rename(published_dir, &previous)
            .map_err(|error| ProjectGraphCommitError::Publish(error.to_string()))?;
    }
    if let Err(error) = fs::rename(&staging, published_dir) {
        if had_previous {
            let _ = fs::rename(&previous, published_dir);
        }
        remove_dir_if_exists(&staging);
        return Err(ProjectGraphCommitError::Publish(error.to_string()));
    }

    let fingerprint_temp = published_dir.join(format!(".fingerprint-{nonce}.tmp"));
    if let Err(error) = write_fingerprint(&fingerprint_temp, published_dir, fingerprint) {
        let _ = fs::remove_file(&fingerprint_temp);
        remove_dir_if_exists(&previous);
        return Err(error);
    }
    remove_dir_if_exists(&previous);
    Ok(report)
}

fn write_fingerprint(
    temporary_path: &Path,
    published_dir: &Path,
    fingerprint: &str,
) -> Result<(), ProjectGraphCommitError> {
    fs::write(temporary_path, fingerprint)
        .map_err(|error| ProjectGraphCommitError::Fingerprint(error.to_string()))?;
    fs::rename(temporary_path, published_dir.join(".fingerprint"))
        .map_err(|error| ProjectGraphCommitError::Fingerprint(error.to_string()))
}

fn remove_dir_if_exists(path: &PathBuf) {
    if path.exists() {
        let _ = fs::remove_dir_all(path);
    }
}
