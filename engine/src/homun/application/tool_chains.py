"""Tool chains: one approval enumerating every effect, durable sequential run.

A chain orchestrates the existing per-tool durable proposals — their digests,
their execution, their artifacts — without a second pipeline. See
docs/architecture/decisions/2026-09-20-tool-chain-design.md.
"""
import hashlib
import json
from copy import deepcopy

from homun.application.material_reads import PROPOSAL_TYPE as READ_TYPE
from homun.application.price_comparisons import PROPOSAL_TYPE as COMPARE_TYPE
from homun.application.price_comparisons import cached, save
from homun.domain.capabilities import READ_MATERIAL, COMPARE_CSV, require_capability
from homun.domain.errors import (ConflictError, NotFoundError, PermissionDeniedError,
                                 ValidationError)
from homun.domain.ids import new_id
from homun.materials.source import verify_material
from homun.policy.intake import require_confirmed_intake
from homun.policy import require_project_capability
from homun.policy.work import require_work_access

PROPOSAL_TYPE = 'tool_chain.propose'
ACTIVE = {'pending_approval', 'queued', 'running'}
_CHAINABLE = {'read_material', 'compare_csv'}


def public(chain):
    return {key: value for key, value in chain.items() if not key.startswith('_')}


def lookup(store, chain_id, work_id):
    record = store.commands.get(chain_id)
    if not record or record.type != PROPOSAL_TYPE or record.result['work_id'] != work_id:
        raise NotFoundError('Tool chain not found')
    return record.result


def _chain_sources(ctx, store, actor, step):
    """Resolve and authorize the material sources of one chain step."""
    if step.get('capability') == 'read_material':
        ids = [str(step.get('material_id', ''))]
    elif step.get('capability') == 'compare_csv':
        ids = [str(step.get('left_material_id', '')), str(step.get('right_material_id', ''))]
    else:
        raise ValidationError(f"Unchainable capability: {step.get('capability')}")
    if len(set(ids)) != len(ids) or not all(ids):
        raise ValidationError('Chain steps need distinct, non-empty material ids')
    bindings = []
    for material_id in ids:
        spec = require_capability(step['capability'])
        binding, _ = verify_material(ctx, store, actor, material_id,
                                     max_bytes=spec.limits['max_bytes_per_material'])
        bindings.append(binding)
    return bindings


def _step_digest(chain):
    bound = {
        'action': 'tool_chain',
        'steps': [
            {'capability': step['capability'], 'tool_version': step['tool_version'],
             'materials': step['materials'], 'proposal_id': step['proposal_id']}
            for step in chain['steps']
        ],
        'work_id': chain['work_id'],
        'expected_version': chain['expected_version'],
    }
    return hashlib.sha256(json.dumps(bound, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def propose(ctx, actor, work_id, body):
    payload = {**body, 'work_id': work_id}
    raw_steps = body.get('steps')
    if not isinstance(raw_steps, list) or not 2 <= len(raw_steps) <= 8:
        raise ValidationError('A chain needs between 2 and 8 steps')
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work = require_work_access(store, actor, work_id)
            record, fingerprint = cached(store, actor, body['command_id'], PROPOSAL_TYPE, payload)
            if record:
                require_work_access(store, actor, work_id, 'read')
                return deepcopy(public(record.result))
            steps = []
            for raw in raw_steps:
                capability = str(raw.get('capability', ''))
                if capability not in _CHAINABLE:
                    raise ValidationError(f'Unchainable capability: {capability}')
                require_confirmed_intake(store, work_id, capability=capability)
                bindings = _chain_sources(ctx, store, actor, raw)
                spec = require_capability(capability)
                steps.append({
                    'id': new_id('step'), 'capability': capability,
                    'tool_version': spec.tool_version, 'materials': bindings,
                    'proposal_id': f"{body['command_id']}:{len(steps)}",
                })
            for existing in store.commands.values():
                prior = existing.result
                if existing.type != PROPOSAL_TYPE or prior['work_id'] != work_id or prior['status'] not in ACTIVE:
                    continue
                if work.version == prior['expected_version']:
                    raise ConflictError('This work already has an active tool chain')
                prior.update(status='blocked', error_code='chain_obsolete')
            chain = {
                'id': body['command_id'], 'status': 'pending_approval', 'work_id': work_id,
                'expected_version': work.version, 'steps': steps, 'error_code': None,
            }
            chain['digest'] = _step_digest(chain)
            save(store, actor, body['command_id'], PROPOSAL_TYPE, fingerprint, chain)
        ctx.service.store = store
    return deepcopy(public(chain))


def approve(ctx, actor, work_id, chain_id, body):
    payload = {**body, 'work_id': work_id, 'chain_id': chain_id}
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            chain = lookup(store, chain_id, work_id)
            work = require_work_access(store, actor, work_id)
            record, fingerprint = cached(store, actor, body['command_id'], 'tool_chain.approve', payload)
            if body['digest'] != chain['digest'] or body['expected_version'] != chain['expected_version']:
                raise ConflictError('Approval does not match the proposed chain and revision')
            if actor.kind != 'person':
                raise PermissionDeniedError('Only a person may approve the execution of a concrete action')
            if actor.id not in {work.owner_id, work.reviewer_id}:
                raise PermissionDeniedError('Only the current work owner or reviewer may approve')
            # Revalidate every source before starting anything.
            for step in chain['steps']:
                for material in step['materials']:
                    current, _ = _verify_step_material(ctx, store, actor, step, material['id'])
                    if current != material:
                        raise ConflictError('A chain source changed; create a new chain')
            if record:
                return deepcopy(public(chain))
            if chain['status'] != 'pending_approval':
                raise ConflictError('Chain already approved or closed')
            if work.version != chain['expected_version']:
                raise ConflictError('Work changed; create a new chain')
            service = ctx.service.for_store(store)
            plan = service.apply(actor, f"{chain_id}:plan", 'plan.propose', {
                'work_id': work_id, 'expected_version': work.version,
                'steps': [{'title': _step_title(step), 'assignee_id': work.owner_id,
                           'output_expected': _step_output(step)} for step in chain['steps']],
            })
            service.apply(actor, f"{chain_id}:accept", 'plan.accept', {
                'work_id': work_id, 'expected_version': plan['version']})
            service.apply(actor, f"{chain_id}:start", 'work.start', {
                'work_id': work_id, 'expected_version': work.version, 'durable': False})
            _create_step_proposals(store, actor, chain, work)
            chain.update(status='queued', _actor=actor.model_dump(mode='json'),
                         _run_version=work.version,
                         _workflow_id=f"chain:{actor.workspace_id}:{chain_id}")
            _stamp_step_proposals(store, chain)
            save(store, actor, body['command_id'], 'tool_chain.approve', fingerprint, {'chain_id': chain_id})
        ctx.service.store = store
    return deepcopy(public(chain))


def _verify_step_material(ctx, store, actor, step, material_id):
    spec = require_capability(step['capability'])
    return verify_material(ctx, store, actor, material_id,
                          max_bytes=spec.limits['max_bytes_per_material'])


def _step_title(step):
    names = ' e '.join(material['title'] for material in step['materials'])
    if step['capability'] == 'read_material':
        return f"Leggi il materiale {names}"
    return f"Confronta {step['materials'][0]['title']} con {step['materials'][1]['title']}"


def _step_output(step):
    if step['capability'] == 'read_material':
        return 'Artifact di lettura con estratto e provenienza'
    return 'Report e CSV delle differenze in revisione'


def _create_step_proposals(store, actor, chain, work):
    """Materialize each step as a queued durable tool proposal, reusing shapes.

    The records are created with placeholder runtime fields; _stamp_step_proposals
    fills actor/run/workflow once the chain itself carries them.
    """
    from homun.application.material_reads import digest as read_digest
    from homun.application.price_comparison_policy import digest as compare_digest
    for index, step in enumerate(chain['steps']):
        if step['capability'] == 'read_material':
            proposal = {
                'id': step['proposal_id'], 'status': 'queued', 'work_id': work.id,
                'expected_version': work.version, 'tool_version': READ_MATERIAL.tool_version,
                'material': step['materials'][0],
                'limits': {'max_extract_characters': READ_MATERIAL.limits['max_extract_characters'],
                           'max_attempts': READ_MATERIAL.limits['max_attempts']},
                '_attempts': 0,
            }
            proposal['digest'] = read_digest(proposal)
            record_type = READ_TYPE
        else:
            proposal = {
                'id': step['proposal_id'], 'status': 'queued', 'work_id': work.id,
                'expected_version': work.version, 'tool_version': COMPARE_CSV.tool_version,
                'left': step['materials'][0], 'right': step['materials'][1],
                'limits': {'max_rows': COMPARE_CSV.limits['max_rows'],
                           'max_attempts': COMPARE_CSV.limits['max_attempts']},
                '_attempts': 0,
            }
            proposal['digest'] = compare_digest(proposal)
            record_type = COMPARE_TYPE
        from homun.domain.command_identity import request_fingerprint
        from homun.domain.models import CommandRecord
        store.commands[step['proposal_id']] = CommandRecord(
            command_id=step['proposal_id'], type=record_type, actor_id=actor.id,
            workspace_id=actor.workspace_id,
            request_fingerprint=request_fingerprint(actor, record_type, {'chain_id': chain['id'], 'step': index}),
            result=proposal)


def _stamp_step_proposals(store, chain):
    """Chain-level runtime identity reaches every step proposal after approval.

    Steps carry `_chain_id`: single-tool delivery skips them — the chain
    workflow is their only dispatcher, each under its own step workflow id.
    """
    for index, step in enumerate(chain['steps']):
        record = store.commands.get(step['proposal_id'])
        if record is None:
            continue
        record.result['_actor'] = chain['_actor']
        record.result['_run_version'] = chain['_run_version']
        record.result['_chain_id'] = chain['id']
        record.result['_workflow_id'] = f"{chain['_workflow_id']}:{index}"


def list_chains(ctx, actor, work_id):
    store = ctx.repository.load()
    require_work_access(store, actor, work_id, 'read')
    items = []
    for record in store.commands.values():
        if record.type == PROPOSAL_TYPE and record.result['work_id'] == work_id:
            items.append(deepcopy(public(record.result)))
    return {'items': items}
