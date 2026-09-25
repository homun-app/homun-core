"""Persist bounded text continuation before the next model request.

canonical transcript, epoch/lease fencing and durable retry phase accounting.
"""
from homun.application.agent_runs import lookup, authority
from homun.application import agent_recovery
from homun.domain.models import Actor
from homun.domain.errors import DomainError
from homun.application.agent_run_failures import fail
from homun.models.native_turn import NativeMessage
from homun.models.truncation import CONTINUE_PROMPT, MAX_TEXT_CHARACTERS

MAX_NUDGES = 3


def request(ctx, run, error, *, expected_steering):
    try:
        return _request(ctx, run, error, expected_steering=expected_steering)
    except DomainError as exc:
        fail(ctx, run['id'], exc.code, token=run.get('_lease_token'), epoch=run['_epoch'],
             expected_steering=expected_steering,
             blocked=exc.code in {'permission_denied', 'version_conflict', 'not_found'})
        return True


def _request(ctx, run, error, *, expected_steering):
    text = getattr(error, 'partial_text', None)
    if run.get('_continuation_version') != 1 or not text:
        return False
    handled = False
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, run['id'])
            if (current['_epoch'] != run['_epoch'] or current.get('_lease_token') != run.get('_lease_token')
                    or current['status'] != 'running'):
                handled = True
            elif current.get('_steering', []) != expected_steering:
                current.pop('_lease_token', None)
                current.pop('_lease_until', None)
                handled = True
            else:
                authority(ctx, store, Actor.model_validate(run['_actor']), current, running=True)
                parts = (current.get('_continuation') or {}).get('parts', [])
                window = (current.get('_context_policy') or {}).get('context_window')
                prompt_tokens = getattr(error.usage, 'input_tokens', None)
                room = not (window and prompt_tokens is not None and window - prompt_tokens < 512)
                if (len(parts) < MAX_NUDGES and sum(map(len, parts)) + len(text) <= MAX_TEXT_CHARACTERS
                        and current['model_attempts'] < current['limits']['max_model_attempts'] and room):
                    current['_continuation'] = {'parts': [*parts, text]}
                    current['_messages'].extend([
                        NativeMessage(role='assistant', content=text).model_dump(),
                        NativeMessage(role='user', content=CONTINUE_PROMPT).model_dump()])
                    agent_recovery.accept(current, 'decide')
                    current.pop('_lease_token', None)
                    current.pop('_lease_until', None)
                    handled = True
        ctx.service.store = store
    return handled
