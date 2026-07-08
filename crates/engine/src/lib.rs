//! The agentic engine — the single guarded ReAct loop (motore #1, ADR 0021), extracted from the
//! gateway monolith per ADR 0024.
//!
//! The gateway is the postman: HTTP, auth, transport, and the construction of concrete
//! dependencies. This crate owns the loop — perceive → reason/plan → act (tool at the single
//! chokepoint) → observe/verify → iterate or terminate — and stays pure and testable by taking
//! its dependencies as TRAITS (model client, capability executor, memory, stores), never the
//! concrete `AppState`.
//!
//! Extraction is incremental and behavior-preserving (ADR 0024 sequence): contract → chokepoint →
//! move the loop behind `HOMUN_ENGINE_CRATE` → retire the inline parallel. This module currently
//! holds the boundary contract; the loop body is migrated in later increments.

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

pub use contract::{
    BrowserExecutor, CapabilityExecutor, ContextCompactor, EventSink, LoadedTool, ModelCall,
    ModelCallError, ModelClient, ModelRoundOutput, PlanProgress, ProviderBinding, ToolEffects,
    ToolOutcome, TurnCompletionJudge, TurnPolicy,
};
pub use config::TurnConfig;
pub use loop_state::LoopState;
pub use outcome::TurnOutcome;
