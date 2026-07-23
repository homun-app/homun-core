//! Shared browser safety gate. Decides whether a single browser action is
//! high-risk (a final payment commit or arbitrary page script) and must be
//! refused without explicit user approval.
//!
//! Used by the main-agent-driven `browser_act` tool to enforce the guard. Takes
//! the snapshot as `&str` (not a `BrowserObservation`) so it has no dependency on
//! the browser-automation crate types.

use serde_json::Value;

const FINAL_PAYMENT_LABEL_PATTERNS: &[&str] = &[
    "buy",
    "pay",
    "payment",
    "checkout",
    "purchase",
    "place order",
    "order now",
    "acquista",
    "paga",
    "pagamento",
    "compra",
    "acquisto",
    "ordina",
    "procedi all'acquisto",
];

/// True if the action commits something potentially irreversible: a click, a
/// `type` with `submit`, or an Enter/Return key press. Used both by the
/// final-payment check.
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

/// Returns a blocker reason if the action is high-risk: arbitrary JS, or a
/// committing action on a control whose label matches a final-payment pattern.
/// `None` means the action is safe to run. `snapshot` is the latest
/// page snapshot text, used to resolve the control label from `ref`.
pub fn high_risk_reason(action: &Value, snapshot: &str) -> Option<String> {
    high_risk_reason_with_payment_approval(action, snapshot, None)
}

/// Approval-aware variant for the future payment flow. A matching
/// `payment_approval_id` can unlock final payment controls only. Login and
/// booking are user-directed browser actions and do not use this payment gate.
pub fn high_risk_reason_with_payment_approval(
    action: &Value,
    snapshot: &str,
    approved_payment_id: Option<&str>,
) -> Option<String> {
    let kind = action.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind == "evaluate" {
        return Some(
            "blocked: arbitrary page script (evaluate) is not allowed without explicit approval"
                .to_string(),
        );
    }
    // `hold` is not a blanket commit (so a press-and-hold human-verification
    // challenge runs unattended, incl. from a channel), but it must still face the
    // purchase/login label check below — a "hold to pay/confirm order" control is
    // as committing as a click on it.
    if !is_committing_action(action) && kind != "hold" {
        return None;
    }
    let label = action
        .get("ref")
        .and_then(Value::as_str)
        .and_then(|ref_id| snapshot_label_for_ref(snapshot, ref_id))
        .unwrap_or_default()
        .to_ascii_lowercase();
    if label.is_empty() {
        return None;
    }
    let payment_match = FINAL_PAYMENT_LABEL_PATTERNS
        .iter()
        .find(|pattern| label.contains(*pattern));
    if let Some(pattern) = payment_match {
        let action_approval_id = action
            .get("payment_approval_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        if approved_payment_id.is_some_and(|approved| approved == action_approval_id) {
            return None;
        }
        return Some(format!(
            "blocked before final payment action: control \"{label}\" matches \"{pattern}\" \
             and requires a matching Payment Approval Card"
        ));
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

    const SNAP: &str = "- textbox \"Da\" [ref=e1]\n- button \"Acquista ora\" [ref=e9]\n- button \"Cerca\" [ref=e7]\n- button \"Accedi\" [ref=e8]\n- button \"Prenota\" [ref=e11]\n- button \"Tieni premuto per confermare di essere umano\" [ref=e3]";

    #[test]
    fn blocks_evaluate() {
        assert!(high_risk_reason(&json!({"kind":"evaluate"}), SNAP).is_some());
    }

    #[test]
    fn blocks_click_on_purchase_label() {
        assert!(high_risk_reason(&json!({"kind":"click","ref":"e9"}), SNAP).is_some());
    }

    #[test]
    fn allows_click_on_search() {
        assert!(high_risk_reason(&json!({"kind":"click","ref":"e7"}), SNAP).is_none());
    }

    #[test]
    fn allows_login_and_booking_but_blocks_payment() {
        for reference in ["e7", "e8", "e11"] {
            assert!(
                high_risk_reason(&json!({"kind":"click","ref":reference}), SNAP).is_none(),
                "{reference} should be allowed"
            );
        }
        assert!(high_risk_reason(&json!({"kind":"click","ref":"e9"}), SNAP).is_some());
    }

    #[test]
    fn allows_type_into_field() {
        assert!(
            high_risk_reason(&json!({"kind":"type","ref":"e1","text":"Napoli"}), SNAP).is_none()
        );
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
    fn allows_hold_on_human_challenge() {
        assert!(high_risk_reason(&json!({"kind":"hold","ref":"e3"}), SNAP).is_none());
    }

    #[test]
    fn blocks_hold_on_purchase_label() {
        assert!(high_risk_reason(&json!({"kind":"hold","ref":"e9"}), SNAP).is_some());
    }

    #[test]
    fn final_payment_click_requires_matching_payment_approval() {
        let snapshot = "- button \"Paga ora\" [ref=e10]";
        let action = json!({"kind":"click","ref":"e10"});

        let blocked = high_risk_reason_with_payment_approval(&action, snapshot, Some("pay_123"));
        assert!(blocked.is_some());
        assert!(blocked.unwrap().contains("Payment Approval Card"));

        let approved = json!({"kind":"click","ref":"e10","payment_approval_id":"pay_123"});
        assert!(
            high_risk_reason_with_payment_approval(&approved, snapshot, Some("pay_123")).is_none()
        );
    }
}
