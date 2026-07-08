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

pub use contract::{
    CapabilityExecutor, EventSink, LoadedTool, ModelCall, ModelCallError, ModelClient,
    ModelRoundOutput, PlanProgress, ProviderBinding, ToolEffects, ToolOutcome,
    TurnCompletionJudge,
};
