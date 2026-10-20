"""The front-door turn: context, one native tool call, corrections, outcome.

Every ``conversation.post_message`` from a person (outside agent-bound chats)
passes through here: ONE model conversation with the native tool protocol.
The model proposes — text, clarification, work agreement, plan change — and the
engine validates and decides. Model mistakes are outcomes to correct: an
invalid argument returns to the model as the tool result (max two correction
rounds); an empty answer gets one reminder; beyond that a typed,
non-auto-retryable error. Providers without native tools get one constrained
structured-output call with the same rules.
"""
from __future__ import annotations

import logging
from typing import Any

from homun.application.sessions.command_types import CommandRequest
from homun.application.sessions.conversation_context import (
    authorized_conversation_work, compose_conversation_context, revalidate_context,
)
from homun.domain.errors import DomainError, ValidationError
from homun.domain.models import Actor
from homun.domain.roster import build_workspace_roster
from homun.models.conversation_context import MAX_CURRENT_CHARACTERS, ContextManifest, context_notice
from homun.models.native_errors import EMPTY, TIMEOUT, NativeModelError
from homun.models.native_turn import NativeMessage
from homun.models.prompt_store import prompts_for
from . import outcomes, tools

logger = logging.getLogger(__name__)

MAX_ARGUMENT_CORRECTIONS = 2
MAX_EMPTY_RETRIES = 1

CODE_OUTPUT_INVALID = 'model.output_invalid'
CODE_EMPTY_RESPONSE = 'model.empty_response'


class FrontDoorModelError(DomainError):
    """Model output that could not be corrected within the turn budget.

    ``reason`` doubles as the typed ``code`` (``model.output_invalid`` or
    ``model.empty_response``) — never retried automatically; the person can
    send the message again.
    """

    def __init__(self, message: str, *, reason: str):
        super().__init__(message, reason=reason)
        self.code = reason


def default_roster(store, actor: Actor, payload: dict[str, Any]):
    """The roster the UI sends (person + active agents), rebuilt defensively."""
    from homun.domain.roster import RosterEntry
    raw = payload.get('roster')
    existing = None
    if isinstance(raw, list) and raw:
        try:
            existing = [RosterEntry.model_validate(item) for item in raw]
        except Exception:  # noqa: BLE001 — a malformed roster falls back to the store
            existing = None
    return build_workspace_roster(actor=actor, agents=store.agents.values(), existing=existing)


def _empty_reminder() -> str:
    return ('Your last answer was empty. Reply with text for the person, or call exactly '
            'one of the available tools.')


def _budgeted_turn(ctx, actor, work, call):
    """Reserve before the model call, reconcile after — the _budgeted_interpret rules."""
    from homun.application.work import budgets as work_budgets
    from homun.domain.models import BudgetCounters

    reservation = work_budgets.reserve(ctx, actor, work.id, BudgetCounters(attempts=1),
                                       purpose='front_door')
    usage_before = len(getattr(ctx.models, 'usage', []) or [])
    try:
        outcome = call()
    except BaseException:
        work_budgets.reconcile_unknown(ctx, actor, work.id, reservation)
        raise
    usage = [u for u in (getattr(ctx.models, 'usage', []) or [])[usage_before:]
             if getattr(u, 'input_tokens', None) is not None or getattr(u, 'output_tokens', None) is not None]
    if usage:
        counters = BudgetCounters(attempts=max(1, len(usage)),
                                  input_tokens=sum(u.input_tokens or 0 for u in usage),
                                  output_tokens=sum(u.output_tokens or 0 for u in usage))
        work_budgets.reconcile(ctx, actor, work.id, reservation, usage=counters)
    else:
        work_budgets.reconcile_unknown(ctx, actor, work.id, reservation)
    return outcome


def _decision_messages(registry, language, conversation_context, roster, text, tool_catalog):
    system = prompts_for(registry).get('front_door/instructions', language).render(
        tools=tools.tools_block(tool_catalog))
    messages = [NativeMessage(role='system', content=system)]
    for message in conversation_context.messages:
        messages.append(NativeMessage(role=message.role, content=message.content))
    roster_lines = '\n'.join(f'- {entry.id} | {entry.display_name} | {entry.kind}'
                             for entry in roster) or '(empty roster)'
    preamble = getattr(conversation_context, 'preamble', '') or ''
    core = f'Roster:\n{roster_lines}\n\nMessaggio della persona:\n{text}'
    prompt = f'{context_notice(conversation_context)}{preamble}\n\n{core}' if preamble \
        else f'{context_notice(conversation_context)}{core}'
    messages.append(NativeMessage(role='user', content=prompt))
    return messages


def structured_union_schema(tool_catalog) -> dict[str, Any]:
    """Discriminated union of the front-door actions for the structured fallback.

    A flat ``action`` discriminant (instead of ``anyOf``) keeps the schema
    convertible to a grammar by local structured-output backends.
    """
    return {
        'type': 'object',
        'properties': {
            'action': {'type': 'string',
                       'enum': ['reply', tools.ASK_CLARIFICATION, tools.PROPOSE_WORK,
                                tools.PROPOSE_PLAN_CHANGE]},
            'reply_text': {'type': 'string'},
            'questions': tools.CLARIFY_SCHEMA['properties']['questions'],
            'question': {'type': 'string'},
            'choices': {'type': 'array', 'items': {'type': 'string'}},
            'multi_select': {'type': 'boolean'},
            'work': tools.PROPOSE_WORK_SCHEMA,
            'plan_changes': tools.PLAN_CHANGE_SCHEMA['properties']['changes'],
        },
        'required': ['action'],
    }


def _structured_to_message(payload: dict[str, Any]) -> NativeMessage:
    """One structured decision projected onto the same shape as a tool turn."""
    action = str(payload.get('action') or '')
    if action == 'reply':
        text = str(payload.get('reply_text') or payload.get('text') or '')
        if not text.strip():
            raise NativeModelError(EMPTY, 'Structured reply was empty')
        return NativeMessage(role='assistant', content=text)
    if action in (tools.ASK_CLARIFICATION, tools.PROPOSE_WORK, tools.PROPOSE_PLAN_CHANGE):
        if action == tools.ASK_CLARIFICATION:
            arguments = {key: payload[key] for key in ('questions', 'question', 'choices', 'multi_select')
                         if key in payload}
        elif action == tools.PROPOSE_WORK:
            arguments = dict(payload.get('work') or {})
        else:
            arguments = {'changes': payload.get('plan_changes') or []}
        return NativeMessage(role='assistant', content='',
                             tool_calls=[_synthetic_call(action, arguments)])
    raise NativeModelError(EMPTY, f'Unknown structured action: {action or "(missing)"}')


def _synthetic_call(name: str, arguments: dict[str, Any]):
    from uuid import uuid4
    from homun.models.native_turn import ToolCall
    return ToolCall(id=f'call_{uuid4().hex[:12]}', name=name, arguments=arguments)


class _ModelCall:
    """One front-door model step: native tools, or the constrained structured
    fallback when the (endpoint, model) route rejects tools."""

    def __init__(self, ctx, *, connection_id):
        self._ctx = ctx
        self._connection_id = connection_id

    def message(self, messages, tool_catalog) -> NativeMessage:
        from homun.models import structured_fallback
        registry = self._ctx.models
        provider = registry._get_provider(self._connection_id or registry.active_provider_id)
        model_id = str(getattr(provider, 'default_model', '') or '')
        route = structured_fallback.route_key(provider)
        if not structured_fallback.mode_rejected(route, model_id, structured_fallback.TOOLS_MODE):
            try:
                result = registry.complete_tools(messages, tools=tool_catalog,
                                                 connection_id=self._connection_id)
                return result.message
            except NativeModelError as exc:
                if not structured_fallback.is_tools_rejection(exc):
                    raise
                structured_fallback.remember_mode_rejected(route, model_id, structured_fallback.TOOLS_MODE)
                logger.warning('front door: tools rifiutati da %s (%s): ripiego con output strutturato',
                               route, model_id)
        result = registry.complete_structured(messages, schema=structured_union_schema(tool_catalog),
                                              connection_id=self._connection_id)
        return _structured_to_message(result.payload)


def run_front_door_turn(ctx, actor: Actor, body: CommandRequest, result: dict[str, Any]):
    """Model phase: answer the message through one native tool turn.

    Returns ``(enriched, display)``; the domain effects commit later in
    :func:`finalize_front_door`, inside the caller's transaction.
    """
    text = str(body.payload.get('text', ''))
    conversation_id = str(body.payload.get('conversation_id', ''))
    if not text.strip() or not conversation_id:
        return result, ''
    if len(text) > MAX_CURRENT_CHARACTERS:
        raise ValidationError('Message exceeds the front-door character limit; shorten the message',
                              reason='message.too_long', params={'max': MAX_CURRENT_CHARACTERS})

    store = ctx.service.store
    work = authorized_conversation_work(store, actor, conversation_id)
    conversation_context = compose_conversation_context(
        store, actor, conversation_id, result.get('message_id'), work,
        memory=getattr(ctx, 'memory', None),
    )
    roster = default_roster(store, actor, body.payload)
    from homun.application.ops.preferences import resolve_language
    from homun.application.work.intake_policy import active_agents, anchor_brief, proposals_for
    language = resolve_language(ctx, None, person_id=actor.id)
    tool_catalog = tools.front_door_tools(ctx.models, language)
    plan = ctx.service.current_plan(work) if work is not None else None
    agents = active_agents(store)
    anchor = anchor_brief(proposals_for(store, work.id)) if work is not None else None
    roster_ids = {entry.id for entry in roster}
    roster_ids.update(store.agents.keys())

    def decide():
        return _decide(ctx, actor, body, conversation_context, roster, text, language,
                       tool_catalog, work, plan, agents, anchor, roster_ids)

    outcome = _budgeted_turn(ctx, actor, work, decide) if work is not None else decide()

    display = outcomes.display_for(outcome, language=language)
    enriched = dict(result)
    enriched['context_manifest'] = conversation_context.manifest.model_dump(mode='json', exclude_none=True)
    enriched['front_door'] = _payload_for(outcome, language)
    if outcome.kind == outcomes.PLAN_CHANGE:
        enriched['patch_proposal'] = outcome.plan_preview
    return enriched, display


def _payload_for(outcome, language) -> dict[str, Any]:
    payload: dict[str, Any] = {'kind': outcome.kind, 'language': language}
    if outcome.kind == outcomes.CLARIFICATION:
        payload['questions'] = outcome.questions
    if outcome.kind == outcomes.WORK_PROPOSAL and outcome.brief is not None:
        payload['brief'] = outcome.brief.model_dump(mode='json')
    if outcome.kind == outcomes.PLAN_CHANGE:
        payload['plan_change'] = outcome.plan_preview
    return payload


def _decide(ctx, actor, body, conversation_context, roster, text, language,
            tool_catalog, work, plan, agents, anchor, roster_ids) -> outcomes.FrontDoorOutcome:
    connection_id = body.payload.get('connection_id') or body.payload.get('provider_id')
    call = _ModelCall(ctx, connection_id=connection_id)
    messages = _decision_messages(ctx.models, language, conversation_context, roster, text, tool_catalog)
    corrections = 0
    empty_retries = 0
    last_error = ''
    while True:
        try:
            message = call.message(messages, tool_catalog)
        except NativeModelError as exc:
            if exc.code == EMPTY and empty_retries < MAX_EMPTY_RETRIES:
                empty_retries += 1
                messages.append(NativeMessage(role='user', content=_empty_reminder()))
                continue
            raise _transport_error(exc)
        if not message.tool_calls:
            if not message.content.strip():
                if empty_retries < MAX_EMPTY_RETRIES:
                    empty_retries += 1
                    messages.append(NativeMessage(role='user', content=_empty_reminder()))
                    continue
                _warn_front_door(ctx, CODE_EMPTY_RESPONSE, 'empty answer after the reminder')
                raise FrontDoorModelError(
                    'Model returned an empty response twice in one front-door turn',
                    reason=CODE_EMPTY_RESPONSE)
            return outcomes.FrontDoorOutcome(kind=outcomes.TEXT, text=message.content.strip())
        first = message.tool_calls[0]
        if len(message.tool_calls) > 1:
            error = 'Call exactly one tool per turn.'
        else:
            try:
                arguments = tools.parse_arguments(first.name, first.arguments)
            except Exception as exc:  # noqa: BLE001 — the message goes back to the model
                error = f'Invalid arguments for {first.name}: {exc}. Fix them and call again.'
            else:
                outcome, error = outcomes.outcome_from_call(
                    first.name, arguments, work=work, plan=plan, agents=agents, anchor=anchor,
                    roster_ids=roster_ids)
                if error is None:
                    return outcome
        last_error = error
        if corrections >= MAX_ARGUMENT_CORRECTIONS:
            _warn_front_door(ctx, CODE_OUTPUT_INVALID, last_error)
            raise FrontDoorModelError(
                f'Model tool arguments stayed invalid after {MAX_ARGUMENT_CORRECTIONS} '
                f'corrections: {last_error[:200]}',
                reason=CODE_OUTPUT_INVALID)
        corrections += 1
        messages.append(message)
        messages.append(NativeMessage(role='tool', tool_call_id=first.id, name=first.name,
                                      content=error))


def _transport_error(exc: NativeModelError) -> DomainError:
    """Unreachable/timeout stays retryable (provider_unavailable / request_timeout)."""
    error = DomainError(f'Front-door model call failed: {exc}')
    error.code = 'request_timeout' if exc.code == TIMEOUT else 'provider_unavailable'
    return error


def _warn_front_door(ctx, code: str, detail: str) -> None:
    provider = getattr(ctx.models, 'active_provider_id', '?')
    logger.warning('front door: turno non valido (provider=%s, esito=%s, dettaglio=%s)',
                   provider, code, detail[:200])


def finalize_front_door(ctx, actor: Actor, body: CommandRequest, enriched: dict[str, Any],
                        display: str) -> dict[str, Any]:
    """Commit phase: apply the outcome and append the chat reply.

    Runs inside the caller's repository transaction, on ``ctx.service.store``.
    """
    enriched = dict(enriched)
    manifest = enriched.get('context_manifest')
    if manifest is not None:
        revalidate_context(ctx.service.store, actor, ContextManifest.model_validate(manifest))
    front = enriched.get('front_door') or {}
    if front.get('kind') == outcomes.WORK_PROPOSAL:
        from homun.application.work.intake import commit_front_door_proposal
        from homun.models.intake import IntakeBrief
        brief = IntakeBrief.model_validate(front.get('brief') or {})
        work_ids = (manifest or {}).get('work_ids') or []
        proposal = commit_front_door_proposal(
            ctx, actor, command_id=f'{body.command_id}:propose',
            conversation_id=str(body.payload.get('conversation_id', '')),
            work_id=work_ids[0] if work_ids else None, brief=brief,
            text=str(body.payload.get('text', '')))
        enriched['intake_proposal'] = proposal
        if proposal.get('status') != 'pending_confirmation':
            # The intake error code stays on the proposal record for the UI;
            # the chat sentence never carries internal codes.
            from homun.i18n import user_text
            replacement = user_text('front_door.work_proposal_failed',
                                    language=str(front.get('language') or 'en'))
            if replacement:
                display = replacement
    conversation_id = str(body.payload.get('conversation_id', ''))
    if not display or not conversation_id:
        return enriched
    assistant = ctx.service.append_engine_message(
        actor=actor,
        command_id=f'{body.command_id}:interpret',
        conversation_id=conversation_id,
        author_id='homun_engine',
        text=display,
        event_type='message.interpreted',
        event_payload={
            'front_door': {k: v for k, v in front.items() if k != 'brief'},
            'intake_proposal': enriched.get('intake_proposal'),
            'patch_proposal': enriched.get('patch_proposal'),
            'in_reply_to': enriched.get('message_id'),
            'context_manifest': manifest,
        },
    )
    out = dict(enriched)
    out['assistant_message_id'] = assistant['message_id']
    out['assistant_text'] = display
    return out
