use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessKind {
    LlmRuntime,
    BrowserSidecar,
    McpServer,
    SkillRunner,
    PluginHost,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HealthCheck {
    None,
    ProcessAlive,
    HttpGet { url: String, timeout_ms: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RestartPolicy {
    Disabled,
    Bounded { max_restarts: u32, backoff_ms: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessStatus {
    Configured,
    Starting,
    Running,
    Healthy,
    Unhealthy,
    Exited,
    Failed,
    Stopped,
    Restarting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessSpec {
    pub id: String,
    pub kind: ProcessKind,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<String>,
    pub health_check: HealthCheck,
    pub restart_policy: RestartPolicy,
    pub log_capacity: usize,
    pub graceful_shutdown_ms: u64,
}

impl ProcessSpec {
    pub fn new(
        id: impl Into<String>,
        kind: ProcessKind,
        command: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            kind,
            command: command.into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: None,
            health_check: HealthCheck::ProcessAlive,
            restart_policy: RestartPolicy::Disabled,
            log_capacity: 500,
            graceful_shutdown_ms: 1_000,
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

    pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn with_health_check(mut self, health_check: HealthCheck) -> Self {
        self.health_check = health_check;
        self
    }

    pub fn with_restart_policy(mut self, restart_policy: RestartPolicy) -> Self {
        self.restart_policy = restart_policy;
        self
    }

    pub fn with_log_capacity(mut self, log_capacity: usize) -> Self {
        self.log_capacity = log_capacity;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessSnapshot {
    pub process_id: String,
    pub kind: ProcessKind,
    pub status: ProcessStatus,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub last_health_at: Option<String>,
    pub restart_count: u32,
    pub exit_code: Option<i32>,
    pub message: Option<String>,
}

impl ProcessSnapshot {
    pub fn new(
        process_id: impl Into<String>,
        kind: ProcessKind,
        status: ProcessStatus,
    ) -> Self {
        Self {
            process_id: process_id.into(),
            kind,
            status,
            pid: None,
            started_at: None,
            finished_at: None,
            last_health_at: None,
            restart_count: 0,
            exit_code: None,
            message: None,
        }
    }

    pub fn with_pid(mut self, pid: u32) -> Self {
        self.pid = Some(pid);
        self
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }
}
