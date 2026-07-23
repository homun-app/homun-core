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

/// True if the action commits something potentially irreversible: a click, a
/// `type` with `submit`, or an Enter/Return key press. Used both by the
/// gate below and by the "is this action gated at all" check.
pub fn is_committing_action(action: &Value) -> bool {
    let kind = action.get("kind").and_then(Value::as_str).unwrap_or("");
    matches!(kind, "click" | "clickCoords")
        || (kind == "type"
            && action
                .get("submit")
                .and_then(Value::as_bool)
                .unwrap_or(false))
        || (matches!(kind, "press" | "press_key")
            && action
                .get("key")
                .or_else(|| action.get("text"))
                .and_then(Value::as_str)
                .is_some_and(|key| matches!(key.to_ascii_lowercase().as_str(), "enter" | "return")))
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

/// True when the action is committing (or `hold`). Payment gating only applies
/// to these; typing/scrolling/hovering are never gated.
fn is_gated_action(action: &Value) -> bool {
    is_committing_action(action) || action.get("kind").and_then(Value::as_str) == Some("hold")
}

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

/// Effective class for a committing action: `max(declared, machine_floor)`, where
/// `machine_floor = max(ref_floor, page_floor)`. `page_floor` covers what the ref
/// floor structurally cannot: a ref-less Enter/Return submits whatever form holds
/// the page's *focus*, so a machine-detected payment focus context also raises
/// the floor (never lowers it) even with no `ref` on the action itself.
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
    if !is_gated_action(action) {
        return Ok(ActionClass::Ordinary);
    }
    let declared = declared_action_class(action).ok_or_else(|| {
        "BROWSER_ACTION_CLASS_MISSING: a committing action must declare action_class \
         (ordinary|account|booking|payment_commit)"
            .to_string()
    })?;
    let ref_floor = payment_floor_for(action, payment_floor_refs);
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
    ) && is_gated_action(action)
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
}
