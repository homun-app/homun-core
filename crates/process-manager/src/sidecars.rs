use crate::{HealthCheck, ProcessKind, ProcessManagerResult, ProcessRegistryStore, ProcessSpec};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarProcessCatalog {
    workspace_root: PathBuf,
    browser_runtime_dir: PathBuf,
    node_command: String,
}

impl SidecarProcessCatalog {
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        let workspace_root = workspace_root.into();
        Self {
            browser_runtime_dir: workspace_root.join("runtimes/browser-automation"),
            workspace_root,
            node_command: "node".to_string(),
        }
    }

    pub fn with_node_command(mut self, node_command: impl Into<String>) -> Self {
        self.node_command = node_command.into();
        self
    }

    pub fn browser_sidecar(&self) -> ProcessSpec {
        ProcessSpec::new(
            "browser-automation",
            ProcessKind::BrowserSidecar,
            self.node_command.clone(),
        )
        .with_arg("node_modules/tsx/dist/cli.mjs")
        .with_arg("src/server.ts")
        .with_cwd(path_string(&self.browser_runtime_dir))
        .with_env("BROWSER_AUTOMATION_HEADLESS", "1")
        .with_health_check(HealthCheck::ProcessAlive)
        .with_log_capacity(1_000)
    }

    pub fn mcp_stdio(&self, config: McpProcessConfig) -> ProcessSpec {
        let mut spec = ProcessSpec::new(
            format!("mcp-{}", config.id),
            ProcessKind::McpServer,
            config.command,
        )
        .with_health_check(HealthCheck::ProcessAlive)
        .with_log_capacity(config.log_capacity);
        for arg in config.args {
            spec = spec.with_arg(arg);
        }
        for (key, value) in config.env {
            spec = spec.with_env(key, value);
        }
        if let Some(cwd) = config.cwd {
            spec = spec.with_cwd(path_string(cwd));
        }
        spec
    }

    pub fn register_default_sidecars(
        &self,
        store: &ProcessRegistryStore,
    ) -> ProcessManagerResult<()> {
        store.upsert_spec(&self.browser_sidecar())?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpProcessConfig {
    id: String,
    command: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    cwd: Option<PathBuf>,
    log_capacity: usize,
}

impl McpProcessConfig {
    pub fn new(id: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            command: command.into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: None,
            log_capacity: 1_000,
        }
    }

    pub fn with_arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn with_cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().to_string()
}
