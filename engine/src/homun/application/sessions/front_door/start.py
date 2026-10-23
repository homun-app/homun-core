"""After a `start_work` turn commits: start the work, then say what really happened.

The chat sentence is written AFTER the start, from its outcome — running,
waiting for «Avvia», or refused with a typed reason — so the engine never
claims a start that did not happen. A refused start is an answer, not a
failed message: the person's words stay delivered and nothing is retried.
"""
from __future__ import annotations

from dataclasses import replace
from typing import Any

from homun.application.sessions.front_door import outcomes
from homun.domain.errors import DomainError
from homun.i18n import user_text


def _sentence(language: str, view: dict | None, error: DomainError | None) -> str:
    if error is not None:
        parts = [user_text('front_door.work_start_failed', language=language),
                 user_text(error.reason, language=language) if getattr(error, 'reason', None) else None]
        return ' '.join(part for part in parts if part)
    key = 'front_door.work_start_pending' if view and view['status'] == 'pending_approval' \
        else 'front_door.work_started'
    return user_text(key, language=language) or ''


def start_after_turn(ctx, actor, body, result: dict[str, Any], *, publish) -> dict[str, Any]:
    front = result.get('front_door') or {}
    if front.get('kind') != outcomes.WORK_STARTED:
        return result
    from homun.application.work import work_start
    language = str(front.get('language') or 'en')
    work_ids = (result.get('context_manifest') or {}).get('work_ids') or []
    out = dict(result)
    view, error = None, None
    try:
        view = work_start.start(ctx, actor, work_ids[0] if work_ids else '', {
            'command_id': f'{body.command_id}:start',
            'mode': str(body.payload.get('autonomy') or 'guarded'),
            'language': language})
        out['execution'] = view
    except DomainError as exc:
        error = exc
        out['execution_error'] = {'code': exc.code, 'reason': getattr(exc, 'reason', None)}
    text = _sentence(language, view, error)
    conversation_id = str(body.payload.get('conversation_id', ''))
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            fresh = replace(ctx, service=ctx.service.for_store(store))
            assistant = fresh.service.append_engine_message(
                actor=actor,
                command_id=f'{body.command_id}:interpret',
                conversation_id=conversation_id,
                author_id='homun_engine',
                text=text,
                event_type='message.interpreted',
                event_payload={
                    'front_door': front,
                    'execution': out.get('execution'),
                    'execution_error': out.get('execution_error'),
                    'in_reply_to': result.get('message_id'),
                    'context_manifest': result.get('context_manifest'),
                },
            )
            out['assistant_message_id'] = assistant['message_id']
            out['assistant_text'] = text
            record = store.commands.get(body.command_id)
            if record is not None:
                record.result = dict(out)
        ctx.service.store = store
    publish(ctx, store)
    return out
