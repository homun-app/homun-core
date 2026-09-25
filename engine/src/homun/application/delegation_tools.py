"""Execution of isolated subagent delegation, output schemas, and durable tracking (H21/H22).

Derived from Hermes tools/delegate_tool.py, tools/delegation_output_schema.py,
and tools/async_delegation.py (MIT).
Homun executes delegated tasks within the parent work envelope, allocates subagent
budgets, enforces isolated context, validates structured output schemas (preserving raw
work if repair fails), and retains delegations across restarts in the run state.
"""
from __future__ import annotations

import json
import uuid
import jsonschema
from homun.application import budgets
from homun.application.workspace_file_contracts import root_for
from homun.domain.errors import ValidationError
from homun.domain.models import BudgetCounters
from homun.execution.subagent_worktree import cleanup_subagent_worktree, create_subagent_worktree
from homun.models.types import ChatMessage


def _validate_schema(data: str, schema: dict) -> tuple[dict | None, str | None]:
    """Parse JSON and validate against schema. Returns (parsed_obj, error_string)."""
    try:
        parsed = json.loads(data)
    except Exception:
        # Bounded repair attempt: strip code fences if present
        cleaned = data.strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            cleaned = "\n".join(lines).strip()
        try:
            parsed = json.loads(cleaned)
        except Exception as exc:
            return None, f"Failed to parse output as JSON: {exc}"

    try:
        jsonschema.validate(parsed, schema)
        return parsed, None
    except jsonschema.ValidationError as err:
        return parsed, f"Schema validation error: {err.message}"


def execute(ctx, actor, run, tool, args):
    if run.get("delegation", {}).get("policy") != "isolated-subagent-v1":
        raise ValidationError("Delegation tools are not enabled for this run")

    delegations = run.setdefault("_delegations", {})

    if tool == "delegate_task":
        task = args["task"].strip()
        agent_id = args.get("agent_id") or run.get("assignee_id")
        tools_include = args.get("tools_include")
        max_turns = min(args.get("max_turns", 3), 10)
        output_schema = args.get("output_schema")
        run_in_background = bool(args.get("run_in_background", False))

        store = ctx.repository.load()
        agent = store.agents.get(agent_id) if agent_id else None
        agent_name = agent.name if agent else "Subagent"
        agent_instructions = agent.instructions if agent else "Perform the delegated task accurately."
        connection_id = agent.preferred_connection_id if agent else run.get("connection_id")

        del_id = f"del_{uuid.uuid4().hex[:12]}"
        reservation = budgets.reserve(
            ctx,
            actor,
            run["work_id"],
            BudgetCounters(attempts=1),
            purpose="agent_run.delegate",
            accounting_actor_id=agent.id if agent else actor.id,
        )

        # Isolated subagent prompt
        system_content = (
            f"You are a delegated subagent ({agent_name}). "
            f"You work in an isolated execution sandbox. "
            f"Allowed tools: {json.dumps(tools_include) if tools_include else 'all approved'}. "
            f"Instructions:\n{agent_instructions}"
        )
        if output_schema:
            system_content += f"\nYour final answer MUST conform strictly to this JSON schema:\n{json.dumps(output_schema)}"

        user_content = f"Execute the following task:\n{task}"

        worktree_info = None
        if bool(run.get("delegation", {}).get("worktree_isolation")):
            try:
                repo_root = str(root_for(ctx, run))
                worktree_info = create_subagent_worktree(repo_root, subagent_id=del_id)
            except Exception:
                worktree_info = None

        try:
            result = ctx.models.complete(
                [
                    ChatMessage(role="system", content=system_content),
                    ChatMessage(role="user", content=user_content),
                ],
                connection_id=connection_id,
            )
            from homun.application.agent_usage import charge
            charge(ctx, actor, run, reservation, getattr(result, "usage", None))
        except Exception:
            budgets.reconcile_unknown(ctx, actor, run["work_id"], reservation)
            if worktree_info:
                cleanup_subagent_worktree(worktree_info, force=True)
            raise

        result_text = result.text.strip()
        structured_data = None
        schema_error = None
        if output_schema:
            structured_data, schema_error = _validate_schema(result_text, output_schema)

        if worktree_info:
            cleanup_subagent_worktree(worktree_info, force=False)

        record = {
            "delegation_id": del_id,
            "status": "completed",
            "task": task,
            "agent_id": agent_id,
            "tools_include": tools_include,
            "max_turns": max_turns,
            "turns_used": 1,
            "result": result_text,
            "structured_output": structured_data,
            "schema_error": schema_error,
            "worktree": worktree_info,
        }
        delegations[del_id] = record

        if run_in_background:
            return {
                "delegation_id": del_id,
                "status": "running",
                "message": "Subagent launched in background. Use delegation_poll to retrieve final result.",
            }

        return {
            "delegation_id": del_id,
            "status": "completed",
            "result": result_text,
            "structured_output": structured_data,
            "schema_error": schema_error,
            "turns": 1,
        }

    if tool == "delegation_poll":
        del_id = args["delegation_id"].strip()
        record = delegations.get(del_id)
        if record is None:
            return {"error_code": "delegation_not_found", "message": f"Delegation not found: {del_id}"}
        return {
            "delegation_id": del_id,
            "status": record["status"],
            "result": record.get("result"),
            "structured_output": record.get("structured_output"),
            "schema_error": record.get("schema_error"),
            "turns_used": record.get("turns_used", 1),
        }

    if tool == "delegation_cancel":
        del_id = args["delegation_id"].strip()
        record = delegations.get(del_id)
        if record is None:
            return {"error_code": "delegation_not_found", "message": f"Delegation not found: {del_id}"}
        record["status"] = "cancelled"
        return {"delegation_id": del_id, "status": "cancelled", "message": "Delegation cancelled."}

    raise ValidationError(f"Unknown delegation tool: {tool}")
