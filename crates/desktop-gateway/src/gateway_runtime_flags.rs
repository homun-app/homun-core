//! Runtime environment flag ownership.
//!
//! These helpers are intentionally small and pure at the call boundary. Keeping
//! them together makes default-on/default-off behavior explicit and prevents
//! diagnostic environment switches from drifting back into the gateway root.

/// F4 abort is hot-path control-flow that can't be validated live in this environment, so it
/// ships gated (same discipline as `HOMUN_PLAN_RECONCILE`). Flip on to validate. The pure
/// stall math and the `settled`-termination it relies on are always active and tested.
pub(crate) fn plan_stall_abort_enabled() -> bool {
    std::env::var("HOMUN_PLAN_STALL_ABORT")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("on"))
        .unwrap_or(false)
}

/// When the over-running guard accepts the answer with the last
/// step still open, reconcile that step to `done` so the PERSISTED runtime plan reflects the
/// delivered work. Without it the plan stays "active" and the NEXT turn falsely resumes it
/// (the runtime-plan state only goes quiet when the plan is complete->Stale).
/// `HOMUN_PLAN_RECONCILE=0`/`off` remains as a diagnostic opt-out.
pub(crate) fn plan_reconcile_on_delivery_flag(value: Option<&str>) -> bool {
    !matches!(
        value.map(str::trim).filter(|value| !value.is_empty()),
        Some(value) if value == "0" || value.eq_ignore_ascii_case("off")
    )
}

pub(crate) fn plan_reconcile_on_delivery_enabled() -> bool {
    plan_reconcile_on_delivery_flag(std::env::var("HOMUN_PLAN_RECONCILE").ok().as_deref())
}

/// Turn trace is ON by default (local-only, bounded). `HOMUN_TURN_TRACE=0`/`off` opts out. See
/// `engine::turn_trace`.
pub(crate) fn turn_trace_enabled() -> bool {
    !matches!(
        std::env::var("HOMUN_TURN_TRACE")
            .ok()
            .as_deref()
            .map(str::trim),
        Some("0") | Some("off") | Some("OFF") | Some("Off")
    )
}

/// Max bytes before `turn-trace.jsonl` rotates. Override with `HOMUN_TURN_TRACE_MAX_BYTES`.
pub(crate) fn turn_trace_max_bytes() -> u64 {
    std::env::var("HOMUN_TURN_TRACE_MAX_BYTES")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(5_000_000)
}

/// Harness-driven plan progress during a browsing turn. Same default-on +
/// diagnostic opt-out (`HOMUN_PLAN_AUTOADVANCE=0`/`off`) as the delivery reconcile.
pub(crate) fn plan_autoadvance_from_evidence_enabled() -> bool {
    plan_reconcile_on_delivery_flag(std::env::var("HOMUN_PLAN_AUTOADVANCE").ok().as_deref())
}

/// ADR 0022 - Tappa 1: route brief/recall/learn through `MemoryRecallService`.
/// Default ON — the service-object path is the validated encapsulation.
/// `HOMUN_MEMORY_SERVICE=0`/`off`/`false` falls back to inline orchestration as
/// a diagnostic opt-out (same discipline as `HOMUN_PLAN_RECONCILE`).
pub(crate) fn memory_service_flag(value: Option<&str>) -> bool {
    !matches!(
        value.map(str::trim).filter(|value| !value.is_empty()),
        Some(value) if value == "0"
            || value.eq_ignore_ascii_case("off")
            || value.eq_ignore_ascii_case("false")
    )
}

pub(crate) fn memory_service_enabled() -> bool {
    memory_service_flag(std::env::var("HOMUN_MEMORY_SERVICE").ok().as_deref())
}

pub(crate) fn verbose_debug() -> bool {
    std::env::var("HOMUN_DEBUG").is_ok()
}

#[cfg(test)]
mod tests {
    use super::{memory_service_flag, plan_reconcile_on_delivery_flag};

    #[test]
    fn gateway_runtime_flags_plan_reconcile_defaults_on_with_explicit_opt_out() {
        assert!(plan_reconcile_on_delivery_flag(None));
        assert!(plan_reconcile_on_delivery_flag(Some("1")));
        assert!(plan_reconcile_on_delivery_flag(Some("on")));
        assert!(plan_reconcile_on_delivery_flag(Some("")));
        assert!(plan_reconcile_on_delivery_flag(Some("  ")));
        assert!(!plan_reconcile_on_delivery_flag(Some("0")));
        assert!(!plan_reconcile_on_delivery_flag(Some("off")));
        assert!(!plan_reconcile_on_delivery_flag(Some(" OFF ")));
    }

    #[test]
    fn gateway_runtime_flags_memory_service_defaults_on_with_explicit_opt_out() {
        // ADR 0022: the service-object path is now the default; the inline path
        // is a diagnostic opt-out via HOMUN_MEMORY_SERVICE=0/off/false.
        assert!(memory_service_flag(None), "unset env var defaults ON");
        assert!(memory_service_flag(Some("1")));
        assert!(memory_service_flag(Some("on")));
        assert!(memory_service_flag(Some("true")));
        assert!(memory_service_flag(Some("yes")));
        assert!(memory_service_flag(Some("")), "empty string defaults ON");
        assert!(memory_service_flag(Some("  ")), "whitespace defaults ON");
        assert!(!memory_service_flag(Some("0")), "0 disables");
        assert!(!memory_service_flag(Some("off")), "off disables");
        assert!(!memory_service_flag(Some("false")), "false disables");
        assert!(
            !memory_service_flag(Some("OFF")),
            "OFF disables (case-insensitive)"
        );
        assert!(
            !memory_service_flag(Some("False")),
            "False disables (case-insensitive)"
        );
        assert!(
            !memory_service_flag(Some("FALSE")),
            "FALSE disables (case-insensitive)"
        );
        assert!(!memory_service_flag(Some(" 0 ")), "trimmed 0 disables");
        assert!(!memory_service_flag(Some(" off ")), "trimmed off disables");
    }
}
