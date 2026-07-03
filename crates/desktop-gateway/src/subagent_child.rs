//! The CHILD LOOP for Homun's subagent orchestration (ADR 0025, slice-1 Task 1).
//!
//! One child subagent runs a BOUNDED read/gather agentic loop by reusing the
//! orchestrator's [`run_agentic_step`] — the SAME single guarded ReAct loop the
//! drive uses for browsing — with tool execution delegated to the gateway's real
//! read/gather tools. Two things fall out of that reuse for free:
//!
//! 1. The child inherits the process-global sandbox envelope. It calls the exact
//!    same dispatch surface (`execute_chat_tool`) as the main agent, so every
//!    sandbox/read-only/jail check already wired there applies to the child too —
//!    there is no second, weaker tool path to keep in sync.
//! 2. It uses motore #1's native tool-calling shape via `run_agentic_step`'s
//!    harness-owned control flow (choose-tool-under-an-enum, fill-args-constrained,
//!    forced synthesis) — NOT a parallel `generate_json` drive loop. The field
//!    verdict (single guarded loop + planning-as-a-tool, one execution engine, see
//!    the "single-loop evidence" memory) is why we reuse the existing loop instead
//!    of standing up a third subagent implementation (caposaldo #5).
//!
//! ## Why read/gather ONLY (fail-closed)
//!
//! A child limited to Read/Draft produces a PROPOSAL with no external side-effect,
//! so N children can fan out in parallel safely (intelligence gathering). A tool
//! that writes or executes makes a world-state decision and must go through the
//! single-threaded + approval machinery (`validate_single_threaded_writes`), which
//! the manager owns — never a child. So the allowlist EXCLUDES every write/exec
//! tool fail-closed: even if the model asks for `write_file`, it is not in the set
//! and cannot be dispatched. This mirrors the orchestrator's `subagent_write_mode`
//! ReadGather/WriteDecide split — a child is always ReadGather.
//!
//! ## Scope of THIS task (Task 1): machinery only, no live spawn
//!
//! This builds the child-loop machinery and makes it unit-testable without HTTP:
//! the executor is generic over a dispatch closure, so tests drive it with a fake
//! dispatch + a fake LLM. Wiring that closure to the real `execute_chat_tool` (which
//! needs a live `ChatToolCtx`) happens in Task 2, where the manager's turn context
//! exists. The `spawn_subagent` tool stays a stub behind `HOMUN_SUBAGENTS` until
//! then. See [`ChildDispatch`] for the exact bridge plan.

// Seam-phase: this module is the child-loop MACHINERY (Task 1). Nothing calls it
// live yet — the manager fan-out that invokes `run_chat_subagent` with a real
// `execute_chat_tool`-backed dispatch is Task 2. Mirrors `tool_safety.rs`'s
// seam-phase allow. Remove the allow once Task 2 wires it in.
#![allow(dead_code)]

use local_first_capabilities::CapabilityTool;
use local_first_orchestrator::{
    OrchestratorResult, PlanStep, PlanStepKind, StepExecutionPolicy, StepOutcome, run_agentic_step,
};
use local_first_subagents::{AgentId, AllowedAction, JsonRuntime};
use std::collections::BTreeMap;

use crate::tool_safety::{ToolFootprint, tool_footprint};

/// Names of the gateway chat tools a child MAY use: pure read/gather + draft.
///
/// This is an explicit allowlist (default-deny), not a deny-list, because
/// `tool_footprint` maps everything unknown to `NonFilesystem` — and a write-capable
/// MCP/Composio tool is also `NonFilesystem`. So the footprint guard alone would let
/// an unknown external writer through. Curating the positive set keeps the child to
/// tools we KNOW gather without side effects: local file reads, listings, browser
/// read/snapshot, web search, and memory recall. Browser navigate/act are included
/// because in the browsing loop they are read/gather (they open + read pages), the
/// same call the drive's browse SubagentTask offers.
const CHILD_READ_GATHER_TOOLS: &[&str] = &[
    // Local filesystem reads (ToolFootprint::ReadOnly).
    "read_file",
    "read_text_file",
    "list_files",
    "list_directory",
    // Browser read/gather (NonFilesystem; the drive's browse loop offers these).
    "browser_navigate",
    "browser_snapshot",
    "browser_act",
    // Web + memory gather (NonFilesystem).
    "web_search",
    "memory_recall",
];

/// Write/exec tools that a child must NEVER be able to dispatch. Kept as an explicit
/// list for the fail-closed assertion in tests and as documentation of intent; the
/// real guard is [`is_child_read_gather_tool`] (allowlist + footprint), which rejects
/// these both by absence from the allowlist AND by their Write/Exec footprint.
pub const CHILD_FORBIDDEN_TOOLS: &[&str] =
    &["write_file", "edit_file", "apply_patch", "run_in_project"];

/// True iff a chat tool of this name is safe for a child to call: it must be on the
/// read/gather allowlist AND its filesystem footprint must not be a Write/Exec (a
/// second, independent fail-closed check on the file/shell axis). Both must hold, so
/// a future rename that turned an allowlisted name into a writer would still be
/// caught by the footprint guard.
pub fn is_child_read_gather_tool(name: &str, args: &serde_json::Value) -> bool {
    if !CHILD_READ_GATHER_TOOLS.contains(&name) {
        return false;
    }
    match tool_footprint(name, args) {
        // Write/Exec touch the world → never a child.
        ToolFootprint::Write { .. } | ToolFootprint::Exec => false,
        // Reads, contained runs, and non-filesystem (browser/web/memory) gather.
        ToolFootprint::ReadOnly | ToolFootprint::Contained | ToolFootprint::NonFilesystem => true,
    }
}

/// Filter a set of loaded gateway tools down to the child's read/gather allowlist.
/// The manager passes its full loaded-tool set; the child only ever sees the safe
/// subset. Args are unknown at allowlist time, so classify with an empty object
/// (the footprint of file tools depends on the tool name, not the args).
pub fn child_gather_tools(loaded: &[CapabilityTool]) -> Vec<CapabilityTool> {
    let empty = serde_json::json!({});
    loaded
        .iter()
        .filter(|tool| is_child_read_gather_tool(&tool.name, &empty))
        .cloned()
        .collect()
}

/// The dispatch surface a child uses to actually run a tool. Sync-returning-String
/// on purpose: `run_agentic_step`'s executor seam is synchronous, and the whole loop
/// runs under `spawn_blocking` (the model + sidecar calls block), exactly like the
/// drive's browse path (`|tool, args| this.run_browser_tool(...)`).
///
/// ## Bridge plan to `execute_chat_tool` (Task 2)
///
/// In Task 2 the manager, inside its live turn, builds a closure that calls the real
/// async `execute_chat_tool(ctx, name, &args_raw, call_id)` and blocks on it (the
/// child loop is already on a blocking thread; use a `Handle::block_on` /
/// `futures::executor::block_on` at that seam). `execute_chat_tool` needs a
/// `ChatToolCtx`; a child needs a NARROW subset of its fields:
///   - `state`, `tx`, `thread_id`, `prompt`   — read-only turn context / streaming.
///   - `browser_session` + the browser bookkeeping (`browser_used`, `last_snapshot`,
///     `opened_targets`, `current_target`, `nav_failures`, `browse_sources`,
///     `browser_tool_call_ids`) — so browser read/gather reuses the thread's session.
///   - `read_only: true` + an empty write set — belt-and-braces: even the shared
///     dispatch's own read-only guard then refuses any write the allowlist somehow
///     let through.
/// A child does NOT need `plan`, `step_evidence`, `pending_confirm`, `composio_writes`,
/// the model-switch fields, etc. — those are writer/planner concerns. The seam here
/// is a plain `Fn(name, args_json) -> String`, so none of that couples into Task 1.
pub trait ChildDispatch: Fn(&str, serde_json::Value) -> String {}
impl<F: Fn(&str, serde_json::Value) -> String> ChildDispatch for F {}

/// The synthesized result of one child subagent's read/gather loop.
#[derive(Debug, Clone, PartialEq)]
pub struct SubagentResult {
    /// The model's synthesized findings for the manager to consume.
    pub findings: serde_json::Value,
    /// Provenance: which gather tools the child actually called (e.g.
    /// `"gather:web_search"`). Empty means the child gathered nothing.
    pub evidence: Vec<String>,
}

/// Build the read/gather `PlanStep` a child runs. A child is always a ReadGather
/// SubagentTask (Read/Draft only) — never a WriteDecide step (see the module docs
/// and the orchestrator's `subagent_write_mode`).
fn child_step(goal: &str) -> PlanStep {
    PlanStep {
        step_id: "child".to_string(),
        kind: PlanStepKind::SubagentTask,
        depends_on: vec![],
        provider_id: None,
        tool_name: None,
        arguments: serde_json::Value::Null,
        execution_policy: StepExecutionPolicy::DurableTask,
        risk_level: "low".to_string(),
        expected_duration_seconds: 30,
        agent_id: Some(AgentId::Tool),
        goal: Some(goal.to_string()),
        contract: Some("Return your findings for the manager to synthesize.".to_string()),
        // Read + Draft only — the parallel-safe, no-side-effect envelope. This is the
        // ReadGather half of `subagent_write_mode`.
        allowed_actions: vec![AllowedAction::Read, AllowedAction::Draft],
        requires_user_approval: None,
        timeout_seconds: None,
        max_tokens: None,
    }
}

/// Run ONE child subagent's bounded read/gather loop and return its findings.
///
/// A thin wrapper over [`run_agentic_step`]: it adapts the child's simple
/// `Fn(name, args) -> String` dispatch to the orchestrator executor seam
/// (`FnMut(&CapabilityTool, Value) -> OrchestratorResult<Value>`) and enforces the
/// read/gather allowlist a SECOND time at the dispatch boundary (defense in depth: a
/// tool must be in `allowed_tools` AND pass the footprint guard, else the dispatch
/// refuses it rather than executing). The harness (round budget, tool-choice enum,
/// forced synthesis, code-owned done) stays entirely in `run_agentic_step`.
pub fn run_chat_subagent<R, D>(
    goal: &str,
    allowed_tools: &[CapabilityTool],
    dispatch: D,
    llm: &R,
) -> OrchestratorResult<SubagentResult>
where
    R: JsonRuntime,
    D: ChildDispatch,
{
    let step = child_step(goal);
    let completed: BTreeMap<String, StepOutcome> = BTreeMap::new();

    let outcome = run_agentic_step(llm, allowed_tools, &step, &completed, |tool, args| {
        // Fail-closed at the execution boundary too: only dispatch a tool that is
        // both on the offered set and still classifies read/gather. A child MUST NOT
        // reach a write/exec tool even if one slipped into `allowed_tools`.
        if !is_child_read_gather_tool(&tool.name, &args) {
            return Ok(serde_json::json!({
                "error": format!("tool {} is not available to a read/gather subagent", tool.name)
            }));
        }
        // The real gateway dispatch returns a plain string (the tool's model-facing
        // text). Wrap it as JSON so it flows through the loop's history uniformly.
        let text = dispatch(&tool.name, args);
        Ok(serde_json::json!({ "result": text }))
    })?;

    Ok(SubagentResult {
        findings: outcome.output,
        evidence: outcome.evidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use local_first_capabilities::{ActionClass, CapabilityProviderKind, ProviderId};
    use local_first_subagents::{
        GenerateJsonRequest, GenerateJsonResponse, RuntimeClientError, TokenMetrics,
    };
    use std::sync::{Arc, Mutex};

    fn tool(name: &str, action: ActionClass) -> CapabilityTool {
        CapabilityTool {
            name: name.to_string(),
            provider_id: ProviderId::new("gather"),
            provider_kind: CapabilityProviderKind::Native,
            action,
            description: "gather tool".to_string(),
            privacy_domains: vec!["work".to_string()],
            sensitivity: "private".to_string(),
            input_schema: serde_json::json!({"type":"object","additionalProperties":true}),
        }
    }

    /// Replays a fixed script of action JSONs, like the orchestrator's own agentic
    /// tests. No HTTP — a deterministic fake `JsonRuntime`.
    #[derive(Clone)]
    struct ScriptRuntime {
        actions: Arc<Mutex<Vec<serde_json::Value>>>,
    }
    impl ScriptRuntime {
        fn new(actions: Vec<serde_json::Value>) -> Self {
            Self {
                actions: Arc::new(Mutex::new(actions)),
            }
        }
    }
    impl JsonRuntime for ScriptRuntime {
        fn generate_json(
            &self,
            _request: &GenerateJsonRequest,
        ) -> Result<GenerateJsonResponse, RuntimeClientError> {
            let json = self.actions.lock().unwrap().remove(0);
            Ok(GenerateJsonResponse {
                valid: true,
                errors: vec![],
                json,
                raw_output: String::new(),
                repaired: false,
                metrics: TokenMetrics::zero(),
            })
        }
    }

    // ── Allowlist: read/gather IN, write/exec OUT ─────────────────────────────

    #[test]
    fn allowlist_excludes_write_and_exec_tools() {
        // The four world-touching builtins are forbidden — both by absence from the
        // allowlist and by their Write/Exec footprint.
        let empty = serde_json::json!({});
        for name in CHILD_FORBIDDEN_TOOLS {
            assert!(
                !is_child_read_gather_tool(name, &empty),
                "{name} must be forbidden to a child"
            );
            // And its footprint is indeed Write/Exec (the second, independent guard).
            let fp = tool_footprint(name, &serde_json::json!({"path": "/x"}));
            assert!(
                matches!(fp, ToolFootprint::Write { .. } | ToolFootprint::Exec),
                "{name} footprint should be Write/Exec, got {fp:?}"
            );
        }
    }

    #[test]
    fn allowlist_includes_read_and_gather_tools() {
        let empty = serde_json::json!({});
        for name in ["read_text_file", "list_files", "browser_snapshot", "web_search"] {
            assert!(
                is_child_read_gather_tool(name, &empty),
                "{name} should be available to a child"
            );
        }
    }

    #[test]
    fn child_gather_tools_filters_to_the_safe_subset() {
        let loaded = vec![
            tool("web_search", ActionClass::Read),
            tool("read_text_file", ActionClass::Read),
            tool("write_file", ActionClass::WriteWithConfirmation),
            tool("run_in_project", ActionClass::ApprovedAutomation),
            tool("edit_file", ActionClass::WriteWithConfirmation),
        ];
        let mut names: Vec<String> = child_gather_tools(&loaded)
            .into_iter()
            .map(|t| t.name)
            .collect();
        names.sort();
        assert_eq!(names, vec!["read_text_file", "web_search"]);
    }

    // ── Child executor: bounded loop with a fake dispatch + fake LLM ──────────

    #[test]
    fn child_runs_bounded_loop_and_returns_findings_with_evidence() {
        // Fake LLM: pick a read tool, fill its args, then conclude. Mirrors the
        // orchestrator's two-phase-per-round shape (choose tool → fill args → finish).
        let llm = ScriptRuntime::new(vec![
            serde_json::json!({"action": "use_tool", "tool_name": "web_search"}),
            serde_json::json!({"q": "homun subagents"}), // arg-fill for web_search
            serde_json::json!({"action": "finish", "summary": "Found the docs."}),
        ]);
        let allowed = vec![tool("web_search", ActionClass::Read)];

        // Fake dispatch: canned tool output, no HTTP, no ChatToolCtx. Records calls.
        let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_seen = calls.clone();
        let dispatch = move |name: &str, _args: serde_json::Value| {
            calls_seen.lock().unwrap().push(name.to_string());
            "search hit: subagents guide".to_string()
        };

        let result = run_chat_subagent("gather subagent docs", &allowed, dispatch, &llm).unwrap();

        assert_eq!(result.findings["summary"], "Found the docs.");
        // Provenance records the gather call.
        assert_eq!(result.evidence, vec!["gather:web_search".to_string()]);
        // The dispatch was actually invoked with the allowed tool.
        assert_eq!(&*calls.lock().unwrap(), &["web_search".to_string()]);
    }

    #[test]
    fn child_dispatch_refuses_a_write_tool_even_if_offered() {
        // Adversarial: a write tool is (wrongly) in the offered set AND the model asks
        // for it. The dispatch boundary must refuse to execute it — the fake dispatch
        // is never called for a write tool. On the next round the model finishes.
        let llm = ScriptRuntime::new(vec![
            serde_json::json!({"action": "use_tool", "tool_name": "write_file"}),
            serde_json::json!({"path": "/etc/x", "content": "pwned"}), // arg-fill
            serde_json::json!({"action": "use_tool", "tool_name": "web_search"}),
            serde_json::json!({"q": "recover"}), // arg-fill
            serde_json::json!({"action": "finish", "summary": "done safely"}),
        ]);
        let allowed = vec![
            tool("write_file", ActionClass::WriteWithConfirmation),
            tool("web_search", ActionClass::Read),
        ];

        let executed: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let executed_seen = executed.clone();
        let dispatch = move |name: &str, _args: serde_json::Value| {
            executed_seen.lock().unwrap().push(name.to_string());
            format!("ran {name}")
        };

        let result = run_chat_subagent("try to write", &allowed, dispatch, &llm).unwrap();

        // The real dispatch NEVER saw write_file — the executor refused it before
        // calling the closure. Only the read tool actually ran.
        assert_eq!(&*executed.lock().unwrap(), &["web_search".to_string()]);
        assert_eq!(result.findings["summary"], "done safely");
    }
}
