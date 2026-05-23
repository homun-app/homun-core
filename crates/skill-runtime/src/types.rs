use local_first_capabilities::{SkillManifest, SkillToolManifest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillRuntimeLimits {
    pub timeout_seconds: u64,
    pub max_output_bytes: usize,
}

impl Default for SkillRuntimeLimits {
    fn default() -> Self {
        Self {
            timeout_seconds: 30,
            max_output_bytes: 256 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillAccessKind {
    Network,
    Filesystem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillAccess {
    pub kind: SkillAccessKind,
    pub target: String,
}

impl SkillAccess {
    pub fn network(target: impl Into<String>) -> Self {
        Self {
            kind: SkillAccessKind::Network,
            target: target.into(),
        }
    }

    pub fn filesystem(target: impl Into<String>) -> Self {
        Self {
            kind: SkillAccessKind::Filesystem,
            target: target.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillRuntimeRequest {
    pub manifest: SkillManifest,
    pub tool_name: String,
    pub arguments: Value,
    pub declared_access: Vec<SkillAccess>,
    pub limits: SkillRuntimeLimits,
}

impl SkillRuntimeRequest {
    pub fn new(manifest: SkillManifest, tool_name: impl Into<String>, arguments: Value) -> Self {
        Self {
            manifest,
            tool_name: tool_name.into(),
            arguments,
            declared_access: Vec::new(),
            limits: SkillRuntimeLimits::default(),
        }
    }

    pub fn with_declared_access(mut self, declared_access: Vec<SkillAccess>) -> Self {
        self.declared_access = declared_access;
        self
    }

    pub fn with_limits(mut self, limits: SkillRuntimeLimits) -> Self {
        self.limits = limits;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillExecutionTrace {
    pub accessed_network: Vec<String>,
    pub accessed_filesystem: Vec<PathBuf>,
}

impl SkillExecutionTrace {
    pub fn empty() -> Self {
        Self {
            accessed_network: Vec::new(),
            accessed_filesystem: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillRuntimeOutput {
    pub output: Value,
    pub trace: SkillExecutionTrace,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedSkillRequest {
    pub request: SkillRuntimeRequest,
    pub tool: SkillToolManifest,
}
