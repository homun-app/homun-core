---
name: app-factory
description: Use when the user asks to create, design, generate, or modify an internal business app, operational tool, database-backed workflow, approval system, tracker, CRM-like mini app, employee portal, request system, or internal interface.
allowed-tools: "create_internal_app list_internal_apps update_internal_app add_app_field configure_app_capabilities create_app_record query_app_records run_app_action read_file write_file"
---

# App Factory

Create internal business tools using Homun Blueprint v1 and the App Factory tools.

App Factory is a modular app composer, not a code generator. Build apps by selecting supported modules and configuring a declarative blueprint. Never generate arbitrary Rust, JavaScript, SQL, shell commands, webhooks, scripts, or external scaffolds.

## Core Rules

- Always produce or update a complete blueprint before creating the app.
- Prefer Blueprint v1 modular structure for every new app.
- Keep apps small enough to be immediately usable: identity, data, navigation, optional workflow, optional dashboard/calendar.
- Make conservative assumptions for common business tools and proceed without long interviews.
- Ask one concise question only when the missing answer changes entities, fields, ownership, or workflow states.
- Do not expose system/workflow fields as user-editable fields.
- Use human-facing labels for navigation, views, fields, roles, and transitions.
- Never show snake_case names in user-facing labels.

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
10. Call `create_internal_app` with the full blueprint.
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
4. For broader structural changes, produce the complete updated blueprint, not a partial diff.
5. Keep `app.slug` unchanged.
6. Preserve existing `modules`, `permissions`, `navigation`, workflow `initial_state`, system fields, and transition roles unless the user explicitly asks to change them.
7. Call `update_internal_app` with:
   - `app_slug`;
   - the complete updated blueprint;
   - a short `change_note`.
8. Return:
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
- system workflow status.

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

## Operating Existing Apps

- Use `list_internal_apps` before operating on an app when the slug is unknown.
- Use `add_app_field` for requests like "add a field", "add notes", "add detailed reason", or "add email".
- Use `update_internal_app` to modify an existing app blueprint from chat.
- Use `configure_app_capabilities` to configure app bridge permissions from chat.
- Use `create_app_record` to add records after validating entity fields from the blueprint.
- Use `query_app_records` for simple exact-match searches.
- Use `run_app_action` for workflow transitions.

## Visual Direction

Generated apps should follow the App Factory visual direction in `docs/design/app-factory-visual-direction.md`: crafted internal app shell, warm neutral background, compact top bar, lightweight sidebar, central work area, contextual side panel, illustrated empty state, and no visible snake_case.
