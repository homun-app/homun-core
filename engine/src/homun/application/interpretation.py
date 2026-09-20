"""Model interpretation followed by a separate transactional domain decision."""
from __future__ import annotations
from typing import Any
from homun.domain.models import Actor
from homun.domain.patch import WorkPatchChange, build_preview
from homun.domain.roster import build_workspace_roster
from homun.models.interpret import format_interpretation_for_chat
from homun.models.interpretation import RosterEntry
from homun.models.types import AttemptContext
from homun.planning.draft import format_plan_draft_for_chat
from homun.planning.extract import extract_plan_draft
from homun.application.command_types import CommandRequest
from homun.application.conversation_context import (
    authorized_conversation_work, compose_conversation_context, revalidate_context,
)
from homun.models.conversation_context import MAX_CURRENT_CHARACTERS, ContextManifest
from homun.domain.errors import ValidationError

def _default_roster(ctx: Any, actor: Actor, payload: dict[str, Any]) -> list[RosterEntry]:
    raw = payload.get("roster")
    existing: list[RosterEntry] | None = None
    if isinstance(raw, list) and raw:
        existing = [RosterEntry.model_validate(item) for item in raw]
    return build_workspace_roster(
        actor=actor,
        agents=ctx.service.store.agents.values(),
        existing=existing,
    )


def _budgeted_interpret(ctx, actor, work, body, conversation_id, text, roster, conversation_context):
    """Interpret under the work budget: reserve before the call, reconcile after.

    Runs outside any repository transaction, so the reservation commits before
    the provider call and a crash leaves a recoverable trace. Conversations
    without a work stay unbudgeted, exactly like the rest of the domain.
    """
    if work is None:
        return ctx.models.interpret(
            text, roster=roster, conversation_context=conversation_context,
            context=AttemptContext(command_id=body.command_id, conversation_id=conversation_id,
                                   work_id=None, actor_id=actor.id, purpose="interpret"))
    from homun.application import budgets as work_budgets
    from homun.domain.models import BudgetCounters
    reservation = work_budgets.reserve(ctx, actor, work.id, BudgetCounters(attempts=1),
                                       purpose='interpret')
    attempts_before = len(getattr(ctx.models, 'attempts', []) or [])
    usage_before = len(getattr(ctx.models, 'usage', []) or [])
    try:
        interpretation = ctx.models.interpret(
            text, roster=roster, conversation_context=conversation_context,
            context=AttemptContext(command_id=body.command_id, conversation_id=conversation_id,
                                   work_id=work.id, actor_id=actor.id, purpose="interpret"))
    except BaseException:
        work_budgets.reconcile_unknown(ctx, actor, work.id, reservation)
        raise
    attempts = list(getattr(ctx.models, 'attempts', []) or [])[attempts_before:]
    usage = [u for u in (getattr(ctx.models, 'usage', []) or [])[usage_before:]
             if getattr(u, 'input_tokens', None) is not None or getattr(u, 'output_tokens', None) is not None]
    if usage:
        counters = BudgetCounters(attempts=max(1, len(attempts)),
                                  input_tokens=sum(u.input_tokens or 0 for u in usage),
                                  output_tokens=sum(u.output_tokens or 0 for u in usage))
    elif attempts:
        counters = None  # attempts happened but the provider reported no usage
    else:
        counters = BudgetCounters(attempts=1)  # monkeypatched models may not record attempts
    if counters is None:
        work_budgets.reconcile_unknown(ctx, actor, work.id, reservation)
    else:
        work_budgets.reconcile(ctx, actor, work.id, reservation, usage=counters)
    return interpretation


def _budgeted_plan_draft(ctx, actor, work, body, text, roster, conversation_context):
    """Plan extraction under the work budget; usage is not reported by this path."""
    if work is None:
        return extract_plan_draft(ctx.models, text, roster=roster,
                                  conversation_context=conversation_context)
    from homun.application import budgets as work_budgets
    from homun.domain.models import BudgetCounters
    reservation = work_budgets.reserve(ctx, actor, work.id, BudgetCounters(attempts=1),
                                       purpose='plan_draft')
    try:
        draft = extract_plan_draft(ctx.models, text, roster=roster,
                                   conversation_context=conversation_context)
    except BaseException:
        work_budgets.reconcile_unknown(ctx, actor, work.id, reservation)
        raise
    work_budgets.reconcile_unknown(ctx, actor, work.id, reservation)
    return draft


def prepare_interpretation(
    ctx: Any,
    actor: Actor,
    body: CommandRequest,
    result: dict[str, Any],
) -> tuple[dict[str, Any], str]:
    """Interpret + enrich without appending the assistant message yet."""
    text = str(body.payload.get("text", ""))
    conversation_id = str(body.payload.get("conversation_id", ""))
    if not text.strip() or not conversation_id:
        return result, ""
    if len(text) > MAX_CURRENT_CHARACTERS:
        raise ValidationError('Message exceeds interpretation character limit; shorten the message')
    work = authorized_conversation_work(ctx.service.store, actor, conversation_id)
    conversation_context = compose_conversation_context(
        ctx.service.store, actor, conversation_id, result.get('message_id'), work,
        memory=getattr(ctx, 'memory', None),
    )
    roster = _default_roster(ctx, actor, body.payload)
    interpretation = _budgeted_interpret(ctx, actor, work, body, conversation_id, text, roster, conversation_context)
    display = format_interpretation_for_chat(interpretation)
    enriched = dict(result)
    enriched["interpretation"] = interpretation.model_dump(mode="json")
    enriched['context_manifest'] = conversation_context.manifest.model_dump(mode='json', exclude_none=True)

    if interpretation.kind == "patch_proposal":
        if work is None:
            display = (
                (interpretation.text or "Serve un lavoro esistente per applicare la modifica.")
                + "\nNessun lavoro collegato a questa conversazione."
            )
        else:
            draft_changes = [
                WorkPatchChange(
                    field=item.field,
                    to_value=item.to_value,
                    step_id=item.step_id,
                )
                for item in interpretation.patch_changes
            ]
            roster_ids = {entry.id for entry in roster}
            roster_ids.update(ctx.service.store.agents.keys())
            proposal = build_preview(
                work,
                ctx.service.current_plan(work),
                draft_changes,
                roster_ids=roster_ids,
            )
            enriched["patch_proposal"] = proposal.model_dump(mode="json")
            if proposal.missing_or_ambiguous:
                display = (
                    "Non posso proporre questa modifica:\n"
                    + "\n".join(f"- {item}" for item in proposal.missing_or_ambiguous)
                )
            elif proposal.summary_lines:
                display = (
                    (interpretation.text or "Propongo questa modifica:")
                    + "\n"
                    + "\n".join(proposal.summary_lines)
                    + "\nUsa Conferma o Annulla sulla card."
                )
            else:
                display = interpretation.text or "Nessuna modifica riconosciuta."

    elif interpretation.kind == "command_proposal":
        # Interpretation may have waited on a provider while grants changed.
        # Validate all selected provenance before sending it to the plan provider.
        with ctx.repository.locked():
            revalidate_context(ctx.repository.load(), actor, conversation_context.manifest)
        draft = _budgeted_plan_draft(ctx, actor, work, body, text, roster, conversation_context)
        enriched["plan_draft"] = draft.model_dump(mode="json")
        if draft.missing_fields:
            display = format_plan_draft_for_chat(draft, proposed=False)
        else:
            if work is None:
                display = (
                    format_plan_draft_for_chat(draft, proposed=False)
                    + "\nNessun lavoro collegato a questa conversazione: bozza non applicata."
                )
            else:
                # Model work is outside any transaction. Revalidate this expected
                # version against fresh state when committing the assistant result.
                enriched["_pending_plan"] = {
                    "work_id": work.id,
                    "expected_version": work.version,
                    "steps": [{"title": step.title, "assignee_id": step.assignee_id,
                               "output_expected": step.output_expected,
                               "depends_on": step.depends_on} for step in draft.steps],
                }

    return enriched, display


def finalize_assistant(
    ctx: Any,
    actor: Actor,
    body: CommandRequest,
    enriched: dict[str, Any],
    display: str,
) -> dict[str, Any]:
    enriched = dict(enriched)
    manifest = enriched.get('context_manifest')
    if manifest is not None:
        revalidate_context(ctx.service.store, actor, ContextManifest.model_validate(manifest))
    pending = enriched.pop("_pending_plan", None)
    if pending is not None:
        from homun.planning.draft import PlanDraft
        propose = ctx.service.apply(actor, f"{body.command_id}:plan_propose", "plan.propose", pending)
        enriched["plan_proposed"] = propose
        display = format_plan_draft_for_chat(
            PlanDraft.model_validate(enriched["plan_draft"]), proposed=True,
            revision=int(propose.get("plan_revision", 0)) or None,
        )
    conversation_id = str(body.payload.get("conversation_id", ""))
    if not display or not conversation_id:
        return enriched
    interpretation = enriched.get("interpretation") or {}
    assistant = ctx.service.append_engine_message(
        actor=actor,
        command_id=f"{body.command_id}:interpret",
        conversation_id=conversation_id,
        author_id="homun_engine",
        text=display,
        event_type="message.interpreted",
        event_payload={
            "interpretation": interpretation,
            "plan_draft": enriched.get("plan_draft"),
            "plan_proposed": enriched.get("plan_proposed"),
            "patch_proposal": enriched.get("patch_proposal"),
            "in_reply_to": enriched.get("message_id"),
            "context_manifest": manifest,
        },
    )
    out = dict(enriched)
    out["assistant_message_id"] = assistant["message_id"]
    out["assistant_text"] = display
    return out



