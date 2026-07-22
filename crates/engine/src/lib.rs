//! The agentic engine — the single guarded ReAct loop (motore #1, ADR 0021), extracted from the
//! gateway monolith per ADR 0024.
//!
//! The gateway is the postman: HTTP, auth, transport, and the construction of concrete
//! dependencies. This crate owns the loop — perceive → reason/plan → act (tool at the single
//! chokepoint) → observe/verify → iterate or terminate — and stays pure and testable by taking
//! its dependencies as TRAITS (model client, capability executor, memory, stores), never the
//! concrete `AppState`.
//!
//! Extraction followed the ADR 0024 sequence (contract → chokepoint → move the loop → retire the
//! inline parallel) and is COMPLETE (5.D2): the loop body lives here in `agent_loop::run_turn`, the
//! `HOMUN_ENGINE_CRATE` flag and the gateway's inline copy are deleted, and the gateway calls this
//! crate unconditionally.

#![forbid(unsafe_code)]

/// The engine ↔ gateway boundary: the traits the gateway implements and injects
/// (`ModelClient`, `CapabilityExecutor`). See the module docs (ADR 0024, increment 2).
pub mod contract;

/// The pure plan state machine — the engine's control-flow core (ADR 0024, increment 3).
pub mod plan;

/// Structured stream events the engine emits (ADR 0024 inc 5a).
pub mod events;

/// Pure text/answer helpers the loop uses on delivery (ADR 0024 inc 5e.3).
pub mod text;

/// The single marker toolkit (‹‹PLAN››/‹‹REASONING››/… parse, strip, balance, stream-filter).
/// Pure; relocated whole from the gateway (ADR 0024 inc 5e.3) — `model_normalize` depends on it.
pub mod markers;

/// Model-output normalization (ADR 0019): raw model shapes → one canonical valid form.
/// Pure (serde only); relocated whole from the gateway (ADR 0024 inc 5e.3) as loop-move prep.
pub mod model_normalize;

/// The loop's turn-carried state (ADR 0024 inc 5, Point 4) — bundled at its destination
/// ahead of the loop-body move; the gateway constructs it and the inline loop mutates it.
pub mod loop_state;
pub mod loop_checkpoint;
pub mod prompt_packets;

/// The loop's turn-constant config (ADR 0024 inc 5, 5.D1c.1) — resolved gateway-side, injected so the
/// leaf engine never reads env.
pub mod config;

/// Pure browser-support helpers (ADR 0024 inc 5, 5.D1c.2): tool-name canonicalization + message
/// history pruning, relocated from the gateway so the moved loop calls them locally.
pub mod browser;

/// Pure tool-trace helpers (ADR 0024 inc 5, 5.D1c.2): per-tool decision-memory trace lines.
pub mod tools;

/// The turn's result for the gateway's post-turn tail (ADR 0024 inc 5, 5.D1c.8).
pub mod outcome;

/// The parity oracle for the loop move (ADR 0024 inc 5, 5.D1c.9): normalized per-tool-call fingerprints.
pub mod trace;

/// Readable per-turn observability sink (ported from `feat/piano-ui-completion`): one JSON line per
/// in-turn event to `turn-trace.jsonl`. A pure sink threaded through `run_turn` — it records what the
/// turn did and NEVER changes any control-flow decision. Kept separate from `trace` (the hashed oracle).
pub mod turn_trace;

/// Durable, provider-neutral observability events emitted by the guarded loop.
pub mod execution_journal;

/// The single guarded ReAct loop — motore #1 (ADR 0021), extracted here (ADR 0024 inc 5, 5.D1c.10).
pub mod agent_loop;

/// The `browse(goal) → BrowseResult` contract (ADR 0025): the browser as a delegated sub-agent.
pub mod browse;

pub use contract::{
    BrowserExecutor, CapabilityExecutor, ContextCompactor, EventSink, ExecutionJournal, LoadedTool,
    FinalizationFence, ModelCall, ModelCallError, ModelClient, ModelRoundOutput, PlanProgress, ProviderBinding,
    ToolEffects, ToolOutcome, TurnCompletionJudge, TurnPolicy,
};
pub use execution_journal::{
    AgentExecutionEvent, NoopExecutionJournal, PromptMessageSnapshot, PromptSnapshot,
    PromptToolSnapshot, build_prompt_snapshot,
};
pub use browse::{BrowseResult, Confidence};
pub use config::TurnConfig;
pub use loop_state::LoopState;
pub use loop_checkpoint::LoopCheckpoint;
pub use prompt_packets::{PromptPacket, PromptPacketMetadata, PromptPacketSource, compose_prompt_packets};
pub use outcome::{TurnDelivery, TurnOutcome};
