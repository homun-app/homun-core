//! Shared browser safety gate. Decides whether a single browser action is
//! high-risk (a final payment commit or arbitrary page script) and must be
//! refused without explicit user approval.
//!
//! The payment decision is made on the *effective action class*
//! (`max(model-declared class, machine-derived payment floor)`), never on
//! control label text: label keywords fail open on unlabeled controls and on
//! languages outside the hardcoded list, which is exactly wrong for a payment
//! gate. `snapshot_label_for_ref` survives only for approval-card binding and
//! display, never for this decision.
//!
//! Used by the main-agent-driven `browser_act` tool to enforce the guard. Has
//! no dependency on the browser-automation crate types.

use serde_json::Value;
use std::collections::HashSet;

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
/// which, for a committing action, is a fail-closed rejection (see the gate in
/// the effect-class work), never an implicit "ordinary".
pub fn declared_action_class(action: &Value) -> Option<ActionClass> {
    match action.get("action_class").and_then(Value::as_str)? {
        "ordinary" => Some(ActionClass::Ordinary),
        "account" => Some(ActionClass::Account),
        "booking" => Some(ActionClass::Booking),
        "payment_commit" => Some(ActionClass::PaymentCommit),
        _ => None,
    }
}

/// Key spellings (matched case-insensitively) that submit a form via the keyboard,
/// aligned to what the sidecar actually executes
/// (`runtimes/browser-automation/src/browser/actions.ts`): `press` runs
/// `page.keyboard.press(action.key)`, `press_key` runs
/// `page.keyboard.press(action.text)`, and Playwright presses Enter for a trailing
/// `\n`/`\r` in typed text. These are protocol key-name/value constants the sidecar
/// itself matches on — never page label text, so this stays machine-only.
const ENTER_KEY_SPELLINGS: &[&str] = &["enter", "return", "numpadenter", "\n", "\r"];

/// True if `value` IS an Enter spelling, or is a `+`-joined modifier chord whose
/// key token is one. Playwright's `keyboard.press` takes a chord like
/// `"Control+Enter"` / `"Meta+Enter"` (the idiomatic Cmd/Ctrl+Enter submit) as a
/// single literal string dispatched verbatim by the sidecar's `press`/`press_key`
/// — a whole-string membership check against `ENTER_KEY_SPELLINGS` never matches
/// it, so that schema-legal submit spelling slipped through ungated. Splitting on
/// `+` and checking whether ANY lowercased token is an Enter spelling catches
/// every modifier combination without having to enumerate them. Deliberately NO
/// `.trim()` on the token: the bare spellings `"\n"`/`"\r"` are themselves
/// whitespace, and `str::trim` would strip them down to an empty string that
/// never matches — the chord protocol never emits spaces around `+` anyway, so
/// there is nothing legitimate for a trim to remove.
fn is_enter_spelling(value: &str) -> bool {
    value
        .split('+')
        .any(|token| ENTER_KEY_SPELLINGS.contains(&token.to_ascii_lowercase().as_str()))
}

/// True when a `type`/`fill` action submits the form it targets: `submit==true`,
/// OR the typed text ends in `\n`/`\r` (Playwright presses Enter for a trailing
/// newline — trailing only, so an internal line break does not over-gate), OR ANY
/// non-empty `commit` field. The schema's `commit` values (`"enter"`,
/// `"arrow_enter"`, and any future value) all drive a post-type keypress in the
/// sidecar EXCEPT the explicit `"none"` opt-out — but treating `"none"` as
/// submitting too is deliberate: it costs one extra declared `action_class` on a
/// field that opts out of confirmation, never a missed gate on one that doesn't,
/// which is the fail-closed side to err on for a payment-safety predicate.
fn type_or_fill_submits(action: &Value) -> bool {
    let submit = action
        .get("submit")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let text_ends_in_enter = action
        .get("text")
        .and_then(Value::as_str)
        .is_some_and(|text| text.ends_with('\n') || text.ends_with('\r'));
    let has_commit = action
        .get("commit")
        .and_then(Value::as_str)
        .is_some_and(|c| !c.trim().is_empty());
    submit || text_ends_in_enter || has_commit
}

/// True if the action commits/submits something potentially irreversible, matched
/// against what the sidecar actually executes rather than an ad-hoc guess:
/// - `click` / `clickCoords` (the latter is additionally rejected upstream, see
///   `BROWSER_UNSUPPORTED_COMMITTING_ACTION` in `main.rs`);
/// - `press` whose `key` field is an Enter spelling (bare OR a `+`-joined modifier
///   chord, e.g. `"Control+Enter"`/`"Meta+Enter"` — see `is_enter_spelling`);
///   `press_key` whose `text` field is (the sidecar reads a DIFFERENT field per
///   kind — see `ENTER_KEY_SPELLINGS`);
/// - `type` / `fill` that submits per `type_or_fill_submits`: `submit == true`, a
///   trailing `\n`/`\r`, or ANY non-empty `commit` field (not just an Enter
///   spelling — `commit:"arrow_enter"` presses ArrowDown then Enter, so it DOES
///   commit, even though it is not itself an Enter keypress).
///
/// `hold` is NOT included here (see `is_gated_action`, which ORs it in separately):
/// a press-and-hold human-verification challenge must run unattended, so it is
/// gated but never counts as "committing" for wording/UX purposes.
/// Used both by the gate below and by the "is this action gated at all" check.
pub fn is_committing_action(action: &Value) -> bool {
    let kind = action.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "click" | "clickCoords" => true,
        "press" => action
            .get("key")
            .and_then(Value::as_str)
            .is_some_and(is_enter_spelling),
        "press_key" => action
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(is_enter_spelling),
        "type" | "fill" => type_or_fill_submits(action),
        _ => false,
    }
}

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

/// True when the action is committing, `hold`, OR targets a ref already in
/// `payment_floor_refs`. That last arm is defense-in-depth (design 1.4): the ref
/// floor is computed independently of `kind`, so without it a FUTURE (or
/// hallucinated) kind that acts on a floored control — one `is_committing_action`
/// does not yet recognize — would fall through ungated purely because its `kind`
/// isn't in today's committing set. Folding the ref check into the gate itself
/// means a floored ref is ALWAYS gated, regardless of what kind of action touches
/// it. Payment gating applies only when one of these three holds; plain
/// typing/scrolling/hovering on an unfloored ref is never gated.
/// Accepted friction: this also gates a benign `hover`/`scrollIntoView` that
/// merely targets a floored control — over-gating a read-only touch is the
/// fail-closed side of the same tradeoff, not a bug.
fn is_gated_action(action: &Value, payment_floor_refs: &HashSet<String>) -> bool {
    is_committing_action(action)
        || action.get("kind").and_then(Value::as_str) == Some("hold")
        || action
            .get("ref")
            .and_then(Value::as_str)
            .is_some_and(|r| payment_floor_refs.contains(r))
}

/// A committing action whose payment class cannot come from a ref: an Enter/Return
/// key press submits the form that holds the *focus*, not a ref. Precisely:
/// committing `press` (reads `key`) or `press_key` (reads `text`) whose field is an
/// Enter spelling. (A `type submit=true` carries the field's own ref and is handled
/// by the ref floor; `clickCoords` is rejected upstream; press/press_key never
/// carry a `ref` in the sidecar's own action shape, so "no ref" holds structurally.)
pub fn is_refless_committing(action: &Value) -> bool {
    let kind = action.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "press" => action
            .get("key")
            .and_then(Value::as_str)
            .is_some_and(is_enter_spelling),
        "press_key" => action
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(is_enter_spelling),
        _ => false,
    }
}

/// True when the action SUBMITS a form and therefore needs the PAGE floor
/// (focus / last-acted-floored / bundle-predecessor payment context), broader
/// than `is_refless_committing`: a ref-less Enter/Return `press`/`press_key`
/// ALWAYS qualifies (the ref floor structurally cannot cover it), and so does a
/// `type`/`fill` that submits (`type_or_fill_submits`) — even though that one DOES
/// carry a `ref`. The ref it carries may not be the one the machine floor marked
/// (autofocus, a dynamically-inserted field, a same-form sibling input), so a
/// submitting `type` into a non-floored ref would otherwise escape BOTH the ref
/// floor (its own ref is clean) and the old ref-less-only page floor — committing
/// the surrounding payment form while resolving as a plain keystroke. Gating a
/// non-submitting `type`/`fill` here would over-gate ordinary form filling, so
/// this predicate — unlike `is_gated_action`'s ref-membership arm — deliberately
/// stays limited to actions that actually submit.
pub fn is_submitting_action(action: &Value) -> bool {
    if is_refless_committing(action) {
        return true;
    }
    matches!(action.get("kind").and_then(Value::as_str), Some("type") | Some("fill"))
        && type_or_fill_submits(action)
}

/// Effective class for a committing action: `max(declared, machine_floor)`, where
/// `machine_floor = max(ref_floor, page_floor)`. `page_floor` covers what the ref
/// floor structurally cannot: a submitting action (`is_submitting_action`) commits
/// whatever form holds the page's *focus* — not necessarily the ref it carries, if
/// any — so a machine-detected payment focus context also raises the floor (never
/// lowers it) regardless of whether the action's own `ref` (if it has one) was
/// individually marked.
/// `Err` is a typed, fail-closed rejection the model must act on:
/// - `BROWSER_ACTION_CLASS_MISSING`: committing action declared no class;
/// - `BROWSER_ACTION_CLASS_CONFLICT`: a machine floor exceeds the declared class,
///   so the model must re-declare (as payment) rather than have the code silently
///   upgrade and proceed.
pub fn effective_action_class(
    action: &Value,
    payment_floor_refs: &HashSet<String>,
    focus_payment_context: bool,
) -> Result<ActionClass, String> {
    if !is_gated_action(action, payment_floor_refs) {
        return Ok(ActionClass::Ordinary);
    }
    let declared = declared_action_class(action).ok_or_else(|| {
        "BROWSER_ACTION_CLASS_MISSING: a committing action must declare action_class \
         (ordinary|account|booking|payment_commit)"
            .to_string()
    })?;
    let ref_floor = payment_floor_for(action, payment_floor_refs);
    let page_floor = if is_submitting_action(action) && focus_payment_context {
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

/// True when the action's effective class is `PaymentCommit` (declared or floored).
/// Used to decide whether to claim a Payment Approval Card. A class error counts
/// as "treat as payment" so the gate below re-rejects it fail-closed.
pub fn action_is_payment_commit(
    action: &Value,
    payment_floor_refs: &HashSet<String>,
    focus_payment_context: bool,
) -> bool {
    matches!(
        effective_action_class(action, payment_floor_refs, focus_payment_context),
        Ok(ActionClass::PaymentCommit) | Err(_)
    ) && is_gated_action(action, payment_floor_refs)
}

/// The single browser action gate. `None` = allow. `Some(reason)` = typed
/// rejection. Never reads label text for the payment decision.
pub fn evaluate_browser_action(
    action: &Value,
    payment_floor_refs: &HashSet<String>,
    focus_payment_context: bool,
    approved_payment_id: Option<&str>,
) -> Option<String> {
    if action.get("kind").and_then(Value::as_str) == Some("evaluate") {
        return Some(
            "BROWSER_HAZARDOUS_ACTION: arbitrary page script (evaluate) is not allowed".to_string(),
        );
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
        return Some(
            "BROWSER_PAYMENT_APPROVAL_REQUIRED: the final payment action needs a matching, \
             unconsumed Payment Approval Card"
                .to_string(),
        );
    }
    None
}

/// Extracts the accessible name of a ref from an AI snapshot line such as
/// `- button "Acquista" [ref=e5]`.
pub fn snapshot_label_for_ref(snapshot: &str, ref_id: &str) -> Option<String> {
    let marker = format!("[ref={ref_id}]");
    let line = snapshot.lines().find(|line| line.contains(&marker))?;
    let start = line.find('"')?;
    let rest = &line[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn floor(refs: &[&str]) -> std::collections::HashSet<String> {
        refs.iter().map(|r| r.to_string()).collect()
    }

    #[test]
    fn declared_class_parses_the_four_names_and_rejects_unknown() {
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

    #[test]
    fn committing_detects_enter_press() {
        assert!(is_committing_action(&json!({"kind":"press","key":"Enter"})));
        assert!(!is_committing_action(
            &json!({"kind":"type","ref":"e1","text":"x"})
        ));
    }

    #[test]
    fn hold_is_not_a_blanket_commit() {
        // A press-and-hold human challenge must run unattended (incl. from a
        // channel), so it must NOT count as a committing action.
        assert!(!is_committing_action(&json!({"kind":"hold","ref":"e3"})));
    }

    #[test]
    fn committing_action_without_class_is_rejected_fail_closed() {
        use serde_json::json;
        let reason = evaluate_browser_action(&json!({"kind":"click","ref":"e5"}), &floor(&[]), false, None).unwrap();
        assert!(reason.contains("BROWSER_ACTION_CLASS_MISSING"));
    }

    #[test]
    fn ordinary_declared_committing_action_is_allowed_without_a_floor() {
        use serde_json::json;
        let action = json!({"kind":"click","ref":"e7","action_class":"ordinary"});
        assert!(evaluate_browser_action(&action, &floor(&[]), false, None).is_none());
    }

    #[test]
    fn declared_below_payment_floor_is_a_conflict() {
        use serde_json::json;
        let action = json!({"kind":"click","ref":"e9","action_class":"booking"});
        let reason = evaluate_browser_action(&action, &floor(&["e9"]), false, None).unwrap();
        assert!(reason.contains("BROWSER_ACTION_CLASS_CONFLICT"));
    }

    #[test]
    fn payment_commit_requires_matching_approval() {
        use serde_json::json;
        let action = json!({"kind":"click","ref":"e9","action_class":"payment_commit"});
        let blocked = evaluate_browser_action(&action, &floor(&[]), false, None).unwrap();
        assert!(blocked.contains("BROWSER_PAYMENT_APPROVAL_REQUIRED"));
        let approved = json!({"kind":"click","ref":"e9","action_class":"payment_commit","payment_approval_id":"pay_1"});
        assert!(evaluate_browser_action(&approved, &floor(&[]), false, Some("pay_1")).is_none());
    }

    #[test]
    fn non_committing_action_needs_no_class() {
        use serde_json::json;
        assert!(evaluate_browser_action(&json!({"kind":"type","ref":"e1","text":"Napoli"}), &floor(&[]), false, None).is_none());
        assert!(evaluate_browser_action(&json!({"kind":"scroll"}), &floor(&[]), false, None).is_none());
    }

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
        assert!(!is_refless_committing(&json!({"kind":"type","ref":"e1","submit":true}))); // ref-bearing
        assert!(!is_refless_committing(&json!({"kind":"scroll"})));
    }

    #[test]
    fn evaluate_kind_is_always_hazardous() {
        use serde_json::json;
        assert!(evaluate_browser_action(&json!({"kind":"evaluate"}), &floor(&[]), false, None).is_some());
    }

    #[test]
    fn payment_floor_marks_effective_payment() {
        use serde_json::json;
        assert!(action_is_payment_commit(&json!({"kind":"click","ref":"e9","action_class":"payment_commit"}), &floor(&[]), false));
        assert!(action_is_payment_commit(&json!({"kind":"click","ref":"e9","action_class":"ordinary"}), &floor(&["e9"]), false));
        assert!(!action_is_payment_commit(&json!({"kind":"click","ref":"e7","action_class":"ordinary"}), &floor(&[]), false));
    }

    // --- 1.1 canonical committing predicate: every schema-legal Enter spelling ---

    #[test]
    fn committing_detects_every_enter_spelling_on_press() {
        // `press` reads the `key` field. Every spelling in ENTER_KEY_SPELLINGS must
        // be recognized, case-insensitively.
        assert!(is_committing_action(&json!({"kind":"press","key":"Enter"})));
        assert!(is_committing_action(&json!({"kind":"press","key":"ENTER"})));
        assert!(is_committing_action(&json!({"kind":"press","key":"Return"})));
        assert!(is_committing_action(&json!({"kind":"press","key":"NumpadEnter"})));
        assert!(is_committing_action(&json!({"kind":"press","key":"numpadenter"})));
        assert!(is_committing_action(&json!({"kind":"press","key":"\n"})));
        assert!(is_committing_action(&json!({"kind":"press","key":"\r"})));
        assert!(!is_committing_action(&json!({"kind":"press","key":"ArrowDown"})));
    }

    #[test]
    fn committing_detects_every_enter_spelling_on_press_key() {
        // `press_key` reads a DIFFERENT field: `text`, not `key`.
        assert!(is_committing_action(&json!({"kind":"press_key","text":"Enter"})));
        assert!(is_committing_action(&json!({"kind":"press_key","text":"Return"})));
        assert!(is_committing_action(&json!({"kind":"press_key","text":"NumpadEnter"})));
        assert!(is_committing_action(&json!({"kind":"press_key","text":"\n"})));
        assert!(is_committing_action(&json!({"kind":"press_key","text":"\r"})));
        assert!(!is_committing_action(&json!({"kind":"press_key","text":"Tab"})));
        // press_key does NOT fall back to reading `key` — the sidecar only reads `text`.
        assert!(!is_committing_action(&json!({"kind":"press_key","key":"Enter"})));
    }

    #[test]
    fn committing_type_text_ending_in_newline_is_committing() {
        // Playwright presses Enter for a trailing newline in typed text.
        assert!(is_committing_action(&json!({"kind":"type","ref":"e1","text":"Napoli\n"})));
        assert!(is_committing_action(&json!({"kind":"fill","ref":"e1","text":"Napoli\r"})));
        assert!(is_committing_action(&json!({"kind":"type","ref":"e1","commit":"enter"})));
        assert!(is_committing_action(&json!({"kind":"type","ref":"e1","commit":"Return"})));
        // Build1 Fix 2(b): "arrow_enter" is NOT itself an Enter keypress, but it DOES
        // press ArrowDown then UNCONDITIONALLY Enter in the sidecar — it commits, so
        // it must be treated as committing too (previously only an Enter-spelling
        // `commit` qualified, missing this schema-legal submit path).
        assert!(is_committing_action(&json!({"kind":"type","ref":"e1","commit":"arrow_enter"})));
    }

    #[test]
    fn internal_newline_not_at_the_end_is_not_committing() {
        // A multi-line textarea whose text does NOT end in a newline must not be
        // over-gated: Playwright only submits on a TRAILING newline.
        assert!(!is_committing_action(&json!({
            "kind":"type","ref":"e1","text":"line one\nline two"
        })));
        assert!(!is_committing_action(&json!({
            "kind":"fill","ref":"e1","text":"paragraph\nwith an internal break, no trailing newline"
        })));
    }

    #[test]
    fn refless_committing_matches_every_enter_spelling_and_only_press_kinds() {
        assert!(is_refless_committing(&json!({"kind":"press","key":"NumpadEnter"})));
        assert!(is_refless_committing(&json!({"kind":"press","key":"\n"})));
        assert!(is_refless_committing(&json!({"kind":"press_key","text":"\r"})));
        assert!(is_refless_committing(&json!({"kind":"press_key","text":"Enter"})));
        // A committing type/fill (submit or trailing newline) carries its own field
        // ref and is handled by the REF floor, not the page floor.
        assert!(!is_refless_committing(&json!({"kind":"type","ref":"e1","text":"x\n"})));
        assert!(!is_refless_committing(&json!({"kind":"fill","ref":"e1","submit":true})));
        assert!(!is_refless_committing(&json!({"kind":"click","ref":"e5"})));
    }

    #[test]
    fn refless_enter_every_spelling_floors_in_payment_context() {
        // Each Enter spelling, ref-less, in a machine-detected payment-focus context,
        // must resolve to PaymentCommit (via a class conflict when under-declared).
        for key in ["Enter", "Return", "NumpadEnter", "\n", "\r"] {
            let enter = json!({"kind":"press","key":key,"action_class":"ordinary"});
            let reason = evaluate_browser_action(&enter, &floor(&[]), true, None)
                .unwrap_or_else(|| panic!("expected a rejection for key spelling {key:?}"));
            assert!(
                reason.contains("BROWSER_ACTION_CLASS_CONFLICT"),
                "key {key:?} did not floor to payment_commit: {reason}"
            );
        }
        // Same for press_key's `text` field.
        let press_key_enter = json!({"kind":"press_key","text":"Enter","action_class":"ordinary"});
        assert!(
            evaluate_browser_action(&press_key_enter, &floor(&[]), true, None)
                .unwrap()
                .contains("BROWSER_ACTION_CLASS_CONFLICT")
        );
    }

    #[test]
    fn type_committing_via_trailing_newline_conflicts_when_declared_ordinary_in_payment_context() {
        // A `type` whose text ends in `\n` is committing; combined with the ref floor
        // (its own ref is floored) it must resolve to payment_commit, not slip through
        // as an ordinary keystroke just because `submit` was never set.
        let typed = json!({
            "kind": "type", "ref": "e12", "text": "4242 4242 4242 4242\n", "action_class": "ordinary"
        });
        let reason = evaluate_browser_action(&typed, &floor(&["e12"]), false, None).unwrap();
        assert!(reason.contains("BROWSER_ACTION_CLASS_CONFLICT"));
    }

    // --- Build1 Fix 1: modifier+Enter chords are Enter spellings too ---

    #[test]
    fn modifier_enter_chord_is_committing_on_press_and_press_key() {
        // Playwright dispatches Cmd/Ctrl+Enter as a single literal "Control+Enter" /
        // "Meta+Enter" string — the idiomatic modifier-Enter submit spelling. A
        // whole-string membership check misses it entirely; `is_enter_spelling`
        // must split on '+' and match any token.
        assert!(is_committing_action(&json!({"kind":"press","key":"Control+Enter"})));
        assert!(is_committing_action(&json!({"kind":"press_key","text":"Meta+Enter"})));
        // Case-insensitive and order-agnostic on the modifier token.
        assert!(is_committing_action(&json!({"kind":"press","key":"meta+enter"})));
        assert!(is_committing_action(&json!({"kind":"press","key":"Shift+Control+Enter"})));
        // A chord whose key token is NOT an Enter spelling stays non-committing.
        assert!(!is_committing_action(&json!({"kind":"press","key":"Control+ArrowDown"})));
    }

    #[test]
    fn modifier_enter_chord_is_refless_committing_and_floors_in_payment_context() {
        assert!(is_refless_committing(&json!({"kind":"press","key":"Control+Enter"})));
        assert!(is_refless_committing(&json!({"kind":"press_key","text":"Meta+Enter"})));

        let ctrl_enter = json!({"kind":"press","key":"Control+Enter","action_class":"ordinary"});
        let reason = evaluate_browser_action(&ctrl_enter, &floor(&[]), true, None)
            .expect("Control+Enter in payment context must be rejected when under-declared");
        assert!(reason.contains("BROWSER_ACTION_CLASS_CONFLICT"));

        let meta_enter =
            json!({"kind":"press_key","text":"Meta+Enter","action_class":"ordinary"});
        let reason = evaluate_browser_action(&meta_enter, &floor(&[]), true, None)
            .expect("Meta+Enter in payment context must be rejected when under-declared");
        assert!(reason.contains("BROWSER_ACTION_CLASS_CONFLICT"));
    }

    // --- Build1 Fix 2: commit-based and typed submits, incl. into a non-floored ref ---

    #[test]
    fn any_non_empty_commit_field_is_committing_not_just_enter_spellings() {
        // `commit:"arrow_enter"` presses ArrowDown then UNCONDITIONALLY Enter in the
        // sidecar — it commits even though it is not itself an Enter keypress, so it
        // must be treated as committing (previously only an Enter-spelling `commit`
        // qualified).
        assert!(is_committing_action(&json!({"kind":"type","ref":"e1","commit":"arrow_enter"})));
        assert!(is_committing_action(&json!({"kind":"fill","ref":"e1","commit":"arrow_enter"})));
        // An empty commit string is not a real commit directive.
        assert!(!is_committing_action(&json!({"kind":"type","ref":"e1","commit":""})));
    }

    #[test]
    fn is_submitting_action_covers_refless_enter_and_submitting_type_or_fill() {
        assert!(is_submitting_action(&json!({"kind":"press","key":"Enter"})));
        assert!(is_submitting_action(&json!({"kind":"press_key","text":"Control+Enter"})));
        assert!(is_submitting_action(&json!({"kind":"type","ref":"e1","submit":true})));
        assert!(is_submitting_action(&json!({"kind":"type","ref":"e1","text":"x\n"})));
        assert!(is_submitting_action(&json!({"kind":"type","ref":"e1","commit":"arrow_enter"})));
        // A plain, non-submitting type/fill must NOT count — only a genuine submit.
        assert!(!is_submitting_action(&json!({"kind":"type","ref":"e1","text":"Napoli"})));
        assert!(!is_submitting_action(&json!({"kind":"click","ref":"e5"})));
    }

    #[test]
    fn submitting_type_into_a_non_floored_ref_in_payment_context_conflicts_when_ordinary() {
        // Build1 Fix 2(a): a `type` that SUBMITS (trailing newline) targets its own
        // ref (e1), which the machine floor never marked — only the PAGE (focus)
        // context says we're in a payment form. Before the fix, the page floor only
        // covered ref-less Enter, so this submit escaped both floors and resolved as
        // ordinary. It must now conflict when under-declared.
        let typed = json!({
            "kind": "type", "ref": "e1", "text": "4242 4242 4242 4242\n", "action_class": "ordinary"
        });
        let reason = evaluate_browser_action(&typed, &floor(&[]), true, None)
            .expect("a submitting type into a non-floored ref, in payment context, must conflict");
        assert!(reason.contains("BROWSER_ACTION_CLASS_CONFLICT"));
    }

    #[test]
    fn plain_non_submitting_type_outside_payment_context_stays_ordinary() {
        // No over-gating: a benign `type` with submit:false, no trailing newline, no
        // commit, no payment context, must remain a plain allowed ordinary action.
        let typed = json!({
            "kind": "type", "ref": "e1", "text": "Napoli", "submit": false, "action_class": "ordinary"
        });
        assert!(evaluate_browser_action(&typed, &floor(&[]), false, None).is_none());
    }

    // --- 1.4 gateway defense-in-depth: ref ∈ floor ⇒ gated regardless of kind ---

    #[test]
    fn ref_in_payment_floor_gates_a_non_committing_kind() {
        // `hover`/`scroll` are not in the committing set at all, but a ref already
        // floored by the machine analysis must still force a declared class — this is
        // the defense against a FUTURE (or hallucinated) kind acting on a floored
        // control without being one of today's recognized committing kinds.
        let hover = json!({"kind":"hover","ref":"e9"});
        let reason = evaluate_browser_action(&hover, &floor(&["e9"]), false, None).unwrap();
        assert!(reason.contains("BROWSER_ACTION_CLASS_MISSING"));

        let scroll = json!({"kind":"scroll","ref":"e9","action_class":"payment_commit"});
        assert!(
            evaluate_browser_action(&scroll, &floor(&["e9"]), false, None)
                .unwrap()
                .contains("BROWSER_PAYMENT_APPROVAL_REQUIRED")
        );

        // Unfloored ref: the same non-committing kind remains ungated.
        let hover_elsewhere = json!({"kind":"hover","ref":"e1"});
        assert!(evaluate_browser_action(&hover_elsewhere, &floor(&["e9"]), false, None).is_none());
    }

    #[test]
    fn ref_in_payment_floor_makes_action_is_payment_commit_true_for_any_kind() {
        assert!(action_is_payment_commit(
            &json!({"kind":"scroll","ref":"e9"}),
            &floor(&["e9"]),
            false
        ));
        assert!(!action_is_payment_commit(
            &json!({"kind":"scroll","ref":"e1"}),
            &floor(&["e9"]),
            false
        ));
    }
}
