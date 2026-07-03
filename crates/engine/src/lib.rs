//! `local-first-engine` — the agent engine (ADR 0024).
//!
//! The guarded ReAct loop (motore #1 of ADR 0021) and the tool chokepoint are being
//! **extracted incrementally** out of the `desktop-gateway` monolith (`main.rs`, ~60k
//! lines) into this crate — behavior-preserving, behind `HOMUN_ENGINE_CRATE`, with
//! turn-by-turn parity. Inc-0 (this file) seeds the crate with the loop's PURE
//! context-budget logic: no `AppState`, no IO, no runtime — so establishing the crate
//! carries zero behavioral risk. Later increments add the `ModelClient` trait, then move
//! `execute_chat_tool` + `stream_chat_via_openai`.

pub mod context_budget;
pub mod payload;

pub use context_budget::{context_compaction_span, estimate_tokens, needs_context_compaction};
