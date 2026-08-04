// Per-turn memory context blocks and scope projection used by prompt assembly.
use crate::*;
/// The project's OBJECTIVE (north star) — injected FIRST, with a focus directive, so every
/// turn is anchored to where the project is going. A goal is the intent to steer BY
/// (forward-looking: "where we must arrive / how this must work"), distinct from a decision
/// (a backward-looking record of a choice). Built from `goal` memories only; None until an
/// objective is set. This is what keeps the assistant from drifting off-focus.
///
/// Thin wrapper over `objective_block_for_workspace` bound to the per-turn memory scope
/// (`gateway_memory_workspace_id()`), for the system-prompt/briefing injection path.
pub(crate) fn project_objective_block(state: &AppState) -> Option<String> {
    objective_block_for_workspace(state, &gateway_memory_workspace_id())
}

/// Parameterized core of the objective block: derives the north-star text for an EXPLICIT
/// workspace instead of the process-global memory scope. Request handlers (which resolve
/// the workspace per-request) MUST use this so the objective stays consistent with the rest
/// of their payload — the global `MEMORY_WORKSPACE` belongs to the run-turn writer and can
/// describe a different project than a concurrent GET is answering for.
pub(crate) fn objective_block_for_workspace(
    state: &AppState,
    ws: &MemoryWorkspaceId,
) -> Option<String> {
    if ws.as_str() == PERSONAL_WORKSPACE || ws.as_str() == THREADS_WORKSPACE {
        return None;
    }
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let goals: Vec<String> = facade
        .list_memories_for_ui(&user, ws)
        .ok()?
        .into_iter()
        .filter(|m| {
            m.memory_type == "goal"
                && matches!(m.status, MemoryStatus::Confirmed | MemoryStatus::Candidate)
        })
        .map(|m| m.text.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if goals.is_empty() {
        return None;
    }
    let mut block = String::from(
        "🎯 PROJECT OBJECTIVE — this is the NORTH STAR. Every implementation, change, or \
document must SERVE this objective. Stay focused: if the request seems to \
drift, expand beyond the objective, or reintroduce something that goes against it, \
POINT IT OUT before proceeding. The objectives:",
    );
    for g in &goals {
        block.push_str(&format!("\n- {g}"));
    }
    Some(block)
}

/// Reads the active project's `brief.md` for INJECTION into the briefing (push): the
/// recent state the assistant should always hold. None for personal/threads or
/// when no brief exists yet. Capped so it never dominates the prompt.
pub(crate) fn project_brief_block(state: &AppState) -> Option<String> {
    let ws = gateway_memory_workspace_id();
    if ws.as_str() == PERSONAL_WORKSPACE || ws.as_str() == THREADS_WORKSPACE {
        return None;
    }
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let page = facade
        .list_wiki_pages_for_ui(&user, &ws)
        .ok()?
        .into_iter()
        .find(|p| p.path == "brief.md")?;
    let body = page.body.trim();
    if body.is_empty() {
        return None;
    }
    let capped: String = body.chars().take(2000).collect();
    Some(format!(
        "PROJECT BRIEF (objectives and status — where it's heading; keep it in mind, don't drift):\n{capped}"
    ))
}

/// Recent work (push): the active project's last git commits — "what we last worked on",
/// so a new conversation resumes the thread instead of starting cold. Distinct from the
/// brief (goals/state): this is the activity timeline. Projects-with-git only; capped.
pub(crate) fn recent_work_block(state: &AppState) -> Option<String> {
    let _ = state; // kept for signature symmetry with the other briefing blocks
    let ws = gateway_memory_workspace_id();
    if ws.as_str() == PERSONAL_WORKSPACE || ws.as_str() == THREADS_WORKSPACE {
        return None;
    }
    let folder = load_workspaces_file()
        .workspaces
        .into_iter()
        .find(|w| w.id == ws.as_str())
        .and_then(|w| w.folder)
        .filter(|f| !f.trim().is_empty())?;
    let root = std::path::Path::new(&folder);
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["log", "--pretty=format:%ad %s", "--date=short", "-n", "8"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())?;
    if out.is_empty() {
        return None;
    }
    let capped: String = out
        .lines()
        .take(8)
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(1200)
        .collect();
    Some(format!(
        "RECENT WORK (the project's latest commits — pick up the thread, don't start from scratch):\n{capped}"
    ))
}

/// Costruisce il `MemoryScope` corrispondente al workspace attivo del gateway.
///
/// L'assemblaggio canonico del briefing deriva lo scope dal workspace attivo
/// (`gateway_memory_workspace_id`); questo helper lo proietta nel `MemoryScope`
/// del crate memoria. Lo scope `Thread` (episodico) non compare nel briefing
/// always-on canonico, quindi qui mappiamo solo Personal/Project.
pub(crate) fn scope_from_active_workspace() -> MemoryScope {
    memory_scope_for_workspace(gateway_memory_workspace_id(), None)
}

pub(crate) fn memory_scope_for_turn(thread_id: Option<&str>) -> MemoryScope {
    memory_scope_for_workspace(gateway_memory_workspace_id(), thread_id)
}

pub(crate) fn memory_scope_for_workspace(
    project: MemoryWorkspaceId,
    thread_id: Option<&str>,
) -> MemoryScope {
    match thread_id {
        Some(thread_id) if !thread_id.trim().is_empty() => MemoryScope::Thread {
            project,
            thread_id: thread_id.to_string(),
        },
        _ if project.as_str() == PERSONAL_WORKSPACE => MemoryScope::Personal,
        _ => MemoryScope::Project(project),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_memory_turn_context_maps_workspace_and_thread_scopes() {
        assert!(matches!(
            memory_scope_for_workspace(MemoryWorkspaceId::new(PERSONAL_WORKSPACE), None),
            MemoryScope::Personal
        ));

        match memory_scope_for_workspace(MemoryWorkspaceId::new("project-a"), None) {
            MemoryScope::Project(workspace) => assert_eq!(workspace.as_str(), "project-a"),
            other => panic!("project workspace must map to MemoryScope::Project, got {other:?}"),
        }

        match memory_scope_for_workspace(MemoryWorkspaceId::new("project-a"), Some("thread-1")) {
            MemoryScope::Thread { project, thread_id } => {
                assert_eq!(project.as_str(), "project-a");
                assert_eq!(thread_id, "thread-1");
            }
            other => panic!("thread id must map to MemoryScope::Thread, got {other:?}"),
        }
    }
}
