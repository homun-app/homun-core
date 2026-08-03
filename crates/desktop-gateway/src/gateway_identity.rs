use local_first_capabilities::{UserId as CapabilityUserId, WorkspaceId as CapabilityWorkspaceId};
use local_first_memory::{
    PERSONAL_WORKSPACE, UserId as MemoryUserId, WorkspaceId as MemoryWorkspaceId,
};
use local_first_task_runtime::{UserId, WorkspaceId};
use std::env;

fn env_or_default(env_key: &str, fallback: &str) -> String {
    env::var(env_key)
        .unwrap_or_else(|_| fallback.to_string())
        .trim()
        .to_string()
}

pub(crate) fn gateway_user_id() -> UserId {
    UserId::new(env_or_default("HOMUN_USER_ID", "local-user"))
}

/// Active workspace ("project") — the scoping unit for tasks, memory, and
/// capabilities. A project IS a workspace (isolated context), so selecting one
/// re-scopes task/chat helpers through this process-global selection.
static ACTIVE_WORKSPACE: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

pub(crate) fn active_workspace_id() -> String {
    if let Ok(guard) = ACTIVE_WORKSPACE.read()
        && let Some(id) = guard.as_ref().filter(|id| !id.trim().is_empty())
    {
        return id.clone();
    }
    env_or_default("HOMUN_WORKSPACE_ID", "local-workspace")
}

pub(crate) fn set_active_workspace(id: &str) {
    if let Ok(mut guard) = ACTIVE_WORKSPACE.write() {
        *guard = Some(id.trim().to_string());
    }
}

// Per-turn MEMORY scope, set from the chat thread's project. Kept separate from
// ACTIVE_WORKSPACE so scoping memory to a conversation's project does not hijack
// the user's selected workspace for other subsystems.
static MEMORY_WORKSPACE: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

pub(crate) fn set_memory_workspace(id: &str) {
    if let Ok(mut guard) = MEMORY_WORKSPACE.write() {
        *guard = if id.trim().is_empty() {
            None
        } else {
            Some(id.trim().to_string())
        };
    }
}

pub(crate) fn gateway_workspace_id() -> WorkspaceId {
    WorkspaceId::new(active_workspace_id())
}

/// The base "personal" workspace where channel conversations live,
/// independent of whichever project is active.
pub(crate) fn base_workspace_id() -> String {
    env_or_default("HOMUN_WORKSPACE_ID", "local-workspace")
}

pub(crate) fn gateway_memory_user_id() -> MemoryUserId {
    MemoryUserId::new(env_or_default("HOMUN_USER_ID", "local-user"))
}

pub(crate) fn gateway_memory_workspace_id() -> MemoryWorkspaceId {
    // Prefer the per-turn memory scope (the conversation's project) if set, else the
    // user's selected workspace.
    let raw = MEMORY_WORKSPACE
        .read()
        .ok()
        .and_then(|guard| guard.as_ref().filter(|id| !id.trim().is_empty()).cloned())
        .unwrap_or_else(active_workspace_id);
    canonical_memory_workspace_id(&raw)
}

pub(crate) fn canonical_memory_workspace_id(workspace_id: &str) -> MemoryWorkspaceId {
    MemoryWorkspaceId::new(canonical_memory_workspace_id_for_base(
        workspace_id,
        &base_workspace_id(),
    ))
}

fn canonical_memory_workspace_id_for_base(workspace_id: &str, base_workspace_id: &str) -> String {
    let workspace_id = workspace_id.trim();
    if !workspace_id.is_empty() && workspace_id == base_workspace_id.trim() {
        PERSONAL_WORKSPACE.to_string()
    } else {
        workspace_id.to_string()
    }
}

pub(crate) fn gateway_capability_user_id() -> CapabilityUserId {
    CapabilityUserId::new(env_or_default("HOMUN_USER_ID", "local-user"))
}

pub(crate) fn gateway_capability_workspace_id() -> CapabilityWorkspaceId {
    // Capabilities (Composio/Gmail, browser, filesystem MCP) are the user's, not a
    // project's. Scope them to the stable base workspace so they do not disappear
    // when a project is selected.
    CapabilityWorkspaceId::new(base_workspace_id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_memory_workspace_maps_base_to_personal() {
        assert_eq!(
            canonical_memory_workspace_id_for_base("local-workspace", "local-workspace"),
            PERSONAL_WORKSPACE
        );
    }

    #[test]
    fn canonical_memory_workspace_keeps_named_projects() {
        assert_eq!(
            canonical_memory_workspace_id_for_base("project-a", "local-workspace"),
            "project-a"
        );
    }

    #[test]
    fn canonical_memory_workspace_trims_input() {
        assert_eq!(
            canonical_memory_workspace_id_for_base(" project-a ", "local-workspace"),
            "project-a"
        );
    }
}
