---
name: app-factory
description: Use when the user asks to create, design, generate, or modify an internal business app, operational tool, database-backed workflow, approval system, tracker, CRM-like mini app, employee portal, request system, or internal interface.
allowed-tools: create_internal_app, list_internal_apps, create_app_record, query_app_records, run_app_action, read_file, write_file
---

# App Factory

Create internal business tools using Homun blueprint v0 and the App Factory tools.

## Rules

- Do not generate arbitrary Rust, JavaScript, SQL, shell commands, or external scaffolds.
- Always produce or update a blueprint before creating the app.
- Keep v0 apps small: CRUD records, table/form/detail views, and simple workflow transitions.
- Ask one concise question only when the missing answer changes entities, fields, or workflow states.
- For common business tools, make conservative assumptions and proceed with a compact blueprint.
- Never include custom HTML, JavaScript, SQL, webhooks, scripts, or arbitrary code in the blueprint.

## Supported Blueprint Parts

- `app`: slug, name, optional description and icon.
- `entities`: data models with typed fields.
- `views`: table, form, and detail views.
- `workflows`: state field plus transitions such as approve/reject.
- `roles`: named permission groups for future UI and policy hints.
- `notifications`: declarative notification intents.
- `automations`: declarative scheduled task intents.
- `agent_commands`: natural-language intents that map to app actions.

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

## Workflow Pattern

Use one enum state field per workflow.

Example:

```json
{
  "entity": "leave_request",
  "state_field": "status",
  "states": ["pending", "approved", "rejected"],
  "transitions": [
    {"name": "approve", "from": "pending", "to": "approved", "label": "Approva"},
    {"name": "reject", "from": "pending", "to": "rejected", "label": "Rifiuta"}
  ]
}
```

The workflow `states` must match the enum options of the state field.

## Creation Workflow

1. Identify entities, fields, views, and workflow states.
2. Draft a blueprint v0 with `version: 1`.
3. Keep app and entity identifiers lowercase:
   - app slug: lowercase letters, numbers, hyphens.
   - entity, field, transition names: lowercase letters, numbers, underscores.
4. Call `create_internal_app` with the full blueprint.
5. Return:
   - internal app link: `/apps/{slug}`;
   - entity summary;
   - main views;
   - workflow actions;
   - any assumptions made.

## Operating Existing Apps

- Use `list_internal_apps` before operating on an app when the slug is unknown.
- Use `create_app_record` to add records after validating entity fields from the blueprint.
- Use `query_app_records` for simple exact-match searches.
- Use `run_app_action` for workflow transitions.
