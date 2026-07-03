# Turn-trace Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A readable per-turn trace (`~/.homun/logs/turn-trace.jsonl`) that records what happened in a chat turn — rounds, plan transitions, the reconcile decision, and the final answer with derived signals (`claimed_done_without_artifact`, `incomplete_steps`) — so a bad turn can be understood by tailing one file instead of grepping scattered logs.

**Architecture:** A new pure-ish `turn_trace` module mirrors `tool_trace_dump`'s append pattern but writes READABLE (not hashed) turn-scoped JSON lines. A cheap `Arc`-cloneable `TurnTrace` handle is created once per turn in `stream_chat_via_openai` and records typed events at the existing decision points (beside the current `eprintln!`s). The `plan` transition event lives in `execute_chat_tool` (via `ChatToolCtx`) and is wired in a separate, isolated task.

**Tech Stack:** Rust (`crates/desktop-gateway`, package `local-first-desktop-gateway`), serde.

**Spec:** [docs/superpowers/specs/2026-07-03-turn-trace-observability-design.md](../specs/2026-07-03-turn-trace-observability-design.md)

---

## Background the implementer needs (read once)

- Mirror `crates/desktop-gateway/src/tool_trace_dump.rs::append` (open-for-append, swallow every error,
  never panic). The turn trace writes to `<gateway_logs_dir()>/turn-trace.jsonl`.
- `gateway_logs_dir() -> Result<PathBuf>` = `gateway_data_dir()/logs` (already exists in `main.rs`).
- The chat loop is `stream_chat_via_openai` (starts `main.rs:22416`). In scope there:
  `request.request_id` (turn id), `mode` (`main.rs` ~23191), `model`, `turn_tier` (~22429), the round
  loop `for round in 0..hard_round_ceiling()` (~24048), the nudge path (~24865), the forced-synthesis
  log (`[answer] … → forced synthesis`, ~24970), the reconcile block (F2.2, ~24901).
- The plan transition log `"[plan] {name}: sent[…] → canonical[…]"` is at `main.rs:21363`, inside the
  tool dispatch (`execute_chat_tool`), NOT the loop — so its event needs the trace on `ChatToolCtx`.
- Line numbers DRIFT — re-`grep` the quoted anchor strings before each edit.
- Register modules next to the others: `grep -n "^mod tool_trace_dump;" crates/desktop-gateway/src/main.rs`.
- `Instant`/`AtomicUsize`/`Arc` are fine in this Rust runtime (the Date/random restriction is only for
  workflow JS scripts, not gateway code).

## File structure

- **Create** `crates/desktop-gateway/src/turn_trace.rs` — event types + `AnswerSignals`/`DerivedFlags` +
  pure helpers (`answer_signals`, `derive_flags`, `has_markdown_table`, `count_sources`) + `TurnTrace`
  handle (`new`, `record`, no-op when disabled) + `append`. Unit tests inline.
- **Modify** `crates/desktop-gateway/src/main.rs` — register `mod turn_trace;`; create the `TurnTrace` in
  `stream_chat_via_openai`; record the in-loop events; add the field to `ChatToolCtx` and record the
  `plan` event; bound/rotation is inside `append`.

---

## Task 1: `turn_trace` module (types + helpers + append) — TDD

**Files:**
- Create: `crates/desktop-gateway/src/turn_trace.rs`
- Modify: `crates/desktop-gateway/src/main.rs` (add `mod turn_trace;`)

- [ ] **Step 1: Register the module**

`grep -n "^mod tool_trace_dump;" crates/desktop-gateway/src/main.rs`, then add on the next line:

```rust
mod turn_trace;
```

- [ ] **Step 2: Write the module with tests and a STUB helper body (TDD RED)**

Create `crates/desktop-gateway/src/turn_trace.rs`:

```rust
//! Readable per-turn trace (`<logs_dir>/turn-trace.jsonl`).
//!
//! WHY: the P0 `gateway.log` has the raw `[plan]`/`[answer]` eprintlns and `tool_trace_dump` is a
//! HASHED parity oracle (ADR 0024) — neither lets a human read "what happened in this turn". This
//! writes ONE readable JSON line per event, turn-scoped, so a bad turn (e.g. delivered no table and
//! claimed it did) can be understood by tailing one file. Local-only, content truncated, best-effort.
//! Kept SEPARATE from `tool_trace_dump` (one responsibility per unit — caposaldo #5).

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;

/// Fingerprint of the final answer (content truncated elsewhere; only signals kept here).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AnswerSignals {
    pub has_table: bool,
    pub sources_count: usize,
    pub artifact_count: usize,
}

/// Derived red-flags — the high-value part of the trace.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DerivedFlags {
    /// Steps in the final plan that are not `done`.
    pub incomplete_steps: usize,
    /// A plan step implies an artifact (a table / file / deck / …) but that artifact is ABSENT from
    /// the delivered answer — i.e. the turn concluded (claimed done) without the deliverable. This is
    /// the flag that pinpoints the 2026-07-03 "no table but claimed a table" failure.
    pub claimed_done_without_artifact: bool,
}

/// One trace line. `kind` + a flat payload keeps it greppable and easy to read.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnEvent {
    TurnStart { prompt_head: String, prompt_len: usize, mode: String, model: String, tier: String },
    Round { round: usize, finish_reason: String, tool_calls: Vec<String>, content_delta_len: usize },
    Plan { op: String, sent: Vec<String>, canonical: Vec<String> },
    Nudge { reason: String, next_step: String },
    ForcedSynthesis { finish_reason: String },
    Reconcile { fired: bool, step: String, open_steps: usize, delivered_chars: usize, threshold: usize },
    TurnEnd { final_len: usize, plan_final: Vec<String>, signals: AnswerSignals, derived: DerivedFlags },
}

/// A markdown table = at least two CONSECUTIVE lines that look like table rows (a leading pipe with
/// content). Cheap, no regex dependency. Catches header+separator or two data rows.
pub fn has_markdown_table(text: &str) -> bool {
    let mut prev_row = false;
    for line in text.lines() {
        let l = line.trim();
        let is_row = l.starts_with('|') && l.matches('|').count() >= 2;
        if is_row && prev_row {
            return true;
        }
        prev_row = is_row;
    }
    false
}

/// Count http(s) URLs as a proxy for cited sources.
pub fn count_sources(text: &str) -> usize {
    text.matches("http://").count() + text.matches("https://").count()
}

pub fn answer_signals(text: &str, artifact_count: usize) -> AnswerSignals {
    AnswerSignals {
        has_table: has_markdown_table(text),
        sources_count: count_sources(text),
        artifact_count,
    }
}

/// `plan_final` = final status per step; `plan_titles` = step titles (for the artifact-keyword match).
pub fn derive_flags(plan_final: &[String], plan_titles: &[String], signals: &AnswerSignals) -> DerivedFlags {
    let incomplete_steps = plan_final.iter().filter(|s| s.as_str() != "done").count();
    let claimed_done_without_artifact = plan_titles.iter().any(|title| {
        let t = title.to_lowercase();
        let wants_table = t.contains("tabella") || t.contains("table");
        let wants_file = ["file", "deck", "presentazione", "documento", "report", "grafico", "chart"]
            .iter()
            .any(|k| t.contains(k));
        (wants_table && !signals.has_table) || (wants_file && signals.artifact_count == 0)
    });
    DerivedFlags { incomplete_steps, claimed_done_without_artifact }
}

struct Inner {
    turn_id: String,
    dir: std::path::PathBuf,
    start: Instant,
    seq: AtomicUsize,
    max_bytes: u64,
}

/// Cheap `Arc`-cloneable handle. `None` = disabled/no-logs-dir → every `record` is a silent no-op, so
/// it can live on `ChatToolCtx` and in the loop without threading a writer or guarding call sites.
#[derive(Clone)]
pub struct TurnTrace(Option<Arc<Inner>>);

impl TurnTrace {
    /// Disabled handle (opt-out `HOMUN_TURN_TRACE=0/off`, or no resolvable logs dir).
    pub fn disabled() -> Self {
        TurnTrace(None)
    }

    /// Enabled handle writing under `dir`. `max_bytes` bounds the file (rotate at the threshold).
    pub fn new(turn_id: impl Into<String>, dir: std::path::PathBuf, max_bytes: u64) -> Self {
        TurnTrace(Some(Arc::new(Inner {
            turn_id: turn_id.into(),
            dir,
            start: Instant::now(),
            seq: AtomicUsize::new(0),
            max_bytes,
        })))
    }

    /// Record one event (best-effort; never panics; no-op when disabled).
    pub fn record(&self, event: TurnEvent) {
        let Some(inner) = &self.0 else { return };
        let seq = inner.seq.fetch_add(1, Ordering::Relaxed);
        let t_ms = inner.start.elapsed().as_millis();
        append(&inner.dir, &inner.turn_id, seq, t_ms, &event, inner.max_bytes);
    }
}

/// Append one JSON line `{turn_id, seq, t_ms, ...event}` to `<dir>/turn-trace.jsonl`. Rotates the file
/// to `.1` when it would exceed `max_bytes`. Swallows every error — a trace failure must never crash or
/// interrupt a turn (mirror `tool_trace_dump::append`).
fn append(dir: &Path, turn_id: &str, seq: usize, t_ms: u128, event: &TurnEvent, max_bytes: u64) {
    // Merge the envelope with the event's tagged fields into one flat object.
    let Ok(mut value) = serde_json::to_value(event) else { return };
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("turn_id".into(), serde_json::json!(turn_id));
        map.insert("seq".into(), serde_json::json!(seq));
        map.insert("t_ms".into(), serde_json::json!(t_ms as u64));
    }
    let Ok(mut line) = serde_json::to_string(&value) else { return };
    line.push('\n');
    let path = dir.join("turn-trace.jsonl");
    // Rotate if the existing file is already at/over the cap.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() >= max_bytes {
            let _ = std::fs::rename(&path, dir.join("turn-trace.jsonl.1"));
        }
    }
    use std::io::Write as _;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_a_markdown_table_but_not_a_prose_source_list() {
        let table = "| Titolo | Fonte |\n| --- | --- |\n| A | B |";
        assert!(has_markdown_table(table));
        let prose = "Ecco il confronto...\n\n**Sources**\n- https://a.com\n- https://b.com";
        assert!(!has_markdown_table(prose));
    }

    #[test]
    fn counts_source_urls() {
        assert_eq!(count_sources("see https://a.com and http://b.com"), 2);
        assert_eq!(count_sources("no links here"), 0);
    }

    #[test]
    fn flags_a_table_step_delivered_without_a_table() {
        // The 2026-07-03 failure: step wants a table, answer has none.
        let signals = AnswerSignals { has_table: false, sources_count: 3, artifact_count: 0 };
        let flags = derive_flags(
            &["done".into(), "done".into(), "done".into(), "doing".into()],
            &["Cercare".into(), "Selezionare".into(), "Leggere".into(), "Compilare tabella finale".into()],
            &signals,
        );
        assert!(flags.claimed_done_without_artifact);
        assert_eq!(flags.incomplete_steps, 1);
    }

    #[test]
    fn no_flag_when_the_table_is_present() {
        let signals = AnswerSignals { has_table: true, sources_count: 3, artifact_count: 0 };
        let flags = derive_flags(&["done".into()], &["Compilare tabella".into()], &signals);
        assert!(!flags.claimed_done_without_artifact);
    }

    #[test]
    fn no_artifact_flag_when_no_step_expects_one() {
        let signals = AnswerSignals { has_table: false, sources_count: 0, artifact_count: 0 };
        let flags = derive_flags(&["done".into()], &["Rispondere alla domanda".into()], &signals);
        assert!(!flags.claimed_done_without_artifact);
        assert_eq!(flags.incomplete_steps, 0);
    }

    #[test]
    fn append_never_panics_on_a_bad_dir() {
        // A path that can't be created/written must be swallowed silently.
        let t = TurnTrace::new("tid", std::path::PathBuf::from("/nonexistent/xyz/deep"), 5_000_000);
        t.record(TurnEvent::ForcedSynthesis { finish_reason: "stop".into() });
        // no panic == pass
    }

    #[test]
    fn disabled_handle_is_a_silent_noop() {
        TurnTrace::disabled().record(TurnEvent::Round {
            round: 0,
            finish_reason: "stop".into(),
            tool_calls: vec![],
            content_delta_len: 0,
        });
    }
}
```

To get a genuine RED, TEMPORARILY stub `derive_flags` to always return no flags before running:

```rust
pub fn derive_flags(_plan_final: &[String], _plan_titles: &[String], _signals: &AnswerSignals) -> DerivedFlags {
    DerivedFlags { incomplete_steps: 0, claimed_done_without_artifact: false }
}
```

- [ ] **Step 3: Run the tests — expect RED**

Run: `cargo test -p local-first-desktop-gateway turn_trace`
Expected: FAIL — `flags_a_table_step_delivered_without_a_table` fails (stub returns no flags / 0 steps).

- [ ] **Step 4: Restore the real `derive_flags`** (the version shown in Step 2).

- [ ] **Step 5: Run the tests — expect GREEN**

Run: `cargo test -p local-first-desktop-gateway turn_trace`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/turn_trace.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(observability): turn_trace module — readable per-turn events + derived flags"
```

---

## Task 2: Create the `TurnTrace` and record the in-loop events

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Add a bounded opt-out helper**

Near `plan_reconcile_on_delivery_enabled` (grep it), add:

```rust
/// Turn trace is ON by default (local-only, bounded). `HOMUN_TURN_TRACE=0`/`off` opts out.
fn turn_trace_enabled() -> bool {
    !matches!(
        std::env::var("HOMUN_TURN_TRACE").ok().as_deref().map(str::trim),
        Some("0") | Some("off") | Some("OFF") | Some("Off")
    )
}

/// Max bytes before `turn-trace.jsonl` rotates. Override with `HOMUN_TURN_TRACE_MAX_BYTES`.
fn turn_trace_max_bytes() -> u64 {
    std::env::var("HOMUN_TURN_TRACE_MAX_BYTES")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(5_000_000)
}
```

- [ ] **Step 2: Create the trace at the top of `stream_chat_via_openai`**

`grep -n "fn stream_chat_via_openai" crates/desktop-gateway/src/main.rs`. Just after `mode` is bound
(`grep -n 'let mode = request.mode.as_deref().unwrap_or("agent")'`), add:

```rust
    let turn_trace = if turn_trace_enabled() {
        match gateway_logs_dir() {
            Ok(dir) => turn_trace::TurnTrace::new(
                request.request_id.clone(),
                dir,
                turn_trace_max_bytes(),
            ),
            Err(_) => turn_trace::TurnTrace::disabled(),
        }
    } else {
        turn_trace::TurnTrace::disabled()
    };
    turn_trace.record(turn_trace::TurnEvent::TurnStart {
        prompt_head: request.prompt.chars().take(200).collect(),
        prompt_len: request.prompt.chars().count(),
        mode: mode.clone(),
        model: model.clone(),
        tier: turn_tier.as_str().to_string(),
    });
```

(If `model` is not a `String` in scope here, use `model.to_string()`; if `turn_tier` is out of scope at
this exact point, move this block just below where `turn_tier` is computed — re-grep `let turn_tier`.)

- [ ] **Step 3: Record each round**

At the round loop (`grep -n "for round in 0..hard_round_ceiling()"`), after the model response for the
round is parsed (finish_reason + tool_calls available), add a record. Use the finish_reason/tool-call
names as they exist locally; if `finish_reason` isn't in a variable at that point, pass `String::new()`
and record the tool-call names + delta only:

```rust
        turn_trace.record(turn_trace::TurnEvent::Round {
            round,
            finish_reason: finish_reason.clone().unwrap_or_default(),
            tool_calls: tool_call_names.clone(),
            content_delta_len: content.chars().count(),
        });
```

Where `tool_call_names` is `Vec<String>` of the tool names chosen this round (derive from the parsed
tool calls; if a list isn't already built, `tool_calls.iter().map(|c| c.name.clone()).collect()`).

- [ ] **Step 4: Record nudge and forced-synthesis**

At the nudge path (`grep -n "Do NOT stop and do NOT re-run the skill"`), just before `continue;`:

```rust
                        turn_trace.record(turn_trace::TurnEvent::Nudge {
                            reason: "answer_did_not_conclude_plan".into(),
                            next_step: step.clone(),
                        });
```

At the forced-synthesis log (`grep -n "empty answer body (finish_reason="`), beside the `eprintln!`:

```rust
                    turn_trace.record(turn_trace::TurnEvent::ForcedSynthesis {
                        finish_reason: fr.to_string(),
                    });
```

- [ ] **Step 5: Record the reconcile decision**

At the F2.2 reconcile block (`grep -n "reconciled last open step to done on delivery"`), record BOTH the
fired and not-fired cases. Inside the `if plan_reconcile_on_delivery_enabled()` + `if let Some(open_index)`
that fires, after the existing work:

```rust
                            turn_trace.record(turn_trace::TurnEvent::Reconcile {
                                fired: true,
                                step: step.clone(),
                                open_steps: open_left,
                                delivered_chars: content.trim().chars().count(),
                                threshold: MIN_DELIVERED_CHARS_TO_CONCLUDE,
                            });
```

(`open_left` and `MIN_DELIVERED_CHARS_TO_CONCLUDE` are already in scope here — they feed
`answer_concludes_plan`. If `open_left` isn't in scope at this exact line, recompute it as the count of
non-`done` steps in `plan_steps`.)

- [ ] **Step 6: Record `turn_end` at finalization**

Where the turn's final `content` is settled before returning/committing (the same place the final plan
marker/answer is known — near the reconcile/finalize path), add:

```rust
        let plan_final: Vec<String> =
            plan_steps.iter().map(|s| plan_step_status(s).to_string()).collect();
        let plan_titles: Vec<String> =
            plan_steps.iter().map(|s| plan_step_title(s).to_string()).collect();
        let artifact_count = parse_artifact_markers(&content).len();
        let signals = turn_trace::answer_signals(&content, artifact_count);
        let derived = turn_trace::derive_flags(&plan_final, &plan_titles, &signals);
        turn_trace.record(turn_trace::TurnEvent::TurnEnd {
            final_len: content.chars().count(),
            plan_final,
            signals,
            derived,
        });
```

Use the project's existing helpers for step title and artifact-marker parsing: re-grep
`grep -n "fn plan_step_status\|fn plan_step_title\|‹‹ARTIFACT››" crates/desktop-gateway/src/main.rs` and
adapt the names (`plan_step_title` may be inline — if absent, read the title field the same way
`replace_latest_plan_marker` does; if no artifact parser exists, count `content.matches("‹‹ARTIFACT››")`).

- [ ] **Step 7: Build + run the crate tests**

Run: `cargo build -p local-first-desktop-gateway 2>&1 | tail -3`
Expected: builds (warnings ok).
Run: `cargo test -p local-first-desktop-gateway turn_trace`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(observability): record turn-trace events in the chat loop (start/round/nudge/reconcile/end)"
```

---

## Task 3: Record the `plan` transition event (via ChatToolCtx)

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Add the trace to `ChatToolCtx`**

`grep -n "struct ChatToolCtx" crates/desktop-gateway/src/main.rs`. Add a field:

```rust
    turn_trace: turn_trace::TurnTrace,
```

Wire it where `ChatToolCtx` is constructed inside `stream_chat_via_openai` (grep the struct literal
`ChatToolCtx {`): set `turn_trace: turn_trace.clone(),` (the handle is cheap `Arc`/None clone).

- [ ] **Step 2: Record the plan transition beside its log**

At the plan transition log (`grep -n 'sent\[{}\]=\[{}\] → canonical'`), after the `eprintln!`, add:

```rust
                ctx.turn_trace.record(turn_trace::TurnEvent::Plan {
                    op: name.to_string(),
                    sent: sent_statuses.clone(),
                    canonical: canonical_statuses.clone(),
                });
```

Where `sent_statuses`/`canonical_statuses` are `Vec<String>` of the per-step statuses that the log line
already formats. If the log builds them inline (not as vars), extract them into two `Vec<String>` first
(the same values the `[{}]` placeholders print), then log AND record from those vars (behavior-preserving).

- [ ] **Step 3: Build + test**

Run: `cargo build -p local-first-desktop-gateway 2>&1 | tail -3`
Expected: builds.
Run: `cargo test -p local-first-desktop-gateway 2>&1 | grep -E "test result:|FAILED" | tail`
Expected: PASS (the only pre-existing failure allowed is `import_pptx…thumbnail`, env-only, green in CI).

- [ ] **Step 4: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(observability): record plan sent→canonical transitions (verify-hold visibility)"
```

---

## Task 4: Runtime validation — the illuminated retest

**Files:** none (verification)

- [ ] **Step 1: Restart the dev gateway with the new binary**

The dev app spawns the gateway from `HOMUN_DESKTOP_GATEWAY_BIN` (target/debug). Rebuild is already done
by Task 2/3. Restart the running dev app's gateway so it loads the new binary (quit + relaunch
`npm run electron:dev` with `HOMUN_DESKTOP_GATEWAY_BIN` set, OR kill the dev gateway process so the
watchdog/relaunch picks up the rebuilt binary). Confirm health on the dev port.

- [ ] **Step 2: Reproduce the 2026-07-03 case and read the trace**

In the dev app, send: `Cerca le ultime notizie di oggi sull'intelligenza artificiale e riassumile in una tabella con fonte.`

Then tail the trace:

Run: `tail -n 40 ~/.homun/logs/turn-trace.jsonl`
Expected — for that turn's `turn_id`, the sequence contains:
- `turn_start` with `mode:"agent"`, the model, the tier;
- one or more `round` with `finish_reason`;
- `plan` lines where `sent` ≠ `canonical` (the verify-hold made visible);
- `reconcile` with `fired:true` and the last step;
- `turn_end` with `signals.has_table:false` and **`derived.claimed_done_without_artifact:true`** +
  `incomplete_steps ≥ 1` — i.e. the trace states the exact failure that took manual archaeology before.

- [ ] **Step 3: Confirm a GOOD turn is clean**

Send a request that DOES produce a table (or a simple answer), and confirm `turn_end.derived
.claimed_done_without_artifact:false`. This guards against the flag over-firing.

- [ ] **Step 4: Update STATO + commit**

Add a rolling note in `docs/STATO.md`: turn-trace observability shipped (readable `turn-trace.jsonl`,
derived `claimed_done_without_artifact`/`incomplete_steps`, opt-out `HOMUN_TURN_TRACE=0`, bounded);
separate from the `tool_trace_dump` parity oracle; in-app "Turn inspector" is a follow-on. Note the
retest evidence.

```bash
git add docs/STATO.md
git commit -m "docs(stato): turn-trace observability shipped + retest evidence"
```

---

## Self-review notes (author)

- **Spec coverage:** module + events + helpers (Task 1) ✓; in-loop events start/round/nudge/forced/
  reconcile/end (Task 2) ✓; plan transition via ctx (Task 3) ✓; derived signals in the MVP (Task 1 helper
  + Task 2 turn_end) ✓; readable JSONL in logs dir, bounded, opt-out, local-only, truncated content
  (Task 1 `append` + Task 2 flags/prompt_head) ✓; runtime validation on the real case (Task 4) ✓.
- **No placeholders:** the module is complete code; wiring steps show the exact `record(...)` calls with
  re-grep anchors, and each notes the fallback if a local var isn't in scope.
- **Type consistency:** `TurnTrace::{new,disabled,record}`, `TurnEvent::{TurnStart,Round,Plan,Nudge,
  ForcedSynthesis,Reconcile,TurnEnd}`, `AnswerSignals{has_table,sources_count,artifact_count}`,
  `DerivedFlags{incomplete_steps,claimed_done_without_artifact}`, `answer_signals`/`derive_flags` — names
  identical across module, tests, and wiring.
- **Risk isolation:** the `plan` event (only piece needing `ChatToolCtx`) is Task 3, separate from the
  high-value core (Tasks 1–2), so a ctx-threading snag can't block the trace that already captures the
  reconcile + derived flags.
