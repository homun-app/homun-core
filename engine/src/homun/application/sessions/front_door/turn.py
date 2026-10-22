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
from homun.domain.ids import new_id
from homun.domain.models import Actor
from homun.domain.roster import build_workspace_roster
from homun.models.conversation_context import MAX_CURRENT_CHARACTERS, ContextManifest, context_notice
from homun.models.native_errors import EMPTY, MALFORMED, REPETITION, TIMEOUT, TRUNCATED, NativeModelError
from homun.models.native_turn import NativeMessage
from homun.models.prompt_store import prompts_for
from homun.models.types import AttemptContext, UsageAttempt, utc_now
from . import outcomes, tools

logger = logging.getLogger(__name__)

MAX_ARGUMENT_CORRECTIONS = 2
MAX_EMPTY_RETRIES = 1
# Model output the model itself must fix (never a transport failure to retry in the background).
INVALID_OUTPUT_CODES = frozenset({MALFORMED, TRUNCATED, REPETITION})

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


def _prompt(registry, name: str, language: str | None, **values) -> str:
    """A front-door template in the prompt's language (person → workspace → en).

    The file's trailing newline is dropped so the person's text stays the
    exact tail of the request.
    """
    return prompts_for(registry).get(f'front_door/{name}', language).render(**values).rstrip('\n')


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
    system = _prompt(registry, 'instructions', language, tools=tools.tools_block(tool_catalog))
    messages = [NativeMessage(role='system', content=system)]
    for message in conversation_context.messages:
        messages.append(NativeMessage(role=message.role, content=message.content))
    roster_lines = '\n'.join(f'- {entry.id} | {entry.display_name} | {entry.kind}'
                             for entry in roster) or '(empty roster)'
    preamble = getattr(conversation_context, 'preamble', '') or ''
    core = _prompt(registry, 'request', language, roster=roster_lines, text=text)
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
                       'enum': ['reply', *tools.TOOL_ORDER]},
            'reply_text': {'type': 'string'},
            'questions': tools.CLARIFY_SCHEMA['properties']['questions'],
            'question': {'type': 'string'},
            'choices': {'type': 'array', 'items': {'type': 'string'}},
            'multi_select': {'type': 'boolean'},
            'work': tools.PROPOSE_WORK_SCHEMA,
            'plan_changes': tools.PLAN_CHANGE_SCHEMA['properties']['changes'],
            'language': {'type': 'string'},
        },
        'required': ['action'],
    }


def _structured_to_message(payload: dict[str, Any]) -> NativeMessage:
    """One structured decision projected onto the same shape as a tool turn."""
    action = str(payload.get('action') or '')
    language = {'language': payload['language']} if payload.get('language') else {}
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
        arguments.update(language)
        return NativeMessage(role='assistant', content='',
                             tool_calls=[_synthetic_call(action, arguments)])
    raise NativeModelError(MALFORMED, f'Unknown structured action: {action or "(missing)"}')


def _synthetic_call(name: str, arguments: dict[str, Any]):
    from uuid import uuid4
    from homun.models.native_turn import ToolCall
    return ToolCall(id=f'call_{uuid4().hex[:12]}', name=name, arguments=arguments)


class _ModelCall:
    """One front-door model step: native tools, or the constrained structured
    fallback when the (endpoint, model) route rejects tools.

    Every provider round-trip lands in the UsageAttempt ledger (the one the
    Models settings panel lists): status, error code and the tokens the
    provider reported — never invented.
    """

    def __init__(self, ctx, *, connection_id, attempt_context: AttemptContext):
        self._ctx = ctx
        self._connection_id = connection_id
        self._attempt_context = attempt_context
        self._attempt_index = 0

    def message(self, messages, tool_catalog) -> NativeMessage:
        from homun.models import structured_fallback
        registry = self._ctx.models
        provider_id = self._connection_id or registry.active_provider_id
        provider = registry._get_provider(provider_id)
        model_id = str(getattr(provider, 'default_model', '') or '')
        route = structured_fallback.route_key(provider)
        if not structured_fallback.mode_rejected(route, model_id, structured_fallback.TOOLS_MODE):
            try:
                result = self._attempted(provider_id, model_id, lambda: registry.complete_tools(
                    messages, tools=tool_catalog, connection_id=self._connection_id))
                return result.message
            except NativeModelError as exc:
                if not structured_fallback.is_tools_rejection(exc):
                    raise
                structured_fallback.remember_mode_rejected(route, model_id, structured_fallback.TOOLS_MODE)
                logger.warning('front door: tools rifiutati da %s (%s): ripiego con output strutturato',
                               route, model_id)
        result = self._attempted(provider_id, model_id, lambda: registry.complete_structured(
            messages, schema=structured_union_schema(tool_catalog), connection_id=self._connection_id))
        return _structured_to_message(result.payload)

    def _attempted(self, provider_id, model_id, call):
        registry = self._ctx.models
        started = utc_now()
        usage_before = len(registry.usage)
        try:
            result = call()
        except NativeModelError as exc:
            self._record(provider_id, model_id, usage_before, started, status='error', error_code=exc.code)
            raise
        self._record(provider_id, model_id, usage_before, started, status='ok')
        return result

    def _record(self, provider_id, model_id, usage_before, started, *, status, error_code=None):
        registry = self._ctx.models
        usage_entry = registry.usage[-1] if len(registry.usage) > usage_before else None
        context = self._attempt_context
        registry.append_attempt(UsageAttempt(
            id=new_id('uat'), workspace_id=getattr(registry, 'workspace_id', '') or '',
            command_id=context.command_id, conversation_id=context.conversation_id,
            work_id=context.work_id, actor_id=context.actor_id, purpose=context.purpose,
            attempt_index=self._attempt_index, provider_id=provider_id,
            model_id=(usage_entry.model_id if usage_entry else None) or model_id or None,
            status=status, error_code=error_code,
            usage_entry_id=usage_entry.id if usage_entry else None,
            input_tokens=usage_entry.input_tokens if usage_entry else None,
            output_tokens=usage_entry.output_tokens if usage_entry else None,
            started_at=started, finished_at=utc_now(),
            notes='Front-door turn step; the model proposed, nothing was executed.'))
        self._attempt_index += 1


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
    from homun.application.ops.preferences import person_language, resolve_language
    from homun.application.work.intake_policy import active_agents, anchor_brief, proposals_for
    # Prompts follow the documented chain: person → conversation (detected) →
    # workspace → en. The texts generated AFTER the turn add this turn's fresh
    # detection (see below): the person's explicit preference always wins.
    person_pref = person_language(ctx, actor.id)
    prompt_language = person_pref or resolve_language(ctx, None, conversation_id=conversation_id)
    language = prompt_language
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

    detected = outcome.language
    if person_pref is not None:
        text_language = person_pref
    elif detected is not None:
        text_language = detected
    else:
        text_language = prompt_language

    display = outcomes.display_for(outcome, language=text_language)
    enriched = dict(result)
    enriched['context_manifest'] = conversation_context.manifest.model_dump(mode='json', exclude_none=True)
    enriched['front_door'] = _payload_for(outcome, text_language, detected=detected)
    if outcome.kind == outcomes.PLAN_CHANGE:
        enriched['patch_proposal'] = outcome.plan_preview
    return enriched, display


def _payload_for(outcome, language, *, detected=None) -> dict[str, Any]:
    payload: dict[str, Any] = {'kind': outcome.kind, 'language': language}
    if detected is not None:
        payload['detected_language'] = detected
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
    call = _ModelCall(ctx, connection_id=connection_id, attempt_context=AttemptContext(
        command_id=body.command_id, conversation_id=str(body.payload.get('conversation_id', '')),
        work_id=work.id if work is not None else None, actor_id=actor.id, purpose='front_door'))
    messages = _decision_messages(ctx.models, language, conversation_context, roster, text, tool_catalog)
    budget = _TurnBudget(ctx, language)
    rounds = 0
    while True:
        if rounds:
            # Grants may have changed while the model answered: the same
            # context must still be authorized before it travels to the
            # provider again (the rule the two-call path already enforced).
            with ctx.repository.locked():
                revalidate_context(ctx.repository.load(), actor, conversation_context.manifest)
        rounds += 1
        try:
            message = call.message(messages, tool_catalog)
        except NativeModelError as exc:
            if exc.code == EMPTY:
                messages.append(budget.empty_reminder())
                continue
            if exc.code in INVALID_OUTPUT_CODES:
                # Malformed, truncated or looping output is the model's to fix,
                # not a transport failure to retry in the background.
                messages.append(budget.invalid_output(str(exc)))
                continue
            raise _transport_error(exc)
        if not message.tool_calls:
            if not message.content.strip():
                messages.append(budget.empty_reminder())
                continue
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
        budget.correction(error)
        messages.append(message)
        messages.append(NativeMessage(role='tool', tool_call_id=first.id, name=first.name,
                                      content=error))


class _TurnBudget:
    """How many times the model may be asked to fix itself in one turn.

    Two argument/output corrections and one reminder for an empty answer;
    beyond that the turn ends with a typed error the engine never retries on
    its own (the person can send the message again).
    """

    def __init__(self, ctx, language):
        self._ctx = ctx
        self._language = language
        self.corrections = 0
        self.empty_retries = 0

    def empty_reminder(self) -> NativeMessage:
        if self.empty_retries >= MAX_EMPTY_RETRIES:
            _warn_front_door(self._ctx, CODE_EMPTY_RESPONSE, 'empty answer after the reminder')
            raise FrontDoorModelError('Model returned an empty response twice in one front-door turn',
                                      reason=CODE_EMPTY_RESPONSE)
        self.empty_retries += 1
        return NativeMessage(role='user', content=_prompt(self._ctx.models, 'empty_reminder', self._language))

    def correction(self, error: str) -> None:
        if self.corrections >= MAX_ARGUMENT_CORRECTIONS:
            _warn_front_door(self._ctx, CODE_OUTPUT_INVALID, error)
            raise FrontDoorModelError(
                f'Model output stayed invalid after {MAX_ARGUMENT_CORRECTIONS} corrections: {error[:200]}',
                reason=CODE_OUTPUT_INVALID)
        self.corrections += 1

    def invalid_output(self, detail: str) -> NativeMessage:
        note = _prompt(self._ctx.models, 'invalid_output', self._language, detail=detail[:200])
        self.correction(note)
        return NativeMessage(role='user', content=note)


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
    conversation_id = str(body.payload.get('conversation_id', ''))
    # The detected language joins the same transaction as the rest of the turn:
    # it persists exactly when the reply does (person → conversation → ws → en).
    detected = str(front.get('detected_language') or '')
    if conversation_id and detected:
        from homun.application.ops.preferences import remember_conversation_language
        with ctx.repository.locked() as conn:
            remember_conversation_language(conn, conversation_id, detected)
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
