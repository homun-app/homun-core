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

// Task 2 wires the live fan-out (`spawn_subagent` in main.rs calls `run_chat_subagent`
// + `synthesize_subagent_results` with an `execute_chat_tool`-backed dispatch). A few
// items here stay test-only fail-closed documentation (`CHILD_FORBIDDEN_TOOLS`,
// `ChildDispatch` as a named trait), so keep a module-level allow rather than sprinkle
// per-item allows. Mirrors `tool_safety.rs`'s seam-phase allow.
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
    // MEMORY RECALL (read-only). The gateway chat tool is literally named
    // `recall_memory` (see `recall_memory_tool_schema` / the dispatch arm in
    // `execute_chat_tool`), so the allowlist name MUST match that exact string or
    // the entry is dead and a child can never recall. This is READ-only: it derives
    // its `MemoryScope` from the process-global `MEMORY_WORKSPACE` the MANAGER's turn
    // set from `request.thread_id`, and a child runs INLINE inside that same turn, so
    // it rides the manager's scope (Thread/Project) — never Personal-by-default nor
    // another workspace. Memory WRITE tools (`record_decision`, `forget_memory`) are
    // deliberately absent (see `CHILD_FORBIDDEN_TOOLS`): a child gathers, never learns.
    "recall_memory",
];

/// Write/exec tools that a child must NEVER be able to dispatch. Kept as an explicit
/// list for the fail-closed assertion in tests and as documentation of intent; the
/// real guard is [`is_child_read_gather_tool`] (allowlist + footprint), which rejects
/// these both by absence from the allowlist AND by their Write/Exec footprint.
pub const CHILD_FORBIDDEN_TOOLS: &[&str] = &[
    "write_file",
    "edit_file",
    "apply_patch",
    "run_in_project",
    // Memory WRITE/mutation tools: a child gathers and recalls, it must NEVER learn
    // or forget. Learning is a world-state decision (it changes what the manager and
    // future turns recall) and must ride the manager's single-writer path. These are
    // absent from `CHILD_READ_GATHER_TOOLS`, so this list is the fail-closed pin.
    "record_decision",
    "forget_memory",
];

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

/// Map a subagent per-task `role` HINT to a registry role key (the catalog in
/// `model_registry::ROLES` / `role_requirements`), or `None` to INHERIT the manager's
/// model.
///
/// ## Why inherit-by-default (ADR 0025 / Codex role pattern)
///
/// Children specialize by role→model, but the DEFAULT is inherit: an absent or
/// unknown hint returns `None`, and the caller then reuses the MANAGER's model rather
/// than silently escalating cost/capability. Only an explicit, recognized hint routes
/// a child to a role-appropriate model. This is model SELECTION only — it never widens
/// the read/gather envelope (a child stays read-only whatever model it runs on).
///
/// Recognized hints (case-insensitive), each mapped to an existing registry role so we
/// reuse the SAME resolver (`resolve_role_for_task`) the manager/driver use — no new
/// role catalog:
/// - `explorer` / `research` / `search` → `browser` (the fast observe-act/gather tier)
/// - `coding` / `code` → `coding` (strong reasoning + tool-use for code)
/// - `memory` / `recall` → `memory` (fast, cheap extraction/recall tier)
/// - `vision` / `image` → `vision` (a vision-capable model)
/// - `orchestrator` / `plan` / `reasoning` → `orchestrator` (the reasoning tier)
///
/// Anything else (including `None`) → `None` = inherit.
pub fn subagent_role_to_registry_role(role_hint: Option<&str>) -> Option<&'static str> {
    let hint = role_hint?.trim().to_ascii_lowercase();
    match hint.as_str() {
        "explorer" | "research" | "search" => Some("browser"),
        "coding" | "code" => Some("coding"),
        "memory" | "recall" => Some("memory"),
        "vision" | "image" => Some("vision"),
        "orchestrator" | "plan" | "reasoning" => Some("orchestrator"),
        // Unknown / empty → inherit the manager's model (don't guess a role).
        _ => None,
    }
}

/// The dispatch surface a child uses to actually run a tool. Sync-returning-String
/// on purpose: `run_agentic_step`'s executor seam is synchronous, exactly like the
/// drive's browse path (`|tool, args| this.run_browser_tool(...)`).
///
/// `FnMut` (not `Fn`), because the real Task-2 dispatch mutably borrows a child
/// `ChatToolCtx` (`execute_chat_tool(&mut child_ctx, …)`) — so the closure necessarily
/// captures `&mut child_ctx`. `run_agentic_step`'s executor is already `FnMut`, so this
/// composes.
///
/// ## Bridge to `execute_chat_tool` (Task 2, now wired in main.rs)
///
/// The manager, inside its live turn, wraps the sync child loop in
/// `tokio::task::block_in_place` and, inside this closure, `Handle::current().block_on`s
/// the async `execute_chat_tool(&mut child_ctx, name, &args_raw, call_id)`. `block_in_place`
/// (not `spawn_blocking`) is used because the child ctx is not `Send`, so it can't cross
/// a thread boundary. `execute_chat_tool` needs a `ChatToolCtx`; a child gets a NARROW
/// `read_only` one: shared turn context (`state`/`tx`/`thread_id`/`prompt`/`request`) +
/// its OWN fresh mutable buffers, `read_only: true` (belt-and-braces: even the shared
/// dispatch's read-only guard then refuses any write the allowlist somehow let through).
pub trait ChildDispatch: FnMut(&str, serde_json::Value) -> String {}
impl<F: FnMut(&str, serde_json::Value) -> String> ChildDispatch for F {}

/// The synthesized result of one child subagent's read/gather loop.
#[derive(Debug, Clone, PartialEq)]
pub struct SubagentResult {
    /// The model's synthesized findings for the manager to consume.
    pub findings: serde_json::Value,
    /// Provenance: which gather tools the child actually called (e.g.
    /// `"gather:web_search"`). Empty means the child gathered nothing.
    pub evidence: Vec<String>,
}

/// Hard cap on how many children a single `spawn_subagent` fan-out may run
/// (Task 2). A larger `tasks` array is clamped to the first N so a runaway/adversarial
/// model can't spawn an unbounded number of children. Each child is itself bounded by
/// `run_agentic_step`'s `MAX_AGENTIC_ROUNDS`, so the total work is
/// `MAX_SUBAGENT_CHILDREN * MAX_AGENTIC_ROUNDS` rounds — a fixed ceiling.
pub const MAX_SUBAGENT_CHILDREN: usize = 4;

/// Reduce one child's `findings` JSON to a compact one-line string for the manager
/// prompt. The child loop's forced synthesis produces `{"summary": "..."}` (the
/// `finish` action), so prefer `summary`; fall back to the whole JSON for any other
/// shape. Kept separate from [`synthesize_subagent_results`] so both are trivially
/// unit-testable.
fn findings_to_text(findings: &serde_json::Value) -> String {
    if let Some(summary) = findings.get("summary").and_then(|v| v.as_str()) {
        return summary.trim().to_string();
    }
    // No `summary` key (unusual): render the raw JSON so nothing is silently dropped.
    findings.to_string()
}

/// Join N children's results into ONE model-facing block for the manager to act on.
///
/// This is the "synthesize" half of the fan-out/JOIN: the manager stays the only
/// writer, so a child never touches the world — it hands back findings + evidence, and
/// the manager reads THIS block in its own turn and decides what to do. Pure (no ctx,
/// no IO) precisely so it can be unit-tested without a live turn.
///
/// `results` pairs each child's original `goal` with its [`SubagentResult`] so the
/// block is self-describing (which finding answers which sub-task). Evidence is
/// appended per child when present, so the manager can see provenance.
pub fn synthesize_subagent_results(results: &[(String, SubagentResult)]) -> String {
    if results.is_empty() {
        return "Subagent findings: (no sub-tasks were run).".to_string();
    }
    let mut out = String::from("Subagent findings:\n");
    for (goal, result) in results {
        let findings = findings_to_text(&result.findings);
        out.push_str(&format!("- {goal}: {findings}"));
        if !result.evidence.is_empty() {
            out.push_str(&format!(" [evidence: {}]", result.evidence.join(", ")));
        }
        out.push('\n');
    }
    out.push_str(
        "\nSynthesize the above into your answer and take any required action yourself \
         (the subagents only gathered — you are the only writer).",
    );
    out
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
/// `FnMut(name, args) -> String` dispatch to the orchestrator executor seam
/// (`FnMut(&CapabilityTool, Value) -> OrchestratorResult<Value>`) and enforces the
/// read/gather allowlist a SECOND time at the dispatch boundary (defense in depth: a
/// tool must be in `allowed_tools` AND pass the footprint guard, else the dispatch
/// refuses it rather than executing). The harness (round budget, tool-choice enum,
/// forced synthesis, code-owned done) stays entirely in `run_agentic_step`.
pub fn run_chat_subagent<R, D>(
    goal: &str,
    allowed_tools: &[CapabilityTool],
    mut dispatch: D,
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
        // EVERY forbidden tool is rejected for a child — the primary guarantee is
        // absence from the read/gather allowlist (default-deny), which holds for all
        // of them regardless of footprint.
        let empty = serde_json::json!({});
        for name in CHILD_FORBIDDEN_TOOLS {
            assert!(
                !is_child_read_gather_tool(name, &empty),
                "{name} must be forbidden to a child"
            );
        }
        // The FILESYSTEM/EXEC writers additionally carry a Write/Exec footprint (the
        // second, independent fail-closed guard). Memory-write tools are NonFilesystem
        // (they mutate the memory store, not the filesystem), so they are pinned by
        // allowlist-absence alone — asserted separately in `memory_write_tools_*`.
        for name in ["write_file", "edit_file", "apply_patch", "run_in_project"] {
            let fp = tool_footprint(name, &serde_json::json!({"path": "/x"}));
            assert!(
                matches!(fp, ToolFootprint::Write { .. } | ToolFootprint::Exec),
                "{name} footprint should be Write/Exec, got {fp:?}"
            );
        }
    }

    // ── SECURITY (ADR 0025 Task 3): memory scope + read-only memory ───────────

    #[test]
    fn memory_recall_is_child_gatherable_under_the_real_tool_name() {
        // Regression pin: the gateway chat tool is named `recall_memory` (NOT
        // `memory_recall`). If the allowlist name drifts from the dispatch arm the
        // entry goes dead — a child silently loses memory recall. Assert the REAL
        // name is on the read/gather allowlist so recall stays reachable.
        let empty = serde_json::json!({});
        assert!(
            is_child_read_gather_tool("recall_memory", &empty),
            "recall_memory must be gatherable by a child (read-only memory)"
        );
        // And a child that is offered `recall_memory` keeps it after filtering.
        let loaded = vec![tool("recall_memory", ActionClass::Read)];
        let names: Vec<String> = child_gather_tools(&loaded)
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert_eq!(names, vec!["recall_memory".to_string()]);
    }

    #[test]
    fn memory_write_tools_are_never_child_gatherable() {
        // The SECURITY deliverable's write half: a child gathers/recalls but must
        // NEVER learn or forget. `record_decision`/`forget_memory` mutate the shared
        // memory store (a world-state decision that changes future recall) and must
        // ride the manager's single-writer path — so they are absent from the child
        // allowlist AND absent from the filtered gather set even when offered.
        let empty = serde_json::json!({});
        for name in ["record_decision", "forget_memory"] {
            assert!(
                CHILD_FORBIDDEN_TOOLS.contains(&name),
                "{name} must be listed as forbidden to a child"
            );
            assert!(
                !is_child_read_gather_tool(name, &empty),
                "{name} (memory write) must never be gatherable by a child"
            );
        }
        // Even if the manager's loaded set contains them, filtering strips them.
        let loaded = vec![
            tool("recall_memory", ActionClass::Read),
            tool("record_decision", ActionClass::WriteWithConfirmation),
            tool("forget_memory", ActionClass::WriteWithConfirmation),
        ];
        let names: Vec<String> = child_gather_tools(&loaded)
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert_eq!(names, vec!["recall_memory".to_string()]);
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

    // ── Synthesis (JOIN): N child results → one manager-facing block ──────────

    fn result_with(summary: &str, evidence: &[&str]) -> SubagentResult {
        SubagentResult {
            findings: serde_json::json!({ "summary": summary }),
            evidence: evidence.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn synthesize_joins_two_children_with_goals_findings_and_evidence() {
        let results = vec![
            (
                "gather pricing".to_string(),
                result_with("Plan A is $10/mo.", &["gather:web_search"]),
            ),
            (
                "gather changelog".to_string(),
                result_with("v2 shipped subagents.", &["gather:read_text_file"]),
            ),
        ];
        let block = synthesize_subagent_results(&results);

        // Both goals AND both findings appear in the single block.
        assert!(block.contains("gather pricing"));
        assert!(block.contains("Plan A is $10/mo."));
        assert!(block.contains("gather changelog"));
        assert!(block.contains("v2 shipped subagents."));
        // Evidence/provenance is carried per child.
        assert!(block.contains("gather:web_search"));
        assert!(block.contains("gather:read_text_file"));
        // The manager is reminded it is the only writer.
        assert!(block.contains("only writer"));
    }

    #[test]
    fn synthesize_handles_empty_and_summaryless_findings() {
        // Empty fan-out → a clear, non-empty message (never a blank block).
        assert!(synthesize_subagent_results(&[]).contains("no sub-tasks"));

        // A child whose findings has no `summary` key: the raw JSON is preserved,
        // not silently dropped.
        let odd = SubagentResult {
            findings: serde_json::json!({ "note": "partial" }),
            evidence: vec![],
        };
        let block = synthesize_subagent_results(&[("odd goal".to_string(), odd)]);
        assert!(block.contains("odd goal"));
        assert!(block.contains("partial"));
    }

    #[test]
    fn two_children_run_then_synthesize_into_one_block() {
        // End-to-end at the helper level (no live ctx): drive TWO children through the
        // real `run_chat_subagent` loop with a fake dispatch + fake LLM, then JOIN with
        // `synthesize_subagent_results`. The single block must carry BOTH goals + both
        // findings — the exact fan-out/join shape the manager relies on.
        let allowed = vec![tool("web_search", ActionClass::Read)];
        let mut results: Vec<(String, SubagentResult)> = Vec::new();
        for (goal, answer) in [
            ("gather A", "finding A"),
            ("gather B", "finding B"),
        ] {
            let llm = ScriptRuntime::new(vec![
                serde_json::json!({"action": "use_tool", "tool_name": "web_search"}),
                serde_json::json!({"q": goal}),
                serde_json::json!({"action": "finish", "summary": answer}),
            ]);
            let dispatch = |_name: &str, _args: serde_json::Value| "hit".to_string();
            let r = run_chat_subagent(goal, &allowed, dispatch, &llm).unwrap();
            results.push((goal.to_string(), r));
        }
        assert_eq!(results.len(), 2);

        let block = synthesize_subagent_results(&results);
        assert!(block.contains("gather A") && block.contains("finding A"));
        assert!(block.contains("gather B") && block.contains("finding B"));
        // Both children recorded their gather provenance.
        assert!(block.matches("gather:web_search").count() == 2);
    }

    // ── SPECIALIZATION (ADR 0025 Task 3): role hint → registry role, inherit default ──

    #[test]
    fn role_hint_maps_known_hints_and_inherits_otherwise() {
        // Known hints resolve to an existing registry role (reusing the manager's
        // resolver), case-insensitively and trimming whitespace.
        assert_eq!(subagent_role_to_registry_role(Some("explorer")), Some("browser"));
        assert_eq!(subagent_role_to_registry_role(Some("research")), Some("browser"));
        assert_eq!(subagent_role_to_registry_role(Some("  Coding ")), Some("coding"));
        assert_eq!(subagent_role_to_registry_role(Some("MEMORY")), Some("memory"));
        assert_eq!(subagent_role_to_registry_role(Some("vision")), Some("vision"));
        assert_eq!(
            subagent_role_to_registry_role(Some("orchestrator")),
            Some("orchestrator")
        );

        // Unknown, empty, and absent → INHERIT (None) = reuse the manager's model.
        // This is the safe default: don't silently escalate cost/capability.
        assert_eq!(subagent_role_to_registry_role(Some("wizard")), None);
        assert_eq!(subagent_role_to_registry_role(Some("")), None);
        assert_eq!(subagent_role_to_registry_role(Some("   ")), None);
        assert_eq!(subagent_role_to_registry_role(None), None);
    }

    #[test]
    fn role_hint_decides_specialize_vs_inherit_router_path() {
        // The routing DECISION (HTTP-free): a task WITH a recognized role hint takes the
        // "resolve a role → build a specialized router" path (Some), while a task with no
        // (or an unknown) hint takes the INHERIT path (None = reuse manager's router).
        // This pins the branch `run_spawn_subagent` selects per child without a live model.
        let specialized = subagent_role_to_registry_role(Some("explorer"));
        let inherited = subagent_role_to_registry_role(None);
        assert!(
            specialized.is_some(),
            "a role-hinted child must resolve a registry role (specialize)"
        );
        assert!(
            inherited.is_none(),
            "an un-hinted child must inherit the manager's model"
        );
        // The two paths are distinct — a hinted child does NOT share the inherit path.
        assert_ne!(specialized, inherited);
    }

    #[test]
    fn max_children_bound_is_small_and_positive() {
        // The handler clamps `tasks` to this many children; keep it a small ceiling so
        // total work stays bounded (see `MAX_SUBAGENT_CHILDREN` docs). The clamp itself
        // lives in the main.rs handler (needs a live ctx); this pins the constant.
        assert!(MAX_SUBAGENT_CHILDREN >= 1 && MAX_SUBAGENT_CHILDREN <= 8);
    }
}
