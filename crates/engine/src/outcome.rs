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
    /// Provenance delle letture collegate che hanno informato la risposta.
    pub memory_reads: crate::events::TurnMemoryReadSet,
    /// The source URLs actually visited this turn (the browser_navigate targets), in first-seen order.
    /// The MAIN path already folds these into the answer's "Fonti" section and ignores this field; it
    /// exists for ADR 0025's `browse(goal)` recursion, where the sub-turn's `BrowseResult.sources` is
    /// these URLs (the answer itself stays clean, the manager owns source presentation).
    pub browse_sources: Vec<String>,
    /// The turn's FINAL runtime plan (opaque serialized `ExecutionPlan`, `Null` when the turn had no
    /// plan). Carried out so the gateway's `turn_trace` `TurnEnd` can report per-step final status +
    /// the derived "claimed done without artifact" flag — the plan lives in the consumed `LoopState`,
    /// so it can only reach the caller through the outcome. Observability-only; no path reads it for
    /// control flow (the `browse` recursion ignores it).
    pub final_plan: serde_json::Value,
    /// Set when the turn died because the model cannot look at the images it was sent, and NOTHING was
    /// streamed or committed for it (the loop returns before the final answer). Carries the provider's
    /// message. The gateway either recovers — describe the images on the `vision` role, re-seed, re-run
    /// — or, if it has no vision model to fall back on, surfaces this as the turn's answer.
    ///
    /// Only ever set on a turn that has not yet executed a tool: a replayed turn must not re-run side
    /// effects, so a rejection arriving after the model has already acted takes the ordinary (fatal,
    /// user-visible) error path instead.
    pub image_rejection: Option<String>,
}
