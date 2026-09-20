"""Transactional proposal admission and explicit approval; no execution here."""
from copy import deepcopy
from homun.application.price_comparison_policy import (
    ACTIVE, PROPOSAL_TYPE, authority, digest, lookup, public, source, validate_sources,
)
from homun.domain.capabilities import COMPARE_CSV
from homun.domain.command_identity import request_fingerprint
from homun.domain.errors import ConflictError, DomainError, ValidationError
from homun.domain.models import CommandRecord
from homun.domain.states import WorkStatus
from homun.policy.work import require_work_access


def cached(store, actor, command_id, kind, payload):
    record = store.commands.get(command_id)
    fingerprint = request_fingerprint(actor, kind, payload)
    if record and record.request_fingerprint != fingerprint:
        raise ConflictError('Command ID already used for a different request')
    return record, fingerprint


def save(store, actor, command_id, kind, fingerprint, result):
    store.commands[command_id] = CommandRecord(
        command_id=command_id, type=kind, actor_id=actor.id, workspace_id=actor.workspace_id,
        request_fingerprint=fingerprint, result=result,
    )


def propose(ctx, actor, work_id, body):
    payload = {**body, 'work_id': work_id}
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work = require_work_access(store, actor, work_id)
            from homun.policy.intake import require_confirmed_intake
            require_confirmed_intake(store, work_id, capability="compare_csv")
            left, _ = source(ctx, store, actor, body['left_material_id'])
            right, _ = source(ctx, store, actor, body['right_material_id'])
            record, fingerprint = cached(store, actor, body['command_id'], PROPOSAL_TYPE, payload)
            if record:
                authority(store, actor, record.result)
                return deepcopy(public(record.result))
            if left['id'] == right['id']:
                raise ValidationError('Select two different materials')
            max_rows = body.get('max_rows', COMPARE_CSV.limits['max_rows'])
            if isinstance(max_rows, bool) or not isinstance(max_rows, int) or not 1 <= max_rows <= COMPARE_CSV.limits['max_rows']:
                raise ValidationError('max_rows must be between 1 and 10000')
            for existing in store.commands.values():
                prior = existing.result
                if existing.type != PROPOSAL_TYPE or prior['work_id'] != work_id or prior['status'] not in ACTIVE:
                    continue
                stale = False
                if prior['status'] == 'pending_approval':
                    stale = work.version != prior['expected_version']
                    if not stale:
                        try:
                            validate_sources(ctx, store, actor, prior)
                        except DomainError:
                            stale = True
                if not stale:
                    raise ConflictError('This work already has an active comparison')
                prior.update(status='blocked', error_code='comparison_proposal_obsolete')
            service = ctx.service.for_store(store)
            expected_version = body['expected_version']
            if work.status == WorkStatus.FAILED and any(
                r.type == PROPOSAL_TYPE and r.result['work_id'] == work_id
                and r.result.get('_run_version') == work.version - 1
                and r.result['status'] in {'failed', 'blocked'} for r in store.commands.values()
            ):
                service.apply(actor, f"{body['command_id']}:retry", 'plan.accept', {
                    'work_id': work_id, 'expected_version': expected_version})
                expected_version = work.version
            plan = service.apply(actor, f"{body['command_id']}:plan", 'plan.propose', {
                'work_id': work_id, 'expected_version': expected_version,
                'steps': [{'title': 'Confronta i due CSV prezzi', 'assignee_id': work.owner_id,
                           'output_expected': 'Report Markdown e CSV da sottoporre a revisione'}],
            })
            proposal = {
                'id': body['command_id'], 'status': 'pending_approval', 'work_id': work_id,
                'expected_version': plan['version'], 'tool_version': COMPARE_CSV.tool_version,
                'left': left, 'right': right,
                'limits': {'max_rows': max_rows, 'max_attempts': COMPARE_CSV.limits['max_attempts']},
                '_attempts': 0,
            }
            proposal['digest'] = digest(proposal)
            save(store, actor, body['command_id'], PROPOSAL_TYPE, fingerprint, proposal)
        ctx.service.store = store
    return deepcopy(public(proposal))


def approve(ctx, actor, work_id, proposal_id, body):
    payload = {**body, 'work_id': work_id, 'proposal_id': proposal_id}
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            proposal = lookup(store, proposal_id, work_id)
            work = authority(store, actor, proposal, approval=True)
            record, fingerprint = cached(store, actor, body['command_id'], 'price_comparison.approve', payload)
            if body['digest'] != proposal['digest'] or body['expected_version'] != proposal['expected_version']:
                raise ConflictError('Approval does not match the proposed action and revision')
            validate_sources(ctx, store, actor, proposal)
            if record:
                return deepcopy(public(proposal))
            if proposal['status'] != 'pending_approval':
                raise ConflictError('Comparison already approved or closed')
            if work.version != proposal['expected_version']:
                raise ConflictError('Work changed; create a new proposal')
            service = ctx.service.for_store(store)
            service.apply(actor, f"{body['command_id']}:accept", 'plan.accept', {
                'work_id': work_id, 'expected_version': work.version})
            service.apply(actor, f"{body['command_id']}:start", 'work.start', {
                'work_id': work_id, 'expected_version': work.version, 'durable': False})
            proposal.update(status='queued', _actor=actor.model_dump(mode='json'),
                            _run_version=work.version, _workflow_id=f"price:{actor.workspace_id}:{proposal_id}")
            save(store, actor, body['command_id'], 'price_comparison.approve', fingerprint, {'proposal_id': proposal_id})
        ctx.service.store = store
    return deepcopy(public(proposal))


def list_proposals(ctx, actor, work_id):
    store = ctx.repository.load()
    require_work_access(store, actor, work_id, 'read')
    items = []
    for record in store.commands.values():
        if record.type == PROPOSAL_TYPE and record.result['work_id'] == work_id:
            authority(store, actor, record.result, needed='read')
            items.append(deepcopy(public(record.result)))
    return {'items': items}
