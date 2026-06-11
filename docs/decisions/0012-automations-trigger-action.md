# Decision 0012: Automations — first-class trigger→agentic-action model

Date: 2026-06-11

## Status

Accepted, implemented (phases A–G2). Builds on the durable task runtime (proactivity
primitive), the capability registry, approval gates, and channels. Supersedes the ad-hoc
`schedule_task`→raw-TaskRecord path (now a thin alias that creates an Automation).

## Context

We need "do X when Y happens" without becoming n8n (build-the-flow-yourself) or a blank agent
canvas. SOTA reference (Claude Code / Codex / Manus) converges on a **scheduled/observed
agentic prompt**, not a deterministic node graph. The clarity of IFTTT (legible triggers)
belongs on the *trigger* side; the *action* side stays agentic (the model uses all its tools).

Two concepts were being conflated: the recurring RULE and each individual RUN. The task queue
showed raw runs (including internal sub-tasks like `browser`), so "Pianificato" wasn't a real
list of automations.

## Decision

**1. First-class `Automation` (the RULE) distinct from `TaskRecord` (the RUN).**
`crates/task-runtime/src/types.rs`: `Automation { id, title, trigger, prompt, approval, enabled,
source, task_id, state, …ts }`. A Schedule-automation OWNS one recurring `proactive_prompt`
TaskRecord (1:1, `task_id`); an Event-automation MATERIALIZES a one-shot run when it fires.
Persisted in the `automations` table (`store.rs`, schema_version 2) with CRUD
(upsert/get/list/list_enabled_event/delete).

**2. Triggers = IFTTT-legible.** `AutomationTrigger::Schedule { recurrence, tz } | Event { EventTrigger }`.
- `EventTrigger::ChannelMessage { channel?, from? }` — wired (fired from `handle_channel_inbound`
  via `fire_channel_event_automations`, independent of the auto-reply/draft policy).
- `EventTrigger::ConnectorPoll { tool, args, key_field, label }` — GENERIC events on ANY connected
  Composio/MCP capability (G2). A background poller (`spawn_connector_event_poller`,
  `connector_poll_tick`, interval `LFPA_CONNECTOR_POLL_SECS` default 300) calls `tool(args)`,
  `extract_poll_items` finds the result array by `key_field`, diffs against a watermark stored on
  `Automation.state`, and fires one run per NEW item. The FIRST poll only seeds the watermark
  (no fire on pre-existing items).
- `EventTrigger::EmailReceived | FileChanged | MemoryUpdated` — **forward-declared**: they
  deserialize and render a summary but are not yet wired to a producer (matched as `_ => continue`).

**3. Recurrence formats** (`recurrence.rs`, jiff/DST-aware via `next_occurrence`):
`every Nm|Nh|Nd|Nw`, `daily@HH:MM`, `weekly@<dow>@HH:MM`, and the flexible
`dow@<days>@<times>` (multi-day × multi-time, e.g. `dow@mon,wed,fri@08:00,12:00,18:00`;
`dow@*@HH:MM` = every day) via `Rule::MultiCalendar` + `next_multi`.

**4. The action is agentic, and CAN act (with confirmation).** A run executes via
`execute_proactive_prompt_task` → `run_agent_turn`. The tool policy is chosen by whether the
task carries an `automation_id` in `input_json`: **automation runs → "full"** (side-effecting
tools like `send_message`/connector writes PROPOSE a `‹‹COMPOSIO_CONFIRM››` card instead of
being refused); **check-in/curiosity runs → "read_only"** ("no actions"). This fixed the
"can't send on WhatsApp, asks to install a skill" symptom.

**5. `send_message` is a first-class, confirmation-gated tool.** `send_message(channel, to, text)`
→ `channel_send`, gated by the existing write-confirm flow (member of `composio_writes` → emits
the confirm card; on confirm `composio_execute_tool` routes it to `channel_send`). Recipient must
be an explicit number/ID (a bare name is refused — no magic "self").

**6. Always-creatable from chat AND UI.** Chat: `create_automation` (+ `schedule_task` alias),
CORE tools (not behind find_capability), with Jaccard-dedup. UI: `AutomationsView` list + a
«Quando→Allora» editor; the event source uses a searchable, service-grouped picker
(`/api/automations/event-sources`) listing channels + CONNECTED Composio/MCP services (one entry
per service; the poll tool is auto-chosen, the technical filter/key are free-form/auto).

**7. Queue hygiene.** `is_internal_task_kind` hides `capability.*`/`subagent.*` from the queue;
`humanize_task_kind` for labels. "Pianificato" was removed from the nav (the rule is the
first-class object; runs surface in their threads). The TasksView remains reachable via approval
affordances (`onOpenTasks`).

## Status: verified vs pending

**Verified (e2e or unit):** CRUD + schedule materialize/cancel; channel-event automation fires a
run; the run uses full policy and PROPOSES a `send_message` confirm card with the correct payload
(reproduced the original WhatsApp scenario); recurrence incl. `MultiCalendar` (unit); queue
filtering (unit); `extract_poll_items` (unit); event-source picker returns connected services
grouped (Gmail/Calendar/Spotify live).

**Pending / honest caveats:**
- ConnectorPoll real fire on a live connector returning items is verified only at the
  machinery level (poller loop + extraction + creation); the full Gmail→fire path is the user's
  to confirm.
- Autonomous automations (`ApprovalPolicy::Autonomous`) still go through the confirm card in runs
  — the confirm-skip is not implemented.
- The poll-tool auto-pick (`pick_poll_tool`) + `guess_key_field` are heuristics tuned for
  feed-like services (Gmail/Calendar); non-feed services (e.g. Spotify→SEARCH) have weak "event"
  semantics. Chat configuration (agent resolves tool/args/key) is the precise path.
- Forward-declared triggers (EmailReceived/FileChanged/MemoryUpdated) are no-ops until wired.

## Consequences

The engine stays domain-neutral (ADR 0011): a generic rule→run→agentic-action model + a generic
connector poller, no per-service logic. Verticality lives in the prompts/connectors, not the
engine.
