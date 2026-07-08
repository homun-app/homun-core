//! Pure tool-trace helpers for the loop (ADR 0024, increment 5, Point 5 / 5.D1c.2).
//!
//! Small, pure functions keyed on a tool `name` that the loop uses to record what a tool DID for the
//! decision-memory trace. Relocated from the gateway monolith so the loop body (headed into this
//! crate) calls them locally. No `AppState`/HTTP — just string + serde-`Value` reasoning — so they
//! belong in the leaf engine. The gateway keeps calling them via `use local_first_engine::tools::…`.

use serde_json::Value;

/// A one-line human summary of a CONSEQUENTIAL tool action (a write/creation/run), for the decision
/// memory trace. Returns `None` for pure reads/discovery (nothing worth remembering) and for unknown
/// tools. Behavior-preserving relocation of the gateway's `summarize_tool_action`.
pub fn summarize_tool_action(name: &str, args_raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
    let field = |key: &str| {
        value
            .get(key)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let clip = |text: String, n: usize| text.chars().take(n).collect::<String>();
    let line = match name {
        "write_file" | "edit_file" => format!("edited file {}", field("path")),
        "create_artifact" => format!("created artifact {}", field("name")),
        "save_artifact" => {
            let target = if field("name").is_empty() {
                field("path")
            } else {
                field("name")
            };
            format!("saved {target}")
        }
        "run_in_project" => format!("ran in the project: {}", clip(field("command"), 120)),
        "run_in_sandbox" => format!("ran in sandbox: {}", clip(field("command"), 120)),
        "create_skill" => format!("created skill {}", field("name")),
        "customize_addon" => format!("customized addon {}", field("addon_id")),
        "schedule_task" => format!("scheduled task: {}", clip(field("prompt"), 80)),
        "cancel_scheduled_task" => format!("cancelled task {}", field("task_id")),
        // Pure reads / discovery → nothing to remember.
        "read_file"
        | "read_text_file"
        | "list_files"
        | "list_directory"
        | "recall_memory"
        | "suggest_capabilities" => return None,
        _ => return None,
    };
    Some(line)
}

/// A trace line for a connected-CAPABILITY execution (MCP or connector) — the one class of write the
/// per-name summary can't enumerate (the tool set is dynamic). `connector_index` is the turn's
/// catalog of `(slug, label, schema)` tuples. Behavior-preserving relocation; the MCP-name test is
/// reimplemented inline as a pure `bool` (the gateway's `parse_mcp_chat_name` returns a
/// capabilities-crate type the leaf engine can't reference, and only its `is_some` was used here).
pub fn connected_capability_execution_trace_line(
    name: &str,
    connector_index: &[(String, String, Value)],
) -> Option<String> {
    // `mcp__<slug>__<tool>` with non-empty slug + tool — the exact predicate `parse_mcp_chat_name`
    // encodes; inlined so this stays leaf-pure.
    let is_mcp_chat_name = name
        .strip_prefix("mcp__")
        .and_then(|rest| rest.split_once("__"))
        .is_some_and(|(slug, tool)| !slug.is_empty() && !tool.is_empty());
    if is_mcp_chat_name {
        return Some(format!("capability execution mcp:{name}"));
    }
    if connector_index.iter().any(|(slug, _, _)| slug == name) {
        return Some(format!("capability execution connector:{name}"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_writes_skips_reads() {
        assert_eq!(
            summarize_tool_action("write_file", r#"{"path":"a.rs"}"#).as_deref(),
            Some("edited file a.rs")
        );
        assert_eq!(summarize_tool_action("read_file", "{}"), None);
        assert_eq!(summarize_tool_action("unknown_tool", "{}"), None);
    }

    #[test]
    fn traces_mcp_and_connector_executions() {
        let idx = vec![("slack".to_string(), "Slack".to_string(), Value::Null)];
        assert_eq!(
            connected_capability_execution_trace_line("mcp__github__create_issue", &idx).as_deref(),
            Some("capability execution mcp:mcp__github__create_issue")
        );
        assert_eq!(
            connected_capability_execution_trace_line("slack", &idx).as_deref(),
            Some("capability execution connector:slack")
        );
        assert_eq!(connected_capability_execution_trace_line("write_file", &idx), None);
        // malformed mcp names fall through (not Some)
        assert_eq!(connected_capability_execution_trace_line("mcp__only", &idx), None);
    }
}
