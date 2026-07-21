use local_first_task_runtime::TaskStore;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub(crate) fn render(
    store: &TaskStore,
    user_id: &str,
    workspace_id: &str,
    thread_id: &str,
) -> Result<String, String> {
    let plan = store
        .load_runtime_plan(user_id, workspace_id, thread_id)
        .map_err(|error| error.to_string())?;
    let runs = store
        .list_agent_runs_for_thread(thread_id, user_id, workspace_id)
        .map_err(|error| error.to_string())?;
    let receipts = store
        .list_tool_receipts_for_thread(thread_id, user_id, workspace_id)
        .map_err(|error| error.to_string())?;
    let mut out = format!(
        "# Working Ledger\n\n- Thread: `{thread_id}`\n- Workspace: `{workspace_id}`\n\n## Runtime plan\n\n"
    );
    if let Some(plan) = plan {
        out.push_str(&format!(
            "Status: `{}` · revision {} · stalled resumes {}\n\n",
            plan.status, plan.revision, plan.stall_turns
        ));
        if let Some(steps) = plan.plan_json.as_array() {
            for step in steps {
                let status = step
                    .get("status")
                    .and_then(|value| value.as_str())
                    .unwrap_or("todo");
                let title = step
                    .get("title")
                    .and_then(|value| value.as_str())
                    .unwrap_or("Untitled step");
                out.push_str(&format!(
                    "- [{status}] {}\n",
                    title.replace(['\r', '\n'], " ")
                ));
            }
        }
    } else {
        out.push_str("No runtime plan.\n");
    }
    out.push_str("\n## Execution attempts\n\n");
    if runs.is_empty() {
        out.push_str("No attempts.\n");
    }
    for run in &runs {
        out.push_str(&format!(
            "### Attempt {} · `{}`\n\n- Status: `{:?}`\n- Started: `{}`\n- Terminal reason: `{}`\n",
            run.attempt,
            run.run_id,
            run.status,
            run.started_at,
            run.terminal_reason.as_deref().unwrap_or("—")
        ));
        if let Ok(Some(checkpoint)) =
            store.latest_agent_checkpoint(&run.run_id, user_id, workspace_id)
        {
            out.push_str(&format!(
                "- Latest safe checkpoint: round {} · `{}`\n",
                checkpoint.round, checkpoint.fingerprint
            ));
        }
        if let Ok(events) = store.list_agent_run_events(&run.run_id, user_id, workspace_id, None) {
            let timeline = events
                .iter()
                .map(|event| {
                    event
                        .round
                        .map(|round| format!("{}@{}", event.kind, round))
                        .unwrap_or_else(|| event.kind.clone())
                })
                .collect::<Vec<_>>()
                .join(" → ");
            if !timeline.is_empty() {
                out.push_str(&format!("- Timeline: {timeline}\n"));
            }
            for event in events
                .iter()
                .filter(|event| event.kind == "tool_call_completed")
            {
                let name = event
                    .payload
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                let outcome = event
                    .payload
                    .get("outcome")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                let chars = event
                    .payload
                    .get("result_chars")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(0);
                let fingerprint = event
                    .payload
                    .get("result_fingerprint")
                    .and_then(|value| value.as_str())
                    .unwrap_or("—");
                let short_fingerprint = fingerprint.chars().take(12).collect::<String>();
                out.push_str(&format!(
                    "- Tool evidence: `{name}` · outcome `{outcome}` · {chars} chars · hash `{short_fingerprint}`\n"
                ));
            }
        }
        out.push('\n');
    }
    out.push_str("## Effect receipts\n\n");
    if receipts.is_empty() {
        out.push_str("No effectful tools recorded.\n");
    }
    for receipt in receipts {
        out.push_str(&format!(
            "- `{}` · `{}` · `{}`\n",
            receipt.tool_name, receipt.status, receipt.idempotency_key
        ));
    }
    Ok(out)
}

pub(crate) fn ledger_path(data_dir: &Path, thread_id: &str) -> PathBuf {
    let hash = format!("{:x}", Sha256::digest(thread_id.as_bytes()));
    data_dir.join("ledgers").join(format!("{hash}.md"))
}

pub(crate) fn materialize(
    store: &TaskStore,
    data_dir: &Path,
    user_id: &str,
    workspace_id: &str,
    thread_id: &str,
) -> Result<PathBuf, String> {
    let markdown = render(store, user_id, workspace_id, thread_id)?;
    let path = ledger_path(data_dir, thread_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, markdown).map_err(|error| error.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn working_ledger_is_deterministic_and_metadata_only() {
        let store = TaskStore::open_in_memory().unwrap();
        let first = render(&store, "u", "w", "t").unwrap();
        let second = render(&store, "u", "w", "t").unwrap();
        assert_eq!(first, second);
        assert!(!first.contains("api_key"));
        assert!(!first.contains("data:image"));
    }
}
