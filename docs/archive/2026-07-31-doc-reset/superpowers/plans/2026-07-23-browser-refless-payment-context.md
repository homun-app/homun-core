# Ref-less Payment Context — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Floor ref-less committing browser actions (Enter/Return submit) to `payment_commit` when the focus is in a machine-detected payment context, and typed-reject `clickCoords`/unknown committing kinds in the browse path.

**Architecture:** The sidecar adds a machine-only `focusPaymentContext` boolean (activeElement inside a cc-autocomplete form or a PSP-origin frame) to every observation. The gateway threads it (plus a bundle-predecessor inference) into `effective_action_class` as a page-level floor that only raises. `clickCoords` and committing kinds outside the schema enum are rejected before the gate.

**Tech Stack:** Rust (`local-first-desktop-gateway`), TypeScript sidecar (`runtimes/browser-automation`, Playwright).

**Spec:** `docs/superpowers/specs/2026-07-23-browser-refless-payment-context-design.md`

## Global Constraints

- Worktree `/Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery`, branch `fabio/browser-stream-recovery`. Every subagent: `cd` into the worktree and confirm `git branch --show-current` before any edit/commit; use absolute worktree paths; run git as `git -C <worktree>`; never touch `/Users/fabio/Projects/Homun/app/crates|runtimes/...` (branch `main`). If a `cargo -p` result looks wrong, re-run from inside the worktree.
- Comments in English; no `Co-Authored-By` trailer; commit on the branch, do not push.
- Machine-only signals: `autocomplete="cc-*"` + frame origin against the PSP host-suffix list. No label/keyword text in any payment decision.
- Floors only raise; fail-closed on ambiguity.
- PSP host suffixes (reuse the existing list in `snapshot.ts`): `stripe.com`, `js.stripe.com`, `checkout.stripe.com`, `adyen.com`, `paypal.com`, `braintreegateway.com`, `checkout.com`, `klarna.com`, `nexi.it`, `worldline.com`, `satispay.com`.
- Required green gates: `cargo test -p local-first-desktop-gateway`, `npm --prefix runtimes/browser-automation test`.

---

## File Structure

- `crates/desktop-gateway/src/browser_safety.rs` — `effective_action_class` gains a `focus_payment_context: bool` page-floor input; new `is_refless_committing`; `action_is_payment_commit`/`evaluate_browser_action` thread the bool.
- `crates/desktop-gateway/src/main.rs` — `browser_focus_payment_context` extractor; `last_focus_payment_context` on `GatewayBrowserExecutor`; per-action context computed at the enforcement site and per nested item in `normalize_browser_action_bundle` (bundle-predecessor inference); `clickCoords`/unknown-committing-kind typed reject.
- `runtimes/browser-automation/src/browser/snapshot.ts` — `focusPaymentContext` on `BrowserSnapshot`, computed in `createAiSnapshot` (`false` in `createLegacySnapshot`).
- `runtimes/browser-automation/src/browser/session_manager.ts` — carry `focusPaymentContext` on the `snapshot()` and `act()` return objects (same two sites as `paymentFloorRefs`).
- `runtimes/browser-automation/tests/` — extend `payment_floor.test.ts` (or a sibling) with focus-context cases; reuse the `checkout.html` fixture.

---

## Task 1: Rust — page floor for ref-less committing actions + clickCoords reject

**Files:**
- Modify: `crates/desktop-gateway/src/browser_safety.rs`
- Modify: `crates/desktop-gateway/src/main.rs` (`GatewayBrowserExecutor` struct + construction; `browser_floor_refs` neighbourhood; `normalize_browser_action_bundle`; the `execute_browser_tool` enforcement site)

**Interfaces:**
- Produces: `pub fn is_refless_committing(action: &Value) -> bool`; `effective_action_class(action, payment_floor_refs, focus_payment_context: bool)`; `action_is_payment_commit(action, payment_floor_refs, focus_payment_context: bool)`; `evaluate_browser_action(action, payment_floor_refs, focus_payment_context: bool, approved_payment_id)`; `fn browser_focus_payment_context(value: &serde_json::Value) -> bool`; `last_focus_payment_context: bool` on `GatewayBrowserExecutor`.

- [ ] **Step 1: Write the failing tests** (append to the `browser_safety.rs` tests module):

```rust
#[test]
fn refless_enter_in_focus_payment_context_conflicts_when_underdeclared() {
    use serde_json::json;
    let enter = json!({"kind":"press","key":"Enter","action_class":"ordinary"});
    // focus in a cc-form → page floor raises to payment_commit → conflict with ordinary
    let reason = evaluate_browser_action(&enter, &floor(&[]), true, None).unwrap();
    assert!(reason.contains("BROWSER_ACTION_CLASS_CONFLICT"));
}

#[test]
fn refless_enter_declared_payment_needs_approval_then_allowed() {
    use serde_json::json;
    let enter = json!({"kind":"press","key":"Enter","action_class":"payment_commit"});
    assert!(evaluate_browser_action(&enter, &floor(&[]), true, None).unwrap().contains("BROWSER_PAYMENT_APPROVAL_REQUIRED"));
    let approved = json!({"kind":"press","key":"Enter","action_class":"payment_commit","payment_approval_id":"p1"});
    assert!(evaluate_browser_action(&approved, &floor(&[]), true, Some("p1")).is_none());
}

#[test]
fn refless_enter_outside_payment_context_is_ordinary() {
    use serde_json::json;
    let enter = json!({"kind":"press","key":"Enter","action_class":"ordinary"});
    assert!(evaluate_browser_action(&enter, &floor(&[]), false, None).is_none());
}

#[test]
fn is_refless_committing_only_matches_enter_press() {
    use serde_json::json;
    assert!(is_refless_committing(&json!({"kind":"press","key":"Enter"})));
    assert!(is_refless_committing(&json!({"kind":"press_key","text":"Return"})));
    assert!(!is_refless_committing(&json!({"kind":"click","ref":"e5"})));       // has a ref
    assert!(!is_refless_committing(&json!({"kind":"type","ref":"e1","submit":true})); // ref-bearing
    assert!(!is_refless_committing(&json!({"kind":"scroll"})));
}
```

Update every existing `evaluate_browser_action(` / `action_is_payment_commit(` / `effective_action_class(` call in the tests module to pass the new `false` context argument (mechanical).

- [ ] **Step 2: Run tests, verify they fail.** `cargo test -p local-first-desktop-gateway -- refless_enter_in_focus_payment_context_conflicts` → FAIL (arity / not found).

- [ ] **Step 3: Implement in `browser_safety.rs`.** Add:

```rust
/// A committing action whose payment class cannot come from a ref: an
/// Enter/Return key press submits the form that holds the *focus*, not a ref.
/// (A `type submit=true` carries the field ref and is handled by the ref floor;
/// `clickCoords` is rejected upstream.)
pub fn is_refless_committing(action: &Value) -> bool {
    let kind = action.get("kind").and_then(Value::as_str).unwrap_or("");
    matches!(kind, "press" | "press_key")
        && action
            .get("key")
            .or_else(|| action.get("text"))
            .and_then(Value::as_str)
            .is_some_and(|k| matches!(k.to_ascii_lowercase().as_str(), "enter" | "return"))
}
```

Change `effective_action_class` to take the page context and fold it into the floor:

```rust
pub fn effective_action_class(
    action: &Value,
    payment_floor_refs: &HashSet<String>,
    focus_payment_context: bool,
) -> Result<ActionClass, String> {
    if !is_gated_action(action) {
        return Ok(ActionClass::Ordinary);
    }
    let declared = declared_action_class(action).ok_or_else(|| {
        "BROWSER_ACTION_CLASS_MISSING: a committing action must declare action_class \
         (ordinary|account|booking|payment_commit)"
            .to_string()
    })?;
    let ref_floor = payment_floor_for(action, payment_floor_refs);
    // Page-level floor: a ref-less Enter/Return that submits a focused payment form.
    let page_floor = if is_refless_committing(action) && focus_payment_context {
        ActionClass::PaymentCommit
    } else {
        ActionClass::Ordinary
    };
    let floor = ref_floor.max(page_floor);
    if floor > declared {
        return Err(format!(
            "BROWSER_ACTION_CLASS_CONFLICT: this control is a payment control; \
             re-declare action_class=payment_commit (was {declared:?})"
        ));
    }
    Ok(declared.max(floor))
}
```

Thread the bool through `action_is_payment_commit` and `evaluate_browser_action`:

```rust
pub fn action_is_payment_commit(
    action: &Value,
    payment_floor_refs: &HashSet<String>,
    focus_payment_context: bool,
) -> bool {
    matches!(
        effective_action_class(action, payment_floor_refs, focus_payment_context),
        Ok(ActionClass::PaymentCommit) | Err(_)
    ) && is_gated_action(action)
}

pub fn evaluate_browser_action(
    action: &Value,
    payment_floor_refs: &HashSet<String>,
    focus_payment_context: bool,
    approved_payment_id: Option<&str>,
) -> Option<String> {
    if action.get("kind").and_then(Value::as_str) == Some("evaluate") {
        return Some("BROWSER_HAZARDOUS_ACTION: arbitrary page script (evaluate) is not allowed".to_string());
    }
    let effective = match effective_action_class(action, payment_floor_refs, focus_payment_context) {
        Ok(class) => class,
        Err(reason) => return Some(reason),
    };
    if effective == ActionClass::PaymentCommit {
        let action_id = action.get("payment_approval_id").and_then(Value::as_str).unwrap_or("");
        if approved_payment_id.is_some_and(|approved| approved == action_id) {
            return None;
        }
        return Some("BROWSER_PAYMENT_APPROVAL_REQUIRED: the final payment action needs a matching, unconsumed Payment Approval Card".to_string());
    }
    None
}
```

- [ ] **Step 4: Implement threading + clickCoords reject in `main.rs`.**
  - Add the extractor next to `browser_floor_refs`:

```rust
/// Machine focus-in-payment-context flag the sidecar attached to an observation.
/// Absent → false. Raises (never lowers) a ref-less committing action's class.
fn browser_focus_payment_context(value: &serde_json::Value) -> bool {
    value.get("focusPaymentContext").and_then(serde_json::Value::as_bool).unwrap_or(false)
}
```

  - Add `last_focus_payment_context: bool` to `GatewayBrowserExecutor` (init `false`); at each of the four sites that set `*ctx.payment_floor_refs = browser_floor_refs(&value)`, also set `*ctx.focus_payment_context = browser_focus_payment_context(&value)` (thread a `focus_payment_context: &mut bool` through the same ctx that carries `payment_floor_refs`).
  - **clickCoords / unknown committing kind reject** — at the top of the single-action enforcement branch and inside `normalize_browser_action_bundle`'s per-nested loop, before the class gate:

```rust
if action.get("kind").and_then(serde_json::Value::as_str) == Some("clickCoords") {
    return Some("BROWSER_UNSUPPORTED_COMMITTING_ACTION: coordinate clicks are not available; click a specific [ref=…] control instead".to_string());
}
```

(For the single-action site, produce the same typed error string through the existing error path rather than executing.)

  - **Per-action focus context.** Single action: pass `self.last_focus_payment_context`. Bundle (`normalize_browser_action_bundle`): compute per nested item `focus_ctx = page_focus || any_prior_nested_targets_floored_ref`, where `page_focus` is the executor's `last_focus_payment_context` (thread it in as a new parameter next to `payment_floor_refs`) and `any_prior_...` scans the already-seen nested actions in the loop for a `ref` in `payment_floor_refs`. Pass that per-item bool to `action_is_payment_commit`/`evaluate_browser_action`.
  - Update the enforcement-site calls to `action_is_payment_commit`, `evaluate_browser_action`, and `should_claim_payment_approval` (which calls `effective_action_class`) to pass the computed context. `should_claim_payment_approval` gets the single-action `self.last_focus_payment_context`.
  - **Model guidance (semantic, no keywords).** In `browser_act_tool_schema`'s `description`, append one sentence: on a page with a payment form, prefer clicking the specific confirm control (which the per-ref floor covers precisely) over pressing Enter — so approval is requested exactly when a payment is actually submitted. Judged by meaning, never by button wording.

- [ ] **Step 5: Run tests + build.** `cargo test -p local-first-desktop-gateway -- refless_enter is_refless_committing` → PASS; `cargo test -p local-first-desktop-gateway browser` → green (≥ prior baseline); `cargo build -p local-first-desktop-gateway` → clean.

- [ ] **Step 6: Commit.**

```bash
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery add crates/desktop-gateway/src/browser_safety.rs crates/desktop-gateway/src/main.rs
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery commit -m "feat(browser): floor ref-less committing actions in focus payment context"
```

---

## Task 2: Sidecar — compute `focusPaymentContext`

**Files:**
- Modify: `runtimes/browser-automation/src/browser/snapshot.ts` (`BrowserSnapshot` type; `createAiSnapshot`; `createLegacySnapshot`)
- Modify: `runtimes/browser-automation/src/browser/session_manager.ts` (`snapshot()` and `act()` return objects — the same two sites that carry `paymentFloorRefs`)
- Modify: `runtimes/browser-automation/tests/payment_floor.test.ts`

**Interfaces:**
- Produces: `focusPaymentContext: boolean` on `BrowserSnapshot` and on the `snapshot()`/`act()` sidecar responses.

- [ ] **Step 1: Write the failing test** (extend `payment_floor.test.ts`). The `checkout.html` fixture already has a cc-form (`#pay`) and a search form (`#find`).

```ts
test("focusPaymentContext is true when a cc-form field is focused, false for the search field", async () => {
  await mgr.navigate("chat_0", base);
  await mgr.act("chat_0", { kind: "click", ref: (await findRef(mgr, "Card number")) } as never); // focus the cc input
  let snap = await mgr.snapshot("chat_0", { observationMode: "interact" });
  assert.equal(snap.focusPaymentContext, true);
  await mgr.act("chat_0", { kind: "click", ref: (await findRef(mgr, "Termine ricerca")) } as never); // focus the search input
  snap = await mgr.snapshot("chat_0", { observationMode: "interact" });
  assert.equal(snap.focusPaymentContext, false);
});
```

(Use the same ref-lookup helper style already in the file; if none exists, resolve the ref from a fresh `snapshot().refs.find(r => r.name === …)`.)

- [ ] **Step 2: Run test, verify it fails.** `npm --prefix /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery/runtimes/browser-automation test -- payment_floor` → FAIL (`focusPaymentContext` undefined).

- [ ] **Step 3: Implement.** Add `focusPaymentContext: boolean;` to `BrowserSnapshot`. Add a helper and call it in `createAiSnapshot` (set `false` in `createLegacySnapshot`):

```ts
// Machine-only: is the currently-focused element inside a cc-autocomplete form,
// or a PSP-origin frame? Enter/Return submits the focused form, so this is the
// signal that a ref-less submit is a payment. Never reads label text.
async function computeFocusPaymentContext(page: Page): Promise<boolean> {
  return await page
    .evaluate((psp) => {
      const el = document.activeElement as Element | null;
      if (!el) return false;
      const form = el.closest("form");
      if (form && form.querySelector('input[autocomplete^="cc-"]')) return true;
      let origin = ""; try { origin = el.ownerDocument.defaultView?.location.origin ?? ""; } catch {}
      const host = (() => { try { return new URL(origin).hostname; } catch { return ""; } })();
      return (psp as string[]).some((s) => host === s || host.endsWith("." + s));
    }, PSP_HOST_SUFFIXES)
    .catch(() => false);
}
```

In `createAiSnapshot`, `const focusPaymentContext = await computeFocusPaymentContext(page);` and include it in the returned object. In `session_manager.ts`, add `focusPaymentContext: snapshot.focusPaymentContext` to both the `snapshot()` and `act()` return objects (mirror exactly where `paymentFloorRefs` is added).

- [ ] **Step 4: Run tests.** `npm --prefix …/runtimes/browser-automation test -- payment_floor` → PASS; full sidecar suite green; `browser_fixture` (train) unaffected (`tsc --noEmit` clean).

- [ ] **Step 5: Commit.**

```bash
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery add runtimes/browser-automation/src/browser/snapshot.ts runtimes/browser-automation/src/browser/session_manager.ts runtimes/browser-automation/tests/payment_floor.test.ts
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery commit -m "feat(browser): sidecar reports focusPaymentContext for ref-less submits"
```

---

## Final gates

- [ ] `cargo test -p local-first-desktop-gateway` → all pass (≥ prior baseline)
- [ ] `npm --prefix runtimes/browser-automation test` → all pass
- [ ] `git -C <worktree> diff --check` → clean
- [ ] Whole-diff review of the slice; confirm: page floor only raises, only fires for ref-less Enter in machine focus-context, `clickCoords` rejected, no lexical signal, train fixture non-regression.

## Notes for the implementer

- The focus context is a *raise-only* supplement to the ref floor — it never lowers a class, and outside payment context a ref-less Enter is unchanged (no new friction).
- Do not add any label/text matching. The only signals are `autocomplete="cc-*"` and frame origin.
- Documented residual (do not try to close it here): a document-level Enter listener outside the focused form is not covered; the model's declaration + card still gate declared payments.
