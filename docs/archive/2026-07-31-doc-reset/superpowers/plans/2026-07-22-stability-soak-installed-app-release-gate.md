# Stability Soak And Installed-App Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedire il rilascio finché concorrenza, restart, reasoning, browser e noVNC non sono verificati sull'app reale.

**Architecture:** Un soak API riproducibile valida gli invarianti server; il pre-release gate esegue suite Rust/desktop e soak. Una checklist installata raccoglie evidenza visiva separata dai test automatici.

**Tech Stack:** Python 3 standard library, Cargo, Node, Electron, existing pre-release gate.

---

## File structure

- Create `scripts/stability_soak.py` and `scripts/test_stability_soak.py`.
- Modify `scripts/pre_release_gate.py` and its test.
- Create `docs/qa/homun-stability-installed-app-gate.md`.
- Modify `docs/STATO.md` only with measured results.

### Task 1: Costruire il soak concorrente

**Files:**
- Create: `scripts/stability_soak.py`
- Create: `scripts/test_stability_soak.py`

- [ ] **Step 1: Write RED invariant tests**

```python
import unittest
from scripts.stability_soak import evaluate

class StabilitySoakTest(unittest.TestCase):
    def test_rejects_focus_change_duplicate_terminal_and_reasoning(self):
        result = evaluate([
            {"thread":"b", "kind":"selected"},
            {"thread":"a", "kind":"selected"},
            {"thread":"a", "kind":"done", "assistant_id":"x"},
            {"thread":"a", "kind":"done", "assistant_id":"y", "text":"‹‹REASONING››raw"},
        ], expected_selected="b")
        self.assertFalse(result["passed"])
        self.assertIn("focus_changed", result["violations"])
        self.assertIn("duplicate_terminal", result["violations"])
        self.assertIn("reasoning_leak", result["violations"])
```

- [ ] **Step 2: Run RED**

Run: `python3 -m unittest scripts/test_stability_soak.py -v`

- [ ] **Step 3: Implement evaluator and live runner**

`evaluate` groups by turn, requires at most one terminal and assistant id, rejects reasoning markers, and checks that background events do not alter the expected selected task. The CLI creates three tasks through the gateway, submits `TEST-A/B/C`, consumes WebSocket/event replay, restarts the gateway when `--restart` is passed, then writes a bounded JSON report with ids/timings but no prompt contents.

```python
def evaluate(events, expected_selected):
    violations = set(); terminals = {}; assistants = {}
    for event in events:
        if event.get("kind") == "selected" and event.get("thread") != expected_selected: violations.add("focus_changed")
        if event.get("kind") in {"done", "error", "cancelled"}:
            turn = event.get("turn", event.get("thread")); terminals[turn] = terminals.get(turn, 0) + 1
            assistants.setdefault(turn, set()).add(event.get("assistant_id"))
        if "REASONING" in event.get("text", "") or "<think" in event.get("text", ""): violations.add("reasoning_leak")
    if any(v > 1 for v in terminals.values()) or any(len(v) > 1 for v in assistants.values()): violations.add("duplicate_terminal")
    return {"passed": not violations, "violations": sorted(violations)}
```

- [ ] **Step 4: Verify and commit**

```bash
python3 -m unittest scripts/test_stability_soak.py -v
python3 scripts/stability_soak.py --help
git add scripts/stability_soak.py scripts/test_stability_soak.py
git commit -m "test(stability): add concurrent turn soak"
```

### Task 2: Inserire i gate automatici nel pre-release

**Files:**
- Modify: `scripts/pre_release_gate.py`
- Modify: `scripts/test_pre_release_gate.py`

- [ ] **Step 1: Write RED gate inventory test**

```python
def test_stability_steps_are_required():
    names = [step.name for step in build_steps(include_live=False)]
    assert "task runtime tests" in names
    assert "desktop attention tests" in names
    assert "stability soak unit tests" in names
```

- [ ] **Step 2: Run RED**

Run: `python3 -m unittest scripts/test_pre_release_gate.py -v`

- [ ] **Step 3: Add exact steps**

Add commands for `cargo test -p local-first-task-runtime`, `cargo test -p local-first-engine`, gateway tests, `npm run test:electron`, `npm run test:ui-contract`, `npm run build`, attention/replay/visible-content tests, package/noVNC tests and soak unit tests. With live credentials, run `stability_soak.py --restart` last.

- [ ] **Step 4: Verify and commit**

```bash
python3 -m unittest scripts/test_pre_release_gate.py scripts/test_stability_soak.py -v
python3 scripts/pre_release_gate.py --help
git add scripts/pre_release_gate.py scripts/test_pre_release_gate.py
git commit -m "test(release): require Homun stability gates"
```

### Task 3: Eseguire gate app installata

**Files:**
- Create: `docs/qa/homun-stability-installed-app-gate.md`
- Modify: `docs/STATO.md`

- [ ] **Step 1: Write the immutable checklist**

The document requires: installed build/version; three concurrent tasks completed out of order; fixed teal unread dot; zero auto-navigation; retry then one bubble; restart recovery; raw reasoning absent; browser bounded failure; noVNC `connected`; skill publisher visible; proactive source/freshness visible. Each row records timestamp, PASS/FAIL and artifact path.

- [ ] **Step 2: Run all automatic gates**

```bash
python3 scripts/pre_release_gate.py
mkdir -p artifacts/qa
python3 scripts/stability_soak.py --restart --output artifacts/qa/stability-soak.json
```

Expected: every step and soak invariant passes; a hung or excluded suite is recorded as FAIL, not green.

- [ ] **Step 3: Verify the installed app and record evidence**

Capture desktop and compact-width screenshots plus a short screen recording under `artifacts/qa/`. Inspect `~/.homun/logs/turn-trace.jsonl` and `gateway.log` for duplicate terminal, reasoning leak, fail-open privacy and unbounded browser activity.

- [ ] **Step 4: Update status and commit evidence pointers**

```bash
git add docs/qa/homun-stability-installed-app-gate.md docs/STATO.md
git commit -m "docs(release): record installed-app stability evidence"
```
