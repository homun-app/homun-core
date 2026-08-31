//! Browser tool schema and policy owner.
//!
//! Owns delegated browse budgets, browser tool schemas, browser_done parsing,
//! browser action outcome hints, payment-safe bundle normalization, stale-ref
//! recovery messaging, and related manager/browser guidance.

use super::{ChatTurnPolicy, ContactMemoryPerimeter, browser_safety, skill_security};
use std::env;

#[test]
fn browser_tools_owner_smoke() {
    assert_eq!(bounded_browse_subagent_nav_cap(20), 8);
}

pub(crate) const MAX_TOOL_ROUNDS_BROWSER: usize = 64;

/// Round budget once a browser tool has been used this turn (env-overridable).
pub(crate) fn chat_browser_max_rounds() -> usize {
    env::var("HOMUN_CHAT_BROWSER_MAX_ROUNDS")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(MAX_TOOL_ROUNDS_BROWSER)
}

/// Wander-cap: max browser NAVIGATIONS spent on the SAME plan step before we stop
/// browsing and synthesize from what we already gathered. The per-step round budget
/// (F1) only resets on step COMPLETION, so a model that never closes a step (it keeps
/// hopping across cookie-walled / JS-heavy live sources that fail to read — Mondiali:
/// ~15 pages, 0/4 closed) burns the WHOLE 64-round budget wandering. Counting distinct
/// navigations per step (via `step_evidence`, cleared on step close) catches the
/// distinct-URL wander the no-progress guard misses (it only catches IDENTICAL calls).
/// Env-overridable: `HOMUN_CHAT_BROWSER_NAV_CAP`.
///
/// Set GENEROUSLY (20): a legitimate multi-part research reads many DISTINCT productive
/// pages (e.g. all 12 World-Cup group pages + schedule + knockout ≈ 15-18 navigations),
/// and counting can't tell that apart from pathological wander. A too-tight cap (10) cut a
/// real briefing off at 7/12 groups when the turn ran WITHOUT a plan (no step ever closed
/// → the counter never reset). The real backstops are the per-step round budget AND the
/// forced final synthesis (which always emits a deliverable from what was gathered), so
/// this only needs to catch genuinely excessive hopping.
pub(crate) const MAX_BROWSER_NAVS_PER_STEP: usize = 20;

pub(crate) fn chat_browser_nav_cap() -> usize {
    env::var("HOMUN_CHAT_BROWSER_NAV_CAP")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(MAX_BROWSER_NAVS_PER_STEP)
}

pub(crate) fn chat_browser_budget() -> local_first_engine::BrowserBudget {
    let max_elapsed_ms = env::var("HOMUN_CHAT_BROWSER_MAX_ELAPSED_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(|value| value.clamp(1_000, 600_000))
        .unwrap_or(300_000);
    // Stall window: max wall-clock since the last real progress (resets on success). This is the
    // primary control; `max_elapsed_ms` above is only the absolute backstop.
    let max_stall_ms = env::var("HOMUN_CHAT_BROWSER_MAX_STALL_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(|value| value.clamp(1_000, 600_000))
        .unwrap_or(120_000);
    let max_failed_navigations = env::var("HOMUN_CHAT_BROWSER_MAX_FAILED_NAVIGATIONS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .map(|value| value.clamp(1, 32))
        .unwrap_or(8);
    let max_no_progress = env::var("HOMUN_CHAT_BROWSER_MAX_NO_PROGRESS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .map(|value| value.clamp(1, 20))
        .unwrap_or(5);
    local_first_engine::BrowserBudget {
        max_elapsed_ms,
        max_stall_ms,
        max_failed_navigations,
        max_no_progress,
    }
}

/// Absolute wall-clock backstop for ONE delegated `browse` sub-turn (see the sub-turn's `TurnConfig`).
/// Named rather than inlined because the MANAGER budget below is DERIVED from it: the two are one
/// invariant, not two independent numbers that can drift apart. This is a last-resort wall-clock
/// cap, not the primary stuck-loop control: the sub-turn's progress-relative stall window remains
/// much tighter and resets only on real browser progress.
pub(crate) const BROWSE_SUBTURN_MAX_ELAPSED_MS: u64 = 300_000;

/// The MANAGER turn's absolute wall-clock backstop, derived from one browse sub-turn's own cap.
///
/// Same trap as `browse_hard_round_ceiling`: a backstop set EQUAL to the thing it backstops fires
/// first and makes the progress-relative control unreachable. The manager does not browse itself, it
/// DELEGATES — and one `browse` may legitimately spend its entire sub-turn budget (observed: a single
/// browse round taking 259s). With the manager also capped at 300s, any task needing more than one
/// browse was mathematically guaranteed to be killed mid-flight: a train booking ran 4 successful
/// browses, was cut at 302s (`round 4` ended at t=302240ms, the wall-clock check tripped 4ms later)
/// and forced into a synthesis the user received as nothing at all.
///
/// The PRIMARY control remains `max_stall_ms` — wall-clock WITHOUT a single successful delegated
/// browse, reset on every `browser_activity_observed` — so a genuinely stuck manager still dies in
/// ~2 minutes. Only a manager that keeps making real progress gets the long rope. `x4` mirrors
/// `browse_hard_round_ceiling`'s ratio; the `.max()` floor keeps the invariant "the manager outlives
/// what it delegates" true even when `HOMUN_CHAT_BROWSER_MAX_ELAPSED_MS` shortens the shared budget
/// (that knob can still scale the manager UP, it just cannot push it below the sub-turn it drives).
pub(crate) fn manager_browser_max_elapsed_ms(configured_ms: u64) -> u64 {
    configured_ms
        .max(BROWSE_SUBTURN_MAX_ELAPSED_MS)
        .saturating_mul(4)
}

/// Browser budget for the MANAGER turn: the shared budget with only the absolute wall-clock backstop
/// widened (see `manager_browser_max_elapsed_ms`). The stall window and the stagnation counters — the
/// controls that actually stop a stuck turn — are deliberately left identical to `chat_browser_budget`.
pub(crate) fn chat_manager_browser_budget() -> local_first_engine::BrowserBudget {
    let mut budget = chat_browser_budget();
    budget.max_elapsed_ms = manager_browser_max_elapsed_ms(budget.max_elapsed_ms);
    budget
}

// Absolute wall-clock BACKSTOP for one browse sub-turn — never resets, a final safety net only.
// Deliberately generous (15 min): the goal of an autonomous browse is that it ANSWERS, not that it
// answers quickly, so a run that keeps making progress must not be cut off by the clock. What stops a
// STUCK run is the per-progress stall window (90s without a single successful action, reset on every
// success) plus the change-approach hint the loop sends when the same call repeats — controls that
// measure progress rather than elapsed time. This bound only exists so a pathological loop cannot run
// unbounded; reaching it means ~15 minutes of work that never stalled for 90s.
#[allow(dead_code)]
pub(crate) const BROWSE_SUBAGENT_MAX_ELAPSED_MS: u64 = 900_000;
pub(crate) const BROWSE_SUBAGENT_MAX_NAVS: usize = 8;
pub(crate) const BROWSE_SUBAGENT_LIST_MAX_NAVS: usize = 12;

#[allow(dead_code)]
pub(crate) fn browse_subagent_budget() -> local_first_engine::BrowserBudget {
    let mut budget = chat_browser_budget();
    // Upper clamp raised to 1h so a deliberately long autonomous run can be configured; the default
    // above is the 15-minute backstop.
    budget.max_elapsed_ms = env::var("HOMUN_CHAT_BROWSER_SUBAGENT_MAX_ELAPSED_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(|value| value.clamp(1_000, 3_600_000))
        .unwrap_or(BROWSE_SUBAGENT_MAX_ELAPSED_MS);
    budget
}

pub(crate) fn bounded_browse_subagent_nav_cap(configured_cap: usize) -> usize {
    configured_cap.min(BROWSE_SUBAGENT_MAX_NAVS)
}

pub(crate) fn browse_subagent_nav_cap_for_contract(
    contract: Option<&local_first_engine::browse::BrowseResultContract>,
) -> usize {
    let configured_cap = chat_browser_nav_cap();
    let is_multi_item_list = contract.is_some_and(|contract| {
        contract.kind == local_first_engine::browse::BrowseResultKind::List
            && contract.minimum_items.unwrap_or(0) >= 3
    });
    if is_multi_item_list {
        configured_cap.min(BROWSE_SUBAGENT_LIST_MAX_NAVS)
    } else {
        bounded_browse_subagent_nav_cap(configured_cap)
    }
}

/// How many connected-service tools to pull into the searchable catalog (NOT
/// sent to the model — only searched by `find_connected_tools`).
pub(crate) const COMPOSIO_CATALOG_CAP: usize = 200;
/// How many tools `find_connected_tools` returns (and injects) per search.
pub(crate) const COMPOSIO_DISCOVERY_RESULTS: usize = 8;
/// Cap on a Composio tool result fed back to the model (email bodies can be huge).
pub(crate) const COMPOSIO_RESULT_CHARS: usize = 6000;
/// How many MCP tools (across all connected servers) to pull into the searchable
/// catalog. MCP tools are read from the local SQLite cache, so this is cheap.
pub(crate) const MCP_CATALOG_CAP: usize = 100;
/// Granular browser tool: navigate to a URL (and auto-snapshot the result).
/// ADR 0025 (browse-as-recursion): the SINGLE browser tool the manager sees when the sub-agent is on. The
/// manager states an information GOAL (one need, usually one plan step); an isolated sub-agent drives the
/// real browser to satisfy it and returns a compact result. The manager never sees snapshots/clicks — it
/// delegates the whole browse and reads back `found`/`answer`/`sources`, so its context stays clean.
pub(crate) fn browse_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "browse",
            "description": "Delegate a web-browsing GOAL to an isolated browser sub-agent and get back the result. Use it whenever you need real-time or web data (prices, standings, schedules, facts, availability) AND whenever the task itself lives on a website (filling a form, picking a result, booking, checkout, an account page): state ONE concrete goal in `goal` (e.g. 'current BTC price on Kraken', 'Serie A standings after matchday 30'). One delegated browse call should be enough for a concrete goal: include semantic hints/result requirements when useful, then inspect the returned structured result. If the result is partial, blocked, unavailable, or failed, report that grounded state instead of blindly retrying the same browse. CONTINUING A WEB TASK: the thread keeps ONE warm browser session on the page the last browse left, so the next step of a web task is ANOTHER browse call whose goal refers to what is already open (e.g. 'on the search results already open, select the 08:10 Frecciarossa 9524 and proceed to the booking step') rather than a fresh search — never continue it with shell, Python, run_in_project, run_in_sandbox, curl or an HTTP request, which cannot carry the site's interactive session and can never book, buy or submit anything there.",
            "parameters": {
                "type": "object",
                "properties": {
                    "goal": {
                        "type": "string",
                        "description": "The single, concrete information goal to satisfy on the web, in plain language."
                    },
                    "hints": {
                        "type": "object",
                        "description": "Optional starting hints.",
                        "properties": {
                            "url": {
                                "type": "string",
                                "description": "A preferred starting URL, if you already know a good source."
                            },
                            "container": {
                                "type": "string",
                                "description": "A site/section to prefer (e.g. 'wikipedia', 'official schedule')."
                            }
                        }
                    },
                    "result_contract": {
                        "type": "object",
                        "description": "Structured result requirements derived semantically from the user's request. The model chooses these fields; the gateway validates shape and bounds only.",
                        "properties": {
                            "kind": {
                                "type": "string",
                                "enum": ["list", "fact"],
                                "description": "Use fact for one entity/object with one or many requested fields. Use list only for repeated rows/options/entities. Several fields of one page or object are still one fact."
                            },
                            "minimum_items": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 10,
                                "description": "Minimum repeated rows for kind=list. Counts result rows, never the number of requested fields. Omit for kind=fact."
                            },
                            "fields": {
                                "type": "array",
                                "maxItems": 12,
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": { "type": "string", "maxLength": 80 },
                                        "required": { "type": "boolean" }
                                    },
                                    "required": ["name", "required"]
                                }
                            },
                            "boundary": { "type": "string", "maxLength": 400 }
                        }
                    }
                },
                "required": ["goal"]
            }
        }
    })
}

/// Manager-facing browser guide, always appended to the chat system prompt.
///
/// ADR 0025: the manager's ONLY browser surface is the delegated `browse(goal)` tool — the granular
/// micro-tools are seeded exclusively inside the isolated browse sub-loop. The block this replaced
/// still described `browser_navigate`/`browser_act` (a toolset the manager does not have) and gave
/// autocomplete advice contradicting the sub-agent's own rule.
///
/// The CONTINUATION bullet is the load-bearing one: after a `browse` returned `completed`, nothing
/// told the manager that the next step of a web task is ANOTHER `browse`, so on a follow-up like
/// "now book the first one" it fell back to Python/shell — a dead end, because the site's
/// interactive session lives in the thread's warm browser session (`browser_thread_sessions`) and
/// no script or HTTP call can carry it. Pinned by `manager_browser_guidance_*` tests.
pub(crate) fn manager_browser_guidance() -> &'static str {
    "BROWSER (delegated `browse`): web work happens ONLY through the `browse` \
tool — you state ONE concrete goal, an isolated sub-agent drives the real browser and returns the \
result. You never navigate or click yourself; if `browse` is not among your tools yet, activate it \
with `find_capability` instead of giving up or improvising another route.\n\
- CONTINUATION: when a task lives on a website (searching, filling a form, selecting a result, \
booking, checkout, an account page), the ONLY way to continue it is ANOTHER `browse` call stating \
the next goal. NEVER continue a web task with run_in_sandbox, run_in_project, shell, Python, curl \
or an HTTP request: those cannot carry the site's interactive session (cookies, cart, the selected \
result), so they can never book, buy or submit anything there.\n\
- THE SESSION STAYS OPEN: the thread keeps one warm browser session between turns, on the page the \
last browse left (it is closed only after some idle time or when the thread ends). So a follow-up \
like \"book the first one\" is a browse goal that REFERS to what is already on screen (e.g. \"on the \
search results already open, select the 08:10 Frecciarossa 9524 and proceed to the booking step\"), \
not a fresh search from scratch. Carry into the goal every parameter already resolved in the \
conversation (route, date with year, constraints); if the user gave a range of dates, state the \
whole range in the goal instead of silently dropping it.\n\
- RESULTS: rows of results ARE a success: report them (operator, times, duration, changes, price). \
Do NOT say \"no results\" when the browse returned rows. If a browse comes back partial, blocked or \
unavailable, report that grounded state instead of blindly repeating the same browse.\n\
- SECURITY: NEVER logins/bookings/payments unattended. The browse sub-agent CANNOT authorize a \
payment: payment controls are refused to it and it stops and reports. At final checkout, STOP and show \
a Payment Approval Card with marker `‹‹PAYMENT_APPROVAL››{\"snapshot\":{\"approval_id\":\"pay_<uuid>\",\"merchant\":\"...\",\"domain\":\"...\",\"amount_minor\":5900,\"currency\":\"EUR\",\"product_summary\":\"...\",\"payment_method_label\":\"Visa 1111\",\"checkout_fingerprint\":\"stable hash or screenshot id\"}}‹‹/PAYMENT_APPROVAL››`. \
Do not let the payment be committed until the user approves that card locally: only after approval may \
the checkout continue, in a `browse` goal carrying the exact `payment_approval_id` the approval \
returned — never invent that id, never type a CVV yourself, and never try to work around a refused \
payment control with another tool (say what is blocked instead).\n\
- STOP: as soon as you have enough data, STOP browsing and write the final reply \
to the user (one row per option + an optional Sources footer)."
}

pub(crate) fn browser_done_tool_schema(
    contract: Option<&local_first_engine::browse::BrowseResultContract>,
) -> serde_json::Value {
    let mut item_properties = serde_json::Map::new();
    let mut required_item_fields = Vec::new();
    if let Some(contract) = contract {
        for field in &contract.fields {
            item_properties.insert(
                field.name.clone(),
                serde_json::json!({
                    "description": format!("Observed value for result-contract field `{}`.", field.name)
                }),
            );
            if field.required {
                required_item_fields.push(serde_json::Value::String(field.name.clone()));
            }
        }
    }
    let mut item_schema = serde_json::json!({
        "type": "object",
        "properties": item_properties,
        "additionalProperties": true
    });
    if !required_item_fields.is_empty() {
        item_schema["required"] = serde_json::Value::Array(required_item_fields);
    }

    serde_json::json!({
        "type": "function",
        "function": {
            "name": "browser_done",
            "description": "Terminate the browser sub-turn with grounded structured evidence. Put every observed result-contract field in items: one object for a fact, one object per row for a list. The answer is display text and does not satisfy required fields. Use this as soon as the result contract is satisfied, partial, blocked, unavailable, or timed out. Do not write a normal prose answer instead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["completed","partial","blocked","unavailable","timeout"] },
                    "answer": { "type": "string" },
                    "items": { "type": "array", "items": item_schema },
                    "fields_missing": { "type": "array", "items": { "type": "string" } },
                    "sources": { "type": "array", "items": { "type": "string" } },
                    "evidence": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["status", "answer", "items", "fields_missing", "sources", "evidence"]
            }
        }
    })
}

pub(crate) fn provider_wrapped_text(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let object = value.as_object()?;
    if let Some(text) = object.get("$text").and_then(provider_wrapped_text) {
        return Some(text);
    }
    if object.len() == 1 {
        return object.values().next().and_then(provider_wrapped_text);
    }
    None
}

pub(crate) fn parse_browser_done_payload(
    args_raw: &str,
) -> Result<local_first_engine::browse::BrowserDonePayload, String> {
    let mut value = serde_json::from_str::<serde_json::Value>(args_raw)
        .map_err(|error| format!("invalid JSON: {error}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "browser_done arguments must be a JSON object".to_string())?;

    for key in ["status", "answer"] {
        let wrapped = object.get(key).and_then(provider_wrapped_text);
        if let Some(wrapped) = wrapped {
            object.insert(key.to_string(), serde_json::Value::String(wrapped));
        }
    }

    if let Some(status) = object
        .get("status")
        .and_then(serde_json::Value::as_str)
        .map(str::to_ascii_lowercase)
    {
        let normalized = match status.as_str() {
            "complete" | "done" | "success" => "completed",
            "incomplete" => "partial",
            other => other,
        };
        object.insert("status".to_string(), serde_json::json!(normalized));
    }

    if !object.contains_key("status") {
        let has_content = |value: &serde_json::Value| match value {
            serde_json::Value::Array(values) => values.iter().any(|item| match item {
                serde_json::Value::String(text) => !text.trim().is_empty(),
                serde_json::Value::Object(object) => !object.is_empty(),
                other => provider_wrapped_text(other).is_some_and(|text| !text.trim().is_empty()),
            }),
            serde_json::Value::Object(object) => !object.is_empty(),
            serde_json::Value::String(text) => !text.trim().is_empty(),
            other => provider_wrapped_text(other).is_some_and(|text| !text.trim().is_empty()),
        };
        let has_evidence = ["answer", "items", "sources", "evidence"]
            .iter()
            .any(|key| object.get(*key).is_some_and(has_content));
        if has_evidence {
            object.insert("status".to_string(), serde_json::json!("partial"));
        }
    }

    match object.get_mut("items") {
        Some(items @ serde_json::Value::String(_)) => {
            let encoded = items.as_str().unwrap_or("").trim();
            if let Some(parsed @ (serde_json::Value::Array(_) | serde_json::Value::Object(_))) =
                parse_jsonish_browser_done_value(encoded)
            {
                *items = parsed;
            }
        }
        Some(items @ serde_json::Value::Object(_)) => {
            *items = serde_json::Value::Array(vec![items.take()]);
        }
        Some(items @ serde_json::Value::Null) => {
            *items = serde_json::Value::Array(Vec::new());
        }
        None => {
            object.insert("items".to_string(), serde_json::Value::Array(Vec::new()));
        }
        _ => {}
    }
    if let Some(items) = object
        .get_mut("items")
        .and_then(serde_json::Value::as_array_mut)
    {
        for item in items {
            let encoded = provider_wrapped_text(item);
            if let Some(encoded) = encoded
                && let Ok(parsed @ serde_json::Value::Object(_)) =
                    serde_json::from_str::<serde_json::Value>(&encoded)
            {
                *item = parsed;
            }
        }
    }
    for key in ["fields_missing", "sources", "evidence"] {
        let wrapped_scalar = object
            .get(key)
            .filter(|value| !value.is_array())
            .and_then(provider_wrapped_text);
        if let Some(wrapped_scalar) = wrapped_scalar {
            object.insert(
                key.to_string(),
                serde_json::Value::Array(vec![serde_json::Value::String(wrapped_scalar)]),
            );
        }
        match object.get_mut(key) {
            Some(item @ serde_json::Value::String(_)) => {
                *item = serde_json::Value::Array(vec![item.take()]);
            }
            Some(item @ serde_json::Value::Null) => {
                *item = serde_json::Value::Array(Vec::new());
            }
            None => {
                object.insert(key.to_string(), serde_json::Value::Array(Vec::new()));
            }
            _ => {}
        }
        if let Some(values) = object
            .get_mut(key)
            .and_then(serde_json::Value::as_array_mut)
        {
            for value in values {
                let wrapped = provider_wrapped_text(value);
                if let Some(wrapped) = wrapped {
                    *value = serde_json::Value::String(wrapped);
                }
            }
        }
    }

    serde_json::from_value(value).map_err(|error| format!("invalid terminal shape: {error}"))
}

fn parse_jsonish_browser_done_value(encoded: &str) -> Option<serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(encoded)
        .ok()
        .or_else(|| {
            let repaired = repair_browser_done_unquoted_keys(encoded);
            if repaired == encoded {
                return None;
            }
            serde_json::from_str::<serde_json::Value>(&repaired).ok()
        })
}

fn repair_browser_done_unquoted_keys(encoded: &str) -> String {
    let mut repaired = encoded.to_string();
    for key in [
        "heading",
        "fields",
        "amount",
        "button",
        "type",
        "description",
        "source",
        "title",
        "url",
        "name",
    ] {
        for prefix in ["{", "{ ", ",", ", "] {
            let needle = format!("{prefix}{key}\":");
            let replacement = format!("{prefix}\"{key}\":");
            repaired = repaired.replace(&needle, &replacement);
        }
    }
    repaired
}

pub(crate) fn initial_manager_tool_schemas_for_test(
    _turn_policy: &ChatTurnPolicy,
    _contact_memory_perimeter: &ContactMemoryPerimeter,
) -> Vec<serde_json::Value> {
    vec![browse_tool_schema()]
}

pub(crate) fn use_computer_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "use_computer",
            "description": "Use an application explicitly approved by the user on this Mac to accomplish one bounded goal. The work runs in an isolated computer worker; secure fields, password managers, authorization UI, and Terminal input are always blocked.",
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "required": ["goal"],
                "properties": {
                    "goal": { "type": "string", "minLength": 1, "maxLength": 2000 },
                    "app": { "type": "string", "maxLength": 200 }
                }
            }
        }
    })
}

#[cfg(test)]
mod host_computer_tool_contract_tests {
    use super::*;

    #[test]
    fn manager_schema_is_single_bounded_delegate() {
        let schema = use_computer_tool_schema();
        assert_eq!(
            schema
                .pointer("/function/name")
                .and_then(serde_json::Value::as_str),
            Some("use_computer")
        );
        assert_eq!(
            schema.pointer("/function/parameters/additionalProperties"),
            Some(&serde_json::Value::Bool(false))
        );
        let serialized = schema.to_string();
        for granular in [
            "computer_list_apps",
            "computer_get_state",
            "computer_action",
        ] {
            assert!(!serialized.contains(granular));
        }
    }
}

pub(crate) fn computer_list_apps_tool_schema() -> serde_json::Value {
    serde_json::json!({"type":"function","function":{"name":"computer_list_apps","description":"List only Mac applications granted for this workspace.","parameters":{"type":"object","additionalProperties":false,"properties":{}}}})
}
pub(crate) fn computer_get_state_tool_schema() -> serde_json::Value {
    serde_json::json!({"type":"function","function":{"name":"computer_get_state","description":"Read a fresh bounded accessibility snapshot for a granted running app.","parameters":{"type":"object","additionalProperties":false,"required":["pid"],"properties":{"pid":{"type":"integer","minimum":1}}}}})
}
pub(crate) fn computer_action_tool_schema() -> serde_json::Value {
    serde_json::json!({"type":"function","function":{"name":"computer_action","description":"Perform one semantic action using an element from the latest snapshot. After success, read a new snapshot. Text entry and consequential actions stop for user approval.","parameters":{"type":"object","additionalProperties":false,"required":["target","action"],"properties":{"target":{"type":"object","additionalProperties":false,"required":["snapshot_id","generation","index"],"properties":{"snapshot_id":{"type":"string"},"generation":{"type":"integer"},"index":{"type":"integer"}}},"action":{"type":"string","enum":["press","set_value","show_menu","increment","decrement","confirm","cancel","raise","scroll_up","scroll_down"]},"value":{"type":["string","null"],"maxLength":20000}}}}})
}

pub(crate) fn browser_navigate_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "browser_navigate",
            "description": "Open a URL in the real browser and return the SNAPSHOT (accessible text, with the [ref=...] references of interactive elements) of the loaded page. Use it to go to a site (e.g. a train/flight source). After navigation read the snapshot to decide the next action with browser_act. The browser is a headless Chromium running in a Docker container, driven over CDP — there is NO local browser binary, so never diagnose a failure by checking for a local chromium/firefox install. If the browser reports unavailable/unreachable, it is transient or the contained computer isn't running yet: retry, and if it persists tell the user to start the contained computer (Settings → Local computer) — never claim Chromium is missing or that it's 'a known bug'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Full URL to open, e.g. 'https://www.trenitalia.com'."
                    },
                    "target": {
                        "type": "string",
                        "description": "id of the tab to operate on; default: the current tab."
                    },
                    "new_tab": {
                        "type": "boolean",
                        "description": "open in a NEW tab instead of reusing the current one."
                    }
                },
                "required": ["url"]
            }
        }
    })
}

/// Granular browser tool: re-read the current page snapshot (read-only).
pub(crate) fn browser_snapshot_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "browser_snapshot",
            "description": "Re-read the SNAPSHOT of the current page (accessible text + [ref=...] references). Call it to refresh your view of the page after it changed (e.g. after dynamic loading) or if you lost the page context. Read-only, doesn't modify anything. Default mode is 'interact' (compact, ~9k chars, shows interactive elements and suggestions clearly). Use 'extract' only when you need full page content for data collection (returns ~40k chars).",
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "id of the tab to operate on; default: the current tab."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["interact", "extract"],
                        "description": "Observation mode. 'interact' (default): compact view with interactive elements and suggestions (~9k chars, best for navigation). 'extract': full content for data collection (~40k chars). Use 'interact' unless you need complete page text."
                    }
                }
            }
        }
    })
}

pub(crate) fn browser_rehydrate_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "browser_rehydrate",
            "description": "Explicitly restore selected non-sensitive draft values after browser recovery. This is an external write: use only the opaque draft_ref reported by recovery, the current snapshot generation, and current [ref=...] targets. It fills only empty controls whose descriptors still match; it never submits, clicks, books, logs in, or pays.",
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "required": ["draft_ref", "generation", "fields"],
                "properties": {
                    "draft_ref": { "type": "string" },
                    "generation": { "type": "integer", "minimum": 0 },
                    "target": { "type": "string", "description": "id of the tab; default: current tab." },
                    "fields": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 32,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["ref", "draft_control_ref"],
                            "properties": {
                                "ref": { "type": "string", "description": "Current page ref from the fresh recovery snapshot." },
                                "draft_control_ref": { "type": "string", "description": "Opaque draft control id; never a field value." }
                            }
                        }
                    }
                }
            }
        }
    })
}

/// Granular browser tool: perform ONE interaction on the page (then auto-snapshot).
pub(crate) fn browser_act_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "browser_act",
            "description": "Perform one action or a flat bundle of at most four safe actions selected from the current observation generation, then return the updated observation. For fields with autocomplete use kind='type', then inspect the updated snapshot and select the intended suggestion when needed. Login and booking actions are allowed when they are part of the user's request. The final action that transfers money requires an approved Payment Approval Card and its exact payment_approval_id and cannot run inside a bundle. For a 'press and hold' / 'tieni premuto' human-verification challenge use kind='hold' on the button. Every committing action — a click, a submit (kind='type' with submit=true), pressing Enter/Return, or a 'hold' — must declare action_class, judged by what the action actually does on the page, not by button wording: 'ordinary' for everyday navigation/interaction with no lasting effect (following a link, opening a menu, dismissing a dialog); 'account' for anything that changes signed-in identity or account state (logging in/out, registering, changing account settings); 'booking' for reserving/scheduling/ordering something that is not yet a completed purchase (adding to cart, selecting a flight/room/slot, confirming a reservation); 'payment_commit' for the action that actually commits money (placing an order, confirming checkout, submitting a payment form) — this class additionally requires a matching, unapproved-otherwise payment_approval_id and can never run inside a bundle. On a page that is itself a payment form, prefer clicking the specific confirm control over pressing Enter to submit it, so approval is requested exactly when a payment is actually being committed — judge this by what the page and control actually are, never by button wording.",
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["click","type","fill","select","select_option","press","press_key","hover","hold","scroll","scrollIntoView","wait","set_date","set_time"],
                        "description": "Type of action. 'type' writes with possible autocomplete; 'fill' sets the value directly; 'set_date' opens a date field's calendar and sets it to `date` (YYYY-MM-DD) in ONE action (prefer this over clicking through the calendar day by day); 'set_time' opens a time field and picks `time` (HH:MM); 'hold' presses and holds the target (for 'press and hold' challenges); 'wait' waits."
                    },
                    "ref": {
                        "type": "string",
                        "description": "Reference of the target element from the snapshot, e.g. 'e5' (from the token [ref=e5])."
                    },
                    "text": { "type": "string", "description": "Text to type (kind='type'), value (kind='fill'), or the key name to press (kind='press_key'), e.g. 'Enter', 'ArrowDown'." },
                    "date": { "type": "string", "description": "For kind='set_date': the target date as YYYY-MM-DD (resolve it with resolve_datetime first). The sidecar opens the date control, navigates the calendar to that month, and clicks the day — one action instead of many clicks." },
                    "time": { "type": "string", "description": "For kind='set_time': the target time as 24h HH:MM, e.g. '08:00'. The sidecar opens the time control and picks the matching (or closest) time." },
                    "value": { "type": "string", "description": "Value to select (kind='select'/'select_option')." },
                    "values": { "type": "array", "items": { "type": "string" }, "description": "Multiple values for a multi-select." },
                    "submit": { "type": "boolean", "description": "If true, submit the form after writing (equivalent to pressing Enter)." },
                    "auto_complete": { "type": "boolean", "description": "For kind='type': when false (the default), the autocomplete dropdown stays open after typing so you can inspect it and click the desired option yourself from the snapshot. Default false — the gateway forces this to false for all type actions. You MUST click the matching option from the snapshot; the system does NOT auto-select. Set true only if the autocomplete auto-select works correctly (rarely reliable)." },
                    "key": { "type": "string", "description": "Key to press for kind='press', e.g. 'Enter', 'ArrowDown'. For kind='press_key' put the key name in 'text' instead — press_key reads 'text', not 'key'." },
                    "durationMs": { "type": "number", "description": "How long to keep the pointer pressed for kind='hold' (ms). Default ~3000; raise if the challenge needs a longer hold." },
                    "generation": { "type": "integer", "description": "Observation generation used to choose refs." },
                    "observationMode": { "type": "string", "enum": ["interact","delta","extract"], "description": "Observation mode to return after the action. Use delta after action bundles and extract when collecting final results." },
                    "action_class": {
                        "type": "string",
                        "enum": ["ordinary","account","booking","payment_commit"],
                        "description": "REQUIRED on every action (and mandatory for click, submit, Enter, hold — those are refused without it). Judge by real-world effect: 'ordinary' = everyday interaction with no lasting effect (picking a suggestion, opening a menu, pressing a search button, following a link); 'account' = changes signed-in identity or account state; 'booking' = reserves/selects/orders something not yet a completed purchase; 'payment_commit' = actually commits money and requires an approved payment_approval_id."
                    },
                    "actions": {
                        "type": "array",
                        "maxItems": 4,
                        "description": "Flat bundle of at most four safe actions selected from the current observation. No nested batch. Payment actions are not allowed here.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {
                                    "type": "string",
                                    "enum": ["click","type","fill","select","select_option","press","press_key","hover","hold","scroll","scrollIntoView","wait","set_date","set_time"],
                                    "description": "Type of action. 'type' writes with possible autocomplete; 'fill' sets the value directly; 'set_date' opens a date field's calendar and sets it to `date` (YYYY-MM-DD) in ONE action (prefer this over clicking through the calendar day by day); 'set_time' opens a time field and picks `time` (HH:MM); 'hold' presses and holds the target (for 'press and hold' challenges); 'wait' waits."
                                },
                                "ref": { "type": "string", "description": "Reference of the target element from the snapshot, e.g. 'e5' (from the token [ref=e5])." },
                                "text": { "type": "string", "description": "Text to type (kind='type'), value (kind='fill'), or the key name to press (kind='press_key'), e.g. 'Enter', 'ArrowDown'." },
                    "date": { "type": "string", "description": "For kind='set_date': the target date as YYYY-MM-DD (resolve it with resolve_datetime first). The sidecar opens the date control, navigates the calendar to that month, and clicks the day — one action instead of many clicks." },
                    "time": { "type": "string", "description": "For kind='set_time': the target time as 24h HH:MM, e.g. '08:00'. The sidecar opens the time control and picks the matching (or closest) time." },
                                "value": { "type": "string", "description": "Value to select (kind='select'/'select_option')." },
                                "key": { "type": "string", "description": "Key to press for kind='press', e.g. 'Enter', 'ArrowDown'. For kind='press_key' put the key name in 'text' instead — press_key reads 'text', not 'key'." },
                                "submit": { "type": "boolean", "description": "If true, submit the form after writing (equivalent to pressing Enter)." },
                                "auto_complete": { "type": "boolean", "description": "For kind='type': when false (the default), the autocomplete dropdown stays open after typing. Default false — you MUST click the matching option from the snapshot yourself." },
                                "action_class": {
                                    "type": "string",
                                    "enum": ["ordinary","account","booking","payment_commit"],
                                    "description": "REQUIRED on every item. Use 'ordinary' for normal interaction (picking a suggestion, opening a menu, pressing search); 'account' for login/registration; 'booking' for reserving/selecting; 'payment_commit' only for the action that actually pays. Same meaning as the top-level action_class."
                                }
                            },
                            // action_class is REQUIRED, not merely described: the gate refuses any
                            // committing item that omits it, and prose in the system prompt was not
                            // enough — the model kept omitting it, its ordinary clicks were refused,
                            // and it wandered instead of correcting. Schema-level `required` is
                            // enforced by the function-calling layer, so the field is always present.
                            // Harmless on non-committing kinds (the gate simply ignores it there),
                            // and NOT a safety loosening: a wrong 'ordinary' on a real payment control
                            // is still raised by the machine-derived floor and rejected as a conflict.
                            "required": ["kind", "action_class"]
                        }
                    },
                    "payment_approval_id": { "type": "string", "description": "Exact id returned by an approved Payment Approval Card. Use only for approved checkout actions and the final payment click; never invent it." },
                    "vault_secret": { "type": "string", "enum": ["cvv_one_shot"], "description": "Use with payment_approval_id to fill the CVV/CV2 field without exposing the CVV to the model. Do not include a text value when using this." },
                    "target": { "type": "string", "description": "id of the tab to operate on; default: the current tab." }
                },
                "anyOf": [
                    // Single-action form: action_class rides along with `kind` for the same reason
                    // it is required per bundle item — the gate refuses a committing action without
                    // it, and only schema-level `required` reliably makes the model emit it.
                    { "required": ["kind", "action_class"] },
                    { "required": ["actions"] }
                ],
                "required": []
            }
        }
    })
}

/// Turn a raw sidecar `browser_act` error into a hint that TEACHES the correct call, so a
/// model that misused the tool self-corrects instead of looping on the same bad arguments
/// (the observed action-error loop: no `kind`, an element ref passed as a tab `target`, or a
/// blocked `evaluate`). Appended to the error the model sees. Empty when nothing to add.
/// Recovery hint appended to a `browser_navigate` error. A weak model tends to retry the
/// SAME dead URL forever (the observed "navigate the FIFA page 7× then loop" case). On the
/// FIRST failure suggest a search; on a REPEAT failure of the same URL, firmly tell it to
/// STOP and pivot to a web search — the harness owns recovery (caposaldo #2), since the
/// model won't pivot on its own.
pub(crate) fn browser_navigate_failure_hint(url: &str, fails: u32) -> String {
    if fails >= 2 {
        format!(
            "\n\nSTOP — you have tried to open {url} {fails} times and it keeps failing. Do NOT \
             request that URL again. Instead SEARCH the web: call browser_navigate with \
             url=\"https://www.google.com/search?q=<your query>\" (or https://duckduckgo.com/?q=...), \
             read the results snapshot, then open a working result link."
        )
    } else {
        "\n\nIf that URL is wrong or unreachable, do NOT keep retrying it — SEARCH the web instead \
         (browser_navigate to https://www.google.com/search?q=<your query>), then open a working \
         result link."
            .to_string()
    }
}

/// Human-readable "why" for a security-scan block. `scan_blobs` already computes a
/// `SecurityWarning` per match (severity + category + description), but both shell call sites used to
/// format only `risk_score` and drop the warnings — so a blocked command told the model a number and
/// nothing else. With substring-matched needles that is a dead end: the model cannot tell that
/// `rm -rf ./target` passes while `rm -rf /abs/path/target` trips the "rm -rf /" needle, so it
/// rephrases blindly. Naming the matched rule does not weaken the gate (the command still does not
/// run) — it just makes the refusal correctable.
pub(crate) fn security_scan_block_reasons(scan: &skill_security::SecurityReport) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for warning in &scan.warnings {
        if !seen.contains(&warning.description.as_str()) {
            seen.push(warning.description.as_str());
        }
        if seen.len() == 3 {
            break;
        }
    }
    if seen.is_empty() {
        String::new()
    } else {
        format!("Triggered rule(s): {}.", seen.join("; "))
    }
}

pub(crate) fn browser_act_error_hint(error: &str) -> &'static str {
    let e = error.to_lowercase();
    // Gate refusals first: these were the most common real-world rejections and none of the arms
    // below matched them, so the model got a refusal with no hint at all and guessed (usually by
    // navigating away). Each hint states the exact edit that makes the SAME action pass.
    if e.contains("browser_action_class_missing") {
        " HINT: add action_class to this action — \"ordinary\" for normal interaction (picking a suggestion, opening a menu, pressing search), \"account\" for login, \"booking\" for reserving. Re-send the same kind+ref with that field."
    } else if e.contains("browser_action_class_conflict") {
        " HINT: this control is machine-detected as a payment control. Do NOT re-declare it to get past this — stop and report that a payment approval is required."
    } else if e.contains("browser_payment_approval_required") {
        " HINT: you cannot obtain a Payment Approval Card yourself. Stop and report the blocked payment step with the evidence you already have."
    } else if e.contains("browser_unsupported_committing_action") {
        " HINT: use a schema kind (click/type/fill/select/press/hover/hold/scroll/wait) with a [ref=...] from the snapshot — no coordinates and no CSS selector."
    } else if e.contains("unknown action kind")
        || e.contains("invalid_request") && e.contains("kind")
    {
        " HINT: browser_act needs a 'kind' (one of click/type/fill/select/press/hover/hold/scroll/wait) AND a 'ref' from the snapshot, e.g. {\"kind\":\"click\",\"ref\":\"e5\"}. Retry with both."
    } else if e.contains("tab not found") {
        " HINT: that looks like an element ref, not a tab. Put element refs in 'ref' (e.g. \"ref\":\"e83\"); 'target' is ONLY a tab id from browser_tabs. Retry with kind + ref."
    } else if e.contains("evaluate") {
        " HINT: running JavaScript (evaluate) is not available. Read the data straight from the page snapshot text, or click/scroll to reveal it — do not retry evaluate."
    } else {
        ""
    }
}

// Shared with the single-action `browser_act` enforcement site in
// `execute_browser_tool` (see
// `single_action_rejects_unsupported_execution_before_payment_claim`) so both
// reject sites emit byte-identical text — one message to keep in sync, not two
// literals that can silently drift apart.
pub(crate) const BROWSER_UNSUPPORTED_COMMITTING_ACTION_ERROR: &str = "BROWSER_UNSUPPORTED_COMMITTING_ACTION: this action is not executable (an unrecognized kind, coordinate clicks, or a selector field bypassing the ref) — use a schema kind with a specific [ref=…] control instead";

/// The `kind` values the `browser_act` schema exposes (mirrors `browser_act_tool_schema`'s
/// two `"enum"` literals — kept in sync by hand, same convention as the shared error
/// text above, since the schema itself must stay a plain JSON literal for the model).
pub(crate) const BROWSER_ACT_SCHEMA_KINDS: &[&str] = &[
    "click",
    "type",
    "fill",
    "select",
    "select_option",
    "press",
    "press_key",
    "hover",
    "hold",
    "scroll",
    "scrollIntoView",
    "wait",
    "set_date",
    "set_time",
];

/// True when `action` carries only fields the `browser_act` schema exposes for
/// execution: a `kind` in `BROWSER_ACT_SCHEMA_KINDS`, and no `selector` field. A
/// `kind` outside that set cannot have been legitimately produced from the schema —
/// it is either a stale/hallucinated call (`clickCoords`, `batch`) or a sidecar-only
/// kind the schema deliberately never exposes (`evaluate`). `selector` is honored by
/// the sidecar as an alternative to `ref` (`requireRefOrSelector` in
/// `runtimes/browser-automation/src/browser/actions.ts`) but the schema never exposes
/// it — letting it through would let a call target an element by raw CSS selector,
/// bypassing the ref-based payment floor entirely (a floored ref never has to appear
/// in the request at all). Shared by the single-action path and each bundle item in
/// `normalize_browser_action_bundle` (design 1.3).
pub(crate) fn browser_action_execution_fields_are_schema_legal(action: &serde_json::Value) -> bool {
    let kind_ok = action
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|kind| BROWSER_ACT_SCHEMA_KINDS.contains(&kind));
    kind_ok && action.get("selector").is_none()
}

/// D2 machine classification of a browser action's progress — control metadata, NEVER prose or
/// button-label text. The guarded loop's stall/no-progress budget depends on this distinguishing a
/// goal-advancing action from a no-op re-type or a failure.
///
/// The ONLY `type`/`fill` shape that is no-progress is the "Napoli ×3" churn: a typeahead where a
/// suggestion LIST appeared (`suggestions_present`) but nothing was selected (`!committed_option`).
/// A plain field with no list, a committed suggestion, or an explicit submit (Enter/`submit:true`,
/// which skips autocomplete and thus never sets `committed_option`) all filled/advanced the field
/// → progress. Classifying every uncommitted `type`/`fill` as no-progress would stall an ordinary
/// multi-field form mid-way, which is the opposite of this build's goal.
///
/// `navigate` is NOT handled here — the caller only invokes this for `browser_act` kinds; a
/// `browser_navigate` is classified by the `Result` variant in `execute_browser_tool`'s fallback.
pub(crate) fn browser_action_outcome_hint(
    kind: &str,
    ok: bool,
    no_change: bool,
    committed_option: bool,
    suggestions_present: bool,
    errored: bool,
) -> local_first_engine::contract::ToolOutcomeHint {
    use local_first_engine::contract::ToolOutcomeHint::{NoProgress, Success};
    if errored || !ok {
        return NoProgress;
    }
    match kind {
        // A typeahead list appeared but no suggestion was committed → churn. Everything else a
        // successful type/fill can be (plain field filled, suggestion committed, explicit submit)
        // is progress.
        "type" | "fill" => {
            if suggestions_present && !committed_option {
                NoProgress
            } else {
                Success
            }
        }
        // Any other action (click, press, select, a bundle, …): progress iff it changed the page.
        _ => {
            if no_change {
                NoProgress
            } else {
                Success
            }
        }
    }
}

#[cfg(test)]
mod browser_outcome_hint_tests {
    use super::browser_action_outcome_hint;
    use local_first_engine::contract::ToolOutcomeHint::{NoProgress, Success};

    // Signature: browser_action_outcome_hint(kind, ok, no_change, committed_option, suggestions_present, errored)

    #[test]
    fn typeahead_list_appeared_but_nothing_selected_is_no_progress() {
        // The "Napoli ×3" case: a suggestion list rendered but no station was committed.
        assert_eq!(
            browser_action_outcome_hint("type", true, false, false, true, false),
            NoProgress
        );
        assert_eq!(
            browser_action_outcome_hint("fill", true, false, false, true, false),
            NoProgress
        );
    }

    #[test]
    fn type_with_committed_suggestion_is_progress() {
        assert_eq!(
            browser_action_outcome_hint("type", true, false, true, true, false),
            Success
        );
    }

    #[test]
    fn plain_field_type_or_fill_with_no_list_is_progress() {
        // C1 regression: an ordinary form field (no typeahead) fills successfully — progress, so a
        // multi-field form is not stalled mid-way.
        assert_eq!(
            browser_action_outcome_hint("type", true, false, false, false, false),
            Success
        );
        assert_eq!(
            browser_action_outcome_hint("fill", true, false, false, false, false),
            Success
        );
    }

    #[test]
    fn explicit_submit_type_is_progress() {
        // `submit:true` / Enter skips autocomplete → no committed_option and no suggestions list,
        // but it advanced the page. Must be progress, not a stall.
        assert_eq!(
            browser_action_outcome_hint("type", true, false, false, false, false),
            Success
        );
    }

    #[test]
    fn any_error_or_not_ok_is_no_progress() {
        assert_eq!(
            browser_action_outcome_hint("click", true, false, false, false, true),
            NoProgress
        );
        assert_eq!(
            browser_action_outcome_hint("type", false, false, false, false, false),
            NoProgress
        );
    }

    #[test]
    fn other_action_is_progress_only_when_the_page_changed() {
        assert_eq!(
            browser_action_outcome_hint("click", true, false, false, false, false),
            Success
        );
        assert_eq!(
            browser_action_outcome_hint("click", true, true, false, false, false),
            NoProgress
        );
    }
}

pub(crate) fn normalize_browser_action_bundle(
    action: &mut serde_json::Value,
    current_target: &str,
    payment_floor_refs: &std::collections::HashSet<String>,
    page_focus_payment_context: bool,
) -> Option<String> {
    let actions = action
        .get("actions")
        .and_then(serde_json::Value::as_array)?;
    if actions.len() > 4 {
        return Some(
            "Browser action bundle rejected: use at most four actions from the current observation."
                .to_string(),
        );
    }
    // Per-item focus context: the page's own focus, OR'd with any EARLIER item in this
    // same bundle that targeted a floored ref (a bundle that types into a cc field then
    // presses Enter → focus is now on that field, even though the page started elsewhere).
    // Only grows across the loop — never reset — matching the floor's raise-only rule.
    let mut focus_context = page_focus_payment_context;
    for nested in actions {
        // Nested-bundle check FIRST, with its own specific message: a nested
        // "batch"/"actions" item would ALSO fail the general schema-kind check below
        // (a hallucinated "batch" isn't in `BROWSER_ACT_SCHEMA_KINDS` either), but the
        // more specific rejection is clearer for the model to act on.
        if nested.get("kind").and_then(serde_json::Value::as_str) == Some("batch")
            || nested.get("actions").is_some()
        {
            return Some(
                "Browser action bundle rejected: nested bundles are not allowed.".to_string(),
            );
        }
        // Generalizes the former clickCoords-only reject (design 1.3): any kind
        // outside the schema enum, or any item carrying a non-schema `selector`
        // field that would bypass the ref-based floor, is rejected here — BEFORE the
        // payment-commit/gate checks below ever run on this item.
        if !browser_action_execution_fields_are_schema_legal(nested) {
            return Some(BROWSER_UNSUPPORTED_COMMITTING_ACTION_ERROR.to_string());
        }
        // Order matters: report the item's OWN typed reason first. `action_is_payment_commit`
        // deliberately counts a class ERROR as payment (fail-closed for the single-action gate), so
        // running it first masked every ordinary mistake as a payment problem — a bundle item that
        // merely forgot `action_class` was answered with "Ask for the Payment Approval Card", which
        // for a search button is nonsense the model cannot act on (and which the bundle log then
        // faithfully recorded as the wrong cause). Evaluate first; the payment branch below then
        // only speaks for a genuine, well-formed payment_commit.
        if let Some(reason) =
            browser_safety::evaluate_browser_action(nested, payment_floor_refs, focus_context, None)
        {
            return Some(format!("Browser action bundle rejected: {reason}"));
        }
        if matches!(
            browser_safety::effective_action_class(nested, payment_floor_refs, focus_context),
            Ok(browser_safety::ActionClass::PaymentCommit)
        ) {
            return Some(
                "Payment actions cannot run inside a browser action bundle. Ask for the Payment Approval Card and execute the final payment as a standalone approved action."
                    .to_string(),
            );
        }
        let targets_floored_ref = nested
            .get("ref")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|r| payment_floor_refs.contains(r));
        if targets_floored_ref {
            focus_context = true;
        }
    }
    if let Some(obj) = action.as_object_mut() {
        obj.insert(
            "kind".to_string(),
            serde_json::Value::String("batch".to_string()),
        );
        obj.insert("chatBundle".to_string(), serde_json::Value::Bool(true));
    }
    if let Some(actions) = action
        .get_mut("actions")
        .and_then(serde_json::Value::as_array_mut)
    {
        for nested in actions {
            if let Some(obj) = nested.as_object_mut() {
                obj.entry("target_id".to_string())
                    .or_insert_with(|| serde_json::Value::String(current_target.to_string()));
                obj.entry("targetId".to_string())
                    .or_insert_with(|| serde_json::Value::String(current_target.to_string()));
            }
        }
    }
    None
}

/// True when a `browser_act` error means the targeted `[ref=eN]` no longer resolves because the
/// page changed under us (MINOR 8), so the caller should auto-recover with a fresh snapshot instead
/// of just erroring. Broadened beyond `stale`/`detached` to the common Playwright phrasings the
/// underlying CDP/Playwright driver actually throws (`"element is not attached to the DOM"`, `"no
/// node found for selector"`) — case-insensitive, since the wording/casing varies across Playwright
/// versions.
pub(crate) fn is_stale_ref_error(error: &str) -> bool {
    let e = error.to_lowercase();
    e.contains("stale")
        || e.contains("detached")
        || e.contains("not attached")
        || e.contains("no node found")
}

pub(crate) fn stale_ref_recovery_message(old_ref: Option<&str>, snapshot: &str) -> String {
    let old = old_ref
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .unwrap_or("the old ref");
    // Built off the shared `STALE_REF_RECOVERY_MARKER` constant (not a second copy of the same
    // literal) so the engine's `is_stale_ref_recovery_result` — which counts this recovery toward
    // `browser_no_progress` instead of resetting it (MINOR 8) — recognizes it by construction.
    format!(
        "{} I took a fresh snapshot. \
Do NOT retry {old}; choose a NEW [ref=...] from this snapshot, or use browser_snapshot if the \
data is already visible:\n{snapshot}",
        local_first_engine::browser::STALE_REF_RECOVERY_MARKER
    )
}

/// Granular browser tool: capture a screenshot fed back to the vision model.
pub(crate) fn browser_screenshot_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "browser_screenshot",
            "description": "Capture a screenshot of the current page and show it to you as an image. Use it ONLY when the text snapshot is not enough (e.g. graphic layout, map, calendar, content rendered only as an image). Read-only.",
            "parameters": {
                "type": "object",
                "properties": {
                    "full_page": { "type": "boolean", "description": "If true capture the entire scrollable page, otherwise only the visible portion." },
                    "marks": { "type": "boolean", "description": "true to draw numbers on clickable elements and get the number→element legend (useful for acting precisely on visually ambiguous pages)." },
                    "target": { "type": "string", "description": "id of the tab to operate on; default: the current tab." }
                }
            }
        }
    })
}

/// Granular browser tool: list the open tabs (read-only).
pub(crate) fn browser_tabs_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "browser_tabs",
            "description": "List the tabs currently open in the browser, with id, URL and title. Use a tab's id as the 'target' parameter of the other browser tools to operate on it. Read-only, doesn't modify anything.",
            "parameters": { "type": "object", "properties": {} }
        }
    })
}

pub(crate) fn browser_dialog_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "browser_dialog",
            "description": "Reply to a NATIVE browser dialog (alert/confirm/prompt/beforeunload) that blocks the page. Use it when an action reports 'blocked by dialog' or a native popup appears. Do NOT use it to accept purchases/payments.",
            "parameters": {
                "type": "object",
                "properties": {
                    "accept": { "type": "boolean", "description": "true to confirm (OK), false to cancel/close. Default: false." },
                    "prompt_text": { "type": "string", "description": "Text to enter if it's a prompt-type dialog." }
                }
            }
        }
    })
}
