//! Shared browser safety gate. Decides whether a single browser action is
//! high-risk (a purchase/login/booking commit, or arbitrary page script) and
//! must be refused without explicit user approval.
//!
//! Used by the main-agent-driven `browser_act` tool to enforce the guard. Takes
//! the snapshot as `&str` (not a `BrowserObservation`) so it has no dependency on
//! the browser-automation crate types.

use serde_json::Value;

/// Substring patterns (EN + IT) that mark a control as high-risk. Matching is
/// conservative substring on the element label. Search/`cerca` is deliberately
/// NOT here — running a search is allowed; buying/booking/logging in is not.
const HIGH_RISK_LABEL_PATTERNS: &[&str] = &[
    // purchase / payment
    "buy", "pay", "payment", "checkout", "purchase", "place order", "order now",
    "add to cart", "acquista", "paga", "pagamento", "compra", "acquisto", "ordina",
    "carrello", "procedi all'acquisto",
    // booking / reservation
    "book now", "reserve", "prenota", "prenotazione",
    // authentication
    "log in", "login", "sign in", "signin", "accedi", "entra con",
];

/// True if the action commits something potentially irreversible: a click, a
/// `type` with `submit`, or an Enter/Return key press. Used both by the
/// high-risk check and (in read-only/channel turns) to block ALL commits.
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
/// committing action on a control whose label matches a purchase/login/booking
/// pattern. `None` means the action is safe to run. `snapshot` is the latest
/// page snapshot text, used to resolve the control label from `ref`.
pub fn high_risk_reason(action: &Value, snapshot: &str) -> Option<String> {
    let kind = action.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind == "evaluate" {
        return Some(
            "blocked: arbitrary page script (evaluate) is not allowed without explicit approval"
                .to_string(),
        );
    }
    if !is_committing_action(action) {
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
    HIGH_RISK_LABEL_PATTERNS
        .iter()
        .find(|pattern| label.contains(*pattern))
        .map(|pattern| {
            format!(
                "blocked before high-risk action: control \"{label}\" matches \"{pattern}\" \
                 (purchase/login/booking require explicit user approval)"
            )
        })
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

    const SNAP: &str = "- textbox \"Da\" [ref=e1]\n- button \"Acquista ora\" [ref=e9]\n- button \"Cerca\" [ref=e7]";

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
    fn allows_type_into_field() {
        assert!(high_risk_reason(&json!({"kind":"type","ref":"e1","text":"Napoli"}), SNAP).is_none());
    }

    #[test]
    fn committing_detects_enter_press() {
        assert!(is_committing_action(&json!({"kind":"press","key":"Enter"})));
        assert!(!is_committing_action(&json!({"kind":"type","ref":"e1","text":"x"})));
    }
}
