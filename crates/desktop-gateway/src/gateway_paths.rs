use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn ensure_parent(path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn database_path_from_env(
    env_key: &str,
    default_path: impl FnOnce() -> Result<PathBuf, std::io::Error>,
) -> Result<PathBuf, std::io::Error> {
    if let Ok(path) = env::var(env_key) {
        let path = PathBuf::from(path);
        ensure_parent(&path)?;
        return Ok(path);
    }
    default_path()
}

fn default_data_dir(home: Option<PathBuf>, temp_dir: PathBuf) -> PathBuf {
    home.unwrap_or(temp_dir).join(".homun")
}

/// Canonical data directory. All other gateway paths derive from this, so a
/// single `HOMUN_DATA_DIR` override redirects every store at once. Falls back to
/// the desktop default `~/.homun`.
pub(crate) fn gateway_data_dir() -> Result<PathBuf, std::io::Error> {
    let base = match env::var("HOMUN_DATA_DIR") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => default_data_dir(env::var("HOME").ok().map(PathBuf::from), env::temp_dir()),
    };
    fs::create_dir_all(&base)?;
    Ok(base)
}

pub(crate) fn gateway_database_path() -> Result<PathBuf, std::io::Error> {
    // Env override keeps working for backwards compat / testing.
    database_path_from_env("HOMUN_DESKTOP_GATEWAY_DB", gateway_unified_database_path)
}

/// Diagnostic logs directory (panic trail, crash marker). Lives beside the
/// SQLite stores so the desktop shell bundles diagnostics from one root.
pub(crate) fn gateway_logs_dir() -> Result<PathBuf, std::io::Error> {
    let base = gateway_data_dir()?.join("logs");
    fs::create_dir_all(&base)?;
    Ok(base)
}

pub(crate) fn gateway_task_database_path() -> Result<PathBuf, std::io::Error> {
    database_path_from_env("HOMUN_TASK_RUNTIME_DB", gateway_unified_database_path)
}

/// Path of the unified DB. Both ChatStore and TaskStore open this same file.
/// The legacy two-file layout is migrated once at boot by `unify_databases_if_needed`.
pub(crate) fn gateway_unified_database_path() -> Result<PathBuf, std::io::Error> {
    Ok(gateway_data_dir()?.join("homun.sqlite"))
}

/// Legacy chat DB path (desktop-gateway.sqlite). Used only by the migration.
pub(crate) fn gateway_legacy_chat_database_path() -> Result<PathBuf, std::io::Error> {
    Ok(gateway_data_dir()?.join("desktop-gateway.sqlite"))
}

/// Legacy task DB path (task-runtime.sqlite). Used only by the migration.
pub(crate) fn gateway_legacy_task_database_path() -> Result<PathBuf, std::io::Error> {
    Ok(gateway_data_dir()?.join("task-runtime.sqlite"))
}

pub(crate) fn gateway_local_computer_database_path() -> Result<PathBuf, std::io::Error> {
    database_path_from_env("HOMUN_LOCAL_COMPUTER_DB", || {
        Ok(gateway_data_dir()?.join("local-computer-session.sqlite"))
    })
}

pub(crate) fn gateway_browser_policy_database_path() -> Result<PathBuf, std::io::Error> {
    database_path_from_env("HOMUN_BROWSER_POLICY_DB", || {
        Ok(gateway_data_dir()?.join("browser-url-policy.sqlite"))
    })
}

pub(crate) fn gateway_memory_database_path() -> Result<PathBuf, std::io::Error> {
    database_path_from_env("HOMUN_MEMORY_DB", || {
        Ok(gateway_data_dir()?.join("memory.sqlite"))
    })
}

pub(crate) fn gateway_vault_database_path() -> Result<PathBuf, std::io::Error> {
    database_path_from_env("HOMUN_VAULT_DB", || {
        Ok(gateway_data_dir()?.join("vault.sqlite"))
    })
}

/// Directory for human-readable/editable memory wiki markdown pages.
pub(crate) fn gateway_memory_wiki_dir() -> Result<PathBuf, std::io::Error> {
    if let Ok(path) = env::var("HOMUN_MEMORY_WIKI_DIR") {
        let path = PathBuf::from(path);
        fs::create_dir_all(&path)?;
        return Ok(path);
    }
    let base = default_data_dir(env::var("HOME").ok().map(PathBuf::from), env::temp_dir())
        .join("memory-wiki");
    fs::create_dir_all(&base)?;
    Ok(base)
}

pub(crate) fn gateway_capability_database_path() -> Result<PathBuf, std::io::Error> {
    database_path_from_env("HOMUN_CAPABILITY_REGISTRY_DB", || {
        Ok(gateway_data_dir()?.join("capability-registry.sqlite"))
    })
}

pub(crate) fn gateway_workspaces_path() -> Result<PathBuf, std::io::Error> {
    Ok(gateway_data_dir()?.join("workspaces.json"))
}

pub(crate) fn gateway_project_access_path() -> Result<PathBuf, std::io::Error> {
    Ok(gateway_data_dir()?.join("project-access.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_data_dir_uses_home_when_available() {
        assert_eq!(
            default_data_dir(Some(PathBuf::from("/Users/fabio")), PathBuf::from("/tmp")),
            PathBuf::from("/Users/fabio/.homun")
        );
    }

    #[test]
    fn default_data_dir_falls_back_to_temp_dir() {
        assert_eq!(
            default_data_dir(None, PathBuf::from("/tmp/homun-test")),
            PathBuf::from("/tmp/homun-test/.homun")
        );
    }
}
