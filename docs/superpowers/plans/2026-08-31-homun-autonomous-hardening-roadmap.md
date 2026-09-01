# Homun Autonomous Hardening Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spend the next autonomous work window closing real Homun core regressions by reproducing live scenarios, fixing one bug class at a time, and committing only evidence-backed changes.

**Architecture:** Treat `turn_events`, `agent_runs`, runtime plans, HITL waits, receipts, and kernel projection as the source of truth. Browser, automation, MCP, model routing, memory, privacy, and coding scenarios must pass through those canonical owners; UI text or model prose is never sufficient evidence. Add focused tests before code changes, then verify with `kernel_regression_gate.py`, `pre_release_gate.py`, and selected live package smokes.

**Tech Stack:** Rust workspace (`crates/engine`, `crates/task-runtime`, `crates/desktop-gateway`), Electron/React desktop (`apps/desktop`), SQLite runtime profile (`~/.homun/homun.sqlite` for real smoke evidence), Python smoke/audit scripts, Node unit tests.

---

## Operating Rules For This Work Window

- Work on `main` only if the tree is clean; otherwise create a `fabio/<topic>` branch.
- Do not mutate the real profile to hide old debt; live smoke may create diagnostic rows, but passing runner cleanup should remove successful smoke threads.
- A bug is closed only when the canonical owner is verified, not when the visible chat text looks plausible.
- Prefer one commit per closed bug class.
- Stop and report if a live run would require a real payment, real external write, or destructive filesystem action.

## Target Sequence

1. Close S6 browser form-fill functional failure.
2. Re-run browser and approval smoke subset: S5, S6, S7, S8, S9.
3. Exercise automation/MCP/model-routing scenario subset: X1, X2, X4, X6 if available, and SUB1 if the ignored probe can run locally.
4. Run integrity audits after the scenario tranche and classify new findings.
5. Commit every verified fix; leave red scenario evidence explicit when not fixed.

## Current Checkpoint - 2026-08-31 Evening

- Browser delegation now pre-navigates direct URL goals, seeds initial observations, forces `browser_done` only inside browser sub-turns, and keeps S5/S8/S9 package smokes guarded by semantic validators.
- S8 Payment Approval is the active reference for guarded checkout work: the browser sub-turn must return visible checkout facts with a fact contract, and the smoke harness treats a canonical `payment_approval` event as the success marker even if the runtime plan remains open for user approval.
- The next autonomous tranche should start with extended scenarios X1/X2/X4/X6, then inspect long-running lifecycle/budget behavior before returning to public release readiness.
- Do not treat addon architecture as closed in this plan; keep it as a separate product-design session.

## Current Checkpoint - 2026-09-01 Morning

- S6 Browser form fill passed on the packaged gateway after the engine began emitting a final structured `PlanUpdate` when delivery reconciliation closes the last open plan step.
- S7 Dead URL plan settles passed on the same packaged gateway; the URL-failure path did not hang or surface browser-unavailable fallbacks.
- S8 briefly regressed by completing with checkout facts while only claiming "Payment Approval Card already presented"; the engine now treats prose-only Payment Approval Card claims as a repair nudge and admits `PAYMENT_APPROVAL` as an actionable hold card.
- Latest packaged smoke evidence: S5 passed in 282.5s, S6 in 59.3s, S7 in 81.3s, S8 in 75.2s, and S9 in 163.4s. Functional green, but discovery latency remains a product-readiness risk.
- Extended packaged smoke evidence: X1, X2, X3, X4, X5, and X6 passed against the packaged gateway.
- Real-profile audit now distinguishes legitimate `waiting_user_approval` HITL turns from active-turn corruption; after that invariant fix, the audit reports 56 errors and 218 warnings from historical/current profile debt.
- Next tranche: inspect long-running lifecycle/action-budget invariants with canonical `agent_runs`, `runtime_plans`, `turn_events`, and integrity audit output.

---

### Task 1: Reproduce And Diagnose S6 Browser Form Fill

**Files:**
- Read: `/Users/fabio/Projects/Homun/app/scripts/production_smoke.py`
- Read: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/gateway_tool_execution.rs`
- Read: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/gateway_browser_tools.rs`
- Read: `/Users/fabio/Projects/Homun/app/crates/engine/src/agent_loop.rs`
- Possible modify: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/gateway_browser_tools.rs`
- Possible modify: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/gateway_tool_execution.rs`
- Possible modify: `/Users/fabio/Projects/Homun/app/crates/engine/src/agent_loop.rs`
- Test: focused Rust tests near the changed owner

- [ ] **Step 1: Confirm clean starting state**

Run:

```bash
git status --short
```

Expected: no output.

- [ ] **Step 2: Start a packaged local gateway with the current release binary**

Run:

```bash
cargo build -p local-first-desktop-gateway --release
cd apps/desktop && npm run package:smoke
```

Expected: `Prepared Electron resources` and a running gateway on `127.0.0.1:18766`.

- [ ] **Step 3: Verify the packaged binary is current**

Run from repo root:

```bash
curl -fsS http://127.0.0.1:18766/api/health
shasum -a 256 /Users/fabio/.cache/cargo-target/release/local-first-desktop-gateway apps/desktop/.package/resources/bin/local-first-desktop-gateway
```

Expected: health `ok:true`; both hashes identical.

- [ ] **Step 4: Reproduce S6**

Run:

```bash
python3 scripts/production_smoke.py --profile all --scenario S6 --gateway-base http://127.0.0.1:18766
```

Expected current failure: `FAIL S6: unexpected terminal status failed`.

- [ ] **Step 5: Extract canonical evidence for the latest S6 turn**

Run:

```bash
LATEST_TURN=$(sqlite3 "$HOME/.homun/homun.sqlite" "select turn_id from agent_runs where turn_id like 'turn_production-smoke-s6-%' order by started_at desc limit 1;")
sqlite3 "$HOME/.homun/homun.sqlite" "select run_id,turn_id,attempt,status,terminal_reason,started_at,completed_at from agent_runs where turn_id='$LATEST_TURN';"
sqlite3 "$HOME/.homun/homun.sqlite" "select seq,kind,substr(payload_json,1,600) from turn_events where turn_id='$LATEST_TURN' order by seq;"
```

Expected: terminal status is `failed` or a reproducible non-success; event sequence shows exactly where progress stopped.

- [ ] **Step 6: Identify the canonical owner of the failure**

Run:

```bash
rg -n "browser_act|browser_done|outcome_hint|semantic|web-form|Text input|text input|fill" crates/desktop-gateway crates/engine scripts/production_smoke.py
```

Expected: one owner emerges: browser action outcome classification, browser subagent prompt, or S6 success detector. Do not patch UI-only code for a runtime failure.

---

### Task 2: Fix One S6 Bug Class With TDD

**Files:**
- Modify only the owner found in Task 1.
- Test beside the owner:
  - Gateway owner: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/gateway_browser_tools.rs` or `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/gateway_tool_execution.rs`
  - Engine owner: `/Users/fabio/Projects/Homun/app/crates/engine/src/agent_loop.rs`
  - Smoke harness owner: `/Users/fabio/Projects/Homun/app/scripts/test_production_smoke.py`

- [ ] **Step 1: Write the failing owner-level test**

If the failure is a browser result incorrectly classified as progress, add a test equivalent to:

```rust
#[test]
fn form_fill_without_committed_value_is_no_progress() {
    let result = classify_browser_action_result(
        "type",
        r#"{"ok":true,"changed":false,"value":"","snapshot":"Text input"}"#,
    );
    assert_eq!(result.outcome_hint, ToolOutcomeHint::NoProgress);
}
```

If the failure is a completed field not recognized by S6, add a Python test in `scripts/test_production_smoke.py` that feeds assistant text plus event evidence containing `Text input=smoke` and asserts S6 success.

- [ ] **Step 2: Run the focused test and require RED**

Run the exact focused command for the touched owner, for example:

```bash
cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway browser_outcome_hint_tests -- --nocapture
```

Expected: the new test fails for the observed reason.

- [ ] **Step 3: Patch the owner minimally**

Implement only the rule required by the failing test. Examples of acceptable rule shapes:

```rust
// A type/fill action counts as progress only when the field value is committed
// or the snapshot semantically changes in a user-visible way.
```

or:

```python
# S6 success requires canonical browser evidence that the requested field holds
# the expected smoke value, not just generic assistant prose.
```

- [ ] **Step 4: Verify GREEN locally**

Run:

```bash
cargo fmt
cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway browser_outcome_hint_tests -- --nocapture
python3 -m unittest scripts.test_production_smoke -v
```

Expected: relevant focused tests pass. If the touched owner is engine, replace the first cargo command with `cargo test -p local-first-engine delegated_browse -- --nocapture`.

- [ ] **Step 5: Re-run live S6**

Run:

```bash
python3 scripts/production_smoke.py --profile all --scenario S6 --gateway-base http://127.0.0.1:18766
```

Expected target: `PASS S6`. If it still fails, keep the preserved failed thread and repeat Task 1 with the new terminal evidence.

- [ ] **Step 6: Commit the closed bug class**

Run:

```bash
git status --short
git diff --check
git add <changed-files>
git commit -m "Fix browser form fill smoke"
git push
```

Expected: commit pushed; no unrelated files included.

---

### Task 3: Browser And Approval Smoke Tranche

**Files:**
- Read: `/Users/fabio/Projects/Homun/app/docs/testing/usage-scenarios.md`
- Read/possible modify: `/Users/fabio/Projects/Homun/app/scripts/production_smoke.py`
- Read/possible modify: `/Users/fabio/Projects/Homun/app/scripts/test_production_smoke.py`
- Possible modify: browser/approval runtime owner identified by failing scenario

- [ ] **Step 1: Run browser baseline subset**

Run:

```bash
python3 scripts/production_smoke.py --profile all --scenario S5 --gateway-base http://127.0.0.1:18766
python3 scripts/production_smoke.py --profile all --scenario S6 --gateway-base http://127.0.0.1:18766
python3 scripts/production_smoke.py --profile all --scenario S7 --gateway-base http://127.0.0.1:18766
python3 scripts/production_smoke.py --profile all --scenario S9 --gateway-base http://127.0.0.1:18766
```

Expected: S5/S7/S9 pass or fail with canonical terminal evidence; S6 should pass only after Task 2.

- [ ] **Step 2: Run payment approval subset**

Run:

```bash
python3 scripts/production_smoke.py --profile all --scenario S8 --gateway-base http://127.0.0.1:18766
```

Expected target: either a real `PAYMENT_APPROVAL` marker/card with no completed payment, or a red failure that preserves diagnostic evidence. A simulated text-only approval is a failure.

- [ ] **Step 3: For every failing scenario, record canonical ids**

Run:

```bash
sqlite3 "$HOME/.homun/homun.sqlite" "select turn_id,status,terminal_reason,started_at,completed_at from agent_runs where turn_id like 'turn_production-smoke-%' order by started_at desc limit 20;"
```

Expected: each failed scenario has a `turn_id`, `run_id`, terminal status, and events available for diagnosis.

---

### Task 4: Automation, MCP, Model Routing, And Coding Scenario Tranche

**Files:**
- Read/possible modify: `/Users/fabio/Projects/Homun/app/scripts/production_smoke.py`
- Read/possible modify: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/gateway_automation_routes.rs`
- Read/possible modify: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/gateway_automation_tools.rs`
- Read/possible modify: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/gateway_mcp_runtime.rs`
- Read/possible modify: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/gateway_mcp_connections.rs`
- Read/possible modify: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/gateway_model_routing.rs`
- Read/possible modify: `/Users/fabio/Projects/Homun/app/apps/desktop/src/lib/composerTurnContract.mjs`

- [ ] **Step 1: Run automation dry-run/lifecycle smoke**

Run:

```bash
python3 scripts/production_smoke.py --profile extended --scenario X1 --gateway-base http://127.0.0.1:18766
```

Expected: automation test does not create an active unintended schedule; response exposes state/id/next action.

- [ ] **Step 2: Run skill/tool selection smoke**

Run:

```bash
python3 scripts/production_smoke.py --profile extended --scenario X2 --gateway-base http://127.0.0.1:18766
```

Expected: skill/tool selection is explainable and creates no unexpected files.

- [ ] **Step 3: Run coding workspace routing smoke**

Run:

```bash
python3 scripts/production_smoke.py --profile extended --scenario X4 --gateway-base http://127.0.0.1:18766
```

Expected: real temporary workspace is used; `CODE_CONTEXT_OK`; no unexpected file modifications outside the fixture.

- [ ] **Step 4: Run MCP stdio lifecycle if scenario id is present**

Run:

```bash
python3 scripts/production_smoke.py --profile extended --scenario X6 --gateway-base http://127.0.0.1:18766
```

Expected if present: connect/list/disconnect with scoped cleanup. If the runner reports no such scenario, inspect `scripts/production_smoke.py` and do not invent a pass.

- [ ] **Step 5: Run subagent probe if local model/tooling is available**

Run:

```bash
cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway orchestrated_subagent_gathers_on_gemma4 -- --ignored --nocapture
```

Expected: either `SubagentTask` reaches `Done` with summary, or failure is classified as model/tool availability rather than hidden parent success.

---

### Task 5: Integrity Audit And Gate Closure

**Files:**
- Read/possible modify: `/Users/fabio/Projects/Homun/app/scripts/audit_homun_state.py`
- Read/possible modify: `/Users/fabio/Projects/Homun/app/scripts/test_audit_homun_state.py`
- Read/possible modify: `/Users/fabio/Projects/Homun/app/crates/task-runtime/src/store.rs`
- Read/possible modify: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/gateway_integrity_audit.rs`

- [ ] **Step 1: Run read-only runtime audit**

Run:

```bash
python3 scripts/audit_homun_state.py
```

Expected: report current real-profile debt without modifying it.

- [ ] **Step 2: Classify newly introduced findings**

Run:

```bash
python3 scripts/audit_homun_state.py > /tmp/homun-audit-after-scenarios.json
python3 -m json.tool /tmp/homun-audit-after-scenarios.json >/tmp/homun-audit-after-scenarios.pretty.json
```

Expected: new scenario-generated issues are distinguishable from historical debt by ids/timestamps.

- [ ] **Step 3: Run regression gates**

Run:

```bash
python3 scripts/kernel_regression_gate.py
python3 scripts/pre_release_gate.py
```

Expected: both end with `== ALL GREEN ==`.

- [ ] **Step 4: Commit any additional verified fix**

Run:

```bash
git status --short
git diff --check
git add <changed-files>
git commit -m "<specific verified bug class>"
git push
```

Expected: pushed commit per bug class; no generated smoke artifacts committed.

---

## Stop Conditions

- Stop after 3 to 4 hours with a concise report even if more red scenarios remain.
- Stop immediately if the next fix would touch addon architecture or plugin governance deeply; that is a separate session.
- Stop if a live scenario requires real credentials, a real payment, or non-test external writes.
- Before final report, kill `package:smoke`, Electron, gateway, and channel sidecars used for testing.
