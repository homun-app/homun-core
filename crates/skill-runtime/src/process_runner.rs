use crate::{SkillRuntimeError, SkillRuntimeResult};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessSkillRunnerConfig {
    executable: PathBuf,
    working_dir: PathBuf,
    executable_roots: Vec<PathBuf>,
    working_roots: Vec<PathBuf>,
    env: BTreeMap<String, String>,
}

impl ProcessSkillRunnerConfig {
    pub fn new(
        executable: impl Into<PathBuf>,
        working_dir: impl Into<PathBuf>,
        executable_roots: Vec<PathBuf>,
        working_roots: Vec<PathBuf>,
    ) -> SkillRuntimeResult<Self> {
        let executable = canonicalize_path(executable.into(), "executable_not_found")?;
        let working_dir = canonicalize_path(working_dir.into(), "working_dir_not_found")?;
        let executable_roots = canonicalize_roots(executable_roots, "executable_root_not_found")?;
        let working_roots = canonicalize_roots(working_roots, "working_root_not_found")?;

        if !is_inside_any_root(&executable, &executable_roots) {
            return Err(SkillRuntimeError::RunnerFailed(
                "executable_outside_allowed_roots".to_string(),
            ));
        }
        if !is_inside_any_root(&working_dir, &working_roots) {
            return Err(SkillRuntimeError::RunnerFailed(
                "working_dir_outside_allowed_roots".to_string(),
            ));
        }

        Ok(Self {
            executable,
            working_dir,
            executable_roots,
            working_roots,
            env: BTreeMap::new(),
        })
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn working_dir(&self) -> &Path {
        &self.working_dir
    }

    pub fn env(&self) -> &BTreeMap<String, String> {
        &self.env
    }
}

#[derive(Debug, Clone)]
pub struct ProcessSkillRunner {
    config: ProcessSkillRunnerConfig,
}

impl ProcessSkillRunner {
    pub fn new(config: ProcessSkillRunnerConfig) -> Self {
        Self { config }
    }
}

fn canonicalize_roots(roots: Vec<PathBuf>, error: &str) -> SkillRuntimeResult<Vec<PathBuf>> {
    roots
        .into_iter()
        .map(|root| canonicalize_path(root, error))
        .collect()
}

fn canonicalize_path(path: PathBuf, error: &str) -> SkillRuntimeResult<PathBuf> {
    path.canonicalize()
        .map_err(|_| SkillRuntimeError::RunnerFailed(error.to_string()))
}

fn is_inside_any_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}
