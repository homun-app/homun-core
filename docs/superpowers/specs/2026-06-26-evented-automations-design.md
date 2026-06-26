# Homun Evented Automations and Project Access Design

Date: 2026-06-26
Status: approved direction, project-access-first implementation plan pending

## Purpose

Homun automations must support both scheduled work and reactive workflows, but
reactive work is only safe if it is scoped by project access first:

- "Every weekday at 08:00, send me a briefing."
- "When Elena messages me on WhatsApp, summarize it and notify me."
- "When an email from a customer arrives, draft a reply."
- "When a contact asks for a presentation, use the Presentations addon, create the deck, ask approval, then send it back."

The user-facing model is IFTTT-simple:

```text
IF this happens
AND these conditions match
THEN do this
```

The internal model must remain Homun-native: visible execution, project access,
contact perimeter, policy, memory, artifact lifecycle, registry-based capability
selection, and no parallel store.

## Core Principle

Projects are the first authorization surface. Automations are not just schedules;
they are evented rules evaluated inside that surface:

```text
Project access -> event source -> normalized event -> rule match -> condition/filter -> visible action run
```

Time is still first-class. A schedule is one event source, not the whole
automation system. Polling is also a time-driven source, but it represents an
event trigger to the user when a provider cannot push real events.

The effective policy for any run is:

```text
global user defaults
-> channel/provider settings
-> contact perimeter
-> project access
-> automation rule policy
-> capability policy
-> runtime approval
```

The resolver is fail-closed: denial wins, missing project authorization means no
project memory/files/artifacts, and external send/publish still needs explicit
policy or approval.

## Current State

The existing runtime already has the right seed:

- `AutomationTrigger::Schedule`
- `AutomationTrigger::Event`
- `EventTrigger::ChannelMessage`
- forward-declared email/file/memory events
- `EventTrigger::ConnectorPoll`
- `CapabilityProvider::list_triggers`
- visible channel/scheduled conversation lifecycle work

The missing piece is the runtime bridge that makes event automations actually
fire through the same queue, stream, policy and memory paths as scheduled
automations.

The other missing piece is project access. Contacts already have a perimeter
that controls what a channel-originated reply may know or use. Projects do not
yet expose an explicit list of contacts/channels that may access the project.
That list must exist before channel events can safely trigger project-scoped
work.

## Project Access Surface

Each project owns an access surface:

- authorized contacts and channels;
- whether the contact may trigger project automations;
- whether Homun may use project memory for that contact;
- whether generated artifacts may be sent back to that contact;
- optional capability restrictions that further narrow the contact perimeter.

Project access does not replace contact perimeter. It composes with it. A
contact can be globally trusted but still not authorized for a project; a
project can narrow access but must not silently widen a contact's global
perimeter.

Resolution rules:

- **No authorized project**: the event is handled as personal/channel scope and
  cannot read project memory, project files or project artifacts.
- **One authorized project**: the event can use that project scope if the rule
  also matches.
- **Multiple authorized projects**: Homun must ask for disambiguation or route
  to Personal unless the rule names a project explicitly.
- **Explicit project on rule**: the contact/channel must be authorized for that
  project before the rule can fire.
- **Owner/self contact**: `Me` is implicit full access for every project and is
  not represented as a normal grant. Project grants are for other
  contact/channel pairs.
- **Deny wins** across contact perimeter, project access, capability policy and
  runtime approval.

Operational project-access tables are allowed for fast lookup and UI state, but
durable semantic knowledge and provenance still converge to `MemoryFacade`.

## Architecture

### 1. Event Sources

Every connected system can expose event sources:

- Channels: WhatsApp, Telegram, future Slack/Discord/mobile.
- Composio connectors: Gmail, Calendar, Notion, GitHub, etc.
- MCP servers: filesystem, browser, local tools, custom services.
- Skills/addons/plugins: Presentations, Documents, PDF, future Meeting/Research.
- Local computer: folders, downloads, app state, clipboard.
- Time: recurrence and one-off schedules.

Event sources declare:

- event types they can produce;
- push support if available;
- polling support if push is unavailable;
- required permissions;
- payload schema;
- stable event identity key;
- safe display label;
- default dedup/window policy.

### 2. Push vs Polling

There are two implementation modes, but one user model.

**Push source**

The provider notifies Homun directly. Examples: inbound WhatsApp message,
Telegram update, webhook from a connected service.

**Polling source**

Homun checks on an interval and emits events only for new items. Examples:
Gmail unread messages, calendar changes, files in a folder, a provider without
webhooks.

Polling is not exposed as "a schedule" unless the user asked for time-based
behavior. The UI should still read "when a new email from Elena arrives", with
an advanced field that shows "checked every 10 minutes".

### 3. Normalized Event Envelope

All sources emit a normalized event:

```json
{
  "event_id": "whatsapp:message:...",
  "source_kind": "channel|connector|mcp|skill|addon|local|time",
  "provider_id": "whatsapp|composio:gmail|mcp:filesystem|addon:presentations",
  "event_type": "message.received|email.received|file.changed|schedule.due",
  "occurred_at": 1782480000,
  "workspace_id": "personal-or-authorized-project",
  "actor": {
    "contact_ref": "contact_...",
    "display_name": "Elena",
    "channel": "whatsapp",
    "identifier": "..."
  },
  "payload": {},
  "dedup_key": "provider-stable-id",
  "visibility": {
    "thread_id": "channel_whatsapp_...",
    "title": "WhatsApp · Elena"
  }
}
```

The event envelope is operational state. If an event teaches something durable
or triggers a meaningful decision/artifact, that goes through `MemoryFacade` as
evidence, relation, open loop or artifact provenance.

### 4. Rule Model

An automation rule has:

- `trigger`: schedule or event source matcher;
- `filters`: sender, label, account, topic, text/intent, attachment type, project;
- `action`: natural language goal plus optional capability hints;
- `policy`: draft, confirm before external side effects, autonomous;
- `visibility`: where the run appears;
- `dedup`: avoid firing twice for the same event/item;
- `state`: provider watermark and polling cursor.

Rules that mention a project are invalid until every selected contact/channel is
authorized for that project. Rules that do not mention a project must not
implicitly infer one from vague text; they may use the project only when the
event resolver finds exactly one authorized project.

Example:

```json
{
  "trigger": {
    "type": "event",
    "event": {
      "kind": "channel_message",
      "channel": "whatsapp",
      "from": "Elena"
    }
  },
  "filters": [
    { "field": "message.intent", "op": "is", "value": "needs_summary" }
  ],
  "action": {
    "prompt": "Summarize the message and notify Fabio.",
    "capability_hints": ["notify_user"]
  },
  "approval": "confirm"
}
```

### 5. Addons and Capabilities

Addons are not separate from automations. They are capabilities in the registry.

An evented automation can invoke an addon as an action when the policy allows it:

```text
IF WhatsApp message from Tizio
AND intent = presentation_request
THEN use Presentations to create a deck
AND ask approval before sending it back
```

The Presentations addon does not become a special automation subsystem. It
declares capability metadata:

- tools such as `make_deck`, `revise_deck`, `export_pdf`;
- required inputs;
- produced artifacts;
- template and brand kit support;
- side-effect classes;
- whether it is allowed in automations;
- whether it can run autonomously or requires confirmation.

The same contract applies to Documents, PDF, Research, Meeting, MCP tools,
Composio actions and skills.

### 6. Execution Lifecycle

Every matched automation produces a visible run through the same lifecycle used
by chat/channel/scheduled work:

```text
match rule
resolve effective project/contact/capability policy
create or find owner thread
commit trigger event/user-visible placeholder
emit thread.turn_started
run the agent with turn_id
show Workspace/Computer live
commit assistant response
store artifacts/provenance/memory
send external reply only if policy allows
record automation run outcome
```

This is required for safety. No evented automation may run hidden in the
background while only showing the final result.

### 7. Policy Levels

Policies should be simple and visible:

- **Draft only**: prepare output and notify the user.
- **Approval required**: prepare output, then ask before sending/publishing/writing.
- **Autonomous**: run and send/publish only for explicitly authorized contacts,
  providers, destinations and capability classes.

Defaults:

- external send/publish = approval required;
- project memory/file/artifact access from a contact = denied until the contact
  is authorized for that project;
- file writes outside managed artifact store = approval required unless an
  allowed destination exists;
- destructive actions = approval required;
- high-risk browser/computer actions from channel-originated triggers = approval
  required;
- read-only summarization/notification can be autonomous if user enabled it.

### 8. Filtering and Intent

Filters have two layers:

1. Deterministic fields: provider, sender, label, unread state, folder, account,
   project, attachment type, event type.
2. Model-assisted classification: intent, urgency, topic, sentiment, "asks for a
   presentation", "requires reply".

Model-assisted filters must be evidence-bearing:

- store the classifier result in run metadata;
- include the matched text span or rationale where possible;
- let the user inspect why a rule fired.

Do not route critical actions only by fragile keyword checks.

### 9. UI Direction

Automations UI should become a builder with three clear zones:

```text
IF THIS
  source picker: Time, WhatsApp, Telegram, Gmail, Calendar, Folder, MCP, Skill...
  event picker: message received, email received, file changed...

FILTERS
  sender, label, account, project, intent, attachments...

THEN THAT
  action prompt
  capability suggestions/addons
  policy: draft / ask approval / autonomous
```

The simple natural-language creation path remains important:

```text
When Elena messages me on WhatsApp, summarize it and notify me.
```

Homun should parse it into a proposed rule card, then ask for confirmation
before enabling it.

### 10. Memory and Provenance

Evented automation runs must write memory through the canonical facade when they
produce durable knowledge:

- project access grants/revocations when they matter to future reasoning;
- automation rule created/updated/deleted;
- why a rule fired;
- relevant source event;
- generated artifacts;
- approvals and denials;
- open loops if a run cannot complete;
- contact/profile learning if a channel interaction adds stable information.

No separate automation memory store is allowed. Operational tables may exist for
queueing, state and dedup, but semantic knowledge converges into `MemoryFacade`.

### 11. Failure Modes

Expected failure cases:

- provider disconnected;
- webhook unavailable;
- poll cursor invalid;
- duplicate event delivered;
- model cannot classify intent confidently;
- required capability unavailable;
- user approval timeout;
- send-back to channel fails;
- source event deleted before processing;
- run starts while app is closed.

Required behavior:

- fail closed for unsafe actions;
- surface the failure in the owning thread;
- record automation run outcome;
- preserve enough metadata for retry/debug;
- never pretend an external action was sent if channel delivery failed.

### 12. Implementation Slices

**Slice A: Project Access Surface**

Add project-contact access as the first policy surface: backend contract, UI
surface under projects, and effective-policy resolver that composes existing
contact perimeter with project grants.

**Slice B: Event source contract**

Add a provider-facing trigger descriptor and normalized event envelope. Surface
available event sources from channels, Composio/MCP/skills/addons and time.

**Slice C: Channel message rules**

Wire `EventTrigger::ChannelMessage` to inbound WhatsApp/Telegram events. Match
sender/channel filters, create a visible automation run and show it in the
owning thread.

Implementation requirement: the materialized task must inherit the automation's
`user_id` and `workspace_id`, and channel-triggered tasks must carry the owning
thread metadata (`thread_id`, channel/source, title) so the normal visible turn
pipeline renders the run in that channel/project thread. A channel event must
resolve Project Access before task creation; no grant means no project run.
The task input must also carry the normalized event envelope (`source_kind`,
`provider_id`, `event_type`, `dedup_key`, actor, payload, visibility), and the
runtime must mark `(automation_id, event_key)` seen before creating another run
for the same rule/event. Idempotency is operational runtime state in `TaskStore`,
not semantic memory.

**Slice D: Polling rules**

Implement generic `ConnectorPoll`/MCP polling: run a read-only capability on an
interval, dedup by `key_field`, emit normalized events for new items.

**Slice E: Capability action policy**

Allow evented rules to route into registry capabilities/addons, including
Presentations, with explicit policy and approval gates for external send-back.

**Slice F: IFTTT-style UI**

Replace the current event builder with a clearer IF/FILTER/THEN composer, while
keeping schedule creation and natural-language automation proposal cards.

**Slice G: Eval and safety**

Add tests and evals for:

- scheduled automation still works;
- project access denies unauthorized contacts by default;
- project access composes with contact perimeter and deny wins;
- WhatsApp/Telegram inbound can fire event rules;
- polling dedup prevents repeated runs;
- Presentations addon can be selected as an action but cannot auto-send without
  policy;
- all runs are visible in the thread before execution starts;
- memory/provenance records why a rule fired.

## Non-goals

- No separate "Automation v2" store.
- No Zapier-style deterministic node graph as the core execution model.
- No hidden background actions.
- No project memory/file/artifact leakage from channel-originated events.
- No provider-specific hardcoding for every connector.
- No autonomous send/publish by default.

## Open Questions

- Which first event source should be the implementation gate after project
  access: WhatsApp inbound, Gmail polling via Composio, or both?
- How much of model-assisted intent filtering should be enabled in the first
  event slice versus deterministic filters only?
- Should notification actions use OS notifications first, channel messages, or
  both depending on user settings?
