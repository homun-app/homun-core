"""Background terminal sessions on an already approved Docker job.

Poll, wait, stop and one completion notice follow the process-registry
behavior of Hermes Agent (MIT); see homun/notices/hermes-agent.txt.
No PTY, stdin write, or second dispatch.
"""
import hashlib
from copy import deepcopy
from homun.application import agent_native, terminal_jobs
from homun.execution.contracts import ExecutionTimeout, ExecutionUnavailable, ExecutionUncertain
from homun.execution.docker_stdin import StdinNotSent
from homun.application.agent_runs import authority, lookup
from homun.domain.errors import ConflictError, DomainError, NotFoundError, PermissionDeniedError, ValidationError
from homun.domain.models import Actor
from homun.models.native_turn import NativeMessage

RUNNING = {'created', 'running', 'paused', 'restarting'}
FINISHED = {'exited', 'dead'}


def receipt(proposal, *, complete):
    body = {key: deepcopy(proposal.get(key)) for key in
            ('status', 'exit_code', 'timed_out', 'oom_killed', 'logs', 'error_code', 'error')}
    exited = proposal.get('exit_code') not in {None, 0}
    body.update(job_id=proposal['id'], background=bool(proposal.get('background')), complete=complete,
                is_error=bool(proposal.get('timed_out')) or exited or proposal.get('status') in {'dead', 'outcome_unknown'})
    return body


def start_receipt(proposal):
    if not proposal.get('background') or proposal.get('_start_receipt') or proposal['status'] not in RUNNING:
        return None
    return receipt(proposal, complete=False)


def _owned(store, run, session_id):
    record = store.commands.get(session_id)
    if record is None or record.type != terminal_jobs.TYPE or record.result['work_id'] != run['work_id']:
        raise NotFoundError('Terminal session not found for this work')
    proposal = record.result
    if (proposal.get('_agent_binding') or {}).get('run_id') != run['id']:
        raise PermissionDeniedError('Terminal session belongs to another run')
    return proposal


def _session(ctx, run, session_id):
    try:
        return _owned(ctx.repository.load(), run, session_id)
    except NotFoundError as exc:
        raise ValidationError(exc.message) from None


def poll(ctx, actor, run, arguments):
    proposal = _session(ctx, run, arguments['session_id'])
    if proposal['status'] == 'pending_approval':
        return receipt(proposal, complete=False)
    current = terminal_jobs.refresh(ctx, actor, run['work_id'], proposal['id'])
    return receipt(current, complete=current['status'] in FINISHED)


def stop(ctx, actor, run, arguments):
    proposal = _session(ctx, run, arguments['session_id'])
    if proposal['status'] == 'pending_approval':
        raise ValidationError('Terminal session has not started')
    if proposal['status'] in FINISHED:
        current = terminal_jobs.refresh(ctx, actor, run['work_id'], proposal['id'])
    else:
        current = terminal_jobs.stop(ctx, actor, run['work_id'], proposal['id'])
    return receipt(current, complete=current['status'] in FINISHED | {'outcome_unknown'})


def _suppress_notice(ctx, run, session_id):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, run['id'])
            notices = list(current.get('_terminal_notices') or [])
            if session_id not in notices:
                notices.append(session_id)
                current['_terminal_notices'] = notices
        ctx.service.store = store


def stage_wait(ctx, actor, run, decision):
    session_id = decision.arguments['session_id']
    proposal = _session(ctx, run, session_id)
    if not proposal.get('background') or not proposal.get('_start_receipt'):
        raise ValidationError('Only a started background session can be awaited')
    current = terminal_jobs.refresh(ctx, actor, run['work_id'], session_id)
    finished = current['status'] in FINISHED and current.get('logs') is not None
    if finished or current['status'] == 'outcome_unknown':
        if current['status'] in FINISHED:
            _suppress_notice(ctx, run, session_id)
        return receipt(current, complete=current['status'] in FINISHED)
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current_run = lookup(store, run['id'])
            authority(ctx, store, actor, current_run, running=True)
            if current_run.get('_lease_token') != run['_lease_token'] or current_run['status'] != 'running':
                raise ConflictError('Agent lease changed before waiting')
            call = agent_native.pending(current_run)
            if call is None or call.name != 'terminal_wait' or call.arguments.get('session_id') != session_id:
                raise ConflictError('Wait does not match the canonical call')
            _owned(store, current_run, session_id)
            current_run.update(status='waiting_external', terminal_wait_id=session_id)
            for key in ('_lease_token', '_lease_until', '_active_call_id'):
                current_run.pop(key, None)
        ctx.service.store = store
    return 'waiting_external'


def resume_wait(ctx, run_id):
    store = ctx.repository.load()
    run = lookup(store, run_id)
    if run['status'] != 'waiting_external' or not run.get('terminal_wait_id'):
        return False
    actor = Actor.model_validate(run['_actor'])
    authority(ctx, store, actor, run, running=True)
    session_id = run['terminal_wait_id']
    terminal_jobs.refresh(ctx, actor, run['work_id'], session_id)
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = lookup(store, run_id)
            if run['status'] != 'waiting_external' or run.get('terminal_wait_id') != session_id:
                return False
            proposal = _owned(store, run, session_id)
            call = agent_native.pending(run)
            if call is None or call.name != 'terminal_wait' or call.arguments.get('session_id') != session_id:
                raise ConflictError('Wait does not match the canonical call')
            if proposal['status'] == 'outcome_unknown':
                done = receipt(proposal, complete=False)
            elif proposal['status'] in FINISHED and proposal.get('logs') is not None:
                done = receipt(proposal, complete=True)
            else:
                return False
            done = agent_native.append_result(run, done)
            run['observations'].append({'tool': call.name, 'arguments': call.arguments,
                                        'message': 'Background session observed', 'result': done})
            if proposal['status'] in FINISHED:
                notices = list(run.get('_terminal_notices') or [])
                if session_id not in notices:
                    notices.append(session_id)
                run['_terminal_notices'] = notices
            run['turns'] += 1
            for key in ('_decision', '_active_call_id', 'terminal_wait_id'):
                run.pop(key, None)
            run['_epoch'] += 1
            run.update(status='queued', _workflow_id=f'agent:{actor.workspace_id}:{run_id}:{run["_epoch"]}')
        ctx.service.store = store
    return True


def _candidates(store, run):
    notices = set(run.get('_terminal_notices') or [])
    waiting = run.get('terminal_wait_id')
    found = []
    for record in store.commands.values():
        proposal = record.result if record.type == terminal_jobs.TYPE else None
        binding = (proposal or {}).get('_agent_binding') or {}
        if proposal is None or binding.get('run_id') != run['id'] or not proposal.get('background'):
            continue
        if not proposal.get('_start_receipt') or proposal['id'] in notices or proposal['id'] == waiting:
            continue
        if proposal['status'] != 'pending_approval':
            found.append(proposal['id'])
    return found


def announce(ctx, run_id):
    """Append one user notice per finished background session. Never restarts it."""
    try:
        run = lookup(ctx.repository.load(), run_id)
    except DomainError:
        return False
    if not agent_native.enabled(run) or agent_native.pending(run) or run['status'] not in {'queued', 'running'}:
        return False
    actor = Actor.model_validate(run['_actor'])
    finished = []
    for session_id in _candidates(ctx.repository.load(), run):
        try:
            current = terminal_jobs.refresh(ctx, actor, run['work_id'], session_id)
        except DomainError:
            continue
        if current['status'] in FINISHED:
            finished.append(current['id'])
    if not finished:
        return False
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = lookup(store, run_id)
            if agent_native.pending(run) or run['status'] not in {'queued', 'running'}:
                return False
            notices = list(run.get('_terminal_notices') or [])
            changed = False
            for session_id in finished:
                if session_id in notices or session_id == run.get('terminal_wait_id'):
                    continue
                proposal = store.commands[session_id].result
                if proposal['status'] not in FINISHED:
                    continue
                text = (f"Background session {proposal['id']} finished with status {proposal['status']} "
                        f"and exit code {proposal.get('exit_code')}.")
                run['_messages'].append(NativeMessage(role='user', content=text).model_dump())
                notices.append(session_id)
                changed = True
            if not changed:
                return False
            run['_terminal_notices'] = notices
        ctx.service.store = store
    return True


def _write_view(session_id, intent):
    body = {'job_id': session_id, 'background': True, 'stdin': True, 'bytes': intent.get('bytes', 0)}
    if intent['status'] == 'applied':
        body.update(status='applied', complete=True, is_error=False)
    elif intent['status'] == 'not_sent':
        body.update(status='not_sent', complete=False, is_error=True, error=intent.get('error', 'Stdin was not sent'))
    else:
        body.update(status='outcome_unknown', complete=False, is_error=True,
                    error='Stdin delivery could not be confirmed; it will not be sent again')
    return body


def _begin_write(ctx, run, session_id, call_id, payload):
    digest = hashlib.sha256(payload).hexdigest()
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, run['id'])
            authority(ctx, store, Actor.model_validate(current['_actor']), current, running=True)
            proposal = _owned(store, current, session_id)
            writes = proposal.setdefault('_stdin_writes', {})
            intent = writes.get(call_id)
            if intent:
                if intent.get('sha256') != digest:
                    raise ConflictError('Stdin call is already bound to other bytes')
                if intent['status'] == 'sending':
                    intent['status'] = 'unknown'
                return _write_view(session_id, intent)
            writes[call_id] = {'status': 'sending', 'sha256': digest, 'bytes': len(payload)}
        ctx.service.store = store
    return None


def _settle_write(ctx, run, session_id, call_id, status, error=None):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            proposal = _owned(store, lookup(store, run['id']), session_id)
            intent = proposal['_stdin_writes'][call_id]
            if intent['status'] == 'applied':
                return _write_view(session_id, intent)
            intent['status'] = status
            if error:
                intent['error'] = error
            view = _write_view(session_id, intent)
        ctx.service.store = store
    return view


def write_stdin(ctx, actor, run, arguments):
    """Deliver one stdin payload. A repeated call id never sends those bytes again."""
    data = arguments.get('data') or ''
    payload = (data + ('\n' if arguments.get('newline') else '')).encode()
    if not payload or len(payload) > 8192:
        raise ValidationError('Stdin write needs bytes within the limit')
    session_id = arguments['session_id']
    proposal = _session(ctx, run, session_id)
    if not proposal.get('background') or not proposal.get('stdin'):
        raise ValidationError('This session was not approved to receive stdin')
    call = agent_native.pending(run)
    if call is None or call.name != 'terminal_write' or call.id is None:
        raise ConflictError('Stdin write does not match the canonical call')
    begun = _begin_write(ctx, run, session_id, call.id, payload)
    if begun is not None:
        return begun
    try:
        terminal_jobs.write_payload(ctx, actor, run['work_id'], session_id, payload)
    except StdinNotSent as exc:
        return _settle_write(ctx, run, session_id, call.id, 'not_sent', str(exc))
    except (ExecutionUncertain, ExecutionTimeout, ExecutionUnavailable) as exc:
        return _settle_write(ctx, run, session_id, call.id, 'unknown', str(exc))
    return _settle_write(ctx, run, session_id, call.id, 'applied')
