use crate::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};
use std::str::FromStr;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryRefKind {
    Event,
    Memory,
    Entity,
    Relation,
    Wiki,
    Graph,
    Routine,
    Automation,
    Audit,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MemoryRef {
    pub kind: MemoryRefKind,
    pub scope: String,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub key: String,
}

impl MemoryRef {
    pub fn new(
        kind: MemoryRefKind,
        user_id: UserId,
        workspace_id: WorkspaceId,
        key: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            scope: "local".to_string(),
            user_id,
            workspace_id,
            key: key.into(),
        }
    }

    pub fn generated(kind: MemoryRefKind, user_id: UserId, workspace_id: WorkspaceId) -> Self {
        Self::new(kind, user_id, workspace_id, Uuid::new_v4().to_string())
    }
}

impl Display for MemoryRefKind {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            MemoryRefKind::Event => "event",
            MemoryRefKind::Memory => "memory",
            MemoryRefKind::Entity => "entity",
            MemoryRefKind::Relation => "relation",
            MemoryRefKind::Wiki => "wiki",
            MemoryRefKind::Graph => "graph",
            MemoryRefKind::Routine => "routine",
            MemoryRefKind::Automation => "automation",
            MemoryRefKind::Audit => "audit",
        };
        formatter.write_str(value)
    }
}

impl Display for MemoryRef {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}:{}:{}:{}:{}",
            self.kind,
            self.scope,
            self.user_id.as_str(),
            self.workspace_id.as_str(),
            self.key
        )
    }
}

impl FromStr for MemoryRef {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let parts: Vec<&str> = value.splitn(5, ':').collect();
        if parts.len() != 5 {
            return Err(format!("invalid memory ref {value}"));
        }
        let kind = match parts[0] {
            "event" => MemoryRefKind::Event,
            "memory" => MemoryRefKind::Memory,
            "entity" => MemoryRefKind::Entity,
            "relation" => MemoryRefKind::Relation,
            "wiki" => MemoryRefKind::Wiki,
            "graph" => MemoryRefKind::Graph,
            "routine" => MemoryRefKind::Routine,
            "automation" => MemoryRefKind::Automation,
            "audit" => MemoryRefKind::Audit,
            _ => return Err(format!("unknown memory ref kind {}", parts[0])),
        };
        Ok(Self {
            kind,
            scope: parts[1].to_string(),
            user_id: UserId::new(parts[2]),
            workspace_id: WorkspaceId::new(parts[3]),
            key: parts[4].to_string(),
        })
    }
}
