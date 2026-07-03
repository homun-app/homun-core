# Agent-mode Plan Disambiguation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent mode EXECUTE a multi-step task operationally (live `update_plan`, no stop-and-wait) and reserve PLAN_PROPOSE+STOP for plan mode — killing the weak-model stall (finding 1.2) by removing the competing decomposition affordance at the source.

**Architecture:** The harness (not the model) chooses the plan directive by chat `mode`. A pure seam `plan_directive_for_mode(mode)` returns an operational block for agent/debug, a propose-and-STOP block for plan, and empty for ask. The unconditional "FIRST propose the plan and STOP" base block and the redundant `mode=="plan"` prompt arm are removed and replaced by one mode-keyed append.

**Tech Stack:** Rust (`crates/desktop-gateway`, package `local-first-desktop-gateway`).

**Spec:** [docs/superpowers/specs/2026-07-03-agent-mode-plan-disambiguation-design.md](../specs/2026-07-03-agent-mode-plan-disambiguation-design.md)

---

## Background the implementer needs (read once)

- The chat system prompt is assembled in `crates/desktop-gateway/src/main.rs` as a long chain of
  `let system = format!("{system}\n\n…")`. Line numbers DRIFT — re-`grep` the anchor strings.
- **The bug:** the base PLAN block is embedded INSIDE the same `format!` string as the MEMORY/VAULT
  block (that `format!` opens at `let system = format!(` right before `"{system}\n\nMEMORY:`). Its last
  content lines are (grep `PLAN (plan-mode)`):
  - vault tail: `…unless a dedicated approved reveal flow exists. \`
  - then `PLAN (plan-mode): for a non-trivial MULTI-STEP task … FIRST propose the plan and STOP …`
  - … through `…do NOT restart from scratch or re-propose."` then `    );`
- The chat `mode` is bound later: `let mode = request.mode.as_deref().unwrap_or("agent").to_string();`
  (grep `unwrap_or("agent")`), followed by `let system = match mode.as_str() { "plan" => …, "ask" => …,
  "debug" => …, _ => system };` then `let system = system.as_str();`.
- Precedent for a pure, tested policy module: `crates/desktop-gateway/src/scaffold.rs` (`mod scaffold;`
  in main.rs, `#[cfg(test)] mod tests { use super::*; … }` in the file).
- Test command: `cargo test -p local-first-desktop-gateway`.
- Non-goals (do NOT touch): tier-adaptivity (ADR 0018), `spawn_subagent`, the mode toggle UI, the
  approval card. `ask`/`debug` mode-specific text arms stay.

## File structure

- **Create** `crates/desktop-gateway/src/plan_directive.rs` — the pure seam: three `&'static str`
  consts (`AGENT_OPENER`, `PLAN_OPENER`, `OPERATIONAL_BODY`) + `plan_directive_for_mode(mode) -> String`
  + unit tests. One responsibility: map chat mode → plan directive text.
- **Modify** `crates/desktop-gateway/src/main.rs` — register `mod plan_directive;`; remove the base
  PLAN block from the MEMORY `format!` string; remove the `"plan" =>` match arm; append
  `plan_directive_for_mode(&mode)` once after `mode` is bound.

---

## Task 1: Pure seam `plan_directive.rs` (TDD)

**Files:**
- Create: `crates/desktop-gateway/src/plan_directive.rs`
- Modify: `crates/desktop-gateway/src/main.rs` (add `mod plan_directive;`)

- [ ] **Step 1: Register the module**

Re-grep the module list and add the declaration next to the others (alphabetical-ish is fine):

Run: `grep -n "^mod scaffold;" crates/desktop-gateway/src/main.rs`

Add immediately after that line:

```rust
mod plan_directive;
```

- [ ] **Step 2: Create the module with tests and a STUB implementation (RED)**

Create `crates/desktop-gateway/src/plan_directive.rs`:

```rust
//! Plan directive by chat mode (finding 1.2 / C).
//!
//! WHY this exists: the chat toggle has an explicit `agent | plan | ask | debug` mode. "Agent" is
//! the ACT mode; "Plan" is the one that "waits for OK before acting". The old prompt appended an
//! UNCONDITIONAL "for a MULTI-STEP task FIRST propose the plan and STOP" block, so agent behaved like
//! plan and a weak model (gemma4:12b, finding 1.2) obeyed it and STALLED. Rather than make the weak
//! model reason about a conditional in the prompt (the falsified nudge path), the HARNESS picks the
//! directive by mode here (caposaldo #2/#6): agent/debug get an operational block that EXECUTES;
//! plan gets propose-and-STOP; ask gets nothing (it has no tools). See spec 2026-07-03.

/// Shared operational guidance: how to run a plan with `update_plan`/`step_advance`, one step at a
/// time, verified, resumable. Used by BOTH agent and plan (plan uses it for post-approval execution).
const OPERATIONAL_BODY: &str = "Use update_plan to CREATE or revise the plan (give it an `objective`/goal and steps); use step_advance to move ONE step's status (doing→done) by its id WITHOUT re-sending the plan, so steps never duplicate. The plan is shown to the user as a CARD — do NOT repeat it in prose (at most one line of context). For single-step requests no plan is needed. STEP-AT-A-TIME: work ONE step at a time — do, then VERIFY that step's result (file written, search returned usable results, build/render succeeded), and only THEN mark it `done`. Give each step a `done_criterion` (the concrete, checkable proof it's finished): a step you mark done is INDEPENDENTLY verified against its evidence before it counts — if it isn't actually complete you'll be told and must keep working on it. Your working budget RESETS every time a step is verified complete, so a long task (e.g. a 10-slide deck, a deep research) can run as long as it KEEPS CLOSING steps — never rush or skip verification to save rounds, and never mark a step done before its result actually exists. RESUMING: if the conversation ALREADY shows an in-progress plan (some steps done, others not), CONTINUE it — re-emit the plan with update_plan keeping the completed steps as done, and proceed from the first not-done step; do NOT restart from scratch or re-propose.";

/// Agent/debug opener: EXECUTE operationally, no stop-to-propose. The only stop is a user-EXPLICIT
/// request to see/approve a plan first (user-triggered, not model-guessed).
const AGENT_OPENER: &str = "PLAN: for a non-trivial MULTI-STEP task (development, refactor, involved research, actions with effects), CREATE an operational plan with update_plan (set its `objective`) and EXECUTE it in THIS turn, one step at a time — do NOT stop to ask approval of the plan itself; just start working. Irreversible or risky ACTIONS are gated separately by the approval system, not by proposing a plan. ONLY if the user EXPLICITLY asks to see, approve, create, or test a plan FIRST: emit on its own line `‹‹PLAN_PROPOSE››{\"summary\":\"objective in brief\",\"steps\":[\"step 1\",\"step 2\"]}‹‹/PLAN_PROPOSE››` (valid JSON) and STOP, executing after approval.";

/// Plan-mode opener: propose-and-STOP for ANY non-trivial request (the user chose to gate execution).
const PLAN_OPENER: &str = "PLAN MODE (chosen by the user): for ANY non-trivial request FIRST propose a plan — emit on its own line `‹‹PLAN_PROPOSE››{\"summary\":\"objective in brief\",\"steps\":[\"step 1\",\"step 2\"]}‹‹/PLAN_PROPOSE››` (valid JSON) — and STOP. The user will see Accept/Edit; EXECUTE the plan ONLY in the NEXT turn after approval; if they ask for changes, revise and re-propose.";

/// The plan directive for a chat mode. Empty for `ask` (no tools/plan). Pure and total.
pub fn plan_directive_for_mode(mode: &str) -> String {
    match mode {
        "ask" => String::new(),
        "plan" => format!("{PLAN_OPENER}\n{OPERATIONAL_BODY}"),
        // agent | debug | anything else (default is "agent")
        _ => format!("{AGENT_OPENER}\n{OPERATIONAL_BODY}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_executes_and_never_forces_propose_and_stop() {
        let d = plan_directive_for_mode("agent");
        assert!(d.contains("EXECUTE it in THIS turn"));
        assert!(d.contains("update_plan"));
        // The removed miscalibration must not come back in agent mode.
        assert!(!d.contains("FIRST propose the plan and STOP"));
        // Propose is only the user-explicit exception here.
        assert!(d.contains("ONLY if the user EXPLICITLY asks"));
    }

    #[test]
    fn debug_uses_the_same_operational_directive_as_agent() {
        assert_eq!(plan_directive_for_mode("debug"), plan_directive_for_mode("agent"));
    }

    #[test]
    fn plan_mode_proposes_and_stops() {
        let d = plan_directive_for_mode("plan");
        assert!(d.contains("PLAN MODE"));
        assert!(d.contains("FIRST propose a plan"));
        assert!(d.contains("and STOP"));
    }

    #[test]
    fn ask_has_no_plan_directive() {
        assert_eq!(plan_directive_for_mode("ask"), "");
    }

    #[test]
    fn agent_and_plan_share_the_operational_body() {
        // Both must carry the how-to-run guidance (agent to execute, plan post-approval).
        for mode in ["agent", "plan", "debug"] {
            let d = plan_directive_for_mode(mode);
            assert!(d.contains("STEP-AT-A-TIME"), "{mode} missing operational body");
            assert!(d.contains("RESUMING:"), "{mode} missing resuming guidance");
        }
    }
}
```

To create a genuine RED first, TEMPORARILY replace the function body with a stub before running:

```rust
pub fn plan_directive_for_mode(_mode: &str) -> String {
    String::new()
}
```

- [ ] **Step 3: Run tests to verify they FAIL (RED)**

Run: `cargo test -p local-first-desktop-gateway plan_directive`
Expected: FAIL — `agent_executes_…`, `plan_mode_proposes…`, `agent_and_plan_share…` assertions fail
(the stub returns empty for every mode).

- [ ] **Step 4: Restore the real implementation (GREEN)**

Replace the stub body with the real `match` shown in Step 2 (the `"ask"`/`"plan"`/`_` version).

- [ ] **Step 5: Run tests to verify they PASS**

Run: `cargo test -p local-first-desktop-gateway plan_directive`
Expected: PASS — 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/plan_directive.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(prompt): plan_directive_for_mode seam (agent executes, plan proposes)"
```

---

## Task 2: Wire the seam into prompt build; remove the old blocks

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Remove the base PLAN block from the MEMORY `format!` string**

Re-grep the anchor: `grep -n "PLAN (plan-mode): for a non-trivial" crates/desktop-gateway/src/main.rs`

The base block is the tail of the big MEMORY `format!` string. Replace the vault-tail + entire PLAN
block with just the closed vault tail. Find this text (the vault line still ends with ` \` continuing
into PLAN, through the last PLAN line):

```
unless a dedicated approved reveal flow exists. \
PLAN (plan-mode): for a non-trivial MULTI-STEP task (development, refactor, involved research, \
actions with effects) FIRST propose the plan and STOP — do NOT start executing in this turn. Emit \
on its own line `‹‹PLAN_PROPOSE››{{\"summary\":\"objective in brief\",\"steps\":[\"step 1\",\"step 2\"]}}‹‹/PLAN_PROPOSE››` \
(valid JSON). The user will see the Accept/Edit buttons. EXECUTE the plan ONLY in the NEXT turn, \
after the user has approved it (e.g. «I approve the plan…»); if they ask for changes, revise and re-propose. \
If the user explicitly asks to create, show, update, verify, or test a plan, use the plan machinery: \
call update_plan for an operational plan or emit PLAN_PROPOSE for approval-gated plan-mode; do NOT \
write a free-form numbered plan only in prose. \
Once executing, use update_plan to update the step status (doing→done), shown in the \
\"Plan\" panel. To move a step's status (e.g. doing→done) call step_advance with its id (shown in \
parentheses after the title in the plan card) and the new status — this updates that ONE step \
WITHOUT re-sending the plan, so steps never duplicate; use update_plan only to CREATE or revise \
the plan. The plan (PLAN_PROPOSE or update_plan) is ALREADY shown to the user as a CARD: do NOT \
repeat it in the reply text too — no list or table of the steps in prose (at most one \
line of context). For single-step requests neither a plan nor a proposal is needed. \
STEP-AT-A-TIME EXECUTION: work the plan ONE step at a time — do, then VERIFY that step's \
result (file written, search returned usable results, build/render succeeded), and only \
THEN mark it `done` with update_plan before starting the next. Give each step a \
`done_criterion` (the concrete, checkable proof it's finished): a step you mark done is \
INDEPENDENTLY verified against its evidence before it counts — if it isn't actually complete \
you'll be told and must keep working on it. Your working budget RESETS every time a step is \
verified complete, so a long task (e.g. a 10-slide deck, a deep research) can run as long as \
it KEEPS CLOSING STEPS — never rush or skip verification to save rounds, and never mark a \
step done before its result actually exists. RESUMING: if the conversation ALREADY shows an \
in-progress plan (some steps done, others not), CONTINUE it — re-emit the plan with update_plan \
keeping the completed steps as done, and proceed from the first not-done step; do NOT restart \
from scratch or re-propose."
```

Replace it with (close the string right after the vault tail):

```
unless a dedicated approved reveal flow exists."
```

(The plan guidance now lives in `plan_directive_for_mode`, appended per-mode in Step 3.)

- [ ] **Step 2: Remove the redundant `"plan" =>` prompt arm**

Re-grep: `grep -n "PLAN MODE (chosen by the user)" crates/desktop-gateway/src/main.rs`

Delete the `"plan"` arm from the `match mode.as_str()` block (plan now falls through to `_ => system`
and gets its directive from the seam). Find and remove exactly:

```rust
        "plan" => format!(
            "{system}\n\nPLAN MODE (chosen by the user): for ANY non-trivial request \
FIRST propose a plan with `‹‹PLAN_PROPOSE››…‹‹/PLAN_PROPOSE››` and STOP; execute only after approval."
        ),
```

- [ ] **Step 3: Append the mode-keyed directive after `mode` is bound**

Re-grep: `grep -n "let system = system.as_str();" crates/desktop-gateway/src/main.rs` (the one right
after the `match mode.as_str()` block).

Immediately BEFORE that `let system = system.as_str();`, insert:

```rust
    // Plan directive by mode (finding 1.2 / C): the HARNESS decides — agent/debug execute
    // operationally, plan proposes-and-stops, ask has none. The weak model never sees a
    // "propose and STOP" instruction in agent mode, so it can't stall on it. See plan_directive.rs.
    let plan_directive = plan_directive::plan_directive_for_mode(&mode);
    let system = if plan_directive.is_empty() {
        system
    } else {
        format!("{system}\n\n{plan_directive}")
    };
```

- [ ] **Step 4: Build and verify the old block is gone**

Run: `cargo build -p local-first-desktop-gateway 2>&1 | tail -5`
Expected: builds (warnings ok, no errors).

Run: `grep -c "FIRST propose the plan and STOP" crates/desktop-gateway/src/main.rs`
Expected: `0` (the miscalibrated phrase is gone from main.rs).

Run: `grep -c "plan_directive_for_mode" crates/desktop-gateway/src/main.rs`
Expected: `1` (wired once).

- [ ] **Step 5: Run the full crate test suite (no regression)**

Run: `cargo test -p local-first-desktop-gateway 2>&1 | tail -15`
Expected: PASS (pre-existing `import_pptx…thumbnail` may fail locally for lack of LibreOffice — that
one is green in CI; everything else passes).

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(prompt): agent mode executes operationally; PLAN_PROPOSE reserved for plan mode"
```

---

## Task 3: Runtime eval (caposaldo #2) + STATO

**Files:** Modify `docs/STATO.md`

- [ ] **Step 1: Start a debug gateway on a scratch data-dir with gemma4:12b**

Follow the finding-1.2 eval recipe (STATO): build/run the gateway in debug with a scratch data-dir and
the local model, e.g.:

```bash
HOMUN_DATA_DIR=$(mktemp -d) HOMUN_DEBUG=1 cargo run -p local-first-desktop-gateway 2>gateway.log &
```

Confirm the model is available: `curl -s http://127.0.0.1:11434/api/tags | grep gemma4`.

- [ ] **Step 2: Agent mode — the 1.2 prompt must now EXECUTE, not stall**

POST a decomposable multi-step prompt with `mode:"agent"` to `/api/chat/generate_stream` (the same
shape used in the 1.2 eval). Capture the stream to a file.

Expected: the stream contains an `update_plan` / `‹‹PLAN››` event and the turn PROCEEDS to act — it
does NOT emit `‹‹PLAN_PROPOSE››` and stop. (Grep the captured stream: `PLAN_PROPOSE` absent,
`update_plan` or `‹‹PLAN››` present.)

- [ ] **Step 3: Plan mode — still proposes and stops**

POST the same prompt with `mode:"plan"`.
Expected: the stream contains `‹‹PLAN_PROPOSE››` and the turn STOPS awaiting approval.

- [ ] **Step 4: Record the evidence**

Save the two captured streams under `scratchpad/` and note in the commit/STATO whether agent-executes /
plan-proposes were observed. If agent mode still stalls, STOP and reopen the design (do not claim done).

- [ ] **Step 5: Update STATO**

Add a rolling note in `docs/STATO.md`: finding 1.2 / C resolved — agent mode executes operationally,
plan mode proposes-and-stops, via `plan_directive_for_mode`; the unconditional base PLAN block removed;
unit tests + gemma4 agent/plan eval outcome; tier-adaptivity + subagents remain follow-ups.

- [ ] **Step 6: Commit**

```bash
git add docs/STATO.md
git commit -m "docs(stato): finding 1.2 / C — agent executes, plan proposes (mode-disambiguated)"
```

---

## Self-review notes (author)

- **Spec coverage:** seam + consts (Task 1) ✓; remove base block + remove plan arm + append per-mode
  (Task 2) ✓; ask empty / debug operational (Task 1 tests + `_` arm) ✓; runtime eval agent-executes /
  plan-proposes (Task 3) ✓; plan-precedence untouched (no edit to it) ✓; non-goals untouched ✓.
- **No placeholders:** every const/text and command is complete; the RED step uses an explicit stub.
- **Type consistency:** `plan_directive_for_mode(mode: &str) -> String`, consts `AGENT_OPENER` /
  `PLAN_OPENER` / `OPERATIONAL_BODY`, module `plan_directive` — identical across tasks. Caller uses
  `plan_directive.is_empty()` (String) — matches the return type.
- **Escaping:** consts are plain `&str` (not `format!` templates) so JSON braces `{` `}` are literal;
  the base-block being removed used `{{`/`}}` because it WAS inside a `format!` — that's why the removed
  text shows doubled braces and the new consts show single braces. Intentional, not a typo.
