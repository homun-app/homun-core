//! The agentic execution mode for `SubagentTask` steps: a BOUNDED inner loop in
//! which the model steers (chooses the next tool, or finishes) while the harness
//! owns the envelope (round budget, tool gating, forced synthesis, done).
//!
//! ## Why this is not a third subagent implementation (caposaldo #5)
//!
//! ADR 0016 Pilastro 2 defines TWO execution modes over the SAME plan graph:
//! *workflow* (the model fills one constrained slot — the single-shot
//! `subagents::run_generate_json`, used by the durable task path) and *agent* (a
//! step whose execution is itself a bounded mini-loop). This is the *agent* mode —
//! a different execution shape, not a copy of the single-shot runner. It lives in
//! the orchestrator's execution layer, beside the driver, because the driver owns
//! step execution.
//!
//! ## Scope: read/gather only (ADR 0020 Fase 2)
//!
//! The sub-agent may use only Read/Draft tools — it gathers and drafts, it does
//! not write. Writes need the single-threaded + approval machinery
//! (`validate_single_threaded_writes`), which is later work; offering a write tool
//! here would bypass it, so they are excluded fail-closed.
//!
//! ## The invariants the harness keeps
//!
//! - **Bounded** — at most [`MAX_AGENTIC_ROUNDS`] model turns; the final turn is
//!   forced to `finish`, so the step always terminates with a summary (no runaway).
//! - **Constrained** — the action is emitted under a JSON schema whose `tool_name`
//!   is an ENUM of the actually-available gather tools (caposaldo #6/#11): a weak
//!   model cannot invent a tool or cram args into the name.
//! - **Code-owned done** — the loop returns a [`StepOutcome`]; whether the STEP is
//!   `done` is still the driver's verify gate, not the model's say-so.

use crate::driver::StepOutcome;
use crate::{OrchestratorError, OrchestratorResult, PlanStep};
use local_first_capabilities::CapabilityTool;
use local_first_subagents::{GenerateJsonRequest, JsonRuntime};
use std::collections::BTreeMap;

/// Hard ceiling on model turns inside one agentic step. Enough for a real browse
/// (navigate → read → dismiss a cookie banner → fill several fields → search →
/// read results), while still bounding a looping model.
const MAX_AGENTIC_ROUNDS: usize = 16;
/// Per-turn token ceiling for the action/synthesis emission.
const AGENTIC_MAX_TOKENS: u32 = 768;
/// Full size of the MOST RECENT tool result fed back to the model. A page snapshot
/// carries the element "refs" the model needs to act (fill a field, click a button),
/// and those sit deep in the tree — the old flat 4k digest hid the form, which is why
/// the drive couldn't fill search forms (treni/voli). Mirrors motore #1's snapshot
/// budget (`browser_chat_snapshot_params` max_chars=20k); the loop's prune
/// (`render_history`) keeps only THIS latest one full so context stays bounded.
const LATEST_RESULT_CHARS: usize = 16_000;
/// Older tool results collapse to this stub: their element refs are stale (superseded
/// by the latest snapshot), so only a breadcrumb of what was read is kept. This is the
/// agentic-loop twin of motore #1's `prune_browser_history` (keep last snapshot, stub
/// the rest) — without it, full snapshots every round would explode the context.
const STALE_RESULT_CHARS: usize = 200;
/// Truncation of an upstream dependency output in the opening context.
const UPSTREAM_DIGEST_CHARS: usize = 400;

/// Runs the bounded agentic loop for a `SubagentTask` step and returns its outcome.
/// `completed` carries the verified outputs of upstream steps so the sub-agent
/// starts with the data flowing along the DAG edges.
///
/// `gather_tools` is the tool set the caller decides to offer (it pre-filters —
/// the orchestrator passes Read/Draft tools, the gateway passes the browse tools);
/// `execute` is the injected tool-execution surface: the orchestrator backs it
/// with the `CapabilityFacade`, the gateway with the browser sidecar. One agentic
/// loop, two execution surfaces (caposaldo #5) — the harness owns the control flow
/// regardless of where the tools actually run.
pub fn run_agentic_step<R, E>(
    runtime: &R,
    gather_tools: &[CapabilityTool],
    step: &PlanStep,
    completed: &BTreeMap<String, StepOutcome>,
    mut execute: E,
) -> OrchestratorResult<StepOutcome>
where
    R: JsonRuntime,
    E: FnMut(&CapabilityTool, serde_json::Value) -> OrchestratorResult<serde_json::Value>,
{
    let gather_names: Vec<&str> = gather_tools.iter().map(|tool| tool.name.as_str()).collect();
    // Diagnostic (HOMUN_DEBUG): the agentic loop is opaque from outside (only its
    // final summary shows in the drive trace). Log each round's decision + outcome
    // so an empty/poor browse can be diagnosed (model finishing early, tool errors).
    let dbg = std::env::var("HOMUN_DEBUG").is_ok();
    if dbg {
        eprintln!(
            "[agentic] start step={} tools=[{}]",
            step.step_id,
            gather_names.join(",")
        );
    }

    let goal = step
        .goal
        .as_deref()
        .unwrap_or("(gather what the task needs)");
    let contract = step.contract.as_deref().unwrap_or("(return your findings)");
    let upstream = upstream_context(step, completed);

    let mut history: Vec<HistoryEntry> = Vec::new();
    let mut evidence: Vec<String> = Vec::new();

    for round in 0..MAX_AGENTIC_ROUNDS {
        // The last available round (or no gather tools at all) forces a synthesis,
        // so the step always ends with a summary rather than running out silently.
        let force_finish = round + 1 == MAX_AGENTIC_ROUNDS || gather_names.is_empty();
        // Render once per round with the latest snapshot full, older ones stubbed.
        let history_text = render_history(&history);
        let prompt = build_prompt(
            step, goal, contract, &upstream, gather_tools, &history_text, force_finish,
        );
        let request = GenerateJsonRequest {
            usage: {
                let mut usage = local_first_inference_usage::UsageContext::new(
                    uuid::Uuid::new_v4().to_string(),
                    local_first_inference_usage::InferencePurpose::Planning,
                    "local",
                );
                usage.purpose_detail = Some("plan_repair".to_string());
                usage.task_id = Some(step.step_id.clone());
                usage.round = Some(round as u32);
                usage
            },
            prompt,
            max_tokens: step.max_tokens.unwrap_or(AGENTIC_MAX_TOKENS),
            temperature: 0.0,
            wait_if_busy: true,
            request_timeout_seconds: step.timeout_seconds.map(|seconds| seconds as f64),
            json_schema: Some(action_schema(&gather_names, force_finish)),
            required_keys: vec!["action".to_string()],
            repair: true,
        };
        let response = runtime
            .generate_json(&request)
            .map_err(|error| OrchestratorError::Capability(format!("agentic_step_failed:{error:?}")))?;
        let action = response.json;
        let action_kind = action.get("action").and_then(|value| value.as_str());
        if dbg {
            eprintln!(
                "[agentic] round {round} force_finish={force_finish} action={action_kind:?} tool={:?}",
                action.get("tool_name").and_then(|v| v.as_str())
            );
        }

        // Finish (or a forced final round): synthesize and return. The runtime,
        // not the model, owns whether the STEP is done (the driver's verify gate);
        // here we only end the inner loop with the model's summary.
        if action_kind == Some("finish") || force_finish {
            // The harness owns control flow: do NOT let the sub-agent finish
            // EMPTY-HANDED on a non-forced round (a weak/lazy model otherwise
            // returns an empty summary without ever browsing). Require at least one
            // successful gather first — nudge and continue.
            if !force_finish && evidence.is_empty() {
                history.push(HistoryEntry::Note(format!(
                    "Round {round}: you have not gathered anything yet — you MUST use a \
                     tool (start by navigating to a relevant website or search engine, \
                     then read it) before you can finish. Do not finish empty-handed.\n"
                )));
                continue;
            }
            let summary = action
                .get("summary")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            // Return the GATHERED history alongside the model's summary. On a forced
            // round the model sometimes asks for another tool instead of writing a
            // summary (empty summary) — but the history holds what it actually read,
            // so the driver's final synthesis (a capable model) can still answer from
            // it. Never lose the gathered evidence to an empty summary field. The
            // render keeps the latest page full (the results the synthesis needs).
            let gathered: String = render_history(&history).chars().take(20_000).collect();
            return Ok(StepOutcome {
                succeeded: true,
                output: serde_json::json!({ "summary": summary, "gathered": gathered }),
                evidence,
            });
        }

        if action_kind == Some("use_tool") {
            let tool_name = action.get("tool_name").and_then(|value| value.as_str());
            match gather_tools
                .iter()
                .find(|tool| tool_name == Some(tool.name.as_str()))
            {
                Some(tool) => {
                    // Two-phase per round: the tool was chosen under the enum
                    // (above); now fill its arguments CONSTRAINED to that tool's
                    // own input schema (shared with the capability path). The
                    // model cannot emit args that violate the schema — the failure
                    // mode observed on gemma4 ("invalid arguments") when args were
                    // free-form in the action.
                    // Pass the loop history (with the latest snapshot's element refs)
                    // so arg-fill can choose the right ref for a browser_act.
                    match crate::step_executor::fill_arguments(
                        runtime, step, tool, completed, &history_text,
                    ) {
                        Ok(arguments) => {
                            if dbg {
                                eprintln!(
                                    "[agentic]   exec {} args={}",
                                    tool.name,
                                    digest(&arguments, 200)
                                );
                            }
                            match execute(tool, arguments) {
                                Ok(output) => {
                                    if dbg {
                                        eprintln!(
                                            "[agentic]   ok {} -> {}",
                                            tool.name,
                                            digest(&output, 160)
                                        );
                                    }
                                    evidence.push(format!("gather:{}", tool.name));
                                    // Keep the FULL result; the renderer prunes older
                                    // ones so only this latest snapshot stays full.
                                    history.push(HistoryEntry::ToolResult {
                                        round,
                                        tool: tool.name.clone(),
                                        output,
                                    });
                                }
                                // A tool error is fed back so the model can adapt;
                                // it does not kill the step (rounds remain).
                                Err(error) => {
                                    if dbg {
                                        eprintln!("[agentic]   ERR {} failed: {error}", tool.name);
                                    }
                                    history.push(HistoryEntry::Note(format!(
                                        "Round {round}: {} failed: {error}\n",
                                        tool.name
                                    )));
                                }
                            }
                        }
                        Err(error) => {
                            if dbg {
                                eprintln!("[agentic]   argfill ERR {}: {error}", tool.name);
                            }
                            history.push(HistoryEntry::Note(format!(
                                "Round {round}: could not prepare {} arguments: {error}\n",
                                tool.name
                            )));
                        }
                    }
                }
                None => history.push(HistoryEntry::Note(format!(
                    "Round {round}: requested tool {tool_name:?} is not available; \
                     choose one of the listed tools or finish.\n"
                ))),
            }
        } else {
            // Unrecognized action on a non-forced round: nudge and continue.
            history.push(HistoryEntry::Note(format!(
                "Round {round}: no valid action; use a listed tool or finish.\n"
            )));
        }
    }

    // Unreachable in practice (the last round forces finish), but stay honest if it
    // ever is: the work did not conclude → not done.
    Err(OrchestratorError::Planner(format!(
        "agentic_step_budget_exhausted:{}",
        step.step_id
    )))
}

/// JSON schema for the per-round action. `tool_name` is an enum of the available
/// gather tools (caposaldo #6); a forced round offers only `finish`.
fn action_schema(gather_names: &[&str], force_finish: bool) -> serde_json::Value {
    if force_finish {
        return serde_json::json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["finish"] },
                "summary": { "type": "string" }
            },
            "required": ["action", "summary"]
        });
    }
    // Empty enum would be unsatisfiable; an empty gather set forces finish upstream,
    // so here gather_names is non-empty. No `arguments` here on purpose: when the
    // model picks `use_tool`, its arguments are filled in a SECOND, separate call
    // constrained to that tool's own schema (see the loop) — free-form args in this
    // action were the gemma4 "invalid arguments" failure mode.
    serde_json::json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["use_tool", "finish"] },
            "tool_name": { "type": "string", "enum": gather_names },
            "summary": { "type": "string" }
        },
        "required": ["action"]
    })
}

fn build_prompt(
    step: &PlanStep,
    goal: &str,
    contract: &str,
    upstream: &str,
    gather_tools: &[CapabilityTool],
    history: &str,
    force_finish: bool,
) -> String {
    let agent = step
        .agent_id
        .as_ref()
        .map(|id| format!("{id:?}"))
        .unwrap_or_else(|| "Tool".to_string());
    let mut tools = String::new();
    for tool in gather_tools {
        tools.push_str(&format!("- {}: {}\n", tool.name, tool.description));
    }
    let closing = if force_finish {
        "This is your final step. Finish now: return a summary that satisfies the contract."
    } else if history.is_empty() {
        "Start by USING A TOOL: navigate to a relevant website or a search engine to find what \
         the goal needs (do not finish yet — you have gathered nothing)."
    } else {
        "Choose the next action: use a tool to gather more, or — once you have enough — finish \
         with a summary that satisfies the contract."
    };
    // CRITICAL: describe the OUTPUT FORMAT explicitly (like the planner prompt).
    // Without it the model returns free-form JSON with no "action" field — the
    // json_schema is not strictly enforced on every endpoint (ADR 0016), so the
    // prompt must carry the contract. This is what makes the sub-agent actually act.
    format!(
        "You are a {agent} sub-agent. Achieve the goal by browsing the web, ONE tool call at a time.\n\
         Goal: {goal}\n\
         Contract (what to return when you finish): {contract}\n\
         {upstream}\
         Available tools — use EXACTLY one of these names:\n{tools}\
         \n\
         How to browse: browser_navigate(url) opens a page; browser_snapshot reads it and returns \
         elements each with a \"ref\" id; browser_act interacts with a ref (click a button/link, or \
         type text into a field) — pass the ref and what to do. browser_act ALREADY returns the \
         updated snapshot, so do NOT call browser_snapshot right after acting. For quick facts like \
         schedules, prices or results, a SEARCH ENGINE (navigate to \
         https://www.google.com/search?q=...) is usually faster and more reliable than filling a \
         booking site's form. Typical flow: navigate → snapshot → act on the right refs → read the \
         returned snapshot → finish. Never take screenshots (you cannot see images).\n\
         History so far:\n{history}\n\
         \n\
         Reply with ONLY ONE JSON object (no prose, no markdown, no code fence):\n\
         - to use a tool:  {{\"action\":\"use_tool\",\"tool_name\":\"<one tool name from the list above>\"}}\n\
         - to finish:      {{\"action\":\"finish\",\"summary\":\"<your findings that satisfy the contract>\"}}\n\
         {closing}"
    )
}

/// Opening context built from this step's verified dependencies' outputs.
fn upstream_context(step: &PlanStep, completed: &BTreeMap<String, StepOutcome>) -> String {
    let mut context = String::new();
    for dependency in &step.depends_on {
        if let Some(outcome) = completed.get(dependency) {
            context.push_str(&format!(
                "Upstream {dependency}: {}\n",
                digest(&outcome.output, UPSTREAM_DIGEST_CHARS)
            ));
        }
    }
    context
}

fn digest(value: &serde_json::Value, limit: usize) -> String {
    value.to_string().chars().take(limit).collect()
}

/// One entry in the agentic loop's working memory. The split exists so the renderer
/// can PRUNE: browser tool results carry a large page snapshot, but only the LATEST
/// one is actionable (older refs are stale) — so it alone is rendered full, mirroring
/// motore #1's `prune_browser_history`. Notes (errors, nudges) are always small.
enum HistoryEntry {
    ToolResult {
        round: usize,
        tool: String,
        output: serde_json::Value,
    },
    Note(String),
}

/// Renders the loop history for the prompt / arg-fill, keeping ONLY the most recent
/// tool result at full size (`LATEST_RESULT_CHARS`) and stubbing older ones
/// (`STALE_RESULT_CHARS`). This is what lets the model see the current page's form
/// fields without the context growing unbounded over 16 rounds.
fn render_history(entries: &[HistoryEntry]) -> String {
    let last_result = entries
        .iter()
        .rposition(|entry| matches!(entry, HistoryEntry::ToolResult { .. }));
    let mut out = String::new();
    for (index, entry) in entries.iter().enumerate() {
        match entry {
            HistoryEntry::ToolResult {
                round,
                tool,
                output,
            } => {
                if Some(index) == last_result {
                    out.push_str(&format!(
                        "Round {round}: used {tool} -> {}\n",
                        digest(output, LATEST_RESULT_CHARS)
                    ));
                } else {
                    out.push_str(&format!(
                        "Round {round}: used {tool} -> {} …(older snapshot pruned)\n",
                        digest(output, STALE_RESULT_CHARS)
                    ));
                }
            }
            HistoryEntry::Note(text) => out.push_str(text),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PlanStepKind;
    use crate::StepExecutionPolicy;
    use local_first_capabilities::{ActionClass, CapabilityProviderKind, ProviderId};
    use local_first_subagents::{
        AgentId, AllowedAction, GenerateJsonResponse, RuntimeClientError, TokenMetrics,
    };
    use std::sync::{Arc, Mutex};

    /// Runtime that replays a fixed sequence of action JSONs and records prompts.
    #[derive(Clone)]
    struct ScriptRuntime {
        actions: Arc<Mutex<Vec<serde_json::Value>>>,
        schemas: Arc<Mutex<Vec<Option<serde_json::Value>>>>,
    }
    impl ScriptRuntime {
        fn new(actions: Vec<serde_json::Value>) -> Self {
            Self {
                actions: Arc::new(Mutex::new(actions)),
                schemas: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }
    impl JsonRuntime for ScriptRuntime {
        fn generate_json(
            &self,
            request: &GenerateJsonRequest,
        ) -> Result<GenerateJsonResponse, RuntimeClientError> {
            self.schemas.lock().unwrap().push(request.json_schema.clone());
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

    fn tool(name: &str, action: ActionClass) -> CapabilityTool {
        CapabilityTool {
            name: name.to_string(),
            provider_id: ProviderId::new("research"),
            provider_kind: CapabilityProviderKind::Native,
            action,
            description: "research tool".to_string(),
            privacy_domains: vec!["work".to_string()],
            sensitivity: "private".to_string(),
            input_schema: serde_json::json!({"type":"object","additionalProperties":true}),
        }
    }

    /// Canned tool executor: every tool returns `{"hits":[name]}`. Replaces the
    /// facade in tests — the loop no longer talks to a facade, it calls an injected
    /// closure (the real surfaces are the facade and the browser sidecar).
    fn canned(
        tool: &CapabilityTool,
        _arguments: serde_json::Value,
    ) -> OrchestratorResult<serde_json::Value> {
        Ok(serde_json::json!({ "hits": [tool.name] }))
    }

    fn subagent_step() -> PlanStep {
        PlanStep {
            step_id: "gather".to_string(),
            kind: PlanStepKind::SubagentTask,
            depends_on: vec![],
            provider_id: None,
            tool_name: None,
            arguments: serde_json::Value::Null,
            execution_policy: StepExecutionPolicy::DurableTask,
            risk_level: "low".to_string(),
            expected_duration_seconds: 10,
            agent_id: Some(AgentId::Tool),
            goal: Some("find train times".to_string()),
            contract: Some("list of times".to_string()),
            allowed_actions: vec![AllowedAction::Read],
            requires_user_approval: None,
            timeout_seconds: None,
            max_tokens: None,
        }
    }

    #[test]
    fn agentic_step_uses_a_tool_then_finishes() {
        // Two-phase per gather round: (1) choose the tool under the enum, (2) fill
        // its args constrained to the tool schema, then (3) finish.
        let runtime = ScriptRuntime::new(vec![
            serde_json::json!({"action": "use_tool", "tool_name": "web_search"}),
            serde_json::json!({"q": "trains"}), // arg-fill for web_search
            serde_json::json!({"action": "finish", "summary": "Trains at 8:00 and 9:00"}),
        ]);
        let gather = vec![tool("web_search", ActionClass::Read)];

        let outcome = run_agentic_step(
            &runtime,
            &gather,
            &subagent_step(),
            &BTreeMap::new(),
            canned,
        )
        .unwrap();

        assert!(outcome.succeeded);
        assert_eq!(outcome.output["summary"], "Trains at 8:00 and 9:00");
        // Evidence records the gather call (provenance of the summary).
        assert_eq!(outcome.evidence, vec!["gather:web_search".to_string()]);
    }

    #[test]
    fn agentic_step_constrains_tool_name_to_an_enum_of_gather_tools() {
        // Gather once (the harness now forbids finishing empty-handed), then finish.
        let runtime = ScriptRuntime::new(vec![
            serde_json::json!({"action": "use_tool", "tool_name": "web_search"}),
            serde_json::json!({"q": "x"}), // arg-fill
            serde_json::json!({"action": "finish", "summary": "done"}),
        ]);
        let gather = vec![
            tool("web_search", ActionClass::Read),
            tool("read_page", ActionClass::Read),
        ];

        let _ = run_agentic_step(
            &runtime,
            &gather,
            &subagent_step(),
            &BTreeMap::new(),
            canned,
        )
        .unwrap();

        // The first action schema constrained tool_name to exactly the gather tools.
        let schema = runtime.schemas.lock().unwrap()[0].clone().unwrap();
        let names = schema["properties"]["tool_name"]["enum"].as_array().unwrap();
        let mut got: Vec<&str> = names.iter().map(|n| n.as_str().unwrap()).collect();
        got.sort();
        assert_eq!(got, vec!["read_page", "web_search"]);
    }

    /// Runtime that always wants to keep using a tool: it replies based on the
    /// schema it is handed — `use_tool` when offered, `{}` for an arg-fill, and
    /// (only when the schema permits exclusively `finish`) a forced synthesis. Used
    /// to prove the harness — not the model — terminates the loop.
    #[derive(Clone)]
    struct GreedyRuntime {
        schemas: Arc<Mutex<Vec<Option<serde_json::Value>>>>,
    }
    impl JsonRuntime for GreedyRuntime {
        fn generate_json(
            &self,
            request: &GenerateJsonRequest,
        ) -> Result<GenerateJsonResponse, RuntimeClientError> {
            self.schemas.lock().unwrap().push(request.json_schema.clone());
            let schema = request.json_schema.clone().unwrap_or_default();
            let action = &schema["properties"]["action"];
            let json = if action.is_null() {
                // Arg-fill call (schema is the tool's own input schema).
                serde_json::json!({"query": "trains"})
            } else {
                let variants = action["enum"].as_array().cloned().unwrap_or_default();
                if variants.contains(&serde_json::json!("use_tool")) {
                    serde_json::json!({"action": "use_tool", "tool_name": "web_search"})
                } else {
                    serde_json::json!({"action": "finish", "summary": "forced summary"})
                }
            };
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

    #[test]
    fn agentic_step_forces_finish_on_the_last_round() {
        // The model keeps asking for tools forever; the harness must stop it and
        // force a synthesis on the final round (boundedness).
        let runtime = GreedyRuntime {
            schemas: Arc::new(Mutex::new(Vec::new())),
        };
        let gather = vec![tool("web_search", ActionClass::Read)];

        let outcome = run_agentic_step(
            &runtime,
            &gather,
            &subagent_step(),
            &BTreeMap::new(),
            canned,
        )
        .unwrap();

        assert!(outcome.succeeded);
        assert_eq!(outcome.output["summary"], "forced summary");
        // The final tool-choice schema offered ONLY finish (the forced round).
        let schemas = runtime.schemas.lock().unwrap();
        let last_choice = schemas
            .iter()
            .rev()
            .flatten()
            .find(|schema| !schema["properties"]["action"].is_null())
            .unwrap();
        let action_enum = last_choice["properties"]["action"]["enum"]
            .as_array()
            .unwrap();
        assert_eq!(action_enum, &vec![serde_json::json!("finish")]);
    }

    #[test]
    fn render_history_keeps_latest_snapshot_full_and_stubs_older() {
        // A snapshot bigger than the full budget — the model must see the LATEST one
        // in full to find a form's element ref (the form-fill regression root cause).
        let big = "X".repeat(LATEST_RESULT_CHARS + 5_000);
        let entries = vec![
            HistoryEntry::ToolResult {
                round: 0,
                tool: "browser_navigate".to_string(),
                output: serde_json::json!({ "snapshot": big }),
            },
            HistoryEntry::Note("Round 1: cookie banner dismissed\n".to_string()),
            HistoryEntry::ToolResult {
                round: 2,
                tool: "browser_snapshot".to_string(),
                output: serde_json::json!({ "snapshot": big }),
            },
        ];
        let rendered = render_history(&entries);
        // Notes are always kept verbatim.
        assert!(rendered.contains("cookie banner dismissed"));
        // The OLDER snapshot is stubbed; the LATEST is full.
        assert!(rendered.contains("older snapshot pruned"));
        // Latest carried full (>budget); but NOT both full (would be ~2x budget) —
        // proving the older one was pruned to a stub, keeping context bounded.
        assert!(rendered.len() > LATEST_RESULT_CHARS);
        assert!(rendered.len() < LATEST_RESULT_CHARS + STALE_RESULT_CHARS + 1_000);
    }

    // NOTE: the Read/Draft gather filter is now the CALLER's responsibility
    // (`CapabilityStepExecutor` pre-filters before calling the loop), so the loop
    // simply offers whatever `gather_tools` it is given. That caller filter is
    // covered by the brain integration test
    // `drive_runs_subagent_step_via_agentic_loop_then_dependent`.
}
