//! Proactivity review engine and card parsing.
//!
//! This module owns the read-only supervisor review loop that emits proactive
//! suggestion cards. Route handlers and plugin registry endpoints remain in the
//! gateway root until their own owners are extracted.

use crate::gateway_recall_context::{sanitize_dedup_key, scope_display_name};
use crate::*;

/// Durable knowledge of a scope (facts/preferences/decisions/goals), capped to
/// keep the prompt bounded. `scope` is a workspace id or PERSONAL_WORKSPACE,
/// which is exactly the suggestion card's `scope`, so no translation is needed.
fn gather_scope_memory(state: &AppState, scope: &str, cap: usize) -> Vec<String> {
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let workspace = MemoryWorkspaceId::new(scope);
    let mut items: Vec<String> = facade
        .list_memories_for_ui(&user, &workspace)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| {
            matches!(m.status, MemoryStatus::Confirmed | MemoryStatus::Candidate)
                && matches!(
                    m.memory_type.as_str(),
                    "fact" | "preference" | "decision" | "goal"
                )
        })
        .map(|m| {
            let one = m.text.trim().replace('\n', " ");
            format!("[{}] {one}", m.memory_type)
        })
        .collect();
    if items.len() > cap {
        items.drain(0..items.len() - cap);
    }
    items
}

/// Recent connector activity (Composio/MCP tool runs): the "what's been
/// happening" signal that lets the supervisor cite observed work.
fn gather_recent_connector_activity(state: &AppState, cap: usize) -> Vec<String> {
    let Ok(store) = lock_store(state) else {
        return Vec::new();
    };
    store
        .recent_tool_runs(cap.saturating_mul(4).max(cap))
        .unwrap_or_default()
        .into_iter()
        .filter(|r| matches!(r.kind.as_str(), "composio" | "mcp"))
        .take(cap)
        .map(|r| {
            let status = if r.ok {
                "ok".to_string()
            } else {
                format!("error:{}", r.error_kind.as_deref().unwrap_or("?"))
            };
            match r
                .summary
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(s) => format!("- {} [{status}] {s}", r.tool),
                None => format!("- {} [{status}]", r.tool),
            }
        })
        .collect()
}

/// Parse the supervisor's JSON into a ready-to-insert card, or None when the
/// model declined (`suggestion: null`) or omitted the required title/body.
pub(crate) fn parse_review_suggestion(
    value: &serde_json::Value,
    scope: &str,
) -> Option<chat_store::SuggestionInput> {
    let s = value.get("suggestion")?;
    if s.is_null() {
        return None;
    }
    let field = |k: &str| {
        s.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let title = field("title");
    let body = field("body");
    if title.is_empty() || body.is_empty() {
        return None;
    }
    let kind = {
        let raw = field("kind");
        if raw.is_empty() {
            "suggerimento".to_string()
        } else {
            raw
        }
    };
    let anchor = {
        let dk = field("dedup_key");
        if dk.is_empty() { title.clone() } else { dk }
    };
    let proposed_action = s
        .get("proposed_action")
        .filter(|v| !v.is_null())
        .map(|v| match v.as_str() {
            Some(t) => t.to_string(),
            None => v.to_string(),
        })
        .filter(|t| !t.trim().is_empty());
    let choices = s
        .get("choices")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| o.as_str())
                .map(str::trim)
                .filter(|o| !o.is_empty())
                .take(5)
                .map(str::to_string)
                .collect::<Vec<String>>()
        })
        .filter(|opts| !opts.is_empty())
        .and_then(|opts| serde_json::to_string(&opts).ok());
    let dedup_key = sanitize_dedup_key(&kind, &anchor);
    let relevant_until = s
        .get("relevant_until")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .and_then(parse_relevant_until_epoch);
    Some(chat_store::SuggestionInput {
        scope: scope.to_string(),
        kind,
        title,
        body,
        rationale: field("rationale"),
        proposed_action,
        choices,
        dedup_key,
        source_ref: "supervisor:review".to_string(),
        relevant_until,
    })
}

/// Parse an ISO `YYYY-MM-DD` into the unix timestamp of the start of the next
/// UTC day, so a dated card remains relevant through its own day.
fn parse_relevant_until_epoch(iso: &str) -> Option<i64> {
    let head = iso.split(['T', ' ']).next().unwrap_or(iso);
    let mut parts = head.split('-');
    let year: i32 = parts.next()?.trim().parse().ok()?;
    let month: u8 = parts.next()?.trim().parse().ok()?;
    let day: u8 = parts.next()?.trim().parse().ok()?;
    let month = time::Month::try_from(month).ok()?;
    let date = time::Date::from_calendar_date(year, month, day).ok()?;
    Some(date.next_day()?.midnight().assume_utc().unix_timestamp())
}

/// Decode a card's stored `choices` JSON array string into the frontend value.
pub(crate) fn suggestion_choices_json(stored: &Option<String>) -> serde_json::Value {
    stored
        .as_deref()
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .filter(|v| !v.is_empty())
        .map(|v| serde_json::json!(v))
        .unwrap_or(serde_json::Value::Null)
}

const PROACTIVE_SUPERVISOR_SYSTEM: &str = "You are the user's proactive SUPERVISOR for ONE scope of \
work (a project or the personal space). From the REAL CONTEXT below, identify AT MOST ONE thing \
worth surfacing NOW — or NONE. You are a colleague who works alongside, not an assistant who \
waits for orders.\n\
A card can be OF TWO TYPES:\n\
(A) a concrete ACTION to take/decide (kind e.g. deadline, stalled-project, automation, follow-up); \
or\n\
(B) a targeted QUESTION to GET TO KNOW the user or the project better, when answering grows what \
you know and makes you more useful: kind \"curiosity\" if you are digging into a NEW item in the \
context (e.g. a person/project/preference appeared and you are missing a detail); kind \
\"onboarding\" when you STILL KNOW LITTLE (sparse memory) and need the basics (how they work, what \
they do, important people and deadlines, how they prefer answers). Questions do NOT have \
`proposed_action`: the user replies by opening the chat.\n\
For a QUESTION (B) whose answer is naturally a choice among FEW options (e.g. yes/no, a preference \
among alternatives), add `choices`: 2-4 VERY SHORT options that become quick-reply buttons. Omit \
`choices` for open questions (free-form answer) and for ACTIONS.\n\
VALIDATE only if: (1) it is ANCHORED — actions to the real context, questions to a recent fact (or, \
in onboarding, to what you clearly do NOT know yet) — and you cite the basis in `rationale`; do NOT \
invent; (2) it is SPECIFIC, never vague; (3) it is NEW, it does not resemble ALREADY PRESENT \
cards.\n\
Do NOT produce: generic or motivational advice; GENERIC and lazy interview-style questions \
(\"how can I help you?\", \"tell me about yourself\"); several things at once (ONE only, the most \
useful); executed actions (the action goes in `proposed_action`, the user approves it). If there is \
nothing solid and non-trivial, reply {\"suggestion\": null}. ZERO IS BETTER THAN NOISE.\n\
LEARN FROM FEEDBACK: if a FEEDBACK section is present, favor the STYLE and THEMES of suggestions \
the user found USEFUL and AVOID anything resembling the ones marked NOT USEFUL. Feedback is the \
most important signal about their taste.\n\
TIME-AWARENESS: a TODAY date is given above. NEVER surface a card about a date/event that has \
ALREADY passed — a trip, deadline or meeting whose date is before TODAY is done, so say nothing \
about it. When a card DOES hinge on a date, set `relevant_until` to the LAST day it is worth acting \
on (ISO YYYY-MM-DD) so it auto-trashes once that date passes; omit it for timeless cards.\n\
Reply with JSON ONLY: {\"suggestion\": null} OR {\"suggestion\": {\"kind\":\"short theme in \
kebab-case\",\"title\":\"very short title (for a question, this IS the question)\",\"body\":\"1-3 \
sentences: what you noticed and what you propose/ask\",\"rationale\":\"which context element it \
derives from (or what you do not know yet)\",\"dedup_key\":\"STABLE anchor of WHAT it is about \
(the object/person/deadline), not the text\",\"proposed_action\":\"OPTIONAL, only for ACTIONS: what \
to do, which the user will approve\",\"choices\":[\"OPTIONAL, only for CLOSED-CHOICE QUESTIONS: 2-4 \
short options\"],\"relevant_until\":\"OPTIONAL ISO date YYYY-MM-DD past which the card is stale \
(date-bound cards only)\"}}.";

/// Run one read-only supervisor review for a scope. It inserts at most one card.
pub(crate) async fn run_proactive_review(state: &AppState, scope: &str) -> Option<i64> {
    if !lock_store(state)
        .map(|s| s.plugin_enabled("proattivita"))
        .unwrap_or(true)
    {
        eprintln!("[proactivity] addon disabled, skipping");
        return None;
    }
    let memory = gather_scope_memory(state, scope, 60);
    let activity = gather_recent_connector_activity(state, 20);
    let is_personal = scope == PERSONAL_WORKSPACE;
    if memory.is_empty() && activity.is_empty() && !is_personal {
        eprintln!("[proactivity] review '{scope}': no context, skipping");
        return None;
    }
    let pending: Vec<String> = lock_store(state)
        .ok()
        .and_then(|s| s.pending_suggestions(Some(scope), 20).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|c| format!("- [{}] {}", c.kind, c.title))
        .collect();

    let today = OffsetDateTime::now_utc().date();
    let today_str = format!(
        "{:04}-{:02}-{:02}",
        today.year(),
        u8::from(today.month()),
        today.day()
    );
    let mut brief = format!(
        "TODAY (UTC): {}\nSCOPE: {}\n\n",
        today_str,
        scope_display_name(scope)
    );
    if !memory.is_empty() {
        brief.push_str("SCOPE MEMORY (decisions/goals/facts/preferences):\n");
        brief.push_str(&memory.join("\n"));
        brief.push_str("\n\n");
    }
    if !activity.is_empty() {
        brief.push_str("RECENT CONNECTOR ACTIVITY:\n");
        brief.push_str(&activity.join("\n"));
        brief.push_str("\n\n");
    }
    if !pending.is_empty() {
        brief.push_str("CARDS ALREADY PRESENT (do NOT repeat them, not even paraphrased):\n");
        brief.push_str(&pending.join("\n"));
        brief.push_str("\n\n");
    }
    let feedback = lock_store(state)
        .ok()
        .and_then(|s| s.recent_feedback(scope, 12).ok())
        .unwrap_or_default();
    if !feedback.is_empty() {
        brief.push_str("USER FEEDBACK (learn from this):\n");
        for (verdict, kind, title) in &feedback {
            let mark = if verdict == "liked" {
                "USEFUL"
            } else {
                "NOT USEFUL"
            };
            brief.push_str(&format!("- [{mark}] ({kind}) {title}\n"));
        }
        eprintln!(
            "[proactivity] review '{scope}': {} feedback signals in context",
            feedback.len()
        );
    }

    let root = call_memory_json(state, PROACTIVE_SUPERVISOR_SYSTEM, &brief).await?;
    let input = parse_review_suggestion(&root, scope)?;

    let store = lock_store(state).ok()?;
    if store
        .suggestion_dedup_exists(scope, &input.dedup_key)
        .unwrap_or(false)
    {
        eprintln!(
            "[proactivity] review '{scope}': duplicate '{}', skipping",
            input.dedup_key
        );
        return None;
    }
    let anchors = store
        .recent_suggestion_anchors(scope, 150)
        .unwrap_or_default();
    if is_semantic_duplicate(&input.dedup_key, &input.title, &anchors) {
        eprintln!(
            "[proactivity] review '{scope}': near-duplicate of a card already emitted ('{}'), skipping",
            input.title
        );
        return None;
    }
    let id = store.insert_suggestion(&input).ok()?;
    eprintln!(
        "[proactivity] review '{scope}': card #{id} '{}'",
        input.title
    );
    Some(id)
}

/// One-time sweep for legacy cards that predate the `relevant_until` field.
pub(crate) async fn sweep_stale_dated_suggestions_once(state: &AppState) {
    const FLAG: &str = "suggestions_date_sweep_v1";
    let already_done = lock_store(state)
        .ok()
        .and_then(|s| s.flag(FLAG).ok().flatten())
        .is_some_and(|v| v == "done");
    if already_done {
        return;
    }
    let cards = lock_store(state)
        .ok()
        .and_then(|s| s.pending_suggestions(None, 200).ok())
        .unwrap_or_default();
    if cards.is_empty() {
        let _ = lock_store(state).map(|s| s.set_flag(FLAG, "done"));
        return;
    }
    let today = OffsetDateTime::now_utc().date();
    let today_str = format!(
        "{:04}-{:02}-{:02}",
        today.year(),
        u8::from(today.month()),
        today.day()
    );
    let list: String = cards
        .iter()
        .map(|c| {
            format!(
                "- id {}: {} — {}",
                c.id,
                c.title,
                c.body.chars().take(200).collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let system = "You retire stale proactivity cards. Given TODAY and a list of cards, return the ids \
of cards that hinge on a date/event ALREADY PAST relative to TODAY (a trip, deadline or meeting whose \
date is before TODAY — no longer actionable). Cards with no date, or with a date of today or the \
future, are NOT stale. Reply with JSON ONLY: {\"stale_ids\": [<id>, ...]}.";
    let brief = format!("TODAY (UTC): {today_str}\n\nCARDS:\n{list}");
    let Some(root) = call_memory_json(state, system, &brief).await else {
        return;
    };
    let stale_ids: Vec<i64> = root
        .get("stale_ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(serde_json::Value::as_i64).collect())
        .unwrap_or_default();
    if let Ok(store) = lock_store(state) {
        for id in &stale_ids {
            let _ = store.set_suggestion_status(*id, "stale", None, None);
        }
        let _ = store.set_flag(FLAG, "done");
    }
    if !stale_ids.is_empty() {
        eprintln!(
            "[proactivity] one-time date sweep: retired {} stale-dated card(s)",
            stale_ids.len()
        );
    }
}

fn proactive_tick_secs() -> u64 {
    std::env::var("HOMUN_PROACTIVE_TICK_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&v| v >= 60)
        .unwrap_or(600)
}

fn proactive_cooldown_secs() -> i64 {
    std::env::var("HOMUN_PROACTIVE_COOLDOWN_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(3 * 60 * 60)
}

pub(crate) fn start_proactivity_auto_review(state: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(proactive_tick_secs())).await;
            proactivity_auto_review_tick(&state).await;
        }
    });
}

async fn proactivity_auto_review_tick(state: &AppState) {
    if !lock_store(state)
        .map(|s| s.plugin_enabled("proattivita"))
        .unwrap_or(true)
    {
        return;
    }
    if !(9..22).contains(&now_local().hour()) {
        return;
    }
    if let Some(secs) = seconds_since_user_activity()
        && secs < homun_idle_threshold_secs()
    {
        return;
    }
    let mut scopes = vec![PERSONAL_WORKSPACE.to_string()];
    for ws in load_workspaces_file().workspaces {
        if ws.id != base_workspace_id() && ws.id != PERSONAL_WORKSPACE {
            scopes.push(ws.id);
        }
    }
    let now = now_epoch_secs() as i64;
    let cooldown = proactive_cooldown_secs();
    let last_at = |scope: &str| -> i64 {
        lock_store(state)
            .ok()
            .and_then(|s| s.flag(&format!("auto_review_at:{scope}")).ok().flatten())
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
    };
    let Some(scope) = scopes
        .into_iter()
        .filter(|s| now - last_at(s) >= cooldown)
        .min_by_key(|s| last_at(s))
    else {
        return;
    };
    if let Ok(store) = lock_store(state) {
        let _ = store.set_flag(&format!("auto_review_at:{scope}"), &now.to_string());
    }
    eprintln!("[proactivity] auto-review scope '{scope}' (idle + hours ok)");
    let _ = run_proactive_review(state, &scope).await;
}

#[cfg(test)]
mod tests {
    use super::{parse_review_suggestion, suggestion_choices_json};

    #[test]
    fn gateway_proactivity_parse_declines_cleanly() {
        assert!(
            parse_review_suggestion(&serde_json::json!({ "suggestion": null }), "proj").is_none()
        );
        assert!(parse_review_suggestion(&serde_json::json!({}), "proj").is_none());
        let empty = serde_json::json!({ "suggestion": { "kind": "x", "title": "", "body": "" } });
        assert!(parse_review_suggestion(&empty, "proj").is_none());
    }

    #[test]
    fn gateway_proactivity_parse_builds_card_with_choices() {
        let value = serde_json::json!({
            "suggestion": {
                "kind": "curiosità",
                "title": "Lavoro o privato?",
                "body": "Come usi Homun?",
                "rationale": "onboarding",
                "dedup_key": "uso",
                "choices": ["Lavoro", "Privato", "  ", "Entrambi"]
            }
        });
        let card = parse_review_suggestion(&value, "p").expect("card");
        assert_eq!(card.scope, "p");
        assert_eq!(card.dedup_key, "curiosità:uso");
        assert_eq!(
            suggestion_choices_json(&card.choices),
            serde_json::json!(["Lavoro", "Privato", "Entrambi"])
        );
    }
}
