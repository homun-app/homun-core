use crate::{
    SkillRunner, SkillRuntimeError, SkillRuntimeOutput, SkillRuntimeRequest, SkillRuntimeResult,
};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessSkillRunnerConfig {
    executable: PathBuf,
    working_dir: PathBuf,
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

impl SkillRunner for ProcessSkillRunner {
    fn run(&self, request: &SkillRuntimeRequest) -> SkillRuntimeResult<SkillRuntimeOutput> {
        let input = serde_json::to_vec(request)
            .map_err(|error| SkillRuntimeError::RunnerFailed(error.to_string()))?;
        let mut child = Command::new(self.config.executable())
            .current_dir(self.config.working_dir())
            .env_clear()
            .envs(self.config.env())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| SkillRuntimeError::RunnerFailed(format!("process_spawn:{error}")))?;

        let mut stdin = child.stdin.take().ok_or_else(|| {
            SkillRuntimeError::RunnerFailed("process_stdin_unavailable".to_string())
        })?;
        stdin
            .write_all(&input)
            .map_err(|error| SkillRuntimeError::RunnerFailed(format!("process_stdin:{error}")))?;
        drop(stdin);

        let deadline = Instant::now() + Duration::from_secs(request.limits.timeout_seconds);
        loop {
            if child
                .try_wait()
                .map_err(|error| SkillRuntimeError::RunnerFailed(format!("process_wait:{error}")))?
                .is_some()
            {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SkillRuntimeError::RunnerFailed(
                    "process_timeout".to_string(),
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        let output = child
            .wait_with_output()
            .map_err(|error| SkillRuntimeError::RunnerFailed(format!("process_output:{error}")))?;
        if !output.status.success() {
            return Err(SkillRuntimeError::RunnerFailed(format!(
                "process_exit:{}:{}",
                output.status.code().unwrap_or(-1),
                sanitize_stderr(&output.stderr)
            )));
        }
        if output.stdout.len() > request.limits.max_output_bytes {
            return Err(SkillRuntimeError::OutputTooLarge(output.stdout.len()));
        }
        serde_json::from_slice(&output.stdout).map_err(|error| {
            SkillRuntimeError::RunnerFailed(format!("process_output_json:{error}"))
        })
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

fn sanitize_stderr(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .trim()
        .chars()
        .take(512)
        .collect()
}
