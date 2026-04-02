//! Iteration budget management for the agent loop.
//!
//! Tracks stall detection, cycle detection, and dynamic budget
//! extension/contraction to prevent infinite loops while allowing
//! complex multi-step tasks to complete.

/// Summary of a single tool execution within one iteration.
#[derive(Debug, Clone)]
pub(crate) struct ToolExecutionSummary {
    pub name: String,
    pub signature: String,
    pub useful: bool,
}

/// Mutable state for the iteration budget manager.
///
/// Tracks stall streaks, cycle signatures, and budget extensions
/// across iterations of the agent loop.
#[derive(Debug, Default)]
pub(crate) struct IterationBudgetState {
    pub(crate) last_signature: Option<String>,
    pub(crate) stall_streak: u8,
    pub(crate) extensions_used: u8,
    /// Rolling window of recent tool-call signatures for cycle detection.
    pub(crate) recent_signatures: Vec<String>,
    /// When a cycle is detected, stores the period (1 = same call repeated,
    /// 2 = A→B→A→B, 3 = A→B→C→A→B→C). Consumed by hint injection.
    pub(crate) cycle_detected: Option<usize>,
}

/// Build a deterministic signature for a tool call (name + serialized args).
pub(crate) fn tool_call_signature(tool_name: &str, arguments: &serde_json::Value) -> String {
    let args = serde_json::to_string(arguments).unwrap_or_else(|_| "{}".to_string());
    format!("{tool_name}:{args}")
}

/// Evaluate tool results and adjust the iteration budget.
///
/// Extends the budget when the model is making progress (useful, non-repeated
/// tool calls) and contracts it when stalling or cycling.
pub(crate) fn maybe_extend_iteration_budget(
    active_budget: &mut u32,
    hard_max_iterations: u32,
    base_max_iterations: u32,
    iteration: u32,
    tool_summaries: &[ToolExecutionSummary],
    state: &mut IterationBudgetState,
    loop_detection_window: u8,
) {
    if tool_summaries.is_empty() {
        state.stall_streak = state.stall_streak.saturating_add(1);
        // Active contraction: if model stalls too long, cut the budget short.
        if state.stall_streak >= 4 && *active_budget > iteration + 2 {
            *active_budget = iteration + 2;
            tracing::warn!(
                iteration,
                active_budget = *active_budget,
                stall_streak = state.stall_streak,
                "Contracted iteration budget — model is stalling (empty tool calls)"
            );
        }
        return;
    }

    let signature = tool_summaries
        .iter()
        .map(|summary| summary.signature.as_str())
        .collect::<Vec<_>>()
        .join("|");
    let useful = tool_summaries.iter().any(|summary| summary.useful);
    let repeated_signature = state.last_signature.as_deref() == Some(signature.as_str());

    // Browser actions have their own loop detector in BrowserTaskPlanState.
    // Skip stall/cycle tracking here to avoid double-counting.
    let is_browser = tool_summaries
        .iter()
        .any(|s| crate::browser::is_browser_tool(&s.name));

    if useful && !repeated_signature {
        state.stall_streak = 0;
    } else if !is_browser {
        state.stall_streak = state.stall_streak.saturating_add(1);
    }
    state.last_signature = Some(signature.clone());
    // Cycle detection runs for ALL tools (including browser) as a safety net.
    // Stall-streak tracking is still skipped for browser to avoid double-counting
    // with BrowserTaskPlanState, but cycle detection must catch budget runaway.
    if loop_detection_window > 0 {
        state.recent_signatures.push(signature.clone());
        let win = loop_detection_window as usize;
        if state.recent_signatures.len() > win {
            let excess = state.recent_signatures.len() - win;
            state.recent_signatures.drain(..excess);
        }

        // Try exact match first, then fuzzy (normalized).
        let cycle = detect_cycle(&state.recent_signatures).or_else(|| {
            let normalized: Vec<String> = state
                .recent_signatures
                .iter()
                .map(|s| normalize_signature_for_cycle(s))
                .collect();
            detect_cycle(&normalized)
        });

        if let Some(period) = cycle {
            state.cycle_detected = Some(period);
            // Contract budget when cycling + some stall evidence.
            if state.stall_streak >= 2 && *active_budget > iteration + 2 {
                *active_budget = iteration + 2;
                tracing::warn!(
                    iteration,
                    active_budget = *active_budget,
                    cycle_period = period,
                    "Contracted iteration budget — cycle detected (period {})",
                    period,
                );
                return;
            }
        }
    }

    // Active contraction: if stalling for 4+ rounds, cut the budget to
    // current iteration + 2 so the model has a last chance then stops.
    if state.stall_streak >= 4 && *active_budget > iteration + 2 {
        *active_budget = iteration + 2;
        tracing::warn!(
            iteration,
            active_budget = *active_budget,
            stall_streak = state.stall_streak,
            "Contracted iteration budget — model is repeating the same actions"
        );
        return;
    }

    // Don't extend if: stalling, not useful, or repeating the same actions.
    // Repeated signatures mean no progress — extending would just waste tokens.
    if state.stall_streak >= 3 || !useful || repeated_signature {
        return;
    }

    if iteration + 1 < *active_budget {
        return;
    }

    let browser_heavy = tool_summaries
        .iter()
        .any(|summary| crate::browser::is_browser_tool(&summary.name));
    let search_heavy = tool_summaries
        .iter()
        .any(|summary| matches!(summary.name.as_str(), "web_search" | "web_fetch"));
    let extension = if browser_heavy {
        10
    } else if search_heavy {
        4
    } else {
        3
    };

    let next_budget = (*active_budget + extension)
        .max(base_max_iterations)
        .min(hard_max_iterations);
    if next_budget > *active_budget {
        *active_budget = next_budget;
        state.extensions_used = state.extensions_used.saturating_add(1);
        tracing::info!(
            iteration,
            active_budget = *active_budget,
            hard_max_iterations,
            browser_heavy,
            search_heavy,
            "Extended iteration budget after observing continued progress"
        );
    }
}

// ── AB-1: Cycle detection helpers ───────────────────────────────

/// Check the most recent signatures for repeating cycles of period 1, 2, or 3.
///
/// Returns the shortest detected period, or `None` if no cycle is found.
/// For period P we need at least 2*P entries and check that
/// `sigs[len-i] == sigs[len-i-P]` for `i` in `0..P`.
pub(crate) fn detect_cycle(signatures: &[String]) -> Option<usize> {
    let len = signatures.len();
    for period in 1..=3 {
        if len < 2 * period {
            continue;
        }
        let is_cycle =
            (0..period).all(|i| signatures[len - 1 - i] == signatures[len - 1 - i - period]);
        if is_cycle {
            return Some(period);
        }
    }
    None
}

/// Coarsen a composite signature for fuzzy cycle detection.
///
/// `web_search`, `web_fetch`, and `browser` are collapsed to just the tool
/// name, so queries/actions with different parameters are treated as the
/// same action. All other tool segments are preserved verbatim.
pub(crate) fn normalize_signature_for_cycle(sig: &str) -> String {
    sig.split('|')
        .map(|segment| {
            let tool_name = segment.split(':').next().unwrap_or(segment);
            if matches!(tool_name, "web_search" | "web_fetch") {
                // Collapse search/fetch to name only (different queries = same action)
                tool_name.to_string()
            } else if tool_name == "browser" {
                // Preserve browser action type (navigate vs click vs type are DIFFERENT)
                // but strip variable params (ref IDs, URLs, text).
                // Signature format: browser:{"action":"navigate","url":"..."}
                if let Some(args_start) = segment.find('{') {
                    if let Ok(args) = serde_json::from_str::<serde_json::Value>(&segment[args_start..]) {
                        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("unknown");
                        return format!("browser:{action}");
                    }
                }
                tool_name.to_string()
            } else {
                segment.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("|")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn browser_summary(sig: &str) -> ToolExecutionSummary {
        ToolExecutionSummary {
            name: "browser".to_string(),
            signature: sig.to_string(),
            useful: true,
        }
    }

    #[test]
    fn browser_cycle_detection_enabled() {
        // Browser tools must NOT be exempt from cycle detection.
        // navigate→click→navigate→click is a period-2 cycle.
        // With action-preserving normalization, they become
        // "browser:navigate" and "browser:click" — detected as period-2.
        let mut budget = 50u32;
        let hard_max = 100u32;
        let base = 50u32;
        let mut state = IterationBudgetState::default();

        // Simulate alternating browser actions: navigate→click loop.
        let sigs = [
            r#"browser:{"action":"navigate","url":"https://example.com"}"#,
            r#"browser:{"action":"click","ref":"e125"}"#,
        ];

        for i in 0..10u32 {
            let summaries = vec![browser_summary(sigs[(i as usize) % 2])];
            maybe_extend_iteration_budget(
                &mut budget,
                hard_max,
                base,
                49 + i, // approaching budget
                &summaries,
                &mut state,
                20,
            );
        }

        // Budget should have been contracted (not extended to 100)
        assert!(
            budget < hard_max,
            "Budget should be contracted when browser is cycling, got {}",
            budget
        );
        assert!(
            state.cycle_detected.is_some(),
            "Cycle should be detected for browser tools"
        );
    }

    #[test]
    fn normalize_preserves_browser_action_type() {
        // Click and navigate should be DIFFERENT signatures
        let click = r#"browser:{"action":"click","ref":"e125"}"#;
        let nav = r#"browser:{"action":"navigate","url":"https://example.com"}"#;
        let typ = r#"browser:{"action":"type","ref":"e42","text":"hello"}"#;
        assert_eq!(normalize_signature_for_cycle(click), "browser:click");
        assert_eq!(normalize_signature_for_cycle(nav), "browser:navigate");
        assert_eq!(normalize_signature_for_cycle(typ), "browser:type");
        // Different action types should NOT be detected as cycles
        assert_ne!(
            normalize_signature_for_cycle(click),
            normalize_signature_for_cycle(nav)
        );
    }

    #[test]
    fn detect_cycle_period_1() {
        let sigs: Vec<String> = vec!["a", "a"].into_iter().map(String::from).collect();
        assert_eq!(detect_cycle(&sigs), Some(1));
    }

    #[test]
    fn detect_cycle_period_2() {
        let sigs: Vec<String> = vec!["a", "b", "a", "b"].into_iter().map(String::from).collect();
        assert_eq!(detect_cycle(&sigs), Some(2));
    }

    #[test]
    fn no_cycle_when_different() {
        let sigs: Vec<String> = vec!["a", "b", "c", "d"].into_iter().map(String::from).collect();
        assert_eq!(detect_cycle(&sigs), None);
    }
}
