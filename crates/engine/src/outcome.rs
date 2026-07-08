//! What a turn produces for the gateway's post-turn tail (ADR 0024, increment 5, Point 5 / 5.D1c.8).
//!
//! The round loop + forced synthesis run in the engine; the post-turn side-effects — mining the
//! exchange for durable memory (the `learn` extractor) and refreshing the project code-graph — are
//! GATEWAY concerns (they need `AppState`/stores/spawn), so they run in the caller AFTER the turn
//! returns, driven by this outcome. Splitting them out is what lets the loop body move into this leaf
//! crate without dragging the memory/graph subsystems along.

/// The turn's result the gateway tail consumes. Kept minimal — only what the tail can't already see
/// (everything else, like `read_only` / `thread_id` / the memory scope, the caller still holds).
#[derive(Debug, Default, Clone)]
pub struct TurnOutcome {
    /// The committed final answer text (the `Done` payload). Fed to the memory learn extractor; empty
    /// means the turn produced no answer (the tail then skips learning).
    pub memory_answer: String,
    /// The turn's consequential tool actions, newline-joined — the "why" the learn extractor records
    /// alongside the answer.
    pub tool_actions: String,
}
