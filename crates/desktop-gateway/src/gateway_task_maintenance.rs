//! Boot-time task-store maintenance.
//!
//! This module owns cleanup of retired execution tasks and duplicate Homun
//! check-ins. Startup ordering remains in `gateway_boot_maintenance`.

use crate::*;

/// A proactive task that delivers into the Homun thread, matched by the stable
/// `deliver_thread` marker rather than by goal text that changed over time.
fn task_delivers_to_homun(task: &TaskRecord) -> bool {
    task.kind == "proactive_prompt"
        && task
            .input_json
            .get("deliver_thread")
            .and_then(|v| v.as_str())
            == Some("homun")
}

fn task_is_live(task: &TaskRecord) -> bool {
    matches!(
        task.status,
        local_first_task_runtime::TaskStatus::Queued
            | local_first_task_runtime::TaskStatus::Pending
            | local_first_task_runtime::TaskStatus::WaitingTime
            | local_first_task_runtime::TaskStatus::Running
    )
}

pub(crate) fn cancel_homun_checkins(state: &AppState) {
    let Ok(store) = lock_task_store(state) else {
        return;
    };
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let Ok(tasks) = store.list_tasks(&user, &workspace) else {
        return;
    };
    for task in tasks {
        if task_delivers_to_homun(&task) && task_is_live(&task) {
            let _ = store.update_task_status(
                &task.task_id,
                &user,
                &workspace,
                local_first_task_runtime::TaskStatus::Cancelled,
                Some("Homun check-in disabled"),
            );
        }
    }
}

/// Startup garbage-collection of task-store cruft:
/// 1. retired execution tasks stuck in non-terminal waiting/failed states;
/// 2. duplicate Homun check-ins, keeping the newest across all workspaces.
pub(crate) fn gc_stale_tasks(state: &AppState) {
    let Ok(store) = lock_task_store(state) else {
        return;
    };
    let Ok(scopes) = store.task_owner_scopes() else {
        return;
    };
    let cutoff = OffsetDateTime::now_utc() - Duration::days(2);
    let mut cancelled = 0usize;
    let mut homun_live: Vec<(UserId, WorkspaceId, TaskRecord)> = Vec::new();

    for (user, workspace) in &scopes {
        let Ok(tasks) = store.list_tasks(user, workspace) else {
            continue;
        };
        for task in tasks {
            let stuck = matches!(
                task.status,
                local_first_task_runtime::TaskStatus::WaitingExternalEvent
                    | local_first_task_runtime::TaskStatus::WaitingResource
                    | local_first_task_runtime::TaskStatus::Failed
            );
            let is_execution = task.kind == "browser_task" || task.kind.starts_with("capability.");
            if stuck && is_execution && task.created_at < cutoff {
                let _ = store.update_task_status(
                    &task.task_id,
                    user,
                    workspace,
                    local_first_task_runtime::TaskStatus::Cancelled,
                    Some("GC: stale execution task"),
                );
                cancelled += 1;
                continue;
            }
            if task_delivers_to_homun(&task) && task_is_live(&task) {
                homun_live.push((user.clone(), workspace.clone(), task));
            }
        }
    }

    homun_live.sort_by_key(|(_, _, task)| task.created_at);
    if homun_live.len() > 1 {
        for (user, workspace, task) in &homun_live[..homun_live.len() - 1] {
            let _ = store.update_task_status(
                &task.task_id,
                user,
                workspace,
                local_first_task_runtime::TaskStatus::Cancelled,
                Some("GC: check-in Homun duplicato"),
            );
            cancelled += 1;
        }
    }

    if cancelled > 0 {
        eprintln!("[gc] task obsoleti/duplicati cancellati: {cancelled}");
    }
}

#[cfg(test)]
mod tests {
    use super::{task_delivers_to_homun, task_is_live};
    use crate::{TaskRecord, UserId, WorkspaceId};

    fn task(kind: &str, input_json: serde_json::Value) -> TaskRecord {
        TaskRecord::new(
            "task-test",
            UserId::new("user"),
            WorkspaceId::new("workspace"),
            kind,
            "goal",
            input_json,
        )
    }

    #[test]
    fn gateway_task_maintenance_matches_homun_checkin_by_delivery_marker() {
        assert!(task_delivers_to_homun(&task(
            "proactive_prompt",
            serde_json::json!({ "deliver_thread": "homun" }),
        )));
        assert!(!task_delivers_to_homun(&task(
            "proactive_prompt",
            serde_json::json!({ "deliver_thread": "other" }),
        )));
        assert!(!task_delivers_to_homun(&task(
            "chat_turn",
            serde_json::json!({ "deliver_thread": "homun" }),
        )));
    }

    #[test]
    fn gateway_task_maintenance_classifies_only_active_statuses_as_live() {
        let mut live = task(
            "proactive_prompt",
            serde_json::json!({ "deliver_thread": "homun" }),
        );
        live.status = local_first_task_runtime::TaskStatus::Running;
        assert!(task_is_live(&live));

        let mut terminal = live.clone();
        terminal.status = local_first_task_runtime::TaskStatus::Completed;
        assert!(!task_is_live(&terminal));
    }
}
