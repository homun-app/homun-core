//! `ToolExecutor` seam — the single chokepoint through which the chat loop (and,
//! later, the orchestrator) will run every model-requested tool. It is the home
//! for the sandbox + approval enforcement of ADR 0023, and the first step of ADR
//! 0024 step 2 (converge the tool dispatch that is scattered inline across
//! `stream_chat_via_openai` — see `docs/plans/2026-07-02-tool-chokepoint-convergence.md`).
//!
//! **Phase 0 (this file): boundary TYPES only.** They mirror exactly what the chat
//! loop already handles today (a tool name + JSON args + call id → a textual
//! result, or a refusal, or a pending approval). Nothing is wired into the loop
//! yet: extracting the live dispatch into this seam is Phase 1, and the executor's
//! per-turn context (`impl ToolExecutor` state) is fleshed out there — kept out of
//! Phase 0 on purpose, so the context isn't designed ahead of the extraction that
//! reveals its real shape (YAGNI).
#![allow(dead_code)] // wired into the loop in Phase 1 of the chokepoint plan.

use serde_json::Value;

/// One model-requested tool invocation, as the loop receives it from the model's
/// `tool_calls` (main.rs ~20422): a name, JSON arguments, and the call id used to
/// correlate the result back into the message history.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub name: String,
    pub args: Value,
    pub call_id: String,
}

impl ToolCall {
    pub fn new(name: impl Into<String>, args: Value, call_id: impl Into<String>) -> Self {
        Self { name: name.into(), args, call_id: call_id.into() }
    }
}

/// The outcome of executing a tool. These are the three shapes the loop already
/// produces today, made explicit so the single chokepoint can own them:
/// - `Result` — the textual tool output appended to the model's history;
/// - `Refused` — a guardrail block (e.g. a mutating tool refused in read-only mode);
/// - `NeedsApproval` — a pending confirmation (the MCP/Composio approval cards)
///   that must be surfaced to the user before execution proceeds.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolOutcome {
    Result(String),
    Refused { reason: String },
    NeedsApproval { card: String },
}

impl ToolOutcome {
    /// Convenience: did the tool actually run (vs being refused / gated)?
    pub fn is_executed(&self) -> bool {
        matches!(self, ToolOutcome::Result(_))
    }
}

/// The single execution chokepoint. Implementors hold the per-turn dependencies
/// (browser session, activity sink, memory scope, read-only flag) as their own
/// state — NOT the whole `AppState` — so the chat loop and the orchestrator can
/// share one execution surface. The concrete implementor arrives in Phase 1.
pub trait ToolExecutor {
    fn execute(&mut self, call: ToolCall) -> ToolOutcome;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_call_constructs_and_carries_fields() {
        let call = ToolCall::new("browser_navigate", json!({ "url": "https://x" }), "c1");
        assert_eq!(call.name, "browser_navigate");
        assert_eq!(call.args["url"], "https://x");
        assert_eq!(call.call_id, "c1");
    }

    #[test]
    fn only_result_counts_as_executed() {
        assert!(ToolOutcome::Result("ok".into()).is_executed());
        assert!(!ToolOutcome::Refused { reason: "read-only".into() }.is_executed());
        assert!(!ToolOutcome::NeedsApproval { card: "…".into() }.is_executed());
    }

    #[test]
    fn a_trivial_executor_routes_through_the_seam() {
        // A fake executor proves the trait is object-usable and the outcome flows
        // back — the shape the loop will call in Phase 1.
        struct Echo;
        impl ToolExecutor for Echo {
            fn execute(&mut self, call: ToolCall) -> ToolOutcome {
                ToolOutcome::Result(format!("ran {}", call.name))
            }
        }
        let mut exec = Echo;
        let out = exec.execute(ToolCall::new("use_skill", json!({}), "c2"));
        assert_eq!(out, ToolOutcome::Result("ran use_skill".into()));
    }
}
