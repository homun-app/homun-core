"""Optional, durable input deadlines on the canonical pending clarify call."""
import json
from datetime import datetime, timedelta

from homun.application import agent_native
from homun.application.agent_clarification import questions
from homun.application.agent_runs import authority, lookup
from homun.application.agent_tool_registry import registry_for
from homun.domain.clarification import parse_answers
from homun.domain.contribution_resolution import resolve_contribution
from homun.domain.errors import ConflictError
from homun.domain.models import Actor, utc_now


def bind(run, call):
    """Called inside contribution staging; no deadline is the legacy default."""
    args = registry_for(run).validate('clarify', call.arguments)
    timeout = args.get('timeout_seconds')
    run['_clarify_wait'] = {'call_id':call.id, 'epoch':run['_epoch'], 'request_id':run['request_id']}
    if timeout is not None:
        run['clarify_deadline_at'] = (utc_now() + timedelta(seconds=timeout)).isoformat()


def expire_waiting(ctx, run_id, *, now=None):
    """Serialize with human answers; only an explicitly timed clarify expires."""
    now = utc_now() if now is None else now
    # precontrollo read-only: senza scadenza matura la transazione non si apre
    peek = ctx.repository.snapshot().commands.get(run_id)
    if peek is None:
        return False
    _deadline = (peek.result or {}).get('clarify_deadline_at')
    if (peek.result or {}).get('status') != 'waiting_input' or not _deadline \
            or datetime.fromisoformat(_deadline) > now:
        return False
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = lookup(store, run_id)
            deadline = run.get('clarify_deadline_at')
            if run['status'] != 'waiting_input' or not deadline or datetime.fromisoformat(deadline) > now:
                return False
            request = store.contributions[run['request_id']]
            if request.status != 'pending':
                return False
            actor = Actor.model_validate(run['_actor'])
            work, _ = authority(ctx, store, actor, run, approve=True)
            call = agent_native.pending(run)
            binding = run.get('_clarify_wait')
            if (work.archived or work.status != 'waiting_input' or work.version != run['_wait_version']
                    or run.get('_steering') or call is None or call.name != 'clarify'
                    or binding != {'call_id':call.id, 'epoch':run['_epoch'], 'request_id':request.id}):
                raise ConflictError('Clarification changed while awaiting input')
            args = registry_for(run).validate('clarify', call.arguments)
            expected = questions(args)
            if (args.get('timeout_seconds') is None or expected != run.get('clarify_request')
                    or expected != request.questions):
                raise ConflictError('Clarification deadline differs from the pending call')
            draft = parse_answers(expected, request.draft_response_text) if request.draft_response_text else None
            text = json.dumps({'answers':draft['answers'] if draft else {}, 'partial':True, 'timed_out':True})
            engine = Actor(id='homun_engine', workspace_id=actor.workspace_id, display_name='Homun engine', kind='agent')
            service = ctx.service.for_store(store)
            resolve_contribution(service._context, engine, f'{run_id}:clarify-expired:{run["_epoch"]}',
                request, {'expected_version':work.version}, text, [], resolution='expired')
        ctx.service.store = store
    return True
