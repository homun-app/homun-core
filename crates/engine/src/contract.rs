//! The engine ↔ gateway boundary contract (ADR 0024, increment 2).
//!
//! The engine depends on its collaborators as TRAITS, never on the concrete `AppState`. The
//! gateway builds the concrete impls (reqwest client, `CapabilityFacade`, stores) and injects
//! them. Kept deliberately decoupled — only `serde_json` crosses here, so the engine stays a
//! low-level, mockable crate (no heavy `subagents`/`capabilities`/reqwest deps leak in).
//!
//! Four seams: `ModelClient` (the model call), `CapabilityExecutor` (the single tool chokepoint),
//! `EventSink` (the loop's output — every stream event it produces), and `PlanProgress` (the loop's
//! runtime-plan persistence + step-verification port). `GenerateStreamEvent` now lives in this crate
//! (`engine::events`, inc 5a), so `EventSink` can be defined here (inc 5b) — and `PlanProgress`
//! (inc 5c) — ahead of the loop move (inc 5e) that consumes them: the same contract-first pattern.

use crate::events::GenerateStreamEvent;
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

/// The provider binding a round ran against. Returned so a mid-turn fallback (401/timeout/
/// tool-400 swap) inside the impl propagates back to the loop, which reuses it next round. Without
/// this, a swap would be invisible to subsequent rounds (the loop passes the provider by `&`).
pub struct ProviderBinding {
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
}

/// One round's output: the assembled assistant message, the provider the impl ended on, and the
/// completion's `finish_reason` (a provider-neutral signal — e.g. `length` when a reasoning model
/// burned its budget with no visible answer, which the loop's empty-answer recovery logs/branches on).
pub struct ModelRoundOutput {
    pub message: Value,
    pub provider: ProviderBinding,
    pub finish_reason: Option<String>,
}

/// Typed failure. Preserves parity: only an UPSTREAM status error should surface as the turn's
/// committed final answer (the gateway's `last_model_error`); a transport/stream failure already
/// streamed a generic live notice and must NOT overwrite that fallback. A flat `String` would lose
/// this distinction once the branch moves out of the loop.
#[derive(Debug)]
pub enum ModelCallError {
    Upstream(String),
    Transport(String),
}

/// The single model seam. One `generate` per ReAct round. The future is `+ Send` and `on_delta` is
/// `Send + Sync` because the gateway already drives the loop inside a `tokio::spawn` (a multi-thread
/// runtime) — the round future is held across `.await` in a `Send` task, so both bounds are required
/// today, not deferred to the loop-move increment.
pub trait ModelClient {
    /// Run one model round. Stream raw token text through `on_delta` as it arrives, and return the
    /// assembled assistant message (content + `tool_calls`) plus the provider the impl ended on.
    /// Errors are typed (see `ModelCallError`) after the impl has exhausted its retries/fallbacks.
    fn generate(
        &self,
        call: &ModelCall<'_>,
        on_delta: &(dyn Fn(&str) + Send + Sync),
    ) -> impl Future<Output = Result<ModelRoundOutput, ModelCallError>> + Send;
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

/// The engine's output seam: every stream event the loop produces (delta, activity, plan, tool
/// result, done, error, …) goes through here. The gateway's impl fans it onto the transport (the
/// NDJSON turn body + the unified WS). `Send` because the loop runs inside a `tokio::spawn` (same
/// reason as `ModelClient`). Defined ahead of the loop move (inc 5e) that will consume it.
pub trait EventSink {
    fn emit(&self, event: GenerateStreamEvent) -> impl Future<Output = ()> + Send;
}

/// The loop's runtime-plan progress port (ADR 0024, increment 5c). The harness — not the model —
/// owns plan control-flow; the durable plan lives in the memory store and the step judge is an LLM
/// call. Both are `AppState`-shaped, so the engine reaches them through this narrow seam.
///
/// STANDALONE, deliberately not folded into `MemoryRecallService`: the runtime plan is harness
/// control-flow *state* that merely uses the memory store as its durable backend (not recalled
/// knowledge), and `verify_step_complete` is inference, not a memory op — one trait per concern keeps
/// both contracts coherent (SRP) and lets ADR 0025 (browse-as-recursion) retire this whole mechanism
/// in a single delete. `Send` for the same reason as the seams above (the loop runs in `tokio::spawn`).
/// Defined ahead of the loop move (inc 5e) that will consume it — the same contract-first pattern.
pub trait PlanProgress {
    /// Persist the thread's runtime plan durably (cross-turn continuity). The delivery reconcile and
    /// each mid-turn frontier advance call this; `None` thread = no persistence scope (a no-op impl).
    fn persist_plan(
        &self,
        thread: Option<&str>,
        steps: &[Value],
    ) -> impl Future<Output = ()> + Send;

    /// Record a VERIFIED frontier-step outcome as episodic evidence in the memory layer.
    fn record_step_outcome(
        &self,
        thread: Option<&str>,
        step: &Value,
        evidence: &[String],
    ) -> impl Future<Output = ()> + Send;

    /// Strict LLM judge: is this frontier step genuinely complete given the evidence?
    /// Returns `(done, reason)` — the loop advances the frontier only on `true`.
    fn verify_step_complete(
        &self,
        title: &str,
        criterion: &str,
        evidence: &str,
    ) -> impl Future<Output = (bool, String)> + Send;
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
            on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            on_delta("hi");
            Ok(ModelRoundOutput {
                message: serde_json::json!({ "role": "assistant", "content": call.model }),
                provider: ProviderBinding {
                    model: call.model.to_string(),
                    base_url: call.base_url.to_string(),
                    api_key: call.api_key.map(str::to_string),
                },
                finish_reason: None,
            })
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
        use std::sync::Mutex; // the on_delta sink must be Send + Sync (see the trait bound)
        let m = EchoModel;
        let streamed = Mutex::new(String::new());
        let out = m
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
                &|d| streamed.lock().unwrap().push_str(d),
            )
            .await
            .unwrap();
        assert_eq!(out.message["content"], "test-model");
        assert_eq!(out.provider.model, "test-model");
        assert_eq!(out.provider.base_url, "http://x");
        assert_eq!(*streamed.lock().unwrap(), "hi", "on_delta streamed the live token");

        let tools = FixedTools;
        assert_eq!(
            tools.execute_tool("browse", &Value::Null, "c1").await.unwrap(),
            "ran browse"
        );
    }

    // An in-memory sink proves the EventSink seam is usable + mockable (drive the future loop's
    // output with no transport). The gateway's `StreamSink` is the real impl.
    #[derive(Default)]
    struct CollectingSink(std::sync::Mutex<Vec<GenerateStreamEvent>>);
    impl EventSink for CollectingSink {
        async fn emit(&self, event: GenerateStreamEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn event_sink_is_usable_with_a_mock() {
        let sink = CollectingSink::default();
        sink.emit(GenerateStreamEvent::Delta { text: "hi".into() }).await;
        sink.emit(GenerateStreamEvent::Error {
            code: "e".into(),
            message: "boom".into(),
        })
        .await;
        let got = sink.0.lock().unwrap();
        assert_eq!(got.len(), 2);
        assert!(matches!(got[0], GenerateStreamEvent::Delta { .. }));
    }

    // An in-memory plan-progress port proves the seam is usable + mockable: the future loop can be
    // driven with a scripted judge (no LLM) and an inspectable persistence log (no memory store).
    #[derive(Default)]
    struct RecordingPlan {
        persisted: std::sync::Mutex<Vec<usize>>, // step-count of each persist_plan call
        outcomes: std::sync::Mutex<usize>,       // how many step outcomes were recorded
        judge: bool,                             // scripted verify verdict
    }
    impl PlanProgress for RecordingPlan {
        async fn persist_plan(&self, _thread: Option<&str>, steps: &[Value]) {
            self.persisted.lock().unwrap().push(steps.len());
        }
        async fn record_step_outcome(&self, _thread: Option<&str>, _step: &Value, _evidence: &[String]) {
            *self.outcomes.lock().unwrap() += 1;
        }
        async fn verify_step_complete(
            &self,
            _title: &str,
            _criterion: &str,
            _evidence: &str,
        ) -> (bool, String) {
            (self.judge, String::new())
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn plan_progress_is_usable_with_a_mock() {
        let plan = RecordingPlan { judge: true, ..Default::default() };
        plan.persist_plan(Some("t1"), &[Value::Null, Value::Null]).await;
        let (done, _why) = plan.verify_step_complete("step", "crit", "did the thing").await;
        assert!(done, "scripted judge said complete");
        plan.record_step_outcome(Some("t1"), &Value::Null, &["evidence".into()]).await;
        assert_eq!(*plan.persisted.lock().unwrap(), vec![2], "persisted a 2-step plan");
        assert_eq!(*plan.outcomes.lock().unwrap(), 1, "recorded one verified outcome");
    }
}
