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
    let objective = store
        .load_objective_contract(user_id, workspace_id, thread_id)
        .map_err(|error| error.to_string())?;
    let steering = store
        .list_turn_steering(user_id, workspace_id, thread_id)
        .map_err(|error| error.to_string())?;
    let runs = store
        .list_agent_runs_for_thread(thread_id, user_id, workspace_id)
        .map_err(|error| error.to_string())?;
    let receipts = store
        .list_tool_receipts_for_thread(thread_id, user_id, workspace_id)
        .map_err(|error| error.to_string())?;
    let latest_run = runs.last();
    let latest_memory_status = runs.iter().rev().find_map(|run| {
        store
            .read_turn_events(&run.turn_id, 0)
            .ok()?
            .into_iter()
            .rev()
            .find_map(|event| {
                (event.kind == local_first_task_runtime::TurnEventKind::Recall)
                    .then(|| event.payload.get("status")?.as_str().map(str::to_string))
                    .flatten()
            })
    });
    let mut out = format!(
        "# Working Ledger\n\n- Thread: `{thread_id}`\n- Workspace: `{workspace_id}`\n- Run state: `{}`\n- Memory access: `{}`\n\n## Canonical objective\n\n",
        latest_run
            .map(|run| format!("{:?}", run.status).to_ascii_lowercase())
            .unwrap_or_else(|| "idle".to_string()),
        latest_memory_status.as_deref().unwrap_or("not_checked")
    );
    if let Some(objective) = objective {
        let semantic = crate::semantic_decision::semantic_decision_from_contract(&objective);
        let mut bounded_scope = objective.scope_json.clone();
        if let Some(scope) = bounded_scope.as_object_mut() {
            scope.remove("semantic_decision");
        }
        out.push_str(&format!(
            "- Revision: {}\n- Status: `{}`\n- Mode: `{:?}`\n- Objective: {}\n- Scope: `{}`\n- Allowed actions: `{}`\n- Completion: `{}`\n",
            objective.revision,
            objective.status,
            objective.mode,
            objective.objective.replace(['\r', '\n'], " "),
            bounded_scope,
            objective.allowed_actions_json,
            objective.completion_json,
        ));
        out.push_str("\n## Semantic decision\n\n");
        if let Some(semantic) = semantic {
            let payload = crate::semantic_decision::bounded_observability_payload(&semantic);
            out.push_str(&format!(
                "- Schema: `{}`\n- Provider: `{}`\n- Model: `{}`\n- Confidence: `{}`\n- Relationship: `{}`\n- Execution: `{}`\n- Capability: `{}`\n- Confirmation required: `{}`\n- Fallback: `{}`\n- Validator rejection: `{}`\n",
                payload["schema_version"].as_u64().unwrap_or_default(),
                payload["provider"].as_str().unwrap_or("—"),
                payload["model"].as_str().unwrap_or("—"),
                payload["confidence"].as_f64().unwrap_or_default(),
                payload["relationship"].as_str().unwrap_or("unknown"),
                payload["execution_shape"].as_str().unwrap_or("agent_loop"),
                payload["selected_capability"].as_str().unwrap_or("—"),
                payload["requires_user_confirmation"].as_bool().unwrap_or(false),
                payload["fallback_reason"].as_str().unwrap_or("—"),
                payload["validator_rejection_code"].as_str().unwrap_or("—"),
            ));
        } else {
            out.push_str("No validated semantic decision.\n");
        }
    } else {
        out.push_str("No canonical objective.\n");
    }
    out.push_str("\n## Runtime plan\n\n");
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
    out.push_str("\n## Steering\n\n");
    if steering.is_empty() {
        out.push_str("No steering messages.\n");
    }
    for item in steering {
        let content = item
            .content
            .replace(['\r', '\n'], " ")
            .chars()
            .take(240)
            .collect::<String>();
        out.push_str(&format!(
            "- `{}` for `{}` at objective revision {}: {}\n",
            item.status, item.active_turn_id, item.objective_revision, content
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

    #[test]
    fn working_ledger_projects_objective_and_steering_without_new_files() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .upsert_objective_contract(
                "u",
                "w",
                "t",
                "message-1",
                "Analyse only",
                local_first_task_runtime::ObjectiveMode::ReadOnlyAnalysis,
                &serde_json::json!({"workspace": "w"}),
                &serde_json::json!(["read", "test"]),
                &serde_json::json!({"deliverable": "analysis"}),
                "active",
            )
            .unwrap();
        store
            .append_turn_steering("u", "w", "t", "turn-1", "message-2", "continue", 1)
            .unwrap();

        let markdown = render(&store, "u", "w", "t").unwrap();
        assert!(markdown.contains("## Canonical objective"));
        assert!(markdown.contains("Analyse only"));
        assert!(markdown.contains("## Steering"));
        assert!(markdown.contains("continue"));
    }

    #[test]
    fn semantic_decision_ledger_is_bounded_and_omits_prompt_content() {
        let store = TaskStore::open_in_memory().unwrap();
        let mut semantic = crate::semantic_decision::safe_fallback(None, "test_fallback");
        semantic.decision.rationale = "RAW_PROMPT_SENTINEL must not be projected".to_string();
        semantic.provenance.provider = Some("provider-a".to_string());
        semantic.provenance.model = Some("model-a".to_string());
        let projection = crate::semantic_decision::objective_contract_projection(
            &semantic,
            None,
            "t",
            "w",
            Some("/project"),
        );
        store
            .upsert_objective_contract(
                "u",
                "w",
                "t",
                "message-1",
                &projection.objective,
                projection.mode,
                &projection.scope_json,
                &projection.allowed_actions_json,
                &projection.completion_json,
                "active",
            )
            .unwrap();

        let markdown = render(&store, "u", "w", "t").unwrap();
        assert!(markdown.contains("## Semantic decision"));
        assert!(markdown.contains("provider-a"));
        assert!(markdown.contains("test_fallback"));
        assert!(!markdown.contains("RAW_PROMPT_SENTINEL"));
        assert!(!markdown.contains("semantic_decision\":"));
    }
}
