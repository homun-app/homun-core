//! The plan state machine — the engine's pure control-flow core (ADR 0024, increment 3).
//!
//! These operate on the canonical plan as a `serde_json::Value` step array
//! (`{id,title,status,detail}`, status ∈ `todo|doing|done|blocked`). They are PURE — no
//! `AppState`, no I/O, no model — so they are the safest first movers out of the monolith and
//! the natural home of "the harness owns control flow" (caposaldo #2). The `ExecutionPlan`
//! adapter (`execution_plan_steps`/`runtime_execution_plan`) and the persistence wrappers
//! (`*_from_state`) stay gateway-side and call INTO these.

use serde_json::Value;

/// The checkbox marker for a step status: `x` done, `-` doing, `!` blocked, space todo.
pub fn plan_status_marker(status: &str) -> char {
    match status {
        "done" => 'x',
        "doing" | "running" => '-',
        "blocked" => '!',
        _ => ' ',
    }
}

/// Parse the latest ‹‹PLAN›› marker back into a canonical plan (id/title/status/detail
/// objects). The marker is the cross-turn persistence: rebuilding from it on turn start
/// RESUMES an interrupted task on the SAME authoritative state. A `done` step in the
/// marker is genuinely done (the canonical marker only shows done once verified).
pub fn parse_plan_marker(text: &str) -> Vec<Value> {
    let (Some(s), Some(e)) = (text.rfind("‹‹PLAN››"), text.rfind("‹‹/PLAN››")) else {
        return Vec::new();
    };
    if e <= s {
        return Vec::new();
    }
    let mut out = Vec::new();
    for line in text[s..e].lines() {
        // Locate the bullet anywhere on the line — the first step is glued to the
        // opening ‹‹PLAN›› marker (no newline between them), so a `starts_with` check
        // would silently drop step 1 (and break F4 resume).
        let Some(bi) = line.find("- [") else {
            continue;
        };
        let t = &line[bi..];
        let status = if t.starts_with("- [x]") {
            "done"
        } else if t.starts_with("- [-]") {
            "doing"
        } else if t.starts_with("- [!]") {
            "blocked"
        } else if t.starts_with("- [ ]") {
            "todo"
        } else {
            continue;
        };
        // `- [m] **Title** (`id`): detail`
        let title = t
            .find("**")
            .and_then(|a| {
                t[a + 2..]
                    .find("**")
                    .map(|b| t[a + 2..a + 2 + b].trim().to_string())
            })
            .unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        let id = t
            .find("(`")
            .and_then(|a| t[a + 2..].find("`)").map(|b| t[a + 2..a + 2 + b].to_string()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("s{}", out.len() + 1));
        let detail = t
            .rsplit("): ")
            .next()
            .map(|d| d.trim())
            .filter(|d| !d.is_empty() && *d != "—")
            .unwrap_or("")
            .to_string();
        out.push(serde_json::json!({
            "id": id, "title": title, "status": status, "detail": detail
        }));
    }
    out
}

pub fn plan_step_status(step: &Value) -> &str {
    step.get("status").and_then(|s| s.as_str()).unwrap_or("todo")
}

pub fn plan_step_title(step: &Value) -> &str {
    step.get("title").and_then(|s| s.as_str()).unwrap_or("")
}

pub fn plan_step_id(step: &Value) -> Option<&str> {
    step.get("id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Count of canonically-DONE steps (the single source of truth for progress).
pub fn plan_done_count(plan: &[Value]) -> usize {
    plan.iter().filter(|s| plan_step_status(s) == "done").count()
}

/// Title of the first step that isn't done and isn't blocked — the next action. None
/// when the plan is complete (all done) or fully blocked. Drives the directive nudge.
pub fn plan_next_open(plan: &[Value]) -> Option<String> {
    plan.iter()
        .find(|s| matches!(plan_step_status(s), "todo" | "doing"))
        .map(|s| plan_step_title(s).to_string())
        .filter(|t| !t.is_empty())
}

pub fn plan_is_complete(plan: &[Value]) -> bool {
    !plan.is_empty() && plan_done_count(plan) == plan.len()
}

pub fn plan_incomplete_reason(plan: &[Value]) -> Option<String> {
    if plan.is_empty() || plan_is_complete(plan) {
        return None;
    }
    let done = plan_done_count(plan);
    let total = plan.len();
    let next = plan_next_open(plan).unwrap_or_else(|| "blocked or unfinished step".to_string());
    Some(format!("plan is incomplete ({done}/{total}); next step: {next}"))
}

/// A plan is SETTLED when every step is terminal (`done` or `blocked`) — nothing runnable
/// remains. Distinct from `plan_is_complete` (all `done`): a plan with a permanently-blocked
/// step is finished, not in-progress, so it must STOP auto-resuming. This is what lets a
/// blocked step actually terminate the plan instead of keeping it forever "active".
pub fn plan_is_settled(plan: &[Value]) -> bool {
    !plan.is_empty() && plan.iter().all(|s| matches!(plan_step_status(s), "done" | "blocked"))
}

/// Harness-owned MONOTONIC progress: a plan runs in order, so once a step is `doing`
/// (or `done`), every earlier still-open step is finished — mark it `done`. Models,
/// especially weak ones, advance the `doing` pointer without ever marking prior steps
/// `done` (and even re-emit the whole plan with completed steps back to `todo`), which
/// left "Progress" stuck at 0/N despite real work. Derive completion deterministically
/// instead of trusting the model. Lives at the plan source, so EVERY client (chat,
/// Telegram/WhatsApp, future surfaces) gets correct progress. Blocked steps are left
/// untouched (a stalled step before the frontier stays visible as blocked).
pub fn enforce_monotonic_plan_progress(steps: &mut [Value]) {
    let Some(frontier) = steps
        .iter()
        .rposition(|s| matches!(plan_step_status(s), "doing" | "done"))
    else {
        return;
    };
    for step in steps.iter_mut().take(frontier) {
        // Every step BEFORE the frontier is behind the current work → close it. This covers
        // `todo` (never started) AND a stale `doing` the model left open when it moved the
        // pointer forward without ever marking the prior step done. Enforces the invariant
        // "at most one active step" (the frontier). Without closing `doing`, `plan_next_open`
        // keeps returning the FIRST `doing` and the harness nudge points the model back at
        // step 1 forever — the observed "dice step 1 fatto ma resta sullo step 1 / rifà cose
        // già fatte" symptom (deepseek: s1 doing + s2 doing → s1 never advanced to done).
        // The just-claimed step is the LAST doing (the frontier) so it stays doing → F2
        // verification of the current claim is untouched. `blocked` stays blocked.
        if matches!(plan_step_status(step), "todo" | "doing") {
            step["status"] = serde_json::json!("done");
        }
    }
}

/// Move the plan frontier forward one step: the first `doing` step becomes `done`, and the first
/// remaining `todo` becomes the new `doing`. Returns the index of the step just closed, or `None`
/// when nothing is in progress. Shared by the harness auto-advance (verified-evidence progress).
pub fn advance_plan_frontier(steps: &mut [Value]) -> Option<usize> {
    let idx = steps.iter().position(|s| plan_step_status(s) == "doing")?;
    steps[idx]["status"] = serde_json::json!("done");
    if let Some(next) = steps.iter_mut().find(|s| plan_step_status(s) == "todo") {
        next["status"] = serde_json::json!("doing");
    }
    Some(idx)
}

/// Render the canonical plan to the ‹‹PLAN›› marker's inner markdown checklist
/// (`- [m] **Title** (`id`): detail`). The inverse of `parse_plan_marker`.
pub fn build_plan_markdown(steps: &[Value]) -> String {
    let mut lines = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let title = step.get("title").and_then(|t| t.as_str()).unwrap_or("").trim();
        if title.is_empty() {
            continue;
        }
        let status = step.get("status").and_then(|s| s.as_str()).unwrap_or("todo");
        let detail = step
            .get("detail")
            .and_then(|d| d.as_str())
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .unwrap_or("—");
        // Stable id: the canonical plan carries an `id`; fall back to positional.
        let id = step
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| format!("s{}", index + 1));
        lines.push(format!(
            "- [{}] **{}** (`{}`): {}",
            plan_status_marker(status),
            title,
            id,
            detail
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_round_trips_through_parse() {
        let steps = vec![
            serde_json::json!({"id":"s1","title":"Read quote","status":"done","detail":"5.6c"}),
            serde_json::json!({"id":"s2","title":"Next market","status":"doing","detail":""}),
        ];
        let md = build_plan_markdown(&steps);
        let wrapped = format!("‹‹PLAN››{md}‹‹/PLAN››");
        let parsed = parse_plan_marker(&wrapped);
        assert_eq!(plan_step_title(&parsed[0]), "Read quote");
        assert_eq!(plan_step_status(&parsed[0]), "done");
        assert_eq!(plan_step_status(&parsed[1]), "doing");
        assert_eq!(plan_step_id(&parsed[1]), Some("s2"));
    }

    #[test]
    fn monotonic_and_frontier_and_queries() {
        let mut steps = vec![
            serde_json::json!({"id":"s1","title":"A","status":"doing","detail":""}),
            serde_json::json!({"id":"s2","title":"B","status":"doing","detail":""}),
            serde_json::json!({"id":"s3","title":"C","status":"todo","detail":""}),
        ];
        enforce_monotonic_plan_progress(&mut steps);
        assert_eq!(plan_step_status(&steps[0]), "done", "stale doing before frontier closes");
        assert_eq!(plan_next_open(&steps).as_deref(), Some("B"));
        assert_eq!(plan_done_count(&steps), 1);
        assert!(!plan_is_complete(&steps));

        assert_eq!(advance_plan_frontier(&mut steps), Some(1));
        assert_eq!(plan_step_status(&steps[2]), "doing");
        assert_eq!(advance_plan_frontier(&mut steps), Some(2));
        assert!(plan_is_complete(&steps));
    }

    #[test]
    fn settled_covers_blocked() {
        let blocked = vec![
            serde_json::json!({"id":"s1","status":"done"}),
            serde_json::json!({"id":"s2","status":"blocked"}),
        ];
        assert!(plan_is_settled(&blocked), "done+blocked is settled");
        assert!(!plan_is_complete(&blocked), "but not complete (a blocked step)");
    }
}
