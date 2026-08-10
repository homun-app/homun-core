# Implementation Plan — Tasks #8 & #9: Replan Nudge + Consecutive Failure Tracking

## Problem

The F4 stall guard (gateway `main.rs`) blocks a step after 3 resumed turns with no progress, but the engine just stops and synthesizes — it never asks the model to revise the plan. Additionally, there's no tracking of consecutive step failures across different tool families, so the engine can't detect a broader pattern of "this plan approach is failing."

## Solution Overview

Add two complementary mechanisms in the engine loop:

1. **Replan nudge on stall (Task #8)**: When `stop_for_no_progress` fires (3+ consecutive failures in the same tool family), inject a replan directive telling the model to revise the blocked step, then continue the loop instead of stopping.

2. **Consecutive failure tracking (Task #9)**: A `consecutive_step_failures` counter on `LoopState` that tracks failures across ALL tool families. When it exceeds 2, inject a forced replan asking for a fundamentally different approach.

## Files to Modify (engine crate only)

### 1. `crates/engine/src/loop_state.rs`
- Add `consecutive_step_failures: u32` field to `LoopState`
- Reset counter in `apply_effects` when `reset_stall_guards` is true
- Update `new_is_all_empty` test assertion
- Add unit tests for counter increment/reset behavior

### 2. `crates/engine/src/agent_loop.rs`
- Add `replan_injected_this_turn: bool` loop local (near `plan_gate_fired`)
- Increment `ls.consecutive_step_failures` on tool failure (alongside existing `observe_tool_outcome`)
- Reset counter on plan progress (`done_after > done_before`) and on `update_plan`/`step_advance` calls
- Before `stop_for_no_progress` break: inject replan directive and `continue 'rounds` (if not already injected)
- At `nudge_no_progress` threshold (2 failures): also trigger consecutive failure tracking
- Add tests with scripted models that simulate stalled/failing steps

## Detailed Changes

### LoopState (`loop_state.rs`)

```rust
// New field after `browse_calls_completed`:
/// Consecutive step failures across ALL tool families this turn.
/// Incremented on tool error/blocked/no_progress outcomes; reset when a plan
/// step completes (frontier advances) or the model calls update_plan/step_advance.
/// When > 2, triggers a forced replan directive.
pub consecutive_step_failures: u32,
```

Reset in `apply_effects` reset_stall_guards block:
```rust
self.consecutive_step_failures = 0;
```

### Agent Loop (`agent_loop.rs`)

**New loop local** (near line 392):
```rust
let mut replan_injected_this_turn = false;
```

**Increment counter** (after `observe_tool_outcome` in non-browser branch, ~line 1160):
```rust
let no_progress_count = ls.observe_tool_outcome(&tool_family(name), outcome);
if no_progress_count > 0 {
    ls.consecutive_step_failures = ls.consecutive_step_failures.saturating_add(1);
    // ... existing nudge/stop logic
}
```

**Reset counter on plan progress** (~line 1564):
```rust
if done_after > done_before {
    plan_nudges = 0;
    ls.consecutive_step_failures = 0;
}
```

**Reset counter on update_plan/step_advance** (~line 1171):
```rust
if matches!(name, "update_plan" | "step_advance") {
    ls.consecutive_step_failures = 0;
    // ... existing journal record
}
```

**Replan injection** (before `stop_for_no_progress` break, ~line 1398):
```rust
if !replan_injected_this_turn
    && !is_final_round
    && (stop_for_no_progress || ls.consecutive_step_failures > 2)
{
    replan_injected_this_turn = true;
    let reason = if stop_for_no_progress {
        let step_title = plan_next_open(&plan_value_steps(&ls.plan))
            .unwrap_or_else(|| "current step".to_string());
        format!(
            "Step «{step_title}» is blocked after multiple attempts with no progress. \
             Revise your plan using `update_plan`: remove, replace, or break down the \
             blocked step into smaller sub-steps. Then continue with the revised plan."
        )
    } else {
        let n = ls.consecutive_step_failures;
        format!(
            "You have failed {n} consecutive steps. The current plan approach is not \
             working. Generate a fundamentally different approach using `update_plan`. \
             Consider: simpler steps, different tools, or asking the user for clarification."
        )
    };
    turn_trace.record(crate::turn_trace::TurnEvent::Nudge {
        reason: "replan_on_stall".into(),
        next_step: String::new(),
    });
    ls.messages.push(serde_json::json!({
        "role": "system",
        "content": reason,
    }));
    let _ = event_sink
        .emit(GenerateStreamEvent::Delta {
            text: "‹‹ACT›⟩🔄 Replan: asking the model to revise the plan‹‹/ACT›⟩".to_string(),
        })
        .await;
    continue 'rounds;
}
```

## Tests

### LoopState unit tests (`loop_state.rs`)
1. `consecutive_step_failures_starts_at_zero` — verify default
2. `consecutive_step_failures_resets_on_stall_guard_reset` — verify `apply_effects` with `reset_stall_guards: true` clears counter

### Agent loop tests (`agent_loop.rs`)
1. `replan_nudge_injected_when_tool_family_stalls` — scripted model makes 3+ identical failing tool calls → verify replan system message appears in conversation
2. `forced_replan_injected_on_consecutive_cross_family_failures` — scripted model fails across different tool families → verify forced replan message at threshold 3
3. `consecutive_failures_reset_on_plan_progress` — scripted model fails twice then a plan step completes → counter resets, no replan fires
4. `replan_nudge_fires_only_once_per_turn` — scripted model keeps failing after replan → verify no second replan injection

## Verification

```bash
cargo test -p local-first-engine
```

All existing tests must continue to pass. New tests verify the replan/failure-tracking behavior.
