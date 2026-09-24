"""Product wiring for detached side questions against an active agent run (H03)."""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from homun.application.agent_runs import authority, lookup
from homun.application.side_question import SideQuestionOutcome, SideQuestionRunner
from homun.domain.errors import ValidationError
from homun.domain.models import Actor
from homun.models.native_turn import NativeMessage


def _history_from_run(run: Dict[str, Any]) -> List[Dict[str, Any]]:
    messages = run.get("_messages") or []
    history: List[Dict[str, Any]] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        content = msg.get("content")
        if role in {"user", "assistant", "system"} and isinstance(content, str):
            history.append({"role": role, "content": content})
    return history


def _invoker_for_run(ctx, run: Dict[str, Any]) -> Callable[..., Any]:
    connection_id = run.get("connection_id")
    if not connection_id:
        raise ValidationError("Side questions require a model connection on the run")

    def invoker(messages, max_tokens=1024, tools=None):
        native = [
            NativeMessage(role=m["role"], content=m.get("content") or "")
            for m in messages
            if isinstance(m, dict) and m.get("role")
        ]
        result = ctx.models.complete_summary(
            native,
            connection_id=connection_id,
            max_output_tokens=max_tokens,
        )
        usage = result.usage
        return {
            "text": (result.message.content if result.message else "") or "",
            "prompt_tokens": int(getattr(usage, "input_tokens", 0) or 0) if usage else 0,
            "completion_tokens": int(getattr(usage, "output_tokens", 0) or 0) if usage else 0,
            "cost_estimate": float(getattr(usage, "estimated_cost", 0.0) or 0.0) if usage else 0.0,
            "tool_calls": [],
        }

    return invoker


def answer_side_question(
    ctx,
    actor: Actor,
    work_id: str,
    run_id: str,
    question: str,
    *,
    model_invoker: Optional[Callable[..., Any]] = None,
) -> Dict[str, Any]:
    """Answer /btw against a run snapshot without mutating the main transcript."""
    store = ctx.repository.load()
    run = lookup(store, run_id, work_id)
    authority(store, actor, run)
    if run.get("status") in {"completed", "failed", "cancelled"}:
        raise ValidationError("Side questions require an active agent run")

    invoker = model_invoker or _invoker_for_run(ctx, run)
    before_len = len(run.get("_messages") or [])
    runner = SideQuestionRunner(model_invoker=invoker)
    outcome: SideQuestionOutcome = runner.answer(
        question,
        history=_history_from_run(run),
        parent_run=run,
    )
    after_len = len(run.get("_messages") or [])
    if after_len != before_len:
        raise ValidationError("Side question must not mutate the main run transcript")
    if outcome.status == "error":
        raise ValidationError(outcome.error_message or "Side question failed")

    ctx.repository.save(store)

    return {
        "answer": outcome.answer,
        "usage": {
            "prompt_tokens": outcome.prompt_tokens,
            "completion_tokens": outcome.completion_tokens,
            "cost_estimate": outcome.cost_estimate,
        },
        "attempted_tools": list(outcome.tool_calls_attempted),
        "run_id": run_id,
        "work_id": work_id,
        "main_transcript_unchanged": True,
    }
