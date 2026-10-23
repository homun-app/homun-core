"""Start a confirmed work: the engine picks the executor, never the client.

One entry point for every client (UI, front-door `start_work`, golden path):
the executor follows the current plan phase or, without a plan, the confirmed
agreement's capability — synthesis, material read, CSV comparison or the
adaptive agent run. The autonomy mode decides whether the start is immediate
or waits for «Avvia» (`domain.capabilities.starts_without_approval`).
Proposal and approval stay the executors' own (digest, version, provenance):
this module only chooses, defaults the materials and projects one view.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Callable

from homun.domain.capabilities import REGISTRY, starts_without_approval
from homun.domain.errors import ConflictError, NotFoundError, ValidationError
from homun.policy.intake import latest_intake
from homun.policy.work import require_work_access

START_TYPE = 'work.execution_start'
ACTIVE = {'pending_approval', 'queued', 'running', 'waiting_input'}


@dataclass(frozen=True)
class Executor:
    kind: str
    proposal_type: str
    propose: Callable[..., dict]
    approve: Callable[..., dict]


def _executors() -> dict[str, Executor]:
    from homun.application.agent.runs import runs
    from homun.application.work import material_reads, price_comparisons, synthesis
    return {
        'synthesize': Executor('synthesis', synthesis.PROPOSAL_TYPE, synthesis.propose, synthesis.approve),
        'read_material': Executor('material_read', material_reads.PROPOSAL_TYPE,
                                  material_reads.propose, material_reads.approve),
        'compare_csv': Executor('price_comparison', price_comparisons.PROPOSAL_TYPE,
                                price_comparisons.propose, price_comparisons.approve),
        'agent_run': Executor('agent_run', runs.PROPOSAL_TYPE, runs.propose, runs.approve),
    }


def _by_type() -> dict[str, Executor]:
    return {executor.proposal_type: executor for executor in _executors().values()}


# -- choosing ------------------------------------------------------------------

def execution_capability(store, work) -> str:
    """The executable capability the next execution of this work runs.

    The running or next pending plan phase wins (multi-phase agreements); a
    work back in `ready` after «Chiedi correzione» reruns its last phase;
    otherwise the agreement's capability, where `general` means the adaptive
    agent run.
    """
    plan = (store.plans.get(store.plan_key(work.id, work.current_plan_revision))
            if work.current_plan_revision else None)
    if plan is not None and plan.steps:
        step = (next((s for s in plan.steps if s.status == 'running'), None)
                or next((s for s in plan.steps if s.status == 'pending'), None)
                or (plan.steps[-1] if work.status == 'ready' else None))
        if step is not None and step.capability in _executors():
            return step.capability
    agreement = latest_intake(store, work.id)
    capability = (agreement or {}).get('capability') or 'general'
    return capability if capability in _executors() else 'agent_run'


def _readable(material) -> bool:
    return material.status == 'active' and (
        material.extract_status == 'extracted' or (material.kind == 'note' and bool(material.text)))


def _is_csv(material) -> bool:
    name = (material.origin_name or material.title or '').lower()
    return (material.mime_type or '').lower() in {'text/csv', 'application/csv'} or name.endswith('.csv')


def default_materials(store, work, capability) -> list[str]:
    """The work's project materials an execution reads when none are chosen."""
    if not work.project_id:
        return []
    pool = sorted((m for m in store.materials.values()
                   if m.project_id == work.project_id and _readable(m)), key=lambda m: m.created_at)
    if capability == 'compare_csv':
        pool = [m for m in pool if _is_csv(m)]
    limit = int(REGISTRY[capability].limits.get('max_materials') or len(pool) or 1)
    return [m.id for m in pool][:limit]


def _executor_body(capability, command_id, version, material_ids, language) -> dict[str, Any]:
    if capability == 'synthesize':
        return {'command_id': command_id, 'expected_version': version, 'material_ids': material_ids,
                'skill_ids': [], 'language': language}
    if capability == 'read_material':
        if len(material_ids) != 1:
            raise ValidationError('Choose the one material to read', reason='work.start.materials_required')
        return {'command_id': command_id, 'expected_version': version, 'material_id': material_ids[0]}
    if capability == 'compare_csv':
        if len(material_ids) != 2:
            raise ValidationError('Choose the two CSV materials to compare',
                                  reason='work.start.materials_required')
        return {'command_id': command_id, 'expected_version': version,
                'left_material_id': material_ids[0], 'right_material_id': material_ids[1]}
    from homun.application.sessions.run_request import RunRequest
    return RunRequest(command_id=command_id, expected_version=version,
                      material_ids=material_ids).model_dump()


# -- views -----------------------------------------------------------------------

def _material_ids(result) -> list[str]:
    if result.get('materials'):
        return [m['id'] for m in result['materials']]
    if result.get('material'):
        return [result['material']['id']]
    return [m['id'] for m in (result.get('left'), result.get('right')) if isinstance(m, dict) and m.get('id')]


def _view(executor: Executor, result: dict, *, auto_started: bool | None = None) -> dict[str, Any]:
    view = {
        'id': result['id'], 'kind': executor.kind, 'status': result['status'],
        'digest': result.get('digest'), 'expected_version': result.get('expected_version'),
        'error_code': result.get('error_code'), 'material_ids': _material_ids(result),
    }
    if auto_started is not None:
        view['auto_started'] = auto_started
    return view


def _executions(store, work_id) -> list[tuple[Executor, dict, Any]]:
    by_type = _by_type()
    return sorted(((by_type[r.type], r.result, r.created_at) for r in store.commands.values()
                   if r.type in by_type and r.result.get('work_id') == work_id),
                  key=lambda item: item[2])


def _active(store, work_id):
    return next(((executor, result) for executor, result, _ in reversed(_executions(store, work_id))
                 if result['status'] in ACTIVE and result.get('expected_version') is not None), None)


def _artifact(store, work_id) -> dict[str, Any] | None:
    latest = max((a for a in store.artifacts.values() if a.work_id == work_id),
                 key=lambda a: a.version, default=None)
    if latest is None:
        return None
    return {'id': latest.id, 'version': latest.version, 'title': latest.title, 'content': latest.content}


def current(ctx, actor, work_id) -> dict[str, Any]:
    """What the chat shows about this work's execution, from the engine alone."""
    store = ctx.repository.load()
    work = require_work_access(store, actor, work_id, 'read')
    agreement = latest_intake(store, work_id)
    executions = _executions(store, work_id)
    latest = executions[-1] if executions else None
    base = {
        'work_id': work_id, 'work_status': str(getattr(work.status, 'value', work.status)),
        'work_version': work.version,
        'agreement_status': (agreement or {}).get('status'),
        'artifact': _artifact(store, work_id),
    }
    if latest is None:
        return {**base, 'id': None, 'kind': None, 'status': 'not_started', 'digest': None,
                'expected_version': None, 'error_code': None, 'material_ids': []}
    executor, result, _ = latest
    return {**base, **_view(executor, result)}


STATE_WORDS = {
    'pending_approval': 'in attesa del via libera della persona (card «Avvia»)',
    'queued': 'in coda', 'running': 'in corso',
    'waiting_input': 'in attesa di una risposta della persona',
    'completed': 'completata', 'failed': 'non riuscita', 'blocked': 'non riuscita',
    'cancelled': 'annullata',
}


def execution_line(store, work) -> str | None:
    """One context line on the real execution state of a confirmed work."""
    agreement = latest_intake(store, work.id)
    if not agreement or agreement.get('status') != 'confirmed':
        return None
    executions = _executions(store, work.id)
    if not executions:
        return ('Esecuzione: non avviata — se la persona chiede di procedere, chiama start_work.')
    executor, result, _ = executions[-1]
    status = result['status']
    line = f"Esecuzione: {STATE_WORDS.get(status, status)} ({executor.kind})"
    artifact = _artifact(store, work.id)
    work_status = str(getattr(work.status, 'value', work.status))
    if status == 'completed' and artifact:
        line += f" — risultato v{artifact['version']} " + (
            'approvato' if work_status == 'completed' else 'in revisione della persona')
    if status in {'failed', 'blocked'} and result.get('error_code'):
        line += f" — {result['error_code']}"
    return line


def start_blocker(store, work) -> str | None:
    """Why `start_work` must not run now, worded for the model; None if it may."""
    if work is None:
        return 'No work is linked to this conversation: reply with text or use propose_work.'
    agreement = latest_intake(store, work.id)
    if not agreement or agreement.get('status') != 'confirmed':
        return ('The agreement is not confirmed yet: the person confirms it from the card. '
                'Reply with text; never say the work has started.')
    active = _active(store, work.id)
    if active:
        return (f"This work already has an execution {active[1]['status']}: do not start it again. "
                'Reply with text describing that state.')
    if str(getattr(work.status, 'value', work.status)) in {'review', 'completed', 'cancelled'}:
        return ('This work has a result already (review or done): reply with text; a correction is '
                'requested from the result card.')
    return None


# -- commands --------------------------------------------------------------------

def start(ctx, actor, work_id, body) -> dict[str, Any]:
    """Propose the execution the engine chooses and, when the mode allows, approve it."""
    from homun.application.work.price_comparisons import cached, save
    mode = str(body.get('mode') or 'guarded')
    command_id = str(body['command_id'])
    with ctx.repository.locked():
        store = ctx.repository.load()
        work = require_work_access(store, actor, work_id)
        agreement = latest_intake(store, work_id)
        if not agreement or agreement.get('status') != 'confirmed':
            raise ConflictError('Confirm the work agreement before starting it',
                                reason='work.start.agreement_required')
        capability = execution_capability(store, work)
        auto = starts_without_approval(capability, mode)
        executor = _executors()[capability]
        record, _ = cached(store, actor, command_id, START_TYPE, {'work_id': work_id, 'mode': mode})
        if record:
            done = next(r for r in store.commands.values() if r.command_id == record.result['execution_id'])
            return _view(_by_type()[done.type], done.result, auto_started=record.result['auto_started'])
        active = _active(store, work_id)
        if active:
            return _view(active[0], active[1], auto_started=active[1]['status'] != 'pending_approval')
        material_ids = list(dict.fromkeys(body.get('material_ids') or []))
        if not material_ids:
            material_ids = default_materials(store, work, capability)
        proposal_body = _executor_body(capability, f'{command_id}:propose', work.version,
                                       material_ids, body.get('language'))
    proposal = executor.propose(ctx, actor, work_id, proposal_body)
    if auto and proposal['status'] == 'pending_approval':
        proposal = executor.approve(ctx, actor, work_id, proposal['id'], {
            'command_id': f'{command_id}:approve', 'digest': proposal['digest'],
            'expected_version': proposal['expected_version']})
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            _, fingerprint = cached(store, actor, command_id, START_TYPE, {'work_id': work_id, 'mode': mode})
            save(store, actor, command_id, START_TYPE, fingerprint,
                 {'work_id': work_id, 'execution_id': proposal['id'], 'auto_started': auto})
        ctx.service.store = store
    return _view(executor, proposal, auto_started=auto)


def approve(ctx, actor, work_id, execution_id, body) -> dict[str, Any]:
    """«Avvia» on a pending execution, whatever executor the engine chose."""
    store = ctx.repository.load()
    require_work_access(store, actor, work_id)
    record = store.commands.get(execution_id)
    executor = _by_type().get(record.type) if record else None
    if executor is None or record.result.get('work_id') != work_id:
        raise NotFoundError('Execution not found', reason='work.start.execution_not_found')
    result = executor.approve(ctx, actor, work_id, execution_id, {
        'command_id': body['command_id'], 'digest': body['digest'],
        'expected_version': body['expected_version']})
    return _view(executor, deepcopy(result), auto_started=False)
