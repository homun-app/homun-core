# Browser Semantic Effect Gate, Goal Budget, and Observability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser payment keyword gate with a model-declared, machine-floored, fail-closed effect gate; make the browse budget a function of the goal rather than the clock; persist protocol metrics; add per-call sidecar deadlines; and close two contract holes.

**Architecture:** Committing browser actions carry a required `action_class`. The Rust gate computes `effective = max(declared, machine_floor)` over a fixed lattice and enforces payment approval on `payment_commit`; the machine floor comes from the sidecar (cc-autocomplete fields, PSP-origin frames), never from label text. The keyword tables in `browser_safety.rs` and `crates/browser-automation/src/policy.rs` are deleted. Budget rounds scale from the result contract with progress as the primary limiter; wall-clock becomes a 90 s safety ceiling. Protocol events reach the execution journal via a real `GatewayJournal` on the browse sub-turn.

**Tech Stack:** Rust (workspace crates `local-first-desktop-gateway`, `local-first-engine`, `local-first-browser-automation`), TypeScript sidecar (`runtimes/browser-automation`, Playwright), serde_json.

**Spec:** `docs/superpowers/specs/2026-07-23-browser-semantic-effect-gate-and-budget-design.md`

## Global Constraints

- Worktree: `/Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery`, branch `fabio/browser-stream-recovery`. All paths below are relative to it.
- Comments in English; no `Co-Authored-By` trailer on commits; commit directly to the branch, do not push.
- The gate fails **closed**: a committing action with no resolvable class, a class/floor conflict, or an unavailable classifier requires approval — never silent execution.
- No new keyword/substring/regex table on natural-language content anywhere. Machine contracts (DOM attributes, frame origins) may only *raise* a class.
- Behind the existing temporary browser-protocol path; keyword tables are deleted only after the whole automated suite and the five live Trenitalia runs pass.
- Required green gates before shipping: `cargo test -p local-first-desktop-gateway`, `cargo test -p local-first-engine`, `cargo test -p local-first-browser-automation`, `npm --prefix runtimes/browser-automation test`, `npm --prefix apps/desktop run build`, `npm --prefix apps/desktop run test:ui-contract`.
- Action-class vocabulary is exactly `{ordinary, account, booking, payment_commit}` (from the approved Browser Effects design). No new class names.
- Known PSP origin set (machine identifiers, host suffixes): `stripe.com`, `js.stripe.com`, `checkout.stripe.com`, `adyen.com`, `paypal.com`, `braintreegateway.com`, `checkout.com`, `klarna.com`, `nexi.it`, `worldline.com`, `satispay.com`.

---

## File Structure

- `crates/desktop-gateway/src/browser_safety.rs` — **rewritten gate**: `ActionClass` lattice, `declared_action_class`, `effective_action_class`, `evaluate_browser_action`; `FINAL_PAYMENT_LABEL_PATTERNS` deleted. Keeps `is_committing_action`, `snapshot_label_for_ref` (card binding/display only).
- `crates/desktop-gateway/src/main.rs` — thread `payment_floor_refs` through `normalize_browser_action_bundle` and the `execute_browser_tool` enforcement site; add per-call sidecar deadline around `chat_browser_call`; contract-scaled round budget in the browse executor cfg; per-item bundle schema; record `BrowserProtocol` journal events; `browser_subturn` on the sub-turn cfg.
- `crates/browser-automation/src/policy.rs` — delete the mirrored `contains_final_payment_action` / `is_final_payment_action` / phrase table (no external callers).
- `crates/engine/src/config.rs` — add `browser_subturn: bool` to `TurnConfig`.
- `crates/engine/src/agent_loop.rs` — gate the `browser_done` terminal on `cfg.browser_subturn`.
- `crates/engine/src/execution_journal.rs` — add `AgentExecutionEvent::BrowserProtocol { round, boundary, payload }` + `into_parts` arm.
- `runtimes/browser-automation/src/browser/snapshot.ts` — compute `paymentFloorRefs` (machine-derived) and add to `BrowserSnapshot`.
- `runtimes/browser-automation/tests/` — payment-floor fixture + test; existing `train.html` fixture proves non-regression.

---

## Group A — Semantic effect gate

### Task A1: `ActionClass` lattice and declared-class parsing

**Files:**
- Modify: `crates/desktop-gateway/src/browser_safety.rs`

**Interfaces:**
- Produces: `pub enum ActionClass { Ordinary, Account, Booking, PaymentCommit }` (derives `PartialOrd`/`Ord` so `max` = lattice join); `pub fn declared_action_class(action: &Value) -> Option<ActionClass>`.

- [ ] **Step 1: Write the failing test.** Append to the `tests` module in `browser_safety.rs`:

```rust
#[test]
fn declared_class_parses_the_four_names_and_rejects_unknown() {
    use serde_json::json;
    assert_eq!(declared_action_class(&json!({"action_class":"ordinary"})), Some(ActionClass::Ordinary));
    assert_eq!(declared_action_class(&json!({"action_class":"account"})), Some(ActionClass::Account));
    assert_eq!(declared_action_class(&json!({"action_class":"booking"})), Some(ActionClass::Booking));
    assert_eq!(declared_action_class(&json!({"action_class":"payment_commit"})), Some(ActionClass::PaymentCommit));
    assert_eq!(declared_action_class(&json!({"action_class":"wat"})), None);
    assert_eq!(declared_action_class(&json!({"kind":"click"})), None);
}

#[test]
fn action_class_lattice_orders_payment_highest() {
    assert!(ActionClass::PaymentCommit > ActionClass::Booking);
    assert!(ActionClass::Booking > ActionClass::Account);
    assert!(ActionClass::Account > ActionClass::Ordinary);
    assert_eq!(ActionClass::Ordinary.max(ActionClass::PaymentCommit), ActionClass::PaymentCommit);
}
```

- [ ] **Step 2: Run test, verify it fails.** `cargo test -p local-first-desktop-gateway declared_class_parses -- --nocapture` → FAIL (`ActionClass` not found).

- [ ] **Step 3: Implement.** Add near the top of `browser_safety.rs` (after the `use serde_json::Value;` line):

```rust
/// The effect class of a committing browser action. Ordering is the safety
/// lattice: a machine floor may only raise the class, never lower it, so
/// `declared.max(floor)` is the effective class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ActionClass {
    Ordinary,
    Account,
    Booking,
    PaymentCommit,
}

/// The class the model declared on the action. `None` means it declared none —
/// which, for a committing action, is a fail-closed rejection (see
/// `evaluate_browser_action`), never an implicit "ordinary".
pub fn declared_action_class(action: &Value) -> Option<ActionClass> {
    match action.get("action_class").and_then(Value::as_str)? {
        "ordinary" => Some(ActionClass::Ordinary),
        "account" => Some(ActionClass::Account),
        "booking" => Some(ActionClass::Booking),
        "payment_commit" => Some(ActionClass::PaymentCommit),
        _ => None,
    }
}
```

- [ ] **Step 4: Run test, verify it passes.** `cargo test -p local-first-desktop-gateway declared_class_parses action_class_lattice -- --nocapture` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add crates/desktop-gateway/src/browser_safety.rs
git commit -m "feat(browser): add action_class lattice and declared-class parsing"
```

### Task A2: Rewrite the gate on effective class; delete the keyword table

**Files:**
- Modify: `crates/desktop-gateway/src/browser_safety.rs`

**Interfaces:**
- Consumes: `ActionClass`, `declared_action_class`, `is_committing_action` (A1 + existing).
- Produces:
  - `pub fn effective_action_class(action: &Value, payment_floor_refs: &HashSet<String>) -> Result<ActionClass, String>` — `Err(code)` on missing class or floor/declared conflict for committing actions; `Ok(class)` otherwise (non-committing → `Ordinary`).
  - `pub fn evaluate_browser_action(action: &Value, payment_floor_refs: &HashSet<String>, approved_payment_id: Option<&str>) -> Option<String>` — `None` = allow; `Some(reason)` = typed rejection. Replaces `high_risk_reason` / `high_risk_reason_with_payment_approval`.
  - `pub fn action_is_payment_commit(action: &Value, payment_floor_refs: &HashSet<String>) -> bool` — replaces `is_final_payment_action`.

- [ ] **Step 1: Write the failing tests.** Replace the whole existing `tests` module body's payment-specific tests (keep `blocks_evaluate`, `committing_detects_enter_press`, `hold_is_not_a_blanket_commit`) and add:

```rust
fn floor(refs: &[&str]) -> std::collections::HashSet<String> {
    refs.iter().map(|r| r.to_string()).collect()
}

#[test]
fn committing_action_without_class_is_rejected_fail_closed() {
    use serde_json::json;
    let reason = evaluate_browser_action(&json!({"kind":"click","ref":"e5"}), &floor(&[]), None).unwrap();
    assert!(reason.contains("BROWSER_ACTION_CLASS_MISSING"));
}

#[test]
fn ordinary_declared_committing_action_is_allowed_without_a_floor() {
    use serde_json::json;
    let action = json!({"kind":"click","ref":"e7","action_class":"ordinary"});
    assert!(evaluate_browser_action(&action, &floor(&[]), None).is_none());
}

#[test]
fn declared_below_payment_floor_is_a_conflict() {
    use serde_json::json;
    let action = json!({"kind":"click","ref":"e9","action_class":"booking"});
    let reason = evaluate_browser_action(&action, &floor(&["e9"]), None).unwrap();
    assert!(reason.contains("BROWSER_ACTION_CLASS_CONFLICT"));
}

#[test]
fn payment_commit_requires_matching_approval() {
    use serde_json::json;
    let action = json!({"kind":"click","ref":"e9","action_class":"payment_commit"});
    let blocked = evaluate_browser_action(&action, &floor(&[]), None).unwrap();
    assert!(blocked.contains("BROWSER_PAYMENT_APPROVAL_REQUIRED"));
    let approved = json!({"kind":"click","ref":"e9","action_class":"payment_commit","payment_approval_id":"pay_1"});
    assert!(evaluate_browser_action(&approved, &floor(&[]), Some("pay_1")).is_none());
}

#[test]
fn non_committing_action_needs_no_class() {
    use serde_json::json;
    assert!(evaluate_browser_action(&json!({"kind":"type","ref":"e1","text":"Napoli"}), &floor(&[]), None).is_none());
    assert!(evaluate_browser_action(&json!({"kind":"scroll"}), &floor(&[]), None).is_none());
}

#[test]
fn evaluate_kind_is_always_hazardous() {
    use serde_json::json;
    assert!(evaluate_browser_action(&json!({"kind":"evaluate"}), &floor(&[]), None).is_some());
}

#[test]
fn payment_floor_marks_effective_payment() {
    use serde_json::json;
    assert!(action_is_payment_commit(&json!({"kind":"click","ref":"e9","action_class":"payment_commit"}), &floor(&[])));
    assert!(action_is_payment_commit(&json!({"kind":"click","ref":"e9","action_class":"ordinary"}), &floor(&["e9"])));
    assert!(!action_is_payment_commit(&json!({"kind":"click","ref":"e7","action_class":"ordinary"}), &floor(&[])));
}
```

Also delete the now-obsolete tests that reference labels: `blocks_click_on_purchase_label`, `allows_click_on_search`, `allows_login_and_booking_but_blocks_payment`, `allows_type_into_field`, `allows_hold_on_human_challenge`, `blocks_hold_on_purchase_label`, `final_payment_click_requires_matching_payment_approval`, and the `SNAP` const.

- [ ] **Step 2: Run tests, verify they fail.** `cargo test -p local-first-desktop-gateway committing_action_without_class -- --nocapture` → FAIL (functions not found).

- [ ] **Step 3: Implement.** In `browser_safety.rs`: add `use std::collections::HashSet;` at the top. Delete `FINAL_PAYMENT_LABEL_PATTERNS`, `is_final_payment_action`, `high_risk_reason`, `high_risk_reason_with_payment_approval`. Keep `is_committing_action` and `snapshot_label_for_ref`. Add:

```rust
/// The floor for a ref is `PaymentCommit` when the sidecar's machine analysis
/// (cc-autocomplete fields, PSP-origin frame) marked it; otherwise `Ordinary`.
/// Floors are machine-derived and never read label text.
fn payment_floor_for(action: &Value, payment_floor_refs: &HashSet<String>) -> ActionClass {
    let is_floored = action
        .get("ref")
        .and_then(Value::as_str)
        .is_some_and(|r| payment_floor_refs.contains(r));
    if is_floored { ActionClass::PaymentCommit } else { ActionClass::Ordinary }
}

/// True when the action is committing (or `hold`). Payment gating only applies
/// to these; typing/scrolling/hovering are never gated.
fn is_gated_action(action: &Value) -> bool {
    is_committing_action(action) || action.get("kind").and_then(Value::as_str) == Some("hold")
}

/// Effective class for a committing action: `max(declared, machine_floor)`.
/// `Err` is a typed, fail-closed rejection the model must act on:
/// - `BROWSER_ACTION_CLASS_MISSING`: committing action declared no class;
/// - `BROWSER_ACTION_CLASS_CONFLICT`: a machine floor exceeds the declared class,
///   so the model must re-declare (as payment) rather than have the code silently
///   upgrade and proceed.
pub fn effective_action_class(
    action: &Value,
    payment_floor_refs: &HashSet<String>,
) -> Result<ActionClass, String> {
    if !is_gated_action(action) {
        return Ok(ActionClass::Ordinary);
    }
    let declared = declared_action_class(action).ok_or_else(|| {
        "BROWSER_ACTION_CLASS_MISSING: a committing action must declare action_class \
         (ordinary|account|booking|payment_commit)"
            .to_string()
    })?;
    let floor = payment_floor_for(action, payment_floor_refs);
    if floor > declared {
        return Err(format!(
            "BROWSER_ACTION_CLASS_CONFLICT: this control is a payment control; \
             re-declare action_class=payment_commit (was {declared:?})"
        ));
    }
    Ok(declared.max(floor))
}

/// True when the action's effective class is `PaymentCommit` (declared or floored).
/// Used to decide whether to claim a Payment Approval Card. A class error counts
/// as "treat as payment" so the gate below re-rejects it fail-closed.
pub fn action_is_payment_commit(action: &Value, payment_floor_refs: &HashSet<String>) -> bool {
    matches!(effective_action_class(action, payment_floor_refs), Ok(ActionClass::PaymentCommit) | Err(_))
        && is_gated_action(action)
}

/// The single browser action gate. `None` = allow. `Some(reason)` = typed
/// rejection. Never reads label text for the payment decision.
pub fn evaluate_browser_action(
    action: &Value,
    payment_floor_refs: &HashSet<String>,
    approved_payment_id: Option<&str>,
) -> Option<String> {
    if action.get("kind").and_then(Value::as_str) == Some("evaluate") {
        return Some(
            "BROWSER_HAZARDOUS_ACTION: arbitrary page script (evaluate) is not allowed".to_string(),
        );
    }
    let effective = match effective_action_class(action, payment_floor_refs) {
        Ok(class) => class,
        Err(reason) => return Some(reason),
    };
    if effective == ActionClass::PaymentCommit {
        let action_id = action.get("payment_approval_id").and_then(Value::as_str).unwrap_or("");
        if approved_payment_id.is_some_and(|approved| approved == action_id) {
            return None;
        }
        return Some(
            "BROWSER_PAYMENT_APPROVAL_REQUIRED: the final payment action needs a matching, \
             unconsumed Payment Approval Card"
                .to_string(),
        );
    }
    None
}
```

- [ ] **Step 4: Run tests, verify they pass.** `cargo test -p local-first-desktop-gateway --lib browser_safety` → PASS (note: this leaves `main.rs` callers broken; A3 fixes them, so the *crate* won't compile yet — run the module test via the `browser_safety` unit tests only, or proceed straight to A3 and build once).

- [ ] **Step 5: Commit.**

```bash
git add crates/desktop-gateway/src/browser_safety.rs
git commit -m "feat(browser): gate on effective action_class, delete payment keyword table"
```

### Task A3: Thread machine floors through the gateway enforcement site

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`normalize_browser_action_bundle` ~18303; `execute_browser_tool` enforcement ~22855-22931; `GatewayBrowserExecutor` struct ~26603 and its construction ~26981; `browser_snapshot_text` area for a floor extractor)

**Interfaces:**
- Consumes: `browser_safety::{effective_action_class, evaluate_browser_action, action_is_payment_commit}` (A2).
- Produces: `fn browser_floor_refs(value: &serde_json::Value) -> std::collections::HashSet<String>`; a `last_payment_floor_refs: std::collections::HashSet<String>` field on `GatewayBrowserExecutor`.

- [ ] **Step 1: Write the failing test.** Add to the gateway `tests` module (near the existing browser tests):

```rust
#[test]
fn browser_floor_refs_reads_sidecar_payment_floor() {
    let value = serde_json::json!({
        "snapshot": "- button \"Conferma\" [ref=e9]",
        "paymentFloorRefs": ["e9"]
    });
    let refs = super::browser_floor_refs(&value);
    assert!(refs.contains("e9"));
    assert_eq!(refs.len(), 1);

    let empty = serde_json::json!({ "snapshot": "- button \"Cerca\" [ref=e7]" });
    assert!(super::browser_floor_refs(&empty).is_empty());
}
```

- [ ] **Step 2: Run test, verify it fails.** `cargo test -p local-first-desktop-gateway browser_floor_refs_reads -- --nocapture` → FAIL (function not found).

- [ ] **Step 3: Implement.** Add the extractor next to `browser_snapshot_text`:

```rust
/// Machine-derived payment floor refs the sidecar attached to an observation.
/// Absent field → empty set. These raise (never lower) the effective action class.
fn browser_floor_refs(value: &serde_json::Value) -> std::collections::HashSet<String> {
    value
        .get("paymentFloorRefs")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}
```

Add the field to `GatewayBrowserExecutor` (struct + construction at ~26981, initialize `last_payment_floor_refs: std::collections::HashSet::new()`). Wherever the executor updates `*ctx.last_snapshot` from an act/navigate/snapshot result `value`, also set `self.last_payment_floor_refs = browser_floor_refs(&value);` (mirror every `last_snapshot` assignment in `execute_browser_tool`). Pass a reference to it through the action context so the enforcement site can read it.

Rewrite `normalize_browser_action_bundle` to take floors instead of a snapshot for the payment decision:

```rust
fn normalize_browser_action_bundle(
    action: &mut serde_json::Value,
    current_target: &str,
    payment_floor_refs: &std::collections::HashSet<String>,
) -> Option<String> {
    let actions = action.get("actions").and_then(serde_json::Value::as_array)?;
    if actions.len() > 4 {
        return Some("Browser action bundle rejected: use at most four actions from the current observation.".to_string());
    }
    for nested in actions {
        if nested.get("kind").and_then(serde_json::Value::as_str) == Some("batch")
            || nested.get("actions").is_some()
        {
            return Some("Browser action bundle rejected: nested bundles are not allowed.".to_string());
        }
        if browser_safety::action_is_payment_commit(nested, payment_floor_refs) {
            return Some("Payment actions cannot run inside a browser action bundle. Ask for the Payment Approval Card and execute the final payment as a standalone approved action.".to_string());
        }
        if let Some(reason) = browser_safety::evaluate_browser_action(nested, payment_floor_refs, None) {
            return Some(format!("Browser action bundle rejected: {reason}"));
        }
    }
    // ...unchanged tail: stamp kind=batch, chatBundle=true, inject target_id/targetId...
}
```

At the enforcement site (~22855-22931), replace the snapshot-based calls: pass `&self.last_payment_floor_refs` to `normalize_browser_action_bundle`; replace `browser_safety::is_final_payment_action(&action, ctx.last_snapshot)` with `browser_safety::action_is_payment_commit(&action, floor_refs)`; replace `browser_safety::high_risk_reason_with_payment_approval(&action, ctx.last_snapshot, approved_payment_id.as_deref())` with `browser_safety::evaluate_browser_action(&action, floor_refs, approved_payment_id.as_deref())`, where `floor_refs` is the executor's `last_payment_floor_refs`.

- [ ] **Step 4: Build + run tests.** `cargo test -p local-first-desktop-gateway browser -- --nocapture` → PASS; `cargo build -p local-first-desktop-gateway` → clean.

- [ ] **Step 5: Commit.**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(browser): enforce effect gate with machine payment floors"
```

### Task A4: Sidecar computes machine payment floors

**Files:**
- Modify: `runtimes/browser-automation/src/browser/snapshot.ts` (`BrowserSnapshot` type ~10; `createAiSnapshot` ~157)
- Create: `runtimes/browser-automation/tests/payment_floor.test.ts`
- Create: `runtimes/browser-automation/tests/fixtures/checkout.html`

**Interfaces:**
- Produces: `paymentFloorRefs: string[]` on `BrowserSnapshot`; `export async function computePaymentFloorRefs(page, refs, refLocators): Promise<string[]>`.

- [ ] **Step 1: Write the fixture.** `checkout.html`: a payment form and a search form.

```html
<!doctype html><meta charset="utf-8"><title>Checkout</title>
<form id="pay"><input autocomplete="cc-number" aria-label="Card number">
<button type="submit">Conferma</button></form>
<form id="find"><input aria-label="Cerca"><button type="submit">Cerca</button></form>
```

- [ ] **Step 2: Write the failing test.** `payment_floor.test.ts` (follows the pattern of the existing `browser_fixture.test.ts`: real `node:http` server + real `BrowserSessionManager`):

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { BrowserSessionManager } from "../src/browser/session_manager.js";

let server: http.Server; let base: string; let mgr: BrowserSessionManager;
before(async () => {
  const html = readFileSync(new URL("./fixtures/checkout.html", import.meta.url), "utf8");
  server = http.createServer((_r, res) => { res.setHeader("content-type","text/html"); res.end(html); });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}/`;
  mgr = new BrowserSessionManager({ headless: true });
});
after(async () => { await mgr.close?.(); server.close(); });

test("payment floor marks the cc-form submit but not the search submit", async () => {
  await mgr.navigate("chat_0", base);
  const snap = await mgr.snapshot("chat_0", { observationMode: "interact" });
  const conferma = snap.refs.find((r) => r.name === "Conferma")!.ref;
  const cerca = snap.refs.find((r) => r.name === "Cerca")!.ref;
  assert.ok(snap.paymentFloorRefs.includes(conferma), "cc-form submit is floored");
  assert.ok(!snap.paymentFloorRefs.includes(cerca), "search submit is not floored");
});
```

- [ ] **Step 3: Run test, verify it fails.** `npm --prefix runtimes/browser-automation test -- payment_floor` → FAIL (`paymentFloorRefs` undefined).

- [ ] **Step 4: Implement.** Add `paymentFloorRefs: string[];` to the `BrowserSnapshot` type. Add the helper and call it in `createAiSnapshot` before returning, populating the field. PSP host suffixes come from the Global Constraints list.

```ts
const PSP_HOST_SUFFIXES = [
  "stripe.com","js.stripe.com","checkout.stripe.com","adyen.com","paypal.com",
  "braintreegateway.com","checkout.com","klarna.com","nexi.it","worldline.com","satispay.com",
];

// Machine-only floor: a committing-capable ref is a payment control when its
// element sits in a <form> containing a cc-autocomplete input, or inside a frame
// whose origin is a known PSP. Never reads label text. Raise-only.
export async function computePaymentFloorRefs(
  refs: BrowserRef[],
  refLocators: Map<string, Locator>,
): Promise<string[]> {
  const floored: string[] = [];
  for (const r of refs) {
    if (r.role !== "button" && r.role !== "link") continue;
    const loc = refLocators.get(r.ref);
    if (!loc) continue;
    const isPay = await loc
      .evaluate((el, psp) => {
        const form = el.closest("form");
        const inForm = !!form && !!form.querySelector('input[autocomplete^="cc-"]');
        let origin = ""; try { origin = el.ownerDocument.defaultView?.location.origin ?? ""; } catch {}
        const host = (() => { try { return new URL(origin).hostname; } catch { return ""; } })();
        const inPsp = (psp as string[]).some((s) => host === s || host.endsWith("." + s));
        return inForm || inPsp;
      }, PSP_HOST_SUFFIXES)
      .catch(() => false);
    if (isPay) floored.push(r.ref);
  }
  return floored;
}
```

In `createAiSnapshot`, after `builtSnapshot` is available, add `const paymentFloorRefs = await computePaymentFloorRefs(builtSnapshot.refs, builtSnapshot.refLocators ?? new Map());` and include `paymentFloorRefs` in the returned object. In `createLegacySnapshot` set `paymentFloorRefs: []`.

- [ ] **Step 5: Run tests, verify pass + non-regression.** `npm --prefix runtimes/browser-automation test -- payment_floor` → PASS. `npm --prefix runtimes/browser-automation test -- browser_fixture` → PASS (train fixture has no cc-autocomplete/PSP → empty floor, ordinary submission unaffected).

- [ ] **Step 6: Commit.**

```bash
git add runtimes/browser-automation/src/browser/snapshot.ts runtimes/browser-automation/tests/payment_floor.test.ts runtimes/browser-automation/tests/fixtures/checkout.html
git commit -m "feat(browser): sidecar computes machine payment floor refs"
```

### Task A5: Delete the mirrored payment keyword table

**Files:**
- Modify: `crates/browser-automation/src/policy.rs` (delete `contains_final_payment_action` ~103, `is_final_payment_action` ~113, its phrase array; `is_committing_action`/`snapshot_label_for_ref` are only used by those two — delete if unused after).

**Interfaces:** none produced. Verified: no external callers of `contains_final_payment_action` (only self-recursion). `classify_tool_call` / `is_submit_key` are used by `task_executor.rs` and stay.

- [ ] **Step 1: Confirm no callers.** `grep -rn "contains_final_payment_action\|is_final_payment_action" crates/ runtimes/ | grep -v "policy.rs"` → expect no output.

- [ ] **Step 2: Delete.** Remove `contains_final_payment_action`, `is_final_payment_action`, the inline phrase array, and — if now unused — `is_committing_action` and `snapshot_label_for_ref` in `policy.rs`. Keep `classify_tool_call`, `action_requires_approval`, `is_submit_key`, `SimpleUrl`, private-network helpers.

- [ ] **Step 3: Build + test.** `cargo test -p local-first-browser-automation` → PASS; `cargo build -p local-first-browser-automation` → clean (fix any now-unused `use`/warnings).

- [ ] **Step 4: Commit.**

```bash
git add crates/browser-automation/src/policy.rs
git commit -m "refactor(browser): remove mirrored payment keyword table (converge on effect gate)"
```

---

## Group B — Goal budget

### Task B1: Contract-scaled round budget

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (browse executor cfg ~27027; add helper near it)

**Interfaces:**
- Consumes: `request.contract` (`local_first_engine::browse::BrowseResultContract` with `minimum_items: Option<usize>`, `fields: Vec<BrowseResultField{ name, required }>`).
- Produces: `fn browse_round_budget(contract: &local_first_engine::browse::BrowseResultContract) -> usize`.

- [ ] **Step 1: Write the failing test.** In the gateway `tests` module:

```rust
#[test]
fn browse_round_budget_scales_with_contract_shape() {
    use local_first_engine::browse::{BrowseResultContract, BrowseResultField, BrowseResultKind};
    let simple = BrowseResultContract { kind: BrowseResultKind::Fact, minimum_items: None, fields: vec![], boundary: None };
    assert_eq!(super::browse_round_budget(&simple), 5);

    let list = BrowseResultContract {
        kind: BrowseResultKind::List,
        minimum_items: Some(5),
        fields: vec![
            BrowseResultField { name: "departure".into(), required: true },
            BrowseResultField { name: "arrival".into(), required: true },
            BrowseResultField { name: "duration".into(), required: true },
            BrowseResultField { name: "price".into(), required: false },
        ],
        boundary: None,
    };
    // BASE 5 + ceil(3 required / 2)=2 + (minimum_items>3 ? 1 : 0)=1 = 8
    assert_eq!(super::browse_round_budget(&list), 8);
}

#[test]
fn browse_round_budget_never_exceeds_cap() {
    use local_first_engine::browse::{BrowseResultContract, BrowseResultField, BrowseResultKind};
    let huge = BrowseResultContract {
        kind: BrowseResultKind::List,
        minimum_items: Some(10),
        fields: (0..12).map(|i| BrowseResultField { name: format!("f{i}"), required: true }).collect(),
        boundary: None,
    };
    assert_eq!(super::browse_round_budget(&huge), 10);
}
```

- [ ] **Step 2: Run test, verify it fails.** `cargo test -p local-first-desktop-gateway browse_round_budget -- --nocapture` → FAIL.

- [ ] **Step 3: Implement.** Add near the browse executor:

```rust
/// Round budget scaled from the declared result contract. Progress (the engine's
/// `max_no_progress`) is the primary limiter; this only sizes the ceiling so a
/// richer goal gets proportionally more rounds. Deterministic, no model input.
fn browse_round_budget(contract: &local_first_engine::browse::BrowseResultContract) -> usize {
    const BASE: usize = 5;
    const CAP: usize = 10;
    let required = contract.fields.iter().filter(|f| f.required).count();
    let items_bonus = if contract.minimum_items.unwrap_or(0) > 3 { 1 } else { 0 };
    (BASE + required.div_ceil(2) + items_bonus).clamp(BASE, CAP)
}
```

- [ ] **Step 4: Run test, verify it passes.** `cargo test -p local-first-desktop-gateway browse_round_budget -- --nocapture` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(browser): scale round budget from the result contract"
```

### Task B2: Wire the budget; demote wall-clock to a safety ceiling

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (browse cfg ~27027-27048)

**Interfaces:** consumes `browse_round_budget` (B1).

- [ ] **Step 1: Edit the cfg.** In the browse executor `TurnConfig`, replace the three fixed round fields and the wall-clock:

```rust
let rounds = browse_round_budget(&request.contract);
let cfg = local_first_engine::TurnConfig {
    hard_round_ceiling: rounds,
    max_rounds: rounds,
    browser_max_rounds: rounds,
    browser_nav_cap: browse_subagent_nav_cap(),
    browser_budget: local_first_engine::config::BrowserBudget {
        // Wall-clock is a safety ceiling (a wedge backstop), aligned to the
        // acceptance gate's per-run maximum — NOT the success criterion. Progress
        // (`max_no_progress`) terminates a stalled run; the round budget sizes
        // how far a *progressing* run may go.
        max_elapsed_ms: 90_000,
        max_failed_navigations: 3,
        max_no_progress: 2,
    },
    context_window: None,
    reconcile_on_delivery: false,
    autoadvance_from_evidence: false,
    step_verification: false,
    verbose: verbose_debug(),
    forced_tool: None,
    browser_subturn: true, // set by Task E2; see below
};
```

Note: `browser_subturn` is added by Task E2 — if executing B before E, leave that field out until E2 adds it to the struct, then set it here.

- [ ] **Step 2: Build + smoke the existing browser tests.** `cargo test -p local-first-desktop-gateway browser -- --nocapture` → PASS (28 passed, 1 ignored baseline).

- [ ] **Step 3: Commit.**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(browser): budget by goal, wall-clock as safety ceiling"
```

---

## Group C — Durable protocol metrics

### Task C1: `BrowserProtocol` journal event

**Files:**
- Modify: `crates/engine/src/execution_journal.rs` (enum ~42-97; `into_parts` ~99+)

**Interfaces:**
- Produces: `AgentExecutionEvent::BrowserProtocol { round: usize, boundary: String, payload: Value }`.

- [ ] **Step 1: Write the failing test.** In the `execution_journal.rs` tests module (or add one):

```rust
#[test]
fn browser_protocol_event_maps_to_parts() {
    let event = AgentExecutionEvent::BrowserProtocol {
        round: 2,
        boundary: "action_bundle".to_string(),
        payload: serde_json::json!({ "action_kinds": ["click"], "stop_reason": "completed" }),
    };
    let (kind, round, value) = event.into_parts();
    assert_eq!(kind, "browser_protocol");
    assert_eq!(round, Some(2));
    assert_eq!(value["boundary"], "action_bundle");
}
```

- [ ] **Step 2: Run test, verify it fails.** `cargo test -p local-first-engine browser_protocol_event_maps -- --nocapture` → FAIL.

- [ ] **Step 3: Implement.** Add the variant to `AgentExecutionEvent` and an arm to `into_parts`:

```rust
BrowserProtocol {
    round: usize,
    boundary: String,
    payload: Value,
},
```

```rust
Self::BrowserProtocol { round, boundary, payload } => (
    "browser_protocol",
    Some(round),
    {
        let mut obj = payload.as_object().cloned().unwrap_or_default();
        obj.insert("boundary".to_string(), Value::String(boundary));
        Value::Object(obj)
    },
),
```

- [ ] **Step 4: Run test, verify it passes.** `cargo test -p local-first-engine browser_protocol_event_maps -- --nocapture` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add crates/engine/src/execution_journal.rs
git commit -m "feat(engine): add BrowserProtocol execution-journal event"
```

### Task C2: Record protocol events from the browse sub-turn

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`GatewayBrowserExecutor` struct + construction; each `push_browser_step(browser_protocol_event_summary(...))` site; browse cfg passes a real journal instead of `NoopExecutionJournal` at ~27061)

**Interfaces:** consumes `agent_journal::for_run(...) -> agent_journal::GatewayJournal`, `AgentExecutionEvent::BrowserProtocol` (C1). Produces `fn browser_protocol_journal_event(call_id: &str, boundary: &str, metrics: &Value) -> AgentExecutionEvent`.

- [ ] **Step 1: Write the failing test.** Mirror the existing `browser_event_summary_redacts_page_text_and_keeps_metrics` test:

```rust
#[test]
fn browser_protocol_journal_event_keeps_metrics_and_drops_page_text() {
    let metrics = serde_json::json!({
        "observation_chars": 5000, "refs": 12, "action_kinds": ["click","type"],
        "stop_reason": "completed", "page_text": "SECRET STATION NAMES"
    });
    let event = super::browser_protocol_journal_event("run_1", "action_bundle", &metrics);
    let (_kind, _round, value) = event.into_parts();
    assert_eq!(value["boundary"], "action_bundle");
    assert_eq!(value["stop_reason"], "completed");
    assert!(value.get("page_text").is_none(), "raw page text must not be journaled");
}
```

- [ ] **Step 2: Run test, verify it fails.** `cargo test -p local-first-desktop-gateway browser_protocol_journal_event_keeps -- --nocapture` → FAIL.

- [ ] **Step 3: Implement.** Add the builder reusing the existing redaction shape (same allow-list of metric keys as `browser_protocol_event_summary`; never copy `page_text`/`snapshot`):

```rust
/// Build a durable journal event from the same redacted metrics used for the
/// stderr/activity summary. Only the metric keys are carried — never raw page
/// text, secrets, or snapshots.
fn browser_protocol_journal_event(
    call_id: &str,
    boundary: &str,
    metrics: &serde_json::Value,
) -> local_first_engine::execution_journal::AgentExecutionEvent {
    const ALLOWED: &[&str] = &[
        "observation_chars","refs","action_kinds","stop_reason","generation",
        "completed_actions","unexecuted_actions","minimum_items","contract_fields",
        "contract_fp","item_count","fields_missing","status","elapsed_ms",
    ];
    let mut redacted = serde_json::Map::new();
    redacted.insert("child_run_id".to_string(), serde_json::Value::String(call_id.to_string()));
    if let Some(obj) = metrics.as_object() {
        for key in ALLOWED {
            if let Some(v) = obj.get(*key) { redacted.insert((*key).to_string(), v.clone()); }
        }
    }
    local_first_engine::execution_journal::AgentExecutionEvent::BrowserProtocol {
        round: 0,
        boundary: boundary.to_string(),
        payload: serde_json::Value::Object(redacted),
    }
}
```

- [ ] **Step 4: Run test, verify it passes.** `cargo test -p local-first-desktop-gateway browser_protocol_journal_event_keeps -- --nocapture` → PASS.

- [ ] **Step 5: Wire recording.** Give `GatewayBrowserExecutor` a `journal: agent_journal::GatewayJournal` field (constructed once via `agent_journal::for_run(self.agent_run_id.as_deref())` — thread `agent_run_id` into `GatewayBrowseExecutor`/`GatewayBrowserExecutor` from the enclosing `request.agent_run_id`). At each boundary that already calls `push_browser_step(browser_protocol_event_summary(call_id, boundary, metrics), ...)`, add `self.journal.record(browser_protocol_journal_event(call_id, boundary, &metrics));`. Replace `&local_first_engine::NoopExecutionJournal` at the sub-turn `run_turn` call (~27061) with a real `agent_journal::for_run(...)` handle so engine-emitted `BrowserBudgetExceeded` also persists.

- [ ] **Step 6: Build + test.** `cargo test -p local-first-desktop-gateway browser -- --nocapture` → PASS; `cargo build -p local-first-desktop-gateway` → clean.

- [ ] **Step 7: Commit.**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(browser): persist protocol metrics to the execution journal"
```

---

## Group D — Per-call sidecar deadline

### Task D1: Bound each sidecar RPC

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`chat_browser_call` ~31104; call sites in `execute_browser_tool`)

**Interfaces:** produces `fn browser_call_deadline(method: BrowserMethod) -> std::time::Duration`; a timeout wrapper around `chat_browser_call`.

- [ ] **Step 1: Write the failing test.** Deadlines are pure:

```rust
#[test]
fn sidecar_deadlines_match_the_budget() {
    use std::time::Duration;
    assert_eq!(super::browser_call_deadline(local_first_browser_automation::BrowserMethod::Navigate), Duration::from_secs(25));
    assert_eq!(super::browser_call_deadline(local_first_browser_automation::BrowserMethod::Act), Duration::from_secs(15));
    assert_eq!(super::browser_call_deadline(local_first_browser_automation::BrowserMethod::Snapshot), Duration::from_secs(10));
}
```

- [ ] **Step 2: Run test, verify it fails.** `cargo test -p local-first-desktop-gateway sidecar_deadlines_match -- --nocapture` → FAIL.

- [ ] **Step 3: Implement.** Add:

```rust
/// Per-call gateway deadline for a sidecar RPC. Bounds a wedged CDP call that
/// the sub-turn's between-rounds budget would otherwise miss until the 300s
/// manager deadline. All within the 90s sub-turn ceiling.
fn browser_call_deadline(method: local_first_browser_automation::BrowserMethod) -> std::time::Duration {
    use local_first_browser_automation::BrowserMethod::*;
    match method {
        Navigate => std::time::Duration::from_secs(25),
        Act => std::time::Duration::from_secs(15),
        _ => std::time::Duration::from_secs(10),
    }
}
```

Wrap the `chat_browser_call` awaits in `execute_browser_tool` with `tokio::time::timeout(browser_call_deadline(method), chat_browser_call(...))`. On `Err(_ elapsed)`, return the client as `None` (a wedged call cannot be reused) and produce a typed error string `"BROWSER_SIDECAR_TIMEOUT: the browser call exceeded its deadline"`, mapped to the bundle stop reason / error observation the loop already handles. No automatic retry.

- [ ] **Step 4: Run test + build.** `cargo test -p local-first-desktop-gateway sidecar_deadlines_match -- --nocapture` → PASS; `cargo build -p local-first-desktop-gateway` → clean.

- [ ] **Step 5: Commit.**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(browser): bound each sidecar call with a typed deadline"
```

---

## Group E — Hardening

### Task E1: Per-item bundle schema

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`browser_act_tool_schema` ~18245-18250)

**Interfaces:** none new; tightens the JSON schema `actions.items`.

- [ ] **Step 1: Write the failing test.** Assert the schema shape:

```rust
#[test]
fn browser_act_bundle_items_have_a_real_schema() {
    let schema = super::browser_act_tool_schema();
    let items = &schema["function"]["parameters"]["properties"]["actions"]["items"];
    let kinds = items["properties"]["kind"]["enum"].as_array().expect("kind enum");
    assert!(kinds.iter().any(|k| k == "click"));
    assert!(items["required"].as_array().expect("required").iter().any(|r| r == "kind"));
}
```

- [ ] **Step 2: Run test, verify it fails.** `cargo test -p local-first-desktop-gateway browser_act_bundle_items_have -- --nocapture` → FAIL.

- [ ] **Step 3: Implement.** Replace `"items": { "type": "object" }` with:

```rust
"items": {
    "type": "object",
    "properties": {
        "kind": { "type": "string", "enum": ["click","type","fill","select","select_option","press","press_key","hover","hold","scroll","scrollIntoView","wait"] },
        "ref": { "type": "string" },
        "text": { "type": "string" },
        "value": { "type": "string" },
        "key": { "type": "string" },
        "submit": { "type": "boolean" },
        "action_class": { "type": "string", "enum": ["ordinary","account","booking","payment_commit"] }
    },
    "required": ["kind"]
}
```

Also add the top-level `action_class` property to the tool's `properties` (same enum) so single actions can declare it, and update the tool `description` to state that committing actions must declare `action_class`.

- [ ] **Step 4: Run test + UI contract.** `cargo test -p local-first-desktop-gateway browser_act_bundle_items_have -- --nocapture` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(browser): schema-validate bundle items and expose action_class"
```

### Task E2: Scope `browser_done` to the sub-turn

**Files:**
- Modify: `crates/engine/src/config.rs` (`TurnConfig` ~57); `crates/engine/src/agent_loop.rs` (terminal ~781; test cfg ~1879); `crates/desktop-gateway/src/main.rs` (three `TurnConfig` literals: ~27027, ~27164, ~28909)

**Interfaces:** produces `TurnConfig.browser_subturn: bool`.

- [ ] **Step 1: Write the failing test.** In `agent_loop.rs` tests, add a variant asserting a non-subturn cfg does not terminate on a `browser_done`-named tool result. Adapt the existing `browser_done_tool_terminates_without_forced_synthesis` harness with `cfg.browser_subturn = false` and assert the loop does NOT set `final_done` from that tool:

```rust
#[tokio::test]
async fn browser_done_does_not_terminate_a_non_browser_subturn() {
    let mut config = cfg();
    config.browser_subturn = false;
    // ... drive one round whose tool call is name="browser_done" ...
    // assert the run did NOT finish via the browser_done terminal (it continues/among normal tools)
}
```

- [ ] **Step 2: Run test, verify it fails.** `cargo test -p local-first-engine browser_done_does_not_terminate -- --nocapture` → FAIL (field missing / still terminates).

- [ ] **Step 3: Implement.** Add `pub browser_subturn: bool,` to `TurnConfig`. Gate the terminal:

```rust
if cfg.browser_subturn && name == "browser_done" && !result.trim().is_empty() {
```

Set `browser_subturn: true` in the browse sub-turn cfg (main.rs ~27027) and `false` in the other two production literals (~27164, ~28909) and the `cfg()` test helper (~1879, default `true` there to keep the existing browser_done test green, or set per-test).

- [ ] **Step 4: Run tests, verify pass.** `cargo test -p local-first-engine browser_done -- --nocapture` → PASS (both the terminate-in-subturn and not-terminate-outside tests).

- [ ] **Step 5: Commit.**

```bash
git add crates/engine/src/config.rs crates/engine/src/agent_loop.rs crates/desktop-gateway/src/main.rs
git commit -m "fix(browser): scope browser_done terminal to the browser sub-turn"
```

---

## Final gates (run after all tasks)

- [ ] `cargo test -p local-first-engine` → all pass
- [ ] `cargo test -p local-first-browser-automation` → all pass
- [ ] `cargo test -p local-first-desktop-gateway` → all pass (browser suite ≥ prior 28 passed baseline)
- [ ] `npm --prefix runtimes/browser-automation test` → payment_floor + browser_fixture pass
- [ ] `npm --prefix apps/desktop run build && npm --prefix apps/desktop run test:ui-contract` → pass
- [ ] `git diff --check` → clean
- [ ] **Live gate (manual, gated release):** five consecutive Trenitalia searches per the spec Acceptance Criteria — ≥3 solutions, one `browse`, median < 60 s, no run > 90 s, no booking/payment crossing, one terminal event; plus one synthetic Payment Approval Card check with fake data. Only after green: delete the temporary browser-protocol flag and the old path.

## Notes for the implementer

- The gate never reads label text for the payment decision — that is the whole point. `snapshot_label_for_ref` survives only for Payment Approval Card binding/display; if a control has no label, bind the card on `ref` + snapshot generation.
- Fail-closed is the invariant: any ambiguity (missing class, floor conflict, sidecar timeout mid-checkout) must end in "ask for approval / stop", never "proceed".
- Do not reintroduce a keyword table as a "safety net". The raise role belongs to machine floors; the grant belongs to the user-signed card.
