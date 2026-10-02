"""Reconcile expired owned jobs, including cancelled/revoked agent work.

Only releases an already approved resource; never dispatches a command. Deadlines
are checked while the engine runs, including after restart, not by Docker itself.
"""
from copy import deepcopy
from datetime import datetime
from homun.application import terminal_jobs
from homun.application.terminal_contracts import consent, job_spec
from homun.application.terminal_state import record
from homun.domain.errors import DomainError, ConflictError
from homun.domain.models import utc_now


def _due(proposal,now):
    if (not proposal.get('_approved_at') or not proposal.get('deadline_at')
            or proposal['status'] in {'pending_approval','exited','dead'}):return False
    try:return datetime.fromisoformat(proposal['deadline_at'])<=now
    except (ValueError,TypeError):return False


def reconcile(ctx,*,now=None,limit=4):
    now=now or utc_now()
    candidates=[r.result for r in ctx.repository.snapshot().commands.values()
                if r.type==terminal_jobs.TYPE and _due(r.result,now)]
    candidates.sort(key=lambda p:(p.get('_watchdog_checked_at',''),p['id']))
    for candidate in candidates[:limit]:
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                p=store.commands[candidate['id']].result
                if not _due(p,now):continue
                p['_watchdog_checked_at']=now.isoformat()
                p['_io_epoch']=p.get('_io_epoch',0)+1
                snapshot=deepcopy(p)
            ctx.service.store=store
        try:
            if consent(snapshot)!=snapshot['digest']:
                raise ConflictError('Terminal consent changed')
            backend=terminal_jobs.backend_for(ctx, snapshot);spec=job_spec(ctx,snapshot)
            state=backend.inspect(spec)
            if state['status'] not in {'exited','dead'} and not snapshot.get('_local_deadline_supervised'):
                # Persist the stop reason before IO, even if stop times out/crashes.
                with ctx.repository.locked():
                    with ctx.repository.transaction() as store:
                        current=store.commands[snapshot['id']].result
                        if current.get('_io_epoch')!=snapshot['_io_epoch'] or not _due(current,now):continue
                        current['timed_out']=True
                    ctx.service.store=store
                state=backend.stop(spec)
            try:state['logs']=backend.logs(spec)
            except terminal_jobs.TRANSPORT_ERRORS:
                state.update(logs=None,error_code='execution_logs_unavailable',error='Log non disponibili; aggiorna per riprovare.')
        except (DomainError,OSError) as exc:
            state=dict(status='outcome_unknown',running=None,exit_code=None,logs=None,
                error_code=getattr(exc,'code','execution_unavailable'),
                error='Arresto alla scadenza non verificato; Homun riproverà a controllare il processo.')
        record(ctx,snapshot['id'],snapshot,state)
