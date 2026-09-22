"""Transactional read proposals and explicit approval; execution is elsewhere."""
import hashlib
import json
from copy import deepcopy

from homun.application.price_comparisons import cached, save
from homun.domain.capabilities import READ_MATERIAL
from homun.domain.errors import (ConflictError, DomainError, NotFoundError,
                                 PermissionDeniedError, ValidationError)
from homun.materials.source import verify_material
from homun.policy import require_project_capability
from homun.policy.intake import require_confirmed_intake
from homun.policy.work import require_work_access

PROPOSAL_TYPE = 'material_read.propose'
ACTIVE = {'pending_approval', 'queued', 'running'}


def public(proposal):
    return {key: value for key, value in proposal.items() if not key.startswith('_')}


def lookup(store, proposal_id, work_id):
    record = store.commands.get(proposal_id)
    if not record or record.type != PROPOSAL_TYPE or record.result['work_id'] != work_id:
        raise NotFoundError('Read proposal not found')
    return record.result


def authority(store, actor, proposal, *, approval=False, needed='write'):
    work = require_work_access(store, actor, proposal['work_id'], needed)
    material = store.materials.get(proposal['material']['id'])
    if not material:
        raise NotFoundError('Read material not found')
    require_project_capability(store, actor, material.project_id, 'read')
    if approval:
        # Same delegation boundary as the comparison: a delegated agent owner
        # never approves the execution of a concrete action.
        if actor.kind != 'person':
            raise PermissionDeniedError('Only a person may approve the execution of a concrete action')
        if actor.id not in {work.owner_id, work.reviewer_id}:
            raise PermissionDeniedError('Only the current work owner or reviewer may approve')
    return work


def digest(proposal):
    bound = {key: proposal[key] for key in ('id', 'work_id', 'expected_version', 'tool_version', 'material', 'limits')}
    bound['action'] = 'read_material_and_submit_extract'
    return hashlib.sha256(json.dumps(bound, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _source(ctx, store, actor, material_id):
    return verify_material(ctx, store, actor, material_id,
                           max_bytes=READ_MATERIAL.limits['max_bytes_per_material'])


def propose(ctx, actor, work_id, body):
    payload = {**body, 'work_id': work_id}
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work = require_work_access(store, actor, work_id)
            from homun.application.phase_execution import (
                propose_pin_version, require_confirmed_intake_for_tool,
            )
            require_confirmed_intake_for_tool(store, work_id, capability='read_material')
            material, _ = _source(ctx, store, actor, body['material_id'])
            if store.materials[material['id']].extract_status not in {'extracted', 'none'}:
                raise ValidationError('Material has no readable text extract')
            record, fingerprint = cached(store, actor, body['command_id'], PROPOSAL_TYPE, payload)
            if record:
                authority(store, actor, record.result)
                return deepcopy(public(record.result))
            for existing in store.commands.values():
                prior = existing.result
                if existing.type != PROPOSAL_TYPE or prior['work_id'] != work_id or prior['status'] not in ACTIVE:
                    continue
                stale = work.version != prior['expected_version']
                if not stale:
                    try:
                        _source(ctx, store, actor, prior['material']['id'])
                    except DomainError:
                        stale = True
                if not stale:
                    raise ConflictError('This work already has an active material read')
                prior.update(status='blocked', error_code='read_proposal_obsolete')
            service = ctx.service.for_store(store)
            pinned = propose_pin_version(
                service, store, actor, work, 'read_material', body['command_id'], body['expected_version'],
                {'title': 'Leggi il materiale autorizzato', 'assignee_id': work.owner_id,
                 'output_expected': 'Artifact di lettura con estratto e provenienza'},
            )
            proposal = {
                'id': body['command_id'], 'status': 'pending_approval', 'work_id': work_id,
                'expected_version': pinned, 'tool_version': READ_MATERIAL.tool_version,
                'material': material,
                'limits': {'max_extract_characters': READ_MATERIAL.limits['max_extract_characters'],
                           'max_attempts': READ_MATERIAL.limits['max_attempts']},
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
            record, fingerprint = cached(store, actor, body['command_id'], 'material_read.approve', payload)
            if body['digest'] != proposal['digest'] or body['expected_version'] != proposal['expected_version']:
                raise ConflictError('Approval does not match the proposed action and revision')
            current, _ = _source(ctx, store, actor, proposal['material']['id'])
            if current != proposal['material']:
                raise ConflictError('Read source changed; create a new proposal')
            if record:
                return deepcopy(public(proposal))
            if proposal['status'] != 'pending_approval':
                raise ConflictError('Read already approved or closed')
            if work.version != proposal['expected_version']:
                raise ConflictError('Work changed; create a new proposal')
            service = ctx.service.for_store(store)
            from homun.application.phase_execution import approve_starts_phase
            approve_starts_phase(service, store, actor, work, 'read_material', body['command_id'])
            proposal.update(status='queued', _actor=actor.model_dump(mode='json'),
                            _run_version=work.version, _workflow_id=f"read:{actor.workspace_id}:{proposal_id}")
            save(store, actor, body['command_id'], 'material_read.approve', fingerprint, {'proposal_id': proposal_id})
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
