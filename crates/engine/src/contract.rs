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
    /// S2 T5: force `tool_choice` to this specific tool name for THIS round (belt-and-suspenders
    /// on top of the route's hard-prune, `TurnConfig::forced_tool`). `None` = "auto" — today's
    /// behavior, kept during intake and whenever no deterministic routing binding is active.
    pub forced_tool: Option<&'a str>,
}

/// The provider binding a round ran against. Returned so a mid-turn fallback (401/timeout/
/// tool-400 swap) inside the impl propagates back to the loop, which reuses it next round. Without
/// this, a swap would be invisible to subsequent rounds (the loop passes the provider by `&`).
#[derive(Debug, Default, Clone)]
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
    /// An upstream rejection the caller can RECOVER from: the provider refused the request because it
    /// cannot look at the image parts it carries. Unlike `Upstream`, this must NOT be streamed or
    /// committed — the gateway re-seeds the turn with a vision model's description of the images and
    /// runs it again, and the user should never learn that the first attempt happened. Carries the
    /// provider's message anyway, for the case where no recovery is possible and it must be shown.
    ImageUnsupported(String),
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

/// A tool the loop should mark loaded mid-turn (dynamic capability loading: `find_capability` /
/// `use_skill`). `key` dedups against what's already loaded; `schema` is `None` when the key is only
/// being marked loaded (a connector entry with no schema) — the loop adds a schema only when `Some`.
pub struct LoadedTool {
    pub key: String,
    pub schema: Option<Value>,
}

/// The loop-state changes a tool execution requests. Returned (not applied by the executor) so the
/// executor stays decoupled from the loop's `&mut` state — the ENGINE applies these to its own loop
/// state after the call. This is the ctx→effects redesign (ADR 0024 inc 5d): today `execute_chat_tool`
/// mutates `ctx.<field>` inline; every such mutation becomes a field here. Default = empty (the common
/// case — most tools change nothing but produce a `result`). Each field maps 1:1 to a current mutation:
/// `append_output`→`ctx.accumulated`, `plan`→`*ctx.plan`, `load_tools`→`ctx.loaded_tools`/`tool_schemas`,
/// `trace`→`ctx.tool_trace` (capped), `clear_evidence`→`ctx.step_evidence.clear()`,
/// `request_confirm`→`*ctx.pending_confirm`, `request_compaction`→`*ctx.pending_compaction`,
/// `reset_stall_guards`→ real-progress reset (`progress_anchor_round=round`, `repeat_count=0`,
/// `last_round_sig.clear()`), which today fire together in the `update_plan`/`step_advance` arm.
#[derive(Default)]
pub struct ToolEffects {
    /// Text to append to the assistant's accumulated output, in order (artifact/plan markers, cards).
    pub append_output: Vec<String>,
    /// The tool replaced the runtime plan (canonical, verified state).
    pub plan: Option<Value>,
    /// Tool schemas to begin offering this turn (deduped by `LoadedTool::key`).
    pub load_tools: Vec<LoadedTool>,
    /// Trace lines to record (the loop caps the trace length).
    pub trace: Vec<String>,
    /// A verified plan advance consumed the evidence window → clear it once.
    pub clear_evidence: bool,
    /// The tool needs the user's write-confirm before its effect lands (approval gate).
    pub request_confirm: bool,
    /// The tool asks the loop to compact context before continuing (F3).
    pub request_compaction: bool,
    /// Sensitive domains a `use_skill` load declares (ADR 0023 Step 5): kebab-case tokens the
    /// loop dedups into `LoopState::active_sensitive`, arming the turn's force-confirm. `String`
    /// (not the gateway's `SensitiveCategory`) so the leaf engine stays gateway-type-free.
    pub arm_sensitive: Vec<String>,
    /// Real progress happened → reset the stall guards (F1): anchor the round, zero the repeat
    /// counter, clear the last-round signature.
    pub reset_stall_guards: bool,
    /// S2 T4 (plugin-owned deterministic routing): a `make_deck`/`make_document` call just
    /// delivered its artifact successfully → the thread's `RoutingBinding` (gateway-typed,
    /// stored in `ChatStore`) should be cleared so later turns route freely again. A bare
    /// `bool` (not the binding itself, which is gateway-typed and can't live in the
    /// engine-safe `LoopState`) — the gateway's `CapabilityExecutor` impl reads this flag
    /// off the returned `ToolEffects` and does the actual store clear itself, same pattern
    /// as `request_confirm`/`reset_stall_guards` signaling an action the loop-state alone
    /// can't perform.
    pub clear_routing_binding: bool,
}

/// One tool execution's output: the result text (pushed into the conversation as the tool message)
/// plus the loop-state effects the engine applies. Replaces the bare `String` so the executor can
/// stop mutating the loop's `ctx` (the ctx→effects redesign, inc 5d).
pub struct ToolOutcome {
    pub result: String,
    pub effects: ToolEffects,
}

/// The SINGLE tool-execution chokepoint (ADR 0024). The engine executes EVERY tool through this;
/// the gateway's impl routes to today's `execute_chat_tool` (minus the browser branch, which is a
/// separate seam headed for ADR 0025). `name` + JSON `args` in, `ToolOutcome` out — result text plus
/// the loop-state effects the engine applies. `&self` (no `&mut` loop state) is the whole point: the
/// effects channel is what lets the executor be a decoupled service rather than a `ctx` mutator.
pub trait CapabilityExecutor {
    /// Execute one tool. `state: &mut LoopState` is passed PER CALL (ADR 0026) — the executor does
    /// NOT capture turn state (it would double-borrow `&mut ls` with the loop); it holds only the
    /// turn-constant read-only context and builds its per-call tool ctx from `state` + that context.
    fn execute_tool(
        &self,
        name: &str,
        args_raw: &str,
        call_id: &str,
        state: &mut crate::loop_state::LoopState,
    ) -> impl Future<Output = Result<ToolOutcome, String>> + Send;
}

/// The BROWSER tool seam (ADR 0024 inc 5, 5.D1b slice 5b) — the temporary seam ADR 0025 replaces with
/// a recursive `browse(goal)` sub-agent. SEPARATE from `CapabilityExecutor` for two reasons. First, a
/// DISJOINT read-set: the browser branch reads the browser cluster + a few turn-constants and nothing
/// `execute_chat_tool` touches. Second, and decisively, it carries its OWN mutable subsystem state
/// across the turn — the live sidecar session (a gateway-typed handle that can NEVER enter the
/// engine-safe `LoopState`) plus the browser-private bookkeeping (last snapshot, current tab / opened
/// targets, per-URL nav failures). Hence `&mut self` (unlike the stateless `&self` capability
/// chokepoint): the impl OWNS that state and mutates it per call. Because the loop keeps the executor
/// in a local separate from `&mut ls`, `&mut self` + `&mut state` never double-borrow. The
/// loop-VISIBLE browser fields (`browser_used` / `pending_browser_image` / `browser_tool_call_ids`)
/// travel in `state: &mut LoopState`, passed per call exactly like `CapabilityExecutor`.
pub trait BrowserExecutor {
    /// Execute one granular browser tool (navigate / snapshot / act / screenshot / tabs / dialog)
    /// against the turn's live session. Returns the raw tool-result text: the browser branch produces
    /// no `ToolEffects` today (it mutates its own state directly), so a bare `String`, not `ToolOutcome`.
    fn execute_browser(
        &mut self,
        name: &str,
        args_raw: &str,
        call_id: &str,
        state: &mut crate::loop_state::LoopState,
    ) -> impl Future<Output = String> + Send;

    /// Turn-end teardown (ALL exit paths converge here): park the session warm for the thread's next
    /// turn, or stop it for an anonymous chat so the sidecar doesn't leak; hide the live activity
    /// indicator. `browser_used` (from `LoopState`) reports whether a session was ever meant to exist,
    /// so a mid-turn session loss still clears the indicator. Idempotent — safe when none was opened.
    fn close_session(&mut self, browser_used: bool) -> impl Future<Output = ()> + Send;
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

    /// Reconcile the runtime plan at DELIVERY (ADR 0024 inc 5, 5.D1c.4): once a SUBSTANTIAL final
    /// answer is delivered, force every still-open step to `done` (preserving `blocked`) and return
    /// the reconciled steps — or `None` when reconciliation is disabled or nothing changed. The loop
    /// then persists the returned steps (via [`persist_plan`]) so the next turn won't falsely resume a
    /// plan this answer already finished. SYNC + pure (unlike the other methods it touches no store):
    /// it lives on this seam ONLY because the reconcile logic needs the gateway's typed `ExecutionPlan`
    /// while the leaf engine holds the plan as an opaque `Value`.
    fn reconcile_on_delivery(&self, plan: &Value, delivered: &str) -> Option<Vec<Value>>;

    /// Rebuild the plan `Value` from a fresh step list (ADR 0024 inc 5, 5.D1c.5): the other half of the
    /// Value↔ExecutionPlan bridge. When the mid-turn frontier advance produces new steps, the loop
    /// stores the canonical serialized plan via this method (gateway: `to_value(runtime_execution_plan
    /// (steps))`). SYNC + pure, on this seam for the same reason as `reconcile_on_delivery` — the leaf
    /// engine can't build the typed `ExecutionPlan`.
    fn plan_value_from_steps(&self, steps: &[Value]) -> Value;
}

/// The loop's F3 context-compaction port (ADR 0024 inc 5, 5.D1c.6). When a plan step completes, the
/// loop collapses the messages that step produced into a single summary note so a long multi-step turn
/// stays within the context window. That summary is a `memory`-role LLM call the gateway owns (payload
/// shaping + collectors), so the engine reaches it through this narrow seam. BEST-EFFORT: the impl
/// leaves `messages` untouched on any summarizer failure (less compaction, never data loss). `Send`
/// because the loop runs inside `tokio::spawn`. Retired with the rest of the mid-turn machinery by ADR 0025.
pub trait ContextCompactor {
    /// Collapse `messages[*start..]` (a completed step's COMPLETE tool-call/result groups — safe only
    /// at a round boundary) into one assistant summary message and advance `*start`. No-op when the
    /// slice is empty or too small to be worth compacting.
    fn compact(
        &self,
        messages: &mut Vec<Value>,
        start: &mut usize,
    ) -> impl Future<Output = ()> + Send;

    /// Token-budget auto-compaction (Fase 1.1) — the MEMORY-CHECKPOINT path, distinct from the
    /// per-step `compact` above. Called once per round BEFORE the model send: when `messages`
    /// approach the model's `context_window`, the impl WRITES the older span to the one memory
    /// engine (durable + recallable — nothing lost even if the summary drops something; ADR 0022)
    /// and replaces it in-context with one salience-preserving note. Unlike `compact` it is not
    /// tied to a plan step and takes no `start` cursor — it re-derives the span from the whole
    /// `messages` each round. FAIL-OPEN: unknown window (`None`) → no-op; summarizer failure →
    /// `messages` untouched. Default no-op so the browse sub-turn / test stubs opt out for free;
    /// only the gateway's real compactor overrides it.
    fn compact_for_budget(
        &self,
        _messages: &mut Vec<Value>,
        _context_window: Option<usize>,
    ) -> impl Future<Output = ()> + Send {
        async {}
    }
}

/// Small SYNC gateway-policy probes the loop consults before an action (ADR 0024 inc 5, 5.D1c.7).
/// Two "can I do X right now?" questions whose answers need gateway-only state the leaf engine can't
/// hold: the turn's workflow-route decision (a gateway type) and the provider capability cache. Grouped
/// on one thin seam because both are trivial per-action gates the engine asks the gateway — not worth a
/// trait each. All sync (`&self`, no future): pure lookups, no IO.
pub trait TurnPolicy {
    /// Is this tool BLOCKED by the turn's workflow route? Returns the model-facing block message to
    /// surface (and skip the tool), or `None` when the tool is allowed.
    fn route_blocked(&self, tool: &str) -> Option<String>;

    /// Can the CURRENT provider accept an image part? Gates the browser-screenshot vision injection;
    /// defaults to `true` for undetected/cloud providers (only a confidently non-vision model is skipped).
    fn supports_vision(&self, base_url: &str, model: &str) -> bool;
}

/// The loop's turn-level completion judge (ADR 0024, increment 5, Point 2a). When the model ACTS but
/// stops WITHOUT ever tracking a plan, the loop asks this judge whether the request is actually
/// finished; a `true` (incomplete) verdict triggers the plan-bootstrap nudge. Like the `PlanProgress`
/// judge it is an LLM call (role `memory`) that reaches gateway config, so the engine reaches it
/// through this narrow seam rather than pulling that config into the crate.
///
/// STANDALONE, deliberately NOT a fourth `PlanProgress` method: `PlanProgress` is the lifecycle of a
/// *tracked plan step* (persist/record/verify a step), whereas this is a turn-level "did you finish,
/// with NO plan" judgment (SRP). Both are mid-turn judges that ADR 0025 (browse-as-recursion) retires
/// once the manager judges the answers — separate thin seams delete cleanly, one per concern. `Send`
/// because the loop runs inside `tokio::spawn`. Defined ahead of the loop move that will consume it.
pub trait TurnCompletionJudge {
    /// Strict LLM judge: given the user REQUEST and the agent's final WORK (what it did/said right
    /// before stopping, with no tracked plan), does the request still have clearly-remaining work?
    /// Returns `true` when the turn appears INCOMPLETE. Fails OPEN (returns `false`) on any error, so
    /// a judge outage never fakes a nudge.
    fn task_appears_incomplete(
        &self,
        request: &str,
        work: &str,
    ) -> impl Future<Output = bool> + Send;
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
            _args_raw: &str,
            _call_id: &str,
            _state: &mut crate::loop_state::LoopState,
        ) -> Result<ToolOutcome, String> {
            // A tool that produces a result AND requests one loop effect (append narration) —
            // proves the effects channel round-trips, not just the result text.
            Ok(ToolOutcome {
                result: format!("ran {name}"),
                effects: ToolEffects {
                    append_output: vec![format!("did {name}")],
                    ..Default::default()
                },
            })
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
                    forced_tool: None,
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
        let mut ls = crate::loop_state::LoopState::new();
        let outcome = tools.execute_tool("browse", "{}", "c1", &mut ls).await.unwrap();
        assert_eq!(outcome.result, "ran browse");
        assert_eq!(outcome.effects.append_output, vec!["did browse".to_string()]);
        assert!(!outcome.effects.request_confirm, "default effects are empty");
    }

    // A stub browser proves the BrowserExecutor seam is usable + mockable: `&mut self` lets it carry
    // subsystem state (here a call counter standing in for the sidecar session) while a per-call
    // `&mut LoopState` records the loop-visible effect (browser_used) — the exact split the real impl
    // uses. The gateway's `GatewayBrowserExecutor` is the real impl.
    #[derive(Default)]
    struct StubBrowser {
        calls: u32,   // subsystem state owned by the executor (session stand-in)
        closed: bool, // set by close_session so the test can assert teardown ran
    }
    impl BrowserExecutor for StubBrowser {
        async fn execute_browser(
            &mut self,
            name: &str,
            _args_raw: &str,
            _call_id: &str,
            state: &mut crate::loop_state::LoopState,
        ) -> String {
            self.calls += 1;
            state.browser_used = true; // the loop-visible field travels via LoopState
            format!("browsed {name} (#{})", self.calls)
        }
        async fn close_session(&mut self, _browser_used: bool) {
            self.closed = true;
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn browser_executor_is_usable_with_a_mock() {
        let mut browser = StubBrowser::default();
        let mut ls = crate::loop_state::LoopState::new();
        assert!(!ls.browser_used, "browser_used starts false");
        let out = browser.execute_browser("browser_navigate", "{}", "c1", &mut ls).await;
        assert_eq!(out, "browsed browser_navigate (#1)");
        assert!(ls.browser_used, "execute_browser flipped the loop-visible flag via LoopState");
        assert_eq!(browser.calls, 1, "executor mutated its own subsystem state (&mut self)");
        browser.close_session(ls.browser_used).await;
        assert!(browser.closed, "close_session ran the teardown");
    }

    // A stub compactor proves the ContextCompactor seam is usable + mockable: it collapses the
    // step slice to one note (the real impl's shape) so the loop can be driven with no LLM.
    struct StubCompactor;
    impl ContextCompactor for StubCompactor {
        async fn compact(&self, messages: &mut Vec<Value>, start: &mut usize) {
            if *start < messages.len() {
                messages.truncate(*start);
                messages.push(serde_json::json!({ "role": "assistant", "content": "[summary]" }));
                *start = messages.len();
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn context_compactor_is_usable_with_a_mock() {
        let c = StubCompactor;
        let mut msgs = vec![
            serde_json::json!({ "role": "system", "content": "s" }),
            serde_json::json!({ "role": "tool", "content": "big result" }),
        ];
        let mut start = 1usize; // the step's work begins at index 1
        c.compact(&mut msgs, &mut start).await;
        assert_eq!(msgs.len(), 2, "the step slice collapsed to one summary note");
        assert_eq!(msgs[1]["content"], "[summary]");
        assert_eq!(start, 2, "start advanced past the summary");
    }

    // A scripted policy proves the TurnPolicy seam is usable + mockable (drive the gates with no
    // gateway state). The gateway's `GatewayTurnPolicy` is the real impl.
    struct FixedPolicy;
    impl TurnPolicy for FixedPolicy {
        fn route_blocked(&self, tool: &str) -> Option<String> {
            (tool == "forbidden").then(|| "blocked by route".to_string())
        }
        fn supports_vision(&self, _base_url: &str, model: &str) -> bool {
            model != "text-only"
        }
    }

    #[test]
    fn turn_policy_is_usable_with_a_mock() {
        let p = FixedPolicy;
        assert_eq!(p.route_blocked("forbidden").as_deref(), Some("blocked by route"));
        assert_eq!(p.route_blocked("write_file"), None);
        assert!(p.supports_vision("http://x", "vision-model"));
        assert!(!p.supports_vision("http://x", "text-only"));
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
        fn reconcile_on_delivery(&self, _plan: &Value, _delivered: &str) -> Option<Vec<Value>> {
            // Scripted: report one reconciled step so the seam's sync bridge is exercised.
            Some(vec![Value::Null])
        }
        fn plan_value_from_steps(&self, steps: &[Value]) -> Value {
            // Scripted: echo the steps under a `steps` key (a stand-in for the ExecutionPlan value).
            serde_json::json!({ "steps": steps })
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
        assert_eq!(
            plan.reconcile_on_delivery(&Value::Null, "a substantial delivered answer"),
            Some(vec![Value::Null]),
            "the sync reconcile bridge returns the reconciled steps"
        );
    }

    // A scripted completion judge proves the seam is usable + mockable: the future loop can be driven
    // with a canned verdict (no LLM) and the call recorded for inspection.
    #[derive(Default)]
    struct ScriptedJudge {
        verdict: bool,                          // canned "incomplete?" answer
        seen: std::sync::Mutex<Option<String>>, // last (request, work) joined, for inspection
    }
    impl TurnCompletionJudge for ScriptedJudge {
        async fn task_appears_incomplete(&self, request: &str, work: &str) -> bool {
            *self.seen.lock().unwrap() = Some(format!("{request}|{work}"));
            self.verdict
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn turn_completion_judge_is_usable_with_a_mock() {
        let judge = ScriptedJudge { verdict: true, ..Default::default() };
        let incomplete = judge.task_appears_incomplete("do A and B", "did only A").await;
        assert!(incomplete, "scripted judge said the turn is incomplete");
        assert_eq!(
            judge.seen.lock().unwrap().as_deref(),
            Some("do A and B|did only A"),
            "judge saw the request and work"
        );
    }
}
