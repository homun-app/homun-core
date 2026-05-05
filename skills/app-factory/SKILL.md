---
name: app-factory
description: Use when the user asks to create, design, generate, or modify an internal business app, operational tool, database-backed workflow, approval system, tracker, CRM-like mini app, employee portal, request system, or internal interface.
allowed-tools: "plan_internal_app create_internal_app list_internal_apps update_internal_app add_app_field add_app_view extract_lookup_entity configure_app_capabilities create_app_record query_app_records run_app_action read_file"
---

# App Factory

Create internal business tools using Homun Blueprint v1 and the App Factory tools.

App Factory is a modular app composer, not a code generator. Build apps by selecting supported modules and configuring a declarative blueprint. Never generate arbitrary Rust, JavaScript, SQL, shell commands, webhooks, scripts, or external scaffolds.

An app is not created until an App Factory tool succeeds. Draft files, YAML trees, Markdown summaries, attachments, or downloadable artifacts are not valid completion criteria for app creation requests.

## Core Rules

- Before creating or structurally modifying an app, call `plan_internal_app` and use its field classifications, questions, assumptions, and recommended tool.
- If `plan_internal_app` returns questions, ask one concise business question before building unless the user already answered it in the current message.
- If `plan_internal_app` returns `recommended_blueprint`, pass that exact object to `create_internal_app` unless the user asks for a change. Do not re-author the blueprint manually.
- Treat field classification as binding: `workflow_state` is not user-editable, `lookup_dynamic` becomes a managed entity/relation, and `bridge_backed` requires explicit capability configuration.
- Always produce or update a complete blueprint before creating the app.
- Prefer Blueprint v1 modular structure for every new app.
- Keep apps small enough to be immediately usable: identity, data, navigation, optional workflow, optional dashboard/calendar.
- Make conservative assumptions for common business tools and proceed without long interviews.
- Treat over-specified prompts as product requirements, not implementation instructions. Extract the business intent, roles, data, workflow, and views, then build the simplest valid App Factory blueprint.
- Ask one concise question only when the missing answer changes entities, fields, ownership, or workflow states.
- Do not expose system/workflow fields as user-editable fields.
- Use human-facing labels for navigation, views, fields, roles, and transitions.
- Never show snake_case names in user-facing labels.
- Never satisfy a create-app request by writing files or returning a scaffold. For create requests, the final action must be `create_internal_app`; if that tool is unavailable or fails, report the blocker instead of claiming the app exists.
- If the user mentions YAML, routes, templates, folders, schema aliases, or low-level blueprint mechanics, do not create files and do not mirror that structure in the answer. Translate only the useful intent into the supported JSON blueprint and call the App Factory tool.

## Supported Modules

Use `modules` to declare what the app needs.

Supported module names:

- `identity`: app-local users, roles, ownership.
- `data`: entities, typed fields, relations, isolated records.
- `workflow`: state machines and role-gated transitions.
- `navigation`: role-aware app menu and visible views.
- `dashboard`: compact counts/KPI widgets.
- `calendar`: date-range views.
- `directory`: people, teams, contacts.
- `notifications`: declarative notification intents through allowed Homun channels.
- `agent_bridge`: chat/tool commands that let Homun operate the app.

Every new app should include at least:

```json
[
  {"name": "identity", "version": 1, "features": ["local_users", "roles", "ownership"], "required": true},
  {"name": "data", "version": 1, "features": ["ownership"], "required": true},
  {"name": "navigation", "version": 1, "features": [], "required": true}
]
```

Add `workflow` when records move through states. Add `dashboard` for apps with approvals, ticket queues, CRM stages, inventory counts, or operational monitoring. Add `calendar` for leave, booking, appointments, shifts, deadlines, or events.

## Blueprint v1 Parts

- `app`: slug, name, description, icon.
- `modules`: supported module declarations.
- `entities`: data models with typed fields.
- `views`: table, form, and detail views with optional `id` and `roles`.
- `workflows`: state field, initial state, states, and role-gated transitions.
- `roles`: human role definitions.
- `permissions`: server-enforced allow/deny rules.
- `navigation`: role-aware menu items pointing at view ids.
- `dashboards`: compact widgets.
- `calendars`: date-range views.
- `notifications`: declarative notification intents.
- `agent_commands`: natural-language intents that map to app actions.

## Exact Schema Requirements

Use these exact keys. Do not invent aliases.

- Root must include `"version": 1`.
- A view must use `name`, not `label`.
- Supported view types are `table`, `form`, `detail`, `kanban`, and `calendar`.
- Use `kanban` for workflow entities with visible states.
- Use `calendar` only when the entity has at least one `date` field. Calendar views render as operational month calendars with draggable records; add update permissions when non-admin users should reschedule items.
- Relation fields render as app-local pickers when the current role may read the target entity, so prefer relations for assignee, customer, employee, project, account, and parent-record links.
- Use `extract_lookup_entity` when the user asks to manage options that are currently hard-coded in a select/enum, such as rooms, categories, departments, clients, projects, assets, or locations.
- A dashboard must use `name`, not `label`.
- A dashboard widget filter key is `filter`, not `filters`.
- A workflow transition `from` must be a single string. To allow multiple source states, create multiple transitions with different `name` values.
- `navigation[].view` must reference an existing view `id` or view `name`.
- Do not create navigation entries for dashboards unless a matching view exists.
- Do not put unsupported keys like `filters` on views.
- Use `description`, not `descrizione`, for app description.

Minimal valid view:

```json
{"id": "tickets", "type": "table", "entity": "ticket", "name": "Ticket", "columns": ["title", "priority", "status"], "roles": ["admin", "support", "employee"]}
```

Minimal valid kanban view:

```json
{"id": "ticket_board", "type": "kanban", "entity": "ticket", "name": "Board ticket", "columns": ["title", "priority", "status"], "roles": ["admin", "support"]}
```

Minimal valid calendar view:

```json
{"id": "calendar", "type": "calendar", "entity": "leave_request", "name": "Calendario", "columns": ["start_date", "kind", "status"], "roles": ["admin", "approver", "employee"]}
```

Minimal valid dashboard:

```json
{"name": "overview", "widgets": [{"type": "count", "entity": "ticket", "label": "Ticket aperti", "filter": {"status": "open"}, "roles": ["admin", "support"]}]}
```

## Field Types

Use only:

- `string`
- `text`
- `number`
- `date`
- `boolean`
- `enum`
- `relation`

For `enum`, provide 1-32 snake_case options. For `relation`, set `to` to an existing entity name.

## System And Workflow Fields

Fields controlled by the runtime must be marked explicitly.

Workflow state field:

```json
{
  "name": "status",
  "type": "enum",
  "label": "Stato",
  "options": ["pending", "approved", "rejected"],
  "default": "pending",
  "system": true,
  "managed_by": "workflow",
  "editable_by": []
}
```

Rules:

- State fields must be `system: true`.
- State fields must use `managed_by: "workflow"`.
- Do not put state fields in user-editable form assumptions.
- Set workflow `initial_state` so the server applies the starting state.

## Workflow Pattern

Use one enum state field per workflow.

Example:

```json
{
  "entity": "leave_request",
  "state_field": "status",
  "initial_state": "pending",
  "states": ["pending", "approved", "rejected"],
  "transitions": [
    {"name": "approve", "from": "pending", "to": "approved", "label": "Approva", "roles": ["admin", "approver"]},
    {"name": "reject", "from": "pending", "to": "rejected", "label": "Rifiuta", "roles": ["admin", "approver"]}
  ]
}
```

The workflow `states` must match the enum options of the state field.

## Permission Pattern

Always include `permissions` for apps with app-local users.

Standard role behavior:

- `admin`: full app control.
- `employee` or requester: create records and read own records.
- `approver`, `support`, `manager`, or operator: read relevant records and run specific transitions.

Example:

```json
[
  {"role": "employee", "allow": ["leave_request:create", "leave_request:read:own"], "deny": ["leave_request:transition:*"]},
  {"role": "approver", "allow": ["leave_request:read", "leave_request:transition:approve", "leave_request:transition:reject"], "deny": []},
  {"role": "admin", "allow": ["*"], "deny": []}
]
```

## Navigation Pattern

Every visible view should have a human menu item.

Example:

```json
[
  {"label": "Richieste", "view": "leave_requests", "roles": ["admin", "approver", "employee"]},
  {"label": "Nuova richiesta", "view": "new_leave_request", "roles": ["admin", "employee"]}
]
```

Use `view` ids instead of raw view names when possible.

## Creation Workflow

1. Identify the business domain and choose modules.
   - If the prompt is long or technical, first reduce it internally to a short app brief: purpose, roles, entities, workflow, views, dashboard.
2. Define roles and ownership:
   - who creates records;
   - who reads all records;
   - who reads only own records;
   - who can transition records.
3. Define entities and fields.
4. Mark workflow state fields as system/managed.
5. Define views with ids, human names, columns, and roles.
6. Define navigation using human labels.
7. Define workflows with `initial_state` and transition `roles`.
8. Define permissions.
9. Add dashboard/calendar only when useful.
10. Call `create_internal_app` with the full blueprint. This step is mandatory: do not stop after producing blueprint text or files.
11. Return:
    - external app link: `/a/{slug}`;
    - internal Studio link: `/apps/{slug}`;
    - selected modules;
    - roles and permission summary;
    - workflow actions;
    - assumptions made.

## Modification Workflow

1. Use `list_internal_apps` if the target app slug is not explicit.
2. Ask one concise question only if the requested change changes the data model in an ambiguous way.
3. For simple field additions, prefer `add_app_field` instead of rewriting the full blueprint.
4. For simple view additions, such as "add calendar view", "add kanban", "add board", or "add table/list view", use `add_app_view` instead of rewriting the full blueprint.
5. For requests like "make rooms manageable and connect them to the room select", use `extract_lookup_entity` instead of rewriting the full blueprint.
6. For broader structural changes, produce the complete updated blueprint, not a partial diff.
7. Keep `app.slug` unchanged.
8. Preserve existing `modules`, `permissions`, `navigation`, workflow `initial_state`, system fields, and transition roles unless the user explicitly asks to change them.
9. Call `update_internal_app` with:
   - `app_slug`;
   - the complete updated blueprint;
   - a short `change_note`.
10. Return:
   - updated app link: `/apps/{slug}`;
   - concise change summary;
   - new/changed modules, entities, fields, views, workflows;
   - any migration caveat if existing records may need manual cleanup.

## Capability Configuration Workflow

Use `configure_app_capabilities` when the user asks to let an app use contacts, profiles, channels, knowledge, skills, MCP-like tools, or writeback.

Examples:

- "Permetti all'app ferie-permessi di leggere i contatti HR"
- "Collega questa app alla knowledge policy-hr"
- "Consenti all'app di inviare email"

Prefer `mode: "merge"` unless the user explicitly asks to replace or reset permissions.

## Common App Recipes

### Leave / approval app

Use modules: `identity`, `data`, `workflow`, `navigation`, `dashboard`, `calendar`, `notifications`.

Use roles: `admin`, `approver`, `employee`.

Use a request entity with:

- requester/employee relation or string;
- kind enum;
- start date;
- end date;
- notes/reason;
- system workflow status.

### Ticketing app

Use modules: `identity`, `data`, `workflow`, `navigation`, `dashboard`, `notifications`.

Use roles: `admin`, `support`, `employee`.

Use a ticket entity with:

- title;
- description;
- priority enum;
- category enum when useful;
- assignee string or relation;
- system workflow status.

Add a `ticket_comment` entity when the user asks for collaboration, notes, internal updates, or a credible ticketing demo:

- ticket relation to ticket;
- body text;
- visibility enum (`internal`, `public`) when support/admin roles exist;
- created_date date.

Recommended ticket views:

- table view for all tickets;
- kanban view for support/admin workflow;
- form view for new tickets;
- detail view for selected ticket;
- table view for comments if `ticket_comment` is present.

Use this exact state model unless the user asks otherwise:

```json
{
  "entity": "ticket",
  "state_field": "status",
  "initial_state": "open",
  "states": ["open", "in_progress", "closed"],
  "transitions": [
    {"name": "start", "from": "open", "to": "in_progress", "label": "Prendi in carico", "roles": ["admin", "support"]},
    {"name": "close", "from": "in_progress", "to": "closed", "label": "Chiudi", "roles": ["admin", "support"]},
    {"name": "reopen", "from": "closed", "to": "open", "label": "Riapri", "roles": ["admin"]}
  ]
}
```

### CRM mini app

Use modules: `identity`, `data`, `navigation`, `dashboard`, and optional `workflow`.

Use entities: account, contact, opportunity or lead.

If a pipeline exists, make stage a system workflow field and gate transitions by role.

Recommended CRM views:

- table view for accounts;
- table view for contacts;
- kanban view for opportunity pipeline;
- dashboard counts by stage.

### Booking / scheduling app

Use modules: `identity`, `data`, `navigation`, `dashboard`, `calendar`, and optional `workflow`.

Use one main entity with a required date field, optional end date, title/name, requester, notes, and status when approval is needed.

Permissions should allow operators/admins to update all bookings and requesters/employees to update their own bookings when drag-and-drop rescheduling is expected.

Recommended views:

- calendar view for the dated entity;
- table view for operations/admin;
- form view for new requests/bookings.

## Operating Existing Apps

- Use `list_internal_apps` before operating on an app when the slug is unknown.
- Use `add_app_field` for requests like "add a field", "add notes", "add detailed reason", or "add email".
- Use `add_app_view` for requests like "add a calendar view", "add kanban", "add board", "add agenda", or "add table/list view".
- Use `extract_lookup_entity` for requests like "manage room names and connect them to the room select", "turn categories into a managed list", or "make clients/projects selectable from their own table".
- Use `update_internal_app` to modify an existing app blueprint from chat.
- Use `configure_app_capabilities` to configure app bridge permissions from chat.
- Use `create_app_record` to add records after validating entity fields from the blueprint.
- Use `query_app_records` for simple exact-match searches.
- Use `run_app_action` for workflow transitions.

## Visual Direction

Generated apps should follow the App Factory visual direction in `docs/design/app-factory-visual-direction.md`: crafted internal app shell, warm neutral background, compact top bar, lightweight sidebar, central work area, contextual side panel, illustrated empty state, and no visible snake_case.
