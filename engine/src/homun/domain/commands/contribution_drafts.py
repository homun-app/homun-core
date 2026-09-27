"""Explicit partial clarification answers owned by the requested recipient."""
import json
from homun.domain.clarification import parse_answers
from homun.domain.errors import NotFoundError, PermissionDeniedError, ValidationError


def save_draft(ctx, actor, command_id, payload):
    request = ctx.store.contributions.get(str(payload.get('request_id', '')))
    if request is None:
        raise NotFoundError('Contribution request not found')
    if actor.kind != 'person' or request.to_actor_id != actor.id:
        raise PermissionDeniedError('Only the requested person may save this contribution')
    if request.status != 'pending' or not request.questions:
        raise ValidationError('A draft requires a pending structured clarification')
    work = ctx.get_work(request.work_id)
    ctx._require_expected_version(work.version, payload.get('expected_version'))
    if work.archived or work.status != 'waiting_input':
        raise ValidationError('The work is no longer awaiting input')
    text = payload.get('text')
    if not isinstance(text, str) or len(text) > 16000:
        raise ValidationError('Draft text must be at most 16000 characters')
    parsed = parse_answers(request.questions, text)
    if parsed is None or parsed.get('partial') is not True or parsed.get('timed_out'):
        raise ValidationError('Save explicit structured partial answers, not a timeout')
    previous = parse_answers(request.questions, request.draft_response_text) if request.draft_response_text else None
    answers = {**(previous['answers'] if previous else {}), **parsed['answers']}
    request.draft_response_text = json.dumps({'answers':answers, 'partial':True})
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=work.id, aggregate_type='work',
        aggregate_version=work.version, event_type='contribution.draft_saved', payload={'request_id':request.id})
    return {'request_id':request.id, 'status':request.status, 'version':work.version}
