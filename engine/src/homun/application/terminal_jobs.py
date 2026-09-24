"""Human-approved native jobs, with durable dispatch and inspect-only recovery."""
from copy import deepcopy
from datetime import timedelta
from pydantic import ValidationError as SchemaError
from homun.application.terminal_contracts import TerminalProposalRequest, consent, job_spec, public
from homun.domain.errors import ConflictError, NotFoundError, PermissionDeniedError, ValidationError
from homun.domain.models import CommandRecord, utc_now
from homun.execution.contracts import ExecutionTimeout, ExecutionUnavailable, ExecutionUncertain
from homun.execution.docker import DockerJobs
from homun.execution.local_jobs import LocalJobs
from homun.execution.ssh_jobs import SshJobs, key_fingerprint
from homun.execution.pty_queries import PtyQueryResponder, unread
from homun.policy.work import require_work_access

TYPE = 'terminal.job'
TRANSPORT_ERRORS = (ExecutionTimeout, ExecutionUnavailable, ExecutionUncertain)


def backend_for(ctx, proposal=None):
    # Resolve the trusted context root (macOS temp roots can contain /var aliases),
    # not any caller-supplied workspace or mount path.
    root = ctx.data_dir.resolve() / 'execution'
    if (proposal or {}).get('policy') == 'local-private-v1':
        return LocalJobs(root)
    if (proposal or {}).get('policy') == 'ssh-v1':
        return SshJobs(root)
    return DockerJobs(root)


def _lookup(store, actor, work_id, proposal_id, *, write=False):
    work = require_work_access(store, actor, work_id, 'write' if write else 'read')
    record = store.commands.get(proposal_id)
    if record is None or record.type != TYPE or record.result['work_id'] != work_id:
        raise NotFoundError('Terminal proposal not found for this work')
    return work, record.result


def _human_owner(actor, work):
    if actor.kind != 'person' or actor.id not in {work.owner_id, work.reviewer_id}:
        raise PermissionDeniedError('Only the owner or reviewer may control terminal execution')


def propose(ctx, actor, work_id, body, *, agent_binding=None, ssh_key_path=None):
    try:
        request = TerminalProposalRequest.model_validate(body)
        if request.policy == 'ssh-v1':
            if request.image or request.stdin or request.pty:
                raise ValidationError('An SSH command has no image, stdin, or terminal')
            if not request.ssh_host or not request.ssh_user or not request.ssh_port or not request.ssh_host_key:
                raise ValidationError('SSH target is incomplete')
            if not ssh_key_path:
                raise ValidationError('SSH requires a private key')
            fingerprint = key_fingerprint(ssh_key_path)
        elif request.policy == 'local-private-v1':
            if request.image or request.stdin or request.pty:
                raise ValidationError('A local command has no image, stdin, or terminal')
        elif not request.image:
            raise ValidationError('Terminal image must be a pinned SHA256')
        result = dict(id=request.command_id,work_id=work_id,command=request.command,
                      expected_version=request.expected_version,timeout_seconds=request.timeout_seconds,policy=request.policy,created_by=actor.id,
                      created_at=utc_now().isoformat(),status='pending_approval')
        if request.image:result['image']=request.image
        if request.background:result['background']=True
        if request.stdin:result['stdin']=True
        if request.pty:result['pty']=True
        if request.policy == 'ssh-v1':
            result.update(ssh_host=request.ssh_host, ssh_user=request.ssh_user, ssh_port=request.ssh_port,
                          ssh_host_key=request.ssh_host_key, ssh_key_fingerprint=fingerprint, _ssh_key_path=ssh_key_path)
        job_spec(ctx,result)
    except SchemaError:
        raise ValidationError('Invalid terminal proposal') from None
    if agent_binding:
        result['_agent_binding']=deepcopy(agent_binding)
        result['agent_run_id']=agent_binding['run_id']
    result['digest'] = consent(result)
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work = require_work_access(store,actor,work_id)
            prior = store.commands.get(request.command_id)
            if prior:
                replay=deepcopy(result)
                if 'timeout_seconds' not in prior.result and 'timeout_seconds' not in body:
                    replay.pop('timeout_seconds',None)
                if prior.type != TYPE or prior.result.get('digest') != consent(replay):
                    raise ConflictError('Command id is already bound to another request')
                return deepcopy(public(prior.result))
            if work.archived or work.version != request.expected_version:
                raise ConflictError('Work changed or is archived; create a current proposal')
            if agent_binding:
                from homun.application.agent_terminal_link import validate_link
                run=validate_link(ctx,store,actor,result,staging=True)
                run.update(status='waiting_external',terminal_request_id=result['id'])
                for key in ('_lease_token','_lease_until','_active_call_id'):run.pop(key,None)
            store.commands[request.command_id] = CommandRecord(command_id=request.command_id,type=TYPE,
                actor_id=actor.id,workspace_id=store.workspace_id,result=result)
        ctx.service.store = store
    return public(result)


def approve(ctx, actor, work_id, proposal_id, body):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work, proposal = _lookup(store,actor,work_id,proposal_id,write=True)
            _human_owner(actor,work)
            if body.get('digest') != proposal['digest']:
                raise ValidationError('Approval does not match the proposed command')
            if consent(proposal) != proposal['digest']:
                raise ConflictError('Proposed command changed')
            if proposal['status'] != 'pending_approval':
                return deepcopy(public(proposal))
            if work.archived or work.version != proposal['expected_version']:
                raise ConflictError('Work changed or is archived; create a new proposal')
            from homun.application.agent_terminal_link import validate_link
            linked=validate_link(ctx,store,actor,proposal)
            if linked is not None:linked['_active_call_id']=proposal['_agent_binding']['call_id']
            if proposal.get('timeout_seconds') is not None:
                proposal['deadline_at']=(utc_now()+timedelta(seconds=proposal['timeout_seconds'])).isoformat()
            proposal.update(status='dispatching',_approved_by=actor.id,_approved_at=utc_now().isoformat(),_io_epoch=1)
            snapshot = deepcopy(proposal)
        ctx.service.store = store
    # Persist the intent before IO. Even a process crash cannot authorize another start.
    try:
        state = backend_for(ctx, snapshot).start(job_spec(ctx,snapshot), **({'stdin': True} if snapshot.get('stdin') or snapshot.get('pty') else {}), **({'pty': True} if snapshot.get('pty') else {}))
    except TRANSPORT_ERRORS as exc:
        state = _unknown(exc)
    return _record(ctx,actor,work_id,proposal_id,snapshot,state)


def _unknown(exc):
    return dict(status='outcome_unknown',running=None,exit_code=None,oom_killed=None,logs=None,error_code=exc.code,
                error='Stato del processo non verificato; aggiorna senza ripetere il comando.')


def _record(ctx, actor, work_id, proposal_id, snapshot, state):
    from homun.application.terminal_state import record
    response=record(ctx,proposal_id,snapshot,state)
    # Revocation during IO must not leak newly obtained logs or execution state.
    require_work_access(ctx.repository.load(),actor,work_id,'read')
    return response


def _observe(ctx, actor, work_id, proposal_id, *, stop=False):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work, proposal = _lookup(store,actor,work_id,proposal_id,write=stop)
            if stop:
                _human_owner(actor,work)
                if proposal['status'] in {'pending_approval','dispatching'}:
                    raise ConflictError('Refresh the started process before stopping it')
            if proposal['status'] == 'pending_approval':
                return deepcopy(public(proposal))
            proposal['_io_epoch'] = proposal.get('_io_epoch',0)+1
            snapshot = deepcopy(proposal)
        ctx.service.store = store
    backend = backend_for(ctx, snapshot)
    spec = job_spec(ctx,snapshot)
    try:
        state = backend.stop(spec) if stop else backend.inspect(spec)
        try:
            state['logs'] = backend.logs(spec)
        except TRANSPORT_ERRORS:
            # Process state remains known even when log retrieval is unavailable.
            state.update(logs=None,error_code='execution_logs_unavailable',error='Log non disponibili; aggiorna per riprovare.')
    except TRANSPORT_ERRORS as exc:
        state = _unknown(exc)
    return _record(ctx,actor,work_id,proposal_id,snapshot,state)


def refresh(ctx, actor, work_id, proposal_id):
    observed = _observe(ctx,actor,work_id,proposal_id)
    _answer_pty(ctx,actor,work_id,proposal_id)
    current = ctx.repository.load().commands.get(proposal_id)
    return public(current.result) if current is not None else observed


def _answer_pty(ctx, actor, work_id, proposal_id):
    """Reply once to each new PTY query. Never starts a container."""
    store = ctx.repository.load()
    record = store.commands.get(proposal_id)
    proposal = record.result if record is not None and record.type == TYPE else None
    if proposal is None or not proposal.get('pty') or proposal['status'] in {'pending_approval', 'dispatching'}:
        return
    try:
        logs = backend_for(ctx, proposal).logs(job_spec(ctx, proposal))
    except TRANSPORT_ERRORS:
        return
    raw = logs.get('text') or ''
    delta = unread(proposal.get('_pty_raw', ''), raw)
    if not delta:
        _restore_pty_text(ctx, proposal_id)
        return
    responder = PtyQueryResponder()
    responder._pending[:] = bytes.fromhex(proposal.get('_pty_pending') or '')
    visible_delta, replies = responder.process(delta.encode())
    if proposal['status'] in {'exited', 'dead'}:
        visible_delta += responder.flush()
    if replies and proposal['status'] not in {'exited', 'dead'}:
        try:
            backend_for(ctx, proposal).write_stdin(job_spec(ctx, proposal), replies)
        except TRANSPORT_ERRORS:
            return
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = store.commands[proposal_id].result
            if current.get('_pty_raw', '') != proposal.get('_pty_raw', ''):
                return
            current['_pty_raw'] = raw
            current['_pty_pending'] = bytes(responder._pending).hex()
            visible = current.get('_pty_visible', '') + visible_delta.decode()
            current['_pty_visible'] = visible
            if isinstance(current.get('logs'), dict):
                current['logs']['text'] = visible
        ctx.service.store = store


def _restore_pty_text(ctx, proposal_id):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = store.commands[proposal_id].result
            visible = current.get('_pty_visible')
            if isinstance(visible, str) and isinstance(current.get('logs'), dict):
                current['logs']['text'] = visible
        ctx.service.store = store


def write_payload(ctx, actor, work_id, proposal_id, payload: bytes):
    """Send bytes to a running owned container. Does not create or start one."""
    store = ctx.repository.load()
    _lookup(store, actor, work_id, proposal_id)
    proposal = store.commands[proposal_id].result
    backend_for(ctx, proposal).write_stdin(job_spec(ctx, proposal), payload)


def stop(ctx, actor, work_id, proposal_id):
    return _observe(ctx,actor,work_id,proposal_id,stop=True)


def list_for_work(ctx, actor, work_id):
    store = ctx.repository.load()
    require_work_access(store,actor,work_id,'read')
    return {'items':[public(record.result) for record in store.commands.values()
                     if record.type == TYPE and record.result['work_id'] == work_id]}
