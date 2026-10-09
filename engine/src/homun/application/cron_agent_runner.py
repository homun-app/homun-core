"""Idempotently stage supervised canonical agent proposals for cron occurrences."""
from __future__ import annotations

from homun.application.cron_contracts import CronExecutionResult
from homun.domain.errors import DomainError
from homun.domain.models import Actor

CRON_PROJECT_NAME = "Cron jobs"


def _active_cron_project_id(ctx) -> str | None:
    """Reuse the shared Cron jobs project; active names are workspace-unique."""
    needle = CRON_PROJECT_NAME.casefold()
    for project in ctx.repository.load().projects.values():
        if project.status == "archived":
            continue
        if (project.name or "").strip().casefold() == needle:
            return project.id
    return None


class CronAgentRunner:
    recovery_safe = True

    def __call__(self, payload):
        ctx = payload.get('ctx')
        if ctx is None or not isinstance(ctx.workspace_id, str):
            return CronExecutionResult('failed', output='Cron agent runner requires EngineContext', error='backend_unavailable', exit_code=-1)
        occurrence_id = payload.get('occurrence_id')
        if not occurrence_id:
            return CronExecutionResult('failed', error='cron_occurrence_required', exit_code=-1)
        actor_data = payload.get('actor') or payload.get('owner_actor')
        if not actor_data:
            return CronExecutionResult('failed', error='cron_actor_required', exit_code=-1)
        try:
            actor = actor_data if isinstance(actor_data, Actor) else Actor.model_validate(actor_data)
        except (ValueError, TypeError):
            return CronExecutionResult('failed', error='cron_actor_invalid', exit_code=-1)
        if actor.workspace_id != ctx.workspace_id:
            return CronExecutionResult('failed', error='cron_actor_workspace_mismatch', exit_code=-1)
        if actor.kind != 'person':
            return CronExecutionResult('failed', error='cron_actor_invalid', exit_code=-1)
        if payload.get('source_work_id'):
            from homun.policy.work import require_work_access
            try:
                require_work_access(ctx.repository.load(), actor, payload['source_work_id'], 'write')
            except DomainError as exc:
                return CronExecutionResult('failed', error=exc.code, exit_code=-1)
        prefix = f'cron:{occurrence_id}'
        run_id = prefix + ':proposal'
        prior = ctx.repository.load().commands.get(run_id)
        if prior:
            return CronExecutionResult('awaiting_approval', agent_run_id=run_id,
                                       work_id=prior.result['work_id'])
        prompt = str(payload.get('prompt') or '').strip()
        if not prompt:
            return CronExecutionResult('failed', error='validation_error', exit_code=-1)
        # These restrictions cannot yet be bound into canonical proposal authority.
        if payload.get('workdir') or payload.get('skills'):
            return CronExecutionResult('failed', error='cron_capability_unavailable', exit_code=-1)
        body = {'command_id': run_id, 'material_ids': []}
        if payload.get('model_pin') or payload.get('provider_pin'):
            connections = [c for c in ctx.models.list_connections() if c.active
                and (not payload.get('model_pin') or c.model_id == payload['model_pin'])
                and (not payload.get('provider_pin') or payload['provider_pin'] in {
                    c.kind, c.pydantic_provider})]
            if not connections:
                return CronExecutionResult('failed', error='cron_model_binding_unavailable', exit_code=-1)
            body['connection_id'] = connections[0].id
        from homun.application.agent_runs import propose
        try:
            # Each creation commits independently. Replay reuses the exact command
            # fingerprint, including after a crash before the proposal exists.
            def apply(suffix, kind, arguments):
                with ctx.repository.locked():
                    with ctx.repository.transaction() as store:
                        service = ctx.service.for_store(store)
                        result = service.apply(actor, prefix + suffix, kind, arguments)
                    ctx.service.store = store
                return result

            project_id = _active_cron_project_id(ctx)
            if project_id is None:
                try:
                    project = apply(':project', 'project.create', {'name': CRON_PROJECT_NAME})
                    project_id = project['project_id']
                except DomainError as exc:
                    # Race: another occurrence created the shared project first.
                    if exc.code != 'validation_error':
                        raise
                    project_id = _active_cron_project_id(ctx)
                    if project_id is None:
                        raise
            conversation = apply(':conversation', 'conversation.create', {
                'title': f'Cron {payload.get("job_id")}', 'project_id': project_id})
            work = apply(':work', 'work.create', {'conversation_id': conversation['conversation_id'],
                'title': prompt[:80], 'objective': prompt})
            work_id = work['work_id']
            body['expected_version'] = ctx.repository.load().works[work_id].version
            proposal = propose(ctx, actor, work_id, body)
            if payload.get('auto_approve'):
                from homun.application import agent_runs
                try:
                    agent_runs.approve(ctx, actor, work_id, proposal['id'], {
                        'command_id': run_id + ':auto',
                        'expected_version': proposal['expected_version'],
                        'digest': proposal['digest'],
                    })
                    with ctx.repository.locked():
                        with ctx.repository.transaction() as store:
                            store.commands[proposal['id']].result['_approval_channel'] = 'policy:cron-auto-approve'
                        ctx.service.store = store
                    return CronExecutionResult('running',
                        output=f'Auto-approved agent run {proposal["id"]} (job policy)',
                        agent_run_id=proposal['id'], work_id=work_id)
                except DomainError:
                    pass  # the staged proposal keeps the human gate
            return CronExecutionResult('awaiting_approval',
                output=f'Staged agent run {proposal["id"]} (pending approval)',
                agent_run_id=proposal['id'], work_id=work_id)
        except DomainError as exc:
            return CronExecutionResult('failed', error=exc.code, exit_code=-1)


def make_cron_runner(ctx, actor=None):
    base = CronAgentRunner()
    def bound(payload):
        merged = {**payload, 'ctx': ctx}
        if actor is not None:
            merged['actor'] = actor
        return base(merged)
    bound.recovery_safe = True
    return bound
