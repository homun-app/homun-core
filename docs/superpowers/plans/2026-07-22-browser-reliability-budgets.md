# Browser Reliability Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terminare browser loop stagnanti entro budget espliciti producendo una risposta utile o un errore classificato.

**Architecture:** I limiti per round esistenti vengono affiancati da wall-clock, navigazioni fallite e streak no-progress. Una funzione pura decide lo stop; il loop emette Activity tipizzata e forza una sola sintesi finale.

**Tech Stack:** Rust, Tokio, engine ReAct loop, gateway configuration.

---

## File structure

- Modify `crates/engine/src/{config.rs,loop_state.rs,agent_loop.rs,events.rs}`: budget e stop reason.
- Modify `crates/desktop-gateway/src/main.rs`: default/config e Activity.
- Modify `docs/architecture/agent-loop.md`: contratto.

### Task 1: Definire il budget puro

**Files:**
- Modify: `crates/engine/src/config.rs`
- Modify: `crates/engine/src/loop_state.rs`

- [ ] **Step 1: Write RED tests**

```rust
#[test]
fn browser_budget_stops_on_time_or_stagnation() {
    let b = BrowserBudget { max_elapsed_ms: 300_000, max_failed_navigations: 8, max_no_progress: 5 };
    assert_eq!(b.stop_reason(300_001, 0, 0), Some(BrowserStopReason::WallClock));
    assert_eq!(b.stop_reason(1_000, 8, 0), Some(BrowserStopReason::FailedNavigations));
    assert_eq!(b.stop_reason(1_000, 0, 5), Some(BrowserStopReason::NoProgress));
}
```

- [ ] **Step 2: Run RED**

Run: `cargo test -p local-first-engine browser_budget_stops -- --nocapture`

- [ ] **Step 3: Implement**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserStopReason { WallClock, FailedNavigations, NoProgress }
#[derive(Debug, Clone, Copy)]
pub struct BrowserBudget { pub max_elapsed_ms: u64, pub max_failed_navigations: u32, pub max_no_progress: u32 }
impl BrowserBudget {
    pub fn stop_reason(self, elapsed_ms: u64, failed: u32, no_progress: u32) -> Option<BrowserStopReason> {
        if elapsed_ms >= self.max_elapsed_ms { Some(BrowserStopReason::WallClock) }
        else if failed >= self.max_failed_navigations { Some(BrowserStopReason::FailedNavigations) }
        else if no_progress >= self.max_no_progress { Some(BrowserStopReason::NoProgress) }
        else { None }
    }
}
```

Add `browser_budget` to `TurnConfig` and counters to `LoopState`.

- [ ] **Step 4: Run GREEN and commit**

```bash
cargo test -p local-first-engine browser_budget -- --nocapture
git add crates/engine/src/config.rs crates/engine/src/loop_state.rs
git commit -m "feat(engine): define browser execution budgets"
```

### Task 2: Applicare wall-clock e circuit breaker

**Files:**
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/engine/src/events.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Add a failing loop test**

Add a mock browser that returns five `blocked` outcomes. Add `AgentExecutionEvent::BrowserBudgetExceeded`, whose `into_parts` name is `browser_budget_exceeded`, then assert against the existing `CollectJournal`, `Collect` sink and `TurnOutcome` test fixtures:

```rust
let journal_events = journal.0.lock().unwrap();
assert_eq!(journal_events.iter().filter(|kind| kind.as_str() == "browser_budget_exceeded").count(), 1);
assert_eq!(journal_events.iter().filter(|kind| kind.as_str() == "forced_synthesis").count(), 1);
drop(journal_events);
assert_eq!(sink.0.lock().unwrap().iter().filter(|event| matches!(event, GenerateStreamEvent::Done { .. })).count(), 1);
assert_eq!(outcome.delivery, crate::TurnDelivery::Delivered);
assert!(outcome.memory_answer.contains("Non sono riuscito"));
```

- [ ] **Step 2: Run RED**

Run: `cargo test -p local-first-engine browser_circuit_breaker_synthesizes_once -- --nocapture`

- [ ] **Step 3: Implement the stop boundary**

Capture `Instant::now()` before the loop. After every browser result update failed-navigation and no-progress counters using `classify_tool_result`; before the next round call `stop_reason`. On stop emit structured Activity, break, and run the existing no-tools synthesis once. Gateway defaults: 300 seconds, 8 failed navigations, 5 consecutive no-progress outcomes; env overrides stay bounded above.

- [ ] **Step 4: Run GREEN and commit**

```bash
cargo test -p local-first-engine browser_ -- --nocapture
cargo test -p local-first-desktop-gateway browser_ -- --nocapture
git add crates/engine/src/agent_loop.rs crates/engine/src/events.rs crates/desktop-gateway/src/main.rs
git commit -m "fix(browser): stop stagnant sessions within budget"
```

### Task 3: Rendere il failure mode osservabile

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/i18n/locales/{it,en,fr,de,es}.json`
- Modify: `docs/architecture/agent-loop.md`

- [ ] **Step 1: Add UI contract assertions**

```js
assertContains("src/components/ChatView.tsx", "browser_budget_exceeded", "browser budget has an actionable Activity state");
assertContains("src/i18n/locales/it.json", "Tempo massimo del browser raggiunto", "browser timeout is localized");
```

- [ ] **Step 2: Run RED, implement mapping, run GREEN**

Run: `cd apps/desktop && npm run test:ui-contract`

Map the reason to `Tempo massimo`, `Troppe navigazioni fallite` or `Nessun avanzamento`; expose Retry and Activity without adding a transcript message.

```bash
cd apps/desktop
npm run test:ui-contract
npm run build
git add src/components/ChatView.tsx src/i18n/locales ../../docs/architecture/agent-loop.md
git commit -m "feat(desktop): explain bounded browser failures"
```
