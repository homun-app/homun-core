//! The engine ↔ gateway boundary contract (ADR 0024, increment 2).
//!
//! The engine depends on its collaborators as TRAITS, never on the concrete `AppState`. The
//! gateway builds the concrete impls (reqwest client, `CapabilityFacade`, stores) and injects
//! them. Kept deliberately decoupled — only `serde_json` crosses here, so the engine stays a
//! low-level, mockable crate (no heavy `subagents`/`capabilities`/reqwest deps leak in).
//!
//! Two seams are defined now (the two ADR 0024 names). The engine's OWN output-event contract
//! (the `GenerateStreamEvent` sink) is resolved when the loop body itself moves (increment 5),
//! since that decides where `GenerateStreamEvent` should live (today it sits in the heavy
//! `subagents` crate — the wrong direction for the engine to depend on).

use serde_json::Value;
use std::future::Future;

/// The model call. Config + conversation + tool schemas in; the assembled assistant message
/// (`{ content, tool_calls }`) out. The gateway's impl owns everything transport-shaped that the
/// engine must NOT: HTTP, per-chunk retry/backoff, provider fallback (the mid-turn model/url/key
/// swap), and the OpenAI-vs-Ollama stream collectors. Raw output tokens are streamed live via
/// `on_delta` as they arrive; the engine sees only the final assembled message.
pub struct ModelCall<'a> {
    pub base_url: &'a str,
    pub model: &'a str,
    pub api_key: Option<&'a str>,
    /// The conversation so far (OpenAI message objects).
    pub messages: &'a [Value],
    /// The tool schemas offered this round.
    pub tools: &'a [Value],
    pub temperature: f64,
    /// Final round → no tools offered / synthesis budget (the gateway shapes the payload).
    pub is_final_round: bool,
}

/// The single model seam. One `generate` per ReAct round. NOTE: `Send`/`Sync` bounds are added
/// when the loop body moves into a `tokio::spawn` (increment 5) — the skeleton fixes the SHAPE.
pub trait ModelClient {
    /// Run one model round. Stream raw token text through `on_delta` as it arrives, and return the
    /// assembled assistant message value (content + `tool_calls`). Errors are the human-readable
    /// reason after the impl has exhausted its own retries/fallbacks.
    fn generate(
        &self,
        call: &ModelCall<'_>,
        on_delta: &dyn Fn(&str),
    ) -> impl Future<Output = Result<Value, String>>;
}

/// The SINGLE tool-execution chokepoint (ADR 0024). The engine executes EVERY tool through this;
/// the gateway's impl routes to `CapabilityFacade::call_tool`, where ADR 0023's sandbox fence and
/// the unified approval policy live. `name` + JSON `args` in, the tool's result text out — the
/// exact shape today's `execute_chat_tool` already produces, so the migration is a re-route, not
/// a re-design.
pub trait CapabilityExecutor {
    fn execute_tool(
        &self,
        name: &str,
        args: &Value,
        call_id: &str,
    ) -> impl Future<Output = Result<String, String>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    // A trivial in-memory impl proves the seams are usable + object-mockable for the engine's
    // future unit tests (drive the loop with a scripted model + fake tools, no network).
    struct EchoModel;
    impl ModelClient for EchoModel {
        async fn generate(
            &self,
            call: &ModelCall<'_>,
            on_delta: &dyn Fn(&str),
        ) -> Result<Value, String> {
            on_delta("hi");
            Ok(serde_json::json!({ "role": "assistant", "content": call.model }))
        }
    }

    struct FixedTools;
    impl CapabilityExecutor for FixedTools {
        async fn execute_tool(
            &self,
            name: &str,
            _args: &Value,
            _call_id: &str,
        ) -> Result<String, String> {
            Ok(format!("ran {name}"))
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn seams_are_usable_with_a_mock() {
        use std::cell::RefCell;
        let m = EchoModel;
        let streamed = RefCell::new(String::new());
        let msg = m
            .generate(
                &ModelCall {
                    base_url: "http://x",
                    model: "test-model",
                    api_key: None,
                    messages: &[],
                    tools: &[],
                    temperature: 0.0,
                    is_final_round: false,
                },
                &|d| streamed.borrow_mut().push_str(d),
            )
            .await
            .unwrap();
        assert_eq!(msg["content"], "test-model");
        assert_eq!(*streamed.borrow(), "hi", "on_delta streamed the live token");

        let tools = FixedTools;
        assert_eq!(
            tools.execute_tool("browse", &Value::Null, "c1").await.unwrap(),
            "ran browse"
        );
    }
}
