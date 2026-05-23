# Assistant Orchestrator Brain Hardening Design

## Goal

Close the Brain foundation so it can be shown in a future UI and can route subagent work durably, without exposing raw prompts or raw tool arguments through read models.

## Components

- `OrchestratorAuditStore`: local SQLite audit store for Brain runs. It stores route, status, counts, metrics, redacted plan detail, loaded tool cards, memory refs and task summaries.
- `OrchestratorUiReadModel`: UI-safe projection over the audit store. It exposes step ids, tool names, agent ids, contracts, argument keys and status metadata, but not raw user message, raw attachments, raw tool arguments or raw tool outputs.
- `subagent_workflow`: conversion boundary from planner `subagent_task` steps to durable `SubagentTask` records. It derives permission envelopes from the request policy and uses the existing `SubagentTaskRuntimeBridge`.

## Data Safety

The execution path can still keep raw input inside task payloads when a worker needs it, but the audit/read-model path does not expose raw input. UI detail surfaces only redacted structure: argument keys, output keys, counts, ids and routing decisions.

Planner failures are also recorded when an audit store is configured. Failure messages are scrubbed against the raw user message before persistence.

## Subagent Workflow Rules

Subagent plan steps must include:

- `agent_id`
- `goal`
- `contract`
- `execution_policy`
- `risk_level`
- `expected_duration_seconds`

Optional fields include `allowed_actions`, `requires_user_approval`, `timeout_seconds` and `max_tokens`.

Allowed actions are checked against the request `PolicyContext`; the Brain refuses subagent steps that request actions outside the active policy. Dependencies between subagent steps, and between previous durable capability steps and subagent steps, are persisted in `TaskStore`.

## Definition Of Done

- successful Brain runs are persisted.
- planner failures are persisted.
- UI read model is redacted.
- subagent plan steps become durable task runtime records with dependencies.
- existing lazy tool registry, immediate execution and durable capability queueing behavior remains intact.
