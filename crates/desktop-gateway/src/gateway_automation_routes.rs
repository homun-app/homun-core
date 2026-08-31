//! Automation HTTP routes and runtime owner.
//!
//! Owns automation CRUD endpoints, recurring task materialization, connector
//! polling, channel-event automation firing, and scheduled-task chat tools.

use super::*;

use crate::gateway_project_access::{
    EffectiveProjectContactPolicy, resolve_project_contact_policy,
};

#[test]
fn automation_routes_owner_smoke() {
    assert_eq!(
        connector_poll_event_key("GMAIL_FETCH_EMAILS", "id", &serde_json::json!({"id": "42"})),
        "connector:GMAIL_FETCH_EMAILS:id:42"
    );
}

pub(crate) fn tombstone_automation_memory_records(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    automation_id: &str,
) -> Result<usize, String> {
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "automation".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "automation_removed".to_string(),
    };
    let mut deleted = 0;
    for memory in facade
        .list_memories_for_ui(user, workspace)
        .map_err(|error| error.to_string())?
    {
        let matches_id = memory
            .metadata
            .get("automation_id")
            .and_then(|value| value.as_str())
            == Some(automation_id);
        if !matches_id {
            continue;
        }
        facade
            .delete_memory(&lifecycle, &memory.reference, "automation deleted")
            .map_err(|error| error.to_string())?;
        deleted += 1;
    }
    Ok(deleted)
}

/// Creates a recurring `proactive_prompt` task from chat. Inserts it under the
/// gateway scope so the executor worker (`run_next_task_once`) picks it up; the
/// first occurrence fires one interval from now, then `next_recurrence` re-enqueues.
///
/// Retained (no current caller) as the recurring-task creator the upcoming
/// "automation proposals as cards" feature will reuse — the executor side
/// (`execute_proactive_prompt_task`) is already wired and runs scheduled tasks.
#[allow(dead_code)]
pub(crate) fn schedule_proactive_task(
    state: &AppState,
    goal: &str,
    every: &str,
    tz: Option<&str>,
) -> String {
    let now = OffsetDateTime::now_utc();
    let Some(next) = local_first_task_runtime::next_occurrence(every, tz, now) else {
        return format!(
            "Schedule '{every}' is not valid. Use an interval (\"every 6h\", \"every 1d\") or a time (\"daily@08:00\", \"weekly@mon@09:30\")."
        );
    };
    let id = format!("sched_{}", uuid::Uuid::new_v4().simple());
    let (_, thread_id) = proactive_thread_scope(&id, "scheduled");
    let mut task = TaskRecord::new(
        id,
        gateway_user_id(),
        gateway_workspace_id(),
        "proactive_prompt",
        goal,
        serde_json::json!({
            "thread_id": thread_id,
            "thread_source": "scheduled",
        }),
    );
    task.not_before = Some(next);
    task.recurrence = Some(every.to_string());
    task.recurrence_tz = tz.map(|value| value.to_string());
    match lock_task_store(state) {
        Ok(store) => match store.insert_task(&task) {
            Ok(()) => format!(
                "✅ Scheduled: «{goal}» ({every}). First execution: {next}. \
I'll keep you posted in the «Scheduled» thread."
            ),
            Err(error) => format!("I couldn't schedule the task: {error}"),
        },
        Err(_) => "Task store unavailable: scheduling failed.".to_string(),
    }
}

/// Clean UI-facing DTO: unix-second timestamps (the `time` crate's default serde is a numeric
/// array — useless for the frontend), a human trigger summary, and next_run for schedules.
/// `trigger` stays a typed object so the editor can round-trip it.
pub(crate) fn automation_to_json(a: &Automation) -> serde_json::Value {
    let next_run = match &a.trigger {
        AutomationTrigger::Schedule { recurrence, tz } if a.enabled => {
            local_first_task_runtime::next_occurrence(
                recurrence,
                tz.as_deref(),
                OffsetDateTime::now_utc(),
            )
            .map(|t| t.unix_timestamp())
        }
        _ => None,
    };
    serde_json::json!({
        "id": a.id,
        "workspace_id": a.workspace_id,
        "title": a.title,
        "trigger": a.trigger,
        "trigger_summary": automation_trigger_summary(&a.trigger),
        "prompt": a.prompt,
        "approval": a.approval,
        "enabled": a.enabled,
        "source": a.source,
        "task_id": a.task_id,
        "created_at": a.created_at.unix_timestamp(),
        "updated_at": a.updated_at.unix_timestamp(),
        "last_fired_at": a.last_fired_at.map(|t| t.unix_timestamp()),
        "next_run": next_run,
    })
}

fn validate_automation_trigger(
    trigger: &AutomationTrigger,
    now: OffsetDateTime,
) -> Result<Option<OffsetDateTime>, String> {
    match trigger {
        AutomationTrigger::Schedule { recurrence, tz } => {
            local_first_task_runtime::next_occurrence(recurrence, tz.as_deref(), now)
                .map(Some)
                .ok_or_else(|| format!("recurrence '{recurrence}' is not valid"))
        }
        AutomationTrigger::Event { .. } => Ok(None),
    }
}

fn automation_trigger_kind(trigger: &AutomationTrigger) -> &'static str {
    match trigger {
        AutomationTrigger::Schedule { .. } => "schedule",
        AutomationTrigger::Event { .. } => "event",
    }
}

/// For a Schedule automation, create the recurring TaskRecord that DRIVES it and return its
/// id (tagged with `automation_id` so the run + queue can trace it back). Event automations
/// return `None` — their runs are materialized when the event fires (Auto-C). Validates the
/// recurrence (so an invalid rule fails here, not silently at run time).
pub(crate) fn materialize_automation_task(
    store: &TaskStore,
    automation: &Automation,
) -> Result<Option<String>, String> {
    let (recurrence, tz) = match &automation.trigger {
        AutomationTrigger::Schedule { recurrence, tz } => (recurrence.clone(), tz.clone()),
        AutomationTrigger::Event { .. } => return Ok(None),
    };
    let now = OffsetDateTime::now_utc();
    let next = local_first_task_runtime::next_occurrence(&recurrence, tz.as_deref(), now)
        .ok_or_else(|| format!("recurrence '{recurrence}' is not valid"))?;
    let task_id = format!("autorun_{}", uuid::Uuid::new_v4().simple());
    let (_, thread_id) = proactive_thread_scope(&task_id, "scheduled");
    let mut task = TaskRecord::new(
        task_id.clone(),
        automation.user_id.clone(),
        automation.workspace_id.clone(),
        "proactive_prompt",
        automation.prompt.clone(),
        serde_json::json!({
            "automation_id": automation.id,
            "approval": automation.approval,
            "thread_id": thread_id,
            "thread_source": "scheduled",
        }),
    );
    task.not_before = Some(next);
    task.recurrence = Some(recurrence);
    task.recurrence_tz = tz;
    // Transient failures (a flaky site, a momentary network blip) shouldn't drop a
    // run: retry a few times with backoff before the occurrence is considered failed.
    // next_recurrence carries this policy onto every following occurrence.
    task.retry_policy = local_first_task_runtime::RetryPolicy {
        max_attempts: 3,
        backoff_seconds: 120,
    };
    store.insert_task(&task).map_err(|e| e.to_string())?;
    Ok(Some(task_id))
}

/// Stop an automation's driving task (cancel all future occurrences). Best-effort.
pub(crate) fn cancel_automation_tasks(
    store: &TaskStore,
    automation_id: &str,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    reason: &str,
) -> TaskRuntimeResult<usize> {
    let mut cancelled = 0;
    for task in store.list_tasks(user_id, workspace_id)? {
        let belongs_to_automation =
            task.input_json.get("automation_id").and_then(Value::as_str) == Some(automation_id);
        let terminal = matches!(
            task.status,
            TaskStatus::Completed
                | TaskStatus::Failed
                | TaskStatus::Cancelled
                | TaskStatus::Expired
        );
        if !belongs_to_automation || terminal {
            continue;
        }
        store.update_task_status(
            &task.task_id,
            user_id,
            workspace_id,
            TaskStatus::Cancelled,
            Some(reason),
        )?;
        cancelled += 1;
    }
    Ok(cancelled)
}

pub(crate) fn insert_next_recurrence_if_active(
    store: &TaskStore,
    completed: &TaskRecord,
    now: OffsetDateTime,
) -> TaskRuntimeResult<Option<TaskId>> {
    if let Some(automation_id) = completed
        .input_json
        .get("automation_id")
        .and_then(Value::as_str)
    {
        let enabled = store
            .get_automation(automation_id, &completed.user_id, &completed.workspace_id)?
            .is_some_and(|automation| automation.enabled);
        if !enabled {
            return Ok(None);
        }
    }
    let Some(next) = TaskScheduler::new().next_recurrence(completed, now) else {
        return Ok(None);
    };
    let next_id = next.task_id.clone();
    store.insert_task(&next)?;
    Ok(Some(next_id))
}

/// Edit an existing automation from a chat tool call: resolve it by id or title
/// fragment, apply the given changes, re-sync the driving recurring task (so a new
/// prompt/recurrence takes effect next run), and persist. Returns a user-facing line.
pub(crate) fn update_automation_from_chat(
    state: &AppState,
    args_raw: &str,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
) -> String {
    let args: serde_json::Value =
        serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
    let opt = |k: &str| {
        args.get(k)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(String::from)
    };
    let Ok(store) = lock_task_store(state) else {
        return "The task store is unavailable right now.".to_string();
    };
    // Resolve the target automation by id, else by a title fragment.
    let mut automation = if let Some(id) = opt("id") {
        match store.get_automation(&id, user_id, workspace_id) {
            Ok(Some(a)) => a,
            _ => return format!("I couldn't find an automation with id {id}."),
        }
    } else if let Some(needle) = opt("match") {
        let needle = needle.to_lowercase();
        let all = store
            .list_automations(user_id, workspace_id)
            .unwrap_or_default();
        let mut hits: Vec<Automation> = all
            .into_iter()
            .filter(|a| a.title.to_lowercase().contains(&needle))
            .collect();
        match hits.len() {
            0 => return format!("No automation whose title contains «{needle}»."),
            1 => hits.remove(0),
            _ => {
                let titles = hits
                    .iter()
                    .map(|a| a.title.clone())
                    .collect::<Vec<_>>()
                    .join(", ");
                return format!(
                    "Several automations match «{needle}»: {titles}. Say which one (or pass its id)."
                );
            }
        }
    } else {
        return "To edit an automation, give its `id` or a `match` (a fragment of its title)."
            .to_string();
    };
    let mut changed: Vec<&str> = Vec::new();
    if let Some(title) = opt("title") {
        automation.title = title;
        changed.push("title");
    }
    if let Some(prompt) = opt("prompt") {
        automation.prompt = prompt;
        changed.push("action");
    }
    if let Some(recurrence) = opt("recurrence") {
        match &automation.trigger {
            AutomationTrigger::Schedule { tz, .. } => {
                let tz = tz.clone();
                if local_first_task_runtime::next_occurrence(
                    &recurrence,
                    tz.as_deref(),
                    OffsetDateTime::now_utc(),
                )
                .is_none()
                {
                    return format!("The recurrence '{recurrence}' is not valid.");
                }
                automation.trigger = AutomationTrigger::Schedule { recurrence, tz };
                changed.push("schedule");
            }
            AutomationTrigger::Event { .. } => {
                return "This automation is event-based; `recurrence` only applies to scheduled ones.".to_string();
            }
        }
    }
    if changed.is_empty() {
        return "Nothing to change — give a new title, prompt, or recurrence.".to_string();
    }
    automation.updated_at = OffsetDateTime::now_utc();
    automation.task_id.take();
    if cancel_automation_tasks(
        &store,
        &automation.id,
        &automation.user_id,
        &automation.workspace_id,
        "automation updated",
    )
    .is_err()
    {
        return "Failed to stop the automation's previous schedule.".to_string();
    }
    if automation.enabled {
        match materialize_automation_task(&store, &automation) {
            Ok(tid) => automation.task_id = tid,
            Err(msg) => return format!("Couldn't reschedule the automation: {msg}"),
        }
    }
    if store.upsert_automation(&automation).is_err() {
        return "Failed to save the change to the automation.".to_string();
    }
    format!(
        "✅ Updated automation «{}» ({}).",
        automation.title,
        changed.join(", ")
    )
}

/// Create a first-class Automation from a chat tool call (source=chat). Builds the trigger,
/// dedups against existing automations (same kind + high prompt overlap), materializes the
/// driving task for schedules, and persists it so it shows in the Automazioni view.
pub(crate) fn create_automation_from_chat(
    state: &AppState,
    args_raw: &str,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
) -> String {
    let store = match lock_task_store(state) {
        Ok(store) => store,
        Err(_) => return "Task store unavailable.".to_string(),
    };
    create_automation_from_chat_with_store(&store, args_raw, user_id, workspace_id)
}

pub(crate) fn create_automation_from_chat_with_store(
    store: &TaskStore,
    args_raw: &str,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
) -> String {
    let args: serde_json::Value =
        serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
    let s = |k: &str| {
        args.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let opt = |k: &str| {
        args.get(k)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(String::from)
    };
    let title = s("title");
    let prompt = s("prompt");
    if title.is_empty() || prompt.is_empty() {
        return "Creating an automation requires at least the title and what to do (prompt)."
            .to_string();
    }
    let trigger = if s("trigger_type") == "event" {
        // Event on a connected service (Gmail/Calendar/Slack/MCP/…) via polling, when a
        // tool is given; otherwise an inbound channel message (WhatsApp/Telegram).
        if let Some(tool) = opt("event_tool") {
            let key_field = s("event_key_field");
            if key_field.is_empty() {
                return "An event on a connected service requires event_key_field (the field that identifies an item, e.g. \"messageId\").".to_string();
            }
            let event_args = args
                .get("event_args")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            AutomationTrigger::Event {
                event: EventTrigger::ConnectorPoll {
                    tool,
                    args: event_args,
                    key_field,
                    label: opt("event_label").or_else(|| Some(title.clone())),
                },
            }
        } else {
            AutomationTrigger::Event {
                event: EventTrigger::ChannelMessage {
                    channel: opt("event_channel"),
                    from: opt("event_from"),
                },
            }
        }
    } else {
        let recurrence = s("recurrence");
        if recurrence.is_empty() {
            return "A time-based automation requires the recurrence (e.g. \"daily@08:00\", \"weekly@fri@18:00\", \"every 6h\").".to_string();
        }
        let tz = opt("timezone").or_else(|| Some(effective_user_tz_name()));
        AutomationTrigger::Schedule { recurrence, tz }
    };
    let approval = if args
        .get("require_confirmation")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
    {
        ApprovalPolicy::Confirm
    } else {
        ApprovalPolicy::Autonomous
    };
    let enabled = args
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if let AutomationTrigger::Schedule { recurrence, tz } = &trigger
        && local_first_task_runtime::next_occurrence(
            recurrence,
            tz.as_deref(),
            OffsetDateTime::now_utc(),
        )
        .is_none()
    {
        return format!("Invalid recurrence: recurrence '{recurrence}' is not valid");
    }
    // Dedup: a near-identical existing automation (same trigger kind + >0.6 prompt overlap).
    let new_kind = match &trigger {
        AutomationTrigger::Schedule { .. } => "schedule",
        AutomationTrigger::Event { .. } => "event",
    };
    let new_tokens: std::collections::BTreeSet<String> =
        cap_tokenize(&prompt).into_iter().collect();
    if let Ok(existing) = store.list_automations(user_id, workspace_id) {
        for a in &existing {
            if a.trigger_kind() != new_kind {
                continue;
            }
            let a_tokens: std::collections::BTreeSet<String> =
                cap_tokenize(&a.prompt).into_iter().collect();
            let inter = new_tokens.intersection(&a_tokens).count();
            let uni = new_tokens.union(&a_tokens).count().max(1);
            if inter as f64 / uni as f64 > 0.6 {
                return format!(
                    "A similar automation already exists: «{}». I won't create a duplicate (manage it from the Automations section).",
                    a.title
                );
            }
        }
    }
    let now = OffsetDateTime::now_utc();
    let mut automation = Automation {
        id: format!("auto_{}", uuid::Uuid::new_v4().simple()),
        user_id: user_id.clone(),
        workspace_id: workspace_id.clone(),
        title,
        trigger,
        prompt,
        approval,
        enabled,
        source: AutomationSource::Chat,
        task_id: None,
        created_at: now,
        updated_at: now,
        last_fired_at: None,
        state: None,
    };
    if automation.enabled {
        match materialize_automation_task(store, &automation) {
            Ok(task_id) => automation.task_id = task_id,
            Err(msg) => return format!("Invalid recurrence: {msg}"),
        }
    }
    if store.upsert_automation(&automation).is_err() {
        return "I couldn't save the automation.".to_string();
    }
    format!(
        "✅ Automation created: «{}» — {}. Status: {}. You'll find it in the Automations section.",
        automation.title,
        automation_trigger_summary(&automation.trigger),
        if automation.enabled {
            "enabled"
        } else {
            "disabled"
        }
    )
}

/// How often the connector-event poller checks each ConnectorPoll automation (min 30s).
pub(crate) fn connector_poll_interval() -> std::time::Duration {
    let secs = std::env::var("HOMUN_CONNECTOR_POLL_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&v| v >= 30)
        .unwrap_or(300);
    std::time::Duration::from_secs(secs)
}

/// The result items of a poll: the first array whose elements are objects carrying
/// `key_field`. Tying extraction to the agent-configured key makes it robust across
/// arbitrary connector response shapes (Gmail messages, Calendar events, Slack, …).
pub(crate) fn extract_poll_items(
    value: &serde_json::Value,
    key_field: &str,
) -> Vec<serde_json::Value> {
    fn search(v: &serde_json::Value, key: &str) -> Option<Vec<serde_json::Value>> {
        match v {
            serde_json::Value::Array(arr) => {
                let hits: Vec<serde_json::Value> = arr
                    .iter()
                    .filter(|e| e.get(key).is_some())
                    .cloned()
                    .collect();
                if !hits.is_empty() {
                    return Some(hits);
                }
                for e in arr {
                    if let Some(found) = search(e, key) {
                        return Some(found);
                    }
                }
                None
            }
            serde_json::Value::Object(map) => {
                for val in map.values() {
                    if let Some(found) = search(val, key) {
                        return Some(found);
                    }
                }
                None
            }
            _ => None,
        }
    }
    search(value, key_field).unwrap_or_default()
}

/// Background poller for `ConnectorPoll` automations: every interval, calls each rule's
/// connected tool, fires a run for each NEW item (by `key_field`), and keeps a bounded
/// watermark on the automation. The FIRST poll only seeds the watermark (no firing) so
/// creating a rule doesn't immediately fire on everything already present.
pub(crate) fn spawn_connector_event_poller(state: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(connector_poll_interval()).await;
            connector_poll_tick(&state).await;
        }
    });
}

pub(crate) async fn connector_poll_tick(state: &AppState) {
    let automations = match lock_task_store(state) {
        Ok(store) => store
            .list_enabled_event_automations(&gateway_user_id())
            .unwrap_or_default(),
        Err(_) => return,
    };
    for automation in automations {
        let (tool, args, key_field, label) = match &automation.trigger {
            AutomationTrigger::Event {
                event:
                    EventTrigger::ConnectorPoll {
                        tool,
                        args,
                        key_field,
                        label,
                    },
            } => (tool.clone(), args.clone(), key_field.clone(), label.clone()),
            _ => continue,
        };
        // Execute the connected tool: MCP name → MCP path; otherwise a Composio slug.
        let st = state.clone();
        let tname = tool.clone();
        let av = args.clone();
        let exec: Option<serde_json::Value> =
            if let Some((prov, mcp_tool)) = parse_mcp_chat_name(&tname) {
                tokio::task::spawn_blocking(move || run_mcp_chat_tool(&st, &prov, &mcp_tool, av))
                    .await
                    .ok()
                    .and_then(Result::ok)
            } else {
                tokio::task::spawn_blocking(move || composio_execute_tool(&st, &tname, &av))
                    .await
                    .ok()
                    .and_then(Result::ok)
            };
        let Some(value) = exec else { continue };
        let items = extract_poll_items(&value, &key_field);
        if items.is_empty() {
            continue;
        }
        let mut seen: std::collections::BTreeSet<String> = automation
            .state
            .as_ref()
            .and_then(|s| s.get("seen"))
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let initialized = automation
            .state
            .as_ref()
            .and_then(|s| s.get("initialized"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let mut fresh = Vec::new();
        for item in &items {
            let key = item
                .get(&key_field)
                .map(|v| v.to_string())
                .unwrap_or_default();
            if key.is_empty() {
                continue;
            }
            if seen.insert(key) {
                fresh.push(item.clone());
            }
        }
        let mut fired_any = false;
        if initialized {
            for item in &fresh {
                connector_fire_run(state, &automation, label.as_deref().unwrap_or(&tool), item);
                fired_any = true;
            }
        }
        // Persist a bounded watermark + mark initialized.
        let mut seen_vec: Vec<String> = seen.into_iter().collect();
        if seen_vec.len() > 1000 {
            let drop = seen_vec.len() - 1000;
            seen_vec.drain(0..drop);
        }
        let mut updated = automation.clone();
        updated.state = Some(serde_json::json!({ "seen": seen_vec, "initialized": true }));
        if fired_any {
            updated.last_fired_at = Some(OffsetDateTime::now_utc());
        }
        if let Ok(store) = lock_task_store(state) {
            let _ = store.upsert_automation(&updated);
        }
    }
}

pub(crate) fn connector_poll_event_key(
    tool: &str,
    key_field: &str,
    item: &serde_json::Value,
) -> String {
    let key_value = item
        .get(key_field)
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| Some(value.to_string()))
        })
        .unwrap_or_default();
    format!("connector:{tool}:{key_field}:{key_value}")
}

pub(crate) fn connector_poll_event_envelope(
    automation: &Automation,
    tool: &str,
    label: &str,
    key_field: &str,
    item: &serde_json::Value,
) -> serde_json::Value {
    let key_value = item
        .get(key_field)
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| Some(value.to_string()))
        })
        .unwrap_or_default();
    let dedup_key = connector_poll_event_key(tool, key_field, item);
    serde_json::json!({
        "event_id": dedup_key,
        "source_kind": "connector",
        "provider_id": tool,
        "event_type": "item.detected",
        "occurred_at": OffsetDateTime::now_utc().unix_timestamp(),
        "workspace_id": automation.workspace_id,
        "actor": {
            "contact_ref": null,
            "display_name": label,
            "channel": null,
            "identifier": tool,
        },
        "payload": {
            "key_field": key_field,
            "key_value": key_value,
            "item": item,
        },
        "dedup_key": dedup_key,
        "visibility": {
            "thread_id": null,
            "title": format!("Automation · {label}"),
        }
    })
}

/// Materialize a one-shot run for a fired ConnectorPoll item (the item is the event context).
pub(crate) fn connector_fire_run(
    state: &AppState,
    automation: &Automation,
    label: &str,
    item: &serde_json::Value,
) {
    let store = match lock_task_store(state) {
        Ok(store) => store,
        Err(_) => return,
    };
    let item_str: String = serde_json::to_string(item)
        .unwrap_or_default()
        .chars()
        .take(2000)
        .collect();
    let (tool, key_field) = match &automation.trigger {
        AutomationTrigger::Event {
            event: EventTrigger::ConnectorPoll {
                tool, key_field, ..
            },
        } => (tool.as_str(), key_field.as_str()),
        _ => ("connector", "id"),
    };
    let event = connector_poll_event_envelope(automation, tool, label, key_field, item);
    let goal = format!(
        "{}\n\n[Triggering event: {label}]\nEvent data (JSON):\n{item_str}",
        automation.prompt
    );
    let task_id = format!("autorun_{}", uuid::Uuid::new_v4().simple());
    let (_, thread_id) = proactive_thread_scope(&task_id, "connector_poll");
    let mut task = TaskRecord::new(
        task_id,
        automation.user_id.clone(),
        automation.workspace_id.clone(),
        "proactive_prompt",
        goal,
        serde_json::json!({
            "automation_id": automation.id,
            "approval": automation.approval,
            "source": "connector_poll",
            "thread_id": thread_id,
            "thread_source": "connector_poll",
            "event": event,
            "thread_title": format!("Automation · {label}"),
        }),
    );
    task.not_before = Some(OffsetDateTime::now_utc());
    let _ = store.insert_task(&task);
}

pub(crate) fn channel_reply_target_for_message(message: &ChannelInbound) -> String {
    let non_empty = |s: &String| !s.trim().is_empty();
    message
        .sender_pn
        .clone()
        .filter(&non_empty)
        .or_else(|| message.chat.clone().filter(&non_empty))
        .unwrap_or_else(|| message.sender.clone())
}

pub(crate) fn channel_message_event_key(channel: &str, message: &ChannelInbound) -> String {
    if let Some(message_id) = message.message_id.as_deref().map(str::trim)
        && !message_id.is_empty()
    {
        return format!("{channel}:message:{message_id}");
    }

    let ts = message.ts.map(|ts| ts.to_string()).unwrap_or_default();
    let mut hasher = Sha256::new();
    for part in [
        channel,
        message.sender.as_str(),
        message.chat.as_deref().unwrap_or(""),
        message.sender_pn.as_deref().unwrap_or(""),
        ts.as_str(),
        message.content.as_str(),
    ] {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    let digest = hasher.finalize();
    format!("{channel}:message:sha256:{digest:x}")
}

pub(crate) fn channel_message_event_envelope(
    channel: &str,
    message: &ChannelInbound,
    workspace_id: &str,
    thread_id: &str,
    title: &str,
    actor_display_name: &str,
) -> serde_json::Value {
    let dedup_key = channel_message_event_key(channel, message);
    serde_json::json!({
        "event_id": dedup_key,
        "dedup_key": dedup_key,
        "source_kind": "channel",
        "provider_id": channel,
        "event_type": "message.received",
        "occurred_at": message
            .ts
            .unwrap_or_else(|| OffsetDateTime::now_utc().unix_timestamp()),
        "workspace_id": workspace_id,
        "actor": {
            "display_name": actor_display_name,
            "channel": channel,
            "identifier": message.sender,
        },
        "payload": {
            "message_id": message.message_id.clone(),
            "has_content": !message.content.trim().is_empty(),
        },
        "visibility": {
            "thread_id": thread_id,
            "title": title,
        },
    })
}

pub(crate) fn channel_project_contact_policy(
    state: &AppState,
    workspace_id: &str,
    channel: &str,
    message: &ChannelInbound,
) -> EffectiveProjectContactPolicy {
    let denied = |reason: &str| EffectiveProjectContactPolicy {
        authorized: false,
        can_trigger_automations: false,
        can_use_project_memory: false,
        can_receive_replies: false,
        can_receive_artifacts: false,
        tools_denied: Vec::new(),
        denied_reason: reason.to_string(),
    };
    let Ok(store) = lock_store(state) else {
        return denied("contact store unavailable");
    };
    let Some(contact_id) = store
        .contact_id_by_identity(channel, &message.sender)
        .ok()
        .flatten()
    else {
        return denied("contact/channel is not authorized for this project");
    };
    let Some(contact) = store.contact_by_id(contact_id).ok().flatten() else {
        return denied("contact/channel is not authorized for this project");
    };
    let perimeter = store.perimeter_or_default(contact_id);
    let contact_reference = format!("contact_{contact_id}");
    resolve_project_contact_policy(
        workspace_id,
        &contact_reference,
        channel,
        &perimeter,
        contact.is_self,
    )
}

/// Fire enabled Event automations matching an inbound channel message: each materializes a
/// ONE-SHOT run (proactive_prompt) carrying the automation's prompt + the message as context.
/// Independent of the auto-reply/draft policy — these are explicit user rules. Best-effort.
pub(crate) fn fire_channel_event_automations(
    state: &AppState,
    channel: &str,
    message: &ChannelInbound,
) {
    let automations = match lock_task_store(state).and_then(|store| {
        store
            .list_enabled_event_automations(&gateway_user_id())
            .map_err(GatewayError::task)
    }) {
        Ok(list) => list,
        Err(_) => return,
    };
    let sender = message.sender.trim();
    let sender_name = message.sender_name.trim();
    let speaker = if sender_name.is_empty() {
        sender
    } else {
        sender_name
    };
    let now = OffsetDateTime::now_utc();
    for automation in automations {
        // Only ChannelMessage triggers; clone the filters so the borrow ends here.
        let (want_channel, want_from) = match &automation.trigger {
            AutomationTrigger::Event {
                event: EventTrigger::ChannelMessage { channel, from },
            } => (channel.clone(), from.clone()),
            _ => continue,
        };
        if let Some(want) = &want_channel
            && !want.eq_ignore_ascii_case(channel)
        {
            continue;
        }
        if let Some(want) = &want_from {
            let needle = want.to_lowercase();
            let matches = sender_name.to_lowercase().contains(&needle)
                || sender.to_lowercase().contains(&needle);
            if !matches {
                continue;
            }
        }
        let policy = channel_project_contact_policy(
            state,
            automation.workspace_id.as_str(),
            channel,
            message,
        );
        if !policy.authorized || !policy.can_trigger_automations {
            if let Ok(store) = lock_task_store(state) {
                let detail = if policy.denied_reason.is_empty() {
                    "project access denied: automations disabled for this contact/channel"
                } else {
                    policy.denied_reason.as_str()
                };
                let _ =
                    store.record_automation_run(&automation.id, now, false, false, Some(detail));
            }
            eprintln!(
                "automation/{}: denied on {channel} message from {speaker}: {}",
                automation.id,
                if policy.denied_reason.is_empty() {
                    "automations disabled"
                } else {
                    policy.denied_reason.as_str()
                }
            );
            continue;
        }
        let task_id = format!("autorun_{}", uuid::Uuid::new_v4().simple());
        let goal = format!(
            "{}\n\n[Triggering event: {channel} message from {speaker}]\nMessage content: {}",
            automation.prompt, message.content
        );
        let label = match channel {
            "whatsapp" => "WhatsApp",
            "telegram" => "Telegram",
            other => other,
        };
        let title = format!("{label} · {speaker}");
        let reply_to = channel_reply_target_for_message(message);
        let event_key = channel_message_event_key(channel, message);
        let event_is_new = match lock_task_store(state).and_then(|store| {
            store
                .mark_automation_event_seen(&automation.id, &event_key, now)
                .map_err(GatewayError::task)
        }) {
            Ok(is_new) => is_new,
            Err(error) => {
                eprintln!(
                    "automation/{}: event dedup failed for {event_key}: {error:?}",
                    automation.id
                );
                true
            }
        };
        if !event_is_new {
            eprintln!(
                "automation/{}: duplicate event {event_key} skipped",
                automation.id
            );
            continue;
        }
        let thread_id = match lock_store(state) {
            Ok(store) => store
                .find_or_create_channel_thread(
                    automation.workspace_id.as_str(),
                    channel,
                    &message.sender,
                    &title,
                )
                .ok()
                .map(|thread| {
                    let _ = store.set_channel_thread_recipient(&thread.thread_id, &reply_to);
                    let _ = store.link_task_to_thread(&task_id, &thread.thread_id);
                    thread.thread_id
                }),
            Err(_) => None,
        };
        let Some(thread_id) = thread_id else {
            if let Ok(store) = lock_task_store(state) {
                let _ = store.record_automation_run(
                    &automation.id,
                    now,
                    false,
                    false,
                    Some("could not create visible event thread"),
                );
            }
            continue;
        };
        let event = channel_message_event_envelope(
            channel,
            message,
            automation.workspace_id.as_str(),
            &thread_id,
            &title,
            speaker,
        );
        let mut task = TaskRecord::new(
            task_id,
            automation.user_id.clone(),
            automation.workspace_id.clone(),
            "proactive_prompt",
            goal,
            serde_json::json!({
                "automation_id": automation.id,
                "approval": automation.approval,
                "source": "channel_event",
                "thread_id": thread_id,
                "thread_source": channel,
                "thread_channel": channel,
                "thread_title": title,
                "event": event,
            }),
        );
        task.not_before = Some(now);
        if lock_task_store(state)
            .and_then(|store| store.insert_task(&task).map_err(GatewayError::task))
            .is_ok()
        {
            let mut fired = automation;
            fired.last_fired_at = Some(now);
            if let Ok(store) = lock_task_store(state) {
                let _ = store.upsert_automation(&fired);
            }
            eprintln!(
                "automation/{}: fired on {channel} message from {speaker}",
                fired.id
            );
        }
    }
}

/// Readable SERVICE/toolkit name from a Composio slug prefix (the part before the first `_`),
/// so the picker groups by service (Gmail, Google Calendar, …) not by "Composio". Known
/// multi-word toolkits are mapped; otherwise the prefix is title-cased.
pub(crate) fn composio_toolkit_name(slug: &str) -> String {
    let prefix = slug.split('_').next().unwrap_or(slug);
    match prefix.to_ascii_uppercase().as_str() {
        "GMAIL" => "Gmail".to_string(),
        "GOOGLECALENDAR" => "Google Calendar".to_string(),
        "GOOGLEDRIVE" => "Google Drive".to_string(),
        "GOOGLEDOCS" => "Google Docs".to_string(),
        "GOOGLESHEETS" => "Google Sheets".to_string(),
        "GOOGLEMEET" => "Google Meet".to_string(),
        "GITHUB" => "GitHub".to_string(),
        "LINKEDIN" => "LinkedIn".to_string(),
        "WHATSAPP" => "WhatsApp".to_string(),
        "YOUTUBE" => "YouTube".to_string(),
        "TYPEFORM" => "Typeform".to_string(),
        "ONEDRIVE" => "OneDrive".to_string(),
        "OUTLOOK" => "Outlook".to_string(),
        other => {
            let mut chars = other.chars();
            chars
                .next()
                .map(|f| f.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase())
                .unwrap_or_default()
        }
    }
}

/// Best-guess item-id field for a connector tool (the manual picker pre-fills it; the user
/// can edit). Heuristic by slug — good enough for common services, editable for the rest.
pub(crate) fn guess_key_field(tool: &str) -> &'static str {
    let t = tool.to_ascii_uppercase();
    if t.contains("GMAIL") || t.contains("EMAIL") {
        "messageId"
    } else {
        "id"
    }
}

/// Among a service's READ tools, pick the best "list new items" tool to poll for events:
/// prefer FETCH/LIST/SEARCH + a collection noun (emails/events/messages/files), penalize
/// single-item lookups (BY_ID) and detail getters. Falls back to the first tool.
pub(crate) fn pick_poll_tool(tools: &[String]) -> String {
    fn score(t: &str) -> i32 {
        let u = t.to_ascii_uppercase();
        let mut s = 0;
        // FETCH returns the items themselves (aligns with the per-item key_field guess);
        // LIST/SEARCH may return containers (threads) — slightly lower.
        if u.contains("FETCH") {
            s += 3;
        } else if u.contains("LIST") || u.contains("SEARCH") {
            s += 2;
        }
        if u.contains("EMAILS")
            || u.contains("EVENTS")
            || u.contains("MESSAGES")
            || u.contains("FILES")
            || u.contains("THREADS")
        {
            s += 2;
        }
        if u.contains("BY_ID")
            || u.contains("BY_MESSAGE_ID")
            || u.contains("BY_THREAD_ID")
            || u.contains("ATTACHMENT")
            || u.contains("CONTACTS")
            || u.contains("PEOPLE")
            || u.contains("PROFILE")
        {
            s -= 3;
        }
        s
    }
    tools
        .iter()
        .max_by_key(|t| score(t))
        .cloned()
        .unwrap_or_default()
}

/// GET /api/automations/event-sources — the manual event picker's options (mirrors the model
/// selector: searchable + grouped). Channels + ONE entry per connected SERVICE (Gmail,
/// Calendar, …): the user declares the service, the poller uses that service's "new items"
/// read tool (auto-picked) and the agent decides the rest at run time.
pub(crate) async fn automation_event_sources(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let st = state.clone();
    let (connected, composio, mcp) = tokio::task::spawn_blocking(move || {
        // Authoritative list of CONNECTED Composio toolkits (same source as the Connettori
        // view) — we list exactly these, not whatever the tool catalogue happens to contain.
        let connected = composio_transport_for(&st)
            .ok()
            .map(|t| composio_connected_toolkits(&t))
            .unwrap_or_default();
        (
            connected,
            composio_chat_tools_cached(&st, 500),
            mcp_chat_tools(&st, 500),
        )
    })
    .await
    .unwrap_or_else(|_| {
        (
            Vec::new(),
            ComposioChatTools::default(),
            McpChatTools::default(),
        )
    });
    // Index the catalogue's READ tools by toolkit prefix, so each connected service can be
    // matched to a poll tool (the agent picks the actual operation at run time).
    let mut tools_by_kit: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    for schema in &composio.schemas {
        let Some(name) = schema.pointer("/function/name").and_then(|v| v.as_str()) else {
            continue;
        };
        if composio.writes.contains(name) {
            continue;
        }
        let kit = name.split('_').next().unwrap_or(name).to_ascii_uppercase();
        tools_by_kit.entry(kit).or_default().push(name.to_string());
    }
    // One entry per CONNECTED + active toolkit (the user declares the service).
    let mut services: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    for (slug, active) in &connected {
        if !active {
            continue;
        }
        let kit = slug.split('_').next().unwrap_or(slug).to_ascii_uppercase();
        if let Some(tools) = tools_by_kit.get(&kit) {
            services
                .entry(composio_toolkit_name(slug))
                .or_default()
                .extend(tools.iter().cloned());
        }
    }
    for schema in &mcp.schemas {
        let Some(name) = schema.pointer("/function/name").and_then(|v| v.as_str()) else {
            continue;
        };
        if mcp.writes.contains(name) {
            continue;
        }
        let rest = name.strip_prefix("mcp__").unwrap_or(name);
        let server = rest.split_once("__").map(|(s, _)| s).unwrap_or(rest);
        let label = {
            let mut chars = server.chars();
            chars
                .next()
                .map(|f| f.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_else(|| server.to_string())
        };
        services.entry(label).or_default().push(name.to_string());
    }
    let connectors: Vec<serde_json::Value> = services
        .into_iter()
        .map(|(service, tools)| {
            let tool = pick_poll_tool(&tools);
            serde_json::json!({
                "group": "connected_services",
                "tool": tool,
                "label": service,
                "key_field": guess_key_field(&tool),
            })
        })
        .collect();
    Json(serde_json::json!({
        "channels": [
            { "id": "whatsapp", "label": "WhatsApp" },
            { "id": "telegram", "label": "Telegram" },
        ],
        "connectors": connectors,
    }))
}

/// GET /api/automations — list the user's automations (rules), newest first.
pub(crate) async fn automations_list(
    State(state): State<AppState>,
    Query(scope): Query<AutomationScopeQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let workspace = automation_workspace_scope(scope.workspace_id.as_deref());
    let store = lock_task_store(&state).map_err(|_| GatewayError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "task_store",
        message: "task store unavailable".into(),
    })?;
    let items = store
        .list_automations(&gateway_user_id(), &workspace)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "automations_list",
            message: e.to_string(),
        })?;
    let json: Vec<_> = items.iter().map(automation_to_json).collect();
    Ok(Json(serde_json::json!({ "automations": json })))
}

/// GET /api/automations/{id}/runs — the automation's recent execution history (when
/// it fired + whether it succeeded, failed or ran late), newest first.
pub(crate) async fn automation_runs(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let store = lock_task_store(&state).map_err(|_| GatewayError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "task_store",
        message: "task store unavailable".into(),
    })?;
    let runs = store
        .recent_automation_runs(&id, 20)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "automation_runs",
            message: e.to_string(),
        })?;
    Ok(Json(serde_json::json!({ "runs": runs })))
}

/// POST /api/automations/dry-run — validate an automation request without
/// persisting the rule or materializing its driving task.
pub(crate) async fn automation_dry_run(
    Query(scope): Query<AutomationScopeQuery>,
    Json(req): Json<AutomationCreateRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let workspace = automation_workspace_scope(
        req.workspace_id
            .as_deref()
            .or(scope.workspace_id.as_deref()),
    );
    let now = OffsetDateTime::now_utc();
    let next_run = validate_automation_trigger(&req.trigger, now).map_err(|msg| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "bad_recurrence",
        message: msg,
    })?;
    let trigger_kind = automation_trigger_kind(&req.trigger);
    Ok(Json(serde_json::json!({
        "valid": true,
        "workspace_id": workspace,
        "trigger_kind": trigger_kind,
        "approval": req.approval.unwrap_or_default(),
        "source": req.source.unwrap_or(AutomationSource::Manual),
        "would_create_automation": true,
        "would_materialize_task": trigger_kind == "schedule",
        "next_run": next_run.map(|t| t.unix_timestamp()),
    })))
}

/// POST /api/automations — create an automation (the rule). Phase A persists it;
/// schedule/event wiring (it actually firing) lands in Auto-B / Auto-C.
pub(crate) async fn automation_create(
    State(state): State<AppState>,
    Json(req): Json<AutomationCreateRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    // Validate a schedule trigger's recurrence up front (fail fast, like schedule_task).
    validate_automation_trigger(&req.trigger, OffsetDateTime::now_utc()).map_err(|msg| {
        GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "bad_recurrence",
            message: msg,
        }
    })?;
    let now = OffsetDateTime::now_utc();
    let workspace = automation_workspace_scope(req.workspace_id.as_deref());
    let mut automation = Automation {
        id: format!("auto_{}", uuid::Uuid::new_v4().simple()),
        user_id: gateway_user_id(),
        workspace_id: workspace,
        title: req.title,
        trigger: req.trigger,
        prompt: req.prompt,
        approval: req.approval.unwrap_or_default(),
        enabled: true,
        source: req.source.unwrap_or(AutomationSource::Manual),
        task_id: None,
        created_at: now,
        updated_at: now,
        last_fired_at: None,
        state: None,
    };
    let store = lock_task_store(&state).map_err(|_| GatewayError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "task_store",
        message: "task store unavailable".into(),
    })?;
    // Schedule + enabled → materialize the recurring task that drives it now.
    automation.task_id =
        materialize_automation_task(&store, &automation).map_err(|msg| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "bad_recurrence",
            message: msg,
        })?;
    store
        .upsert_automation(&automation)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "automation_create",
            message: e.to_string(),
        })?;
    Ok(Json(automation_to_json(&automation)))
}

/// PUT /api/automations/{id} — edit an existing rule (title/trigger/prompt/approval).
/// Any field omitted is left unchanged. A changed trigger or prompt re-syncs the
/// driving recurring task (cancel the old one, materialize a fresh one) so the next
/// run reflects the edit; `enabled` stays owned by the toggle endpoint.
pub(crate) async fn automation_update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(scope): Query<AutomationScopeQuery>,
    Json(req): Json<AutomationUpdateRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let workspace = automation_workspace_scope(scope.workspace_id.as_deref());
    // Validate a new schedule recurrence up front (fail fast, like create).
    if let Some(trigger) = &req.trigger {
        validate_automation_trigger(trigger, OffsetDateTime::now_utc()).map_err(|msg| {
            GatewayError {
                status: StatusCode::BAD_REQUEST,
                code: "bad_recurrence",
                message: msg,
            }
        })?;
    }
    let store = lock_task_store(&state).map_err(|_| GatewayError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "task_store",
        message: "task store unavailable".into(),
    })?;
    let mut automation = store
        .get_automation(&id, &gateway_user_id(), &workspace)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "automation_get",
            message: e.to_string(),
        })?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "automation_missing",
            message: "automation not found".into(),
        })?;
    if let Some(title) = req.title {
        automation.title = title;
    }
    if let Some(prompt) = req.prompt {
        automation.prompt = prompt;
    }
    if let Some(trigger) = req.trigger {
        automation.trigger = trigger;
    }
    if let Some(approval) = req.approval {
        automation.approval = approval;
    }
    automation.updated_at = OffsetDateTime::now_utc();
    // Re-sync the driving task: drop the old occurrence schedule and, for an enabled
    // schedule automation, materialize a fresh one carrying the new trigger + prompt.
    automation.task_id.take();
    cancel_automation_tasks(
        &store,
        &automation.id,
        &automation.user_id,
        &automation.workspace_id,
        "automation updated",
    )
    .map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "automation_cancel_schedule",
        message: e.to_string(),
    })?;
    if automation.enabled {
        automation.task_id =
            materialize_automation_task(&store, &automation).map_err(|msg| GatewayError {
                status: StatusCode::BAD_REQUEST,
                code: "bad_recurrence",
                message: msg,
            })?;
    }
    store
        .upsert_automation(&automation)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "automation_update",
            message: e.to_string(),
        })?;
    drop(store);
    let memory_user = gateway_memory_user_id();
    let memory_workspace = MemoryWorkspaceId::new(automation.workspace_id.as_str());
    {
        let facade = memory_facade(&state);
        let _ = tombstone_automation_memory_records(facade, &memory_user, &memory_workspace, &id);
    }
    reconcile_memory_scope(&state, &memory_workspace);
    Ok(Json(automation_to_json(&automation)))
}

/// POST /api/automations/{id}/toggle — enable/disable a rule.
pub(crate) async fn automation_toggle(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(scope): Query<AutomationScopeQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let workspace = automation_workspace_scope(scope.workspace_id.as_deref());
    let store = lock_task_store(&state).map_err(|_| GatewayError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "task_store",
        message: "task store unavailable".into(),
    })?;
    let mut automation = store
        .get_automation(&id, &gateway_user_id(), &workspace)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "automation_get",
            message: e.to_string(),
        })?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "automation_missing",
            message: "automation not found".into(),
        })?;
    automation.enabled = !automation.enabled;
    automation.updated_at = OffsetDateTime::now_utc();
    if automation.enabled {
        // Re-enable: (re)create the driving task for a schedule automation.
        if automation.task_id.is_none() {
            automation.task_id =
                materialize_automation_task(&store, &automation).map_err(|msg| GatewayError {
                    status: StatusCode::BAD_REQUEST,
                    code: "bad_recurrence",
                    message: msg,
                })?;
        }
    } else {
        // Disable every pending occurrence, not only the original driving task. Completed runs
        // enqueue suffixed `@occ@...` records, so `task_id` alone is not authoritative.
        automation.task_id.take();
        cancel_automation_tasks(
            &store,
            &automation.id,
            &automation.user_id,
            &automation.workspace_id,
            "automation disabled or deleted",
        )
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "automation_cancel_schedule",
            message: e.to_string(),
        })?;
    }
    store
        .upsert_automation(&automation)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "automation_toggle",
            message: e.to_string(),
        })?;
    Ok(Json(automation_to_json(&automation)))
}

/// DELETE /api/automations/{id} — remove a rule.
pub(crate) async fn automation_delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(scope): Query<AutomationScopeQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let workspace = automation_workspace_scope(scope.workspace_id.as_deref());
    let store = lock_task_store(&state).map_err(|_| GatewayError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "task_store",
        message: "task store unavailable".into(),
    })?;
    // Stop every pending occurrence before removing the rule.
    if let Some(existing) = store
        .get_automation(&id, &gateway_user_id(), &workspace)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "automation_get",
            message: e.to_string(),
        })?
    {
        cancel_automation_tasks(
            &store,
            &existing.id,
            &existing.user_id,
            &existing.workspace_id,
            "automation disabled or deleted",
        )
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "automation_cancel_schedule",
            message: e.to_string(),
        })?;
    }
    store
        .delete_automation(&id, &gateway_user_id(), &workspace)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "automation_delete",
            message: e.to_string(),
        })?;
    drop(store);
    let memory_user = gateway_memory_user_id();
    let memory_workspace = MemoryWorkspaceId::new(workspace.as_str());
    {
        let facade = memory_facade(&state);
        let _ = tombstone_automation_memory_records(facade, &memory_user, &memory_workspace, &id);
    }
    reconcile_memory_scope(&state, &memory_workspace);
    Ok(Json(serde_json::json!({ "deleted": id })))
}

pub(crate) fn list_scheduled_tasks_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "list_scheduled_tasks",
            "description": "List the active scheduled/recurring tasks (created with schedule_task), with id, what they do, how often and when they next run. Use it before canceling one or when the user asks what you have scheduled.",
            "parameters": { "type": "object", "properties": {} }
        }
    })
}

pub(crate) fn cancel_scheduled_task_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "cancel_scheduled_task",
            "description": "Cancel a scheduled task so it won't run anymore. Pass the EXACT id obtained from list_scheduled_tasks. Use it when the user wants to stop a recurring activity.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string", "description": "id of the scheduled task to cancel (from list_scheduled_tasks)" }
                },
                "required": ["task_id"]
            }
        }
    })
}

/// Lists the user's active scheduled (recurring proactive) tasks for the agent.
pub(crate) fn list_scheduled_tasks(state: &AppState) -> String {
    let store = match lock_task_store(state) {
        Ok(store) => store,
        Err(_) => return "Task store unavailable.".to_string(),
    };
    let tasks = match store.list_tasks(&gateway_user_id(), &gateway_workspace_id()) {
        Ok(tasks) => tasks,
        Err(error) => return format!("Error reading tasks: {error}"),
    };
    let mut rows: Vec<String> = Vec::new();
    for task in tasks {
        if task.kind != "proactive_prompt" {
            continue;
        }
        if !matches!(
            task.status,
            local_first_task_runtime::TaskStatus::Queued
                | local_first_task_runtime::TaskStatus::Pending
                | local_first_task_runtime::TaskStatus::WaitingTime
                | local_first_task_runtime::TaskStatus::Running
        ) {
            continue;
        }
        let every = task.recurrence.as_deref().unwrap_or("one-off");
        let next = task
            .not_before
            .map(|n| n.to_string())
            .unwrap_or_else(|| "—".to_string());
        rows.push(format!(
            "- id={} · «{}» · every {every} · next: {next}",
            task.task_id.as_str(),
            task.goal
        ));
    }
    if rows.is_empty() {
        "No active scheduled tasks.".to_string()
    } else {
        format!("Active scheduled tasks:\n{}", rows.join("\n"))
    }
}

/// Cancels an active scheduled task by id. Scoped to `proactive_prompt` so the
/// agent can't cancel system/capability tasks. Setting the active occurrence to
/// `Cancelled` stops the chain: it won't run, so it won't complete and re-enqueue.
pub(crate) fn cancel_scheduled_task(state: &AppState, task_id: &str) -> String {
    let id = task_id.trim();
    if id.is_empty() {
        return "Specify the task id (use list_scheduled_tasks first).".to_string();
    }
    let store = match lock_task_store(state) {
        Ok(store) => store,
        Err(_) => return "Task store unavailable.".to_string(),
    };
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let tid = local_first_task_runtime::TaskId::new(id);
    let task = match store.get_task(&tid, &user, &workspace) {
        Ok(Some(task)) => task,
        Ok(None) => {
            return format!("No task with id '{id}'. Use list_scheduled_tasks for the exact ids.");
        }
        Err(error) => return format!("Error: {error}"),
    };
    if task.kind != "proactive_prompt" {
        return "I can only cancel scheduled tasks (proactive_prompt).".to_string();
    }
    if matches!(
        task.status,
        local_first_task_runtime::TaskStatus::Completed
            | local_first_task_runtime::TaskStatus::Cancelled
            | local_first_task_runtime::TaskStatus::Failed
            | local_first_task_runtime::TaskStatus::Expired
    ) {
        return format!("The task «{}» is already finished, not active.", task.goal);
    }
    match store.update_task_status(
        &tid,
        &user,
        &workspace,
        local_first_task_runtime::TaskStatus::Cancelled,
        Some("cancelled by the user"),
    ) {
        Ok(()) => format!(
            "✅ Scheduled task «{}» cancelled: it won't run again.",
            task.goal
        ),
        Err(error) => format!("I couldn't cancel the task: {error}"),
    }
}
