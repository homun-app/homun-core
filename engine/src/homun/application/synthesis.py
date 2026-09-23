"""Supervised model synthesis: the assignee's model writes the phase artifact.

Same contract as the deterministic executions (compare/read): durable
proposal with digest, person-only approval as the phase's go, execution
outside the transaction, artifact via work.submit_artifact in REVIEW.
The difference is declared, never hidden: the executor is the assigned
collaborator's model, on their preferred connection when one is set.
"""
import hashlib
import json
from copy import deepcopy

from homun.application.price_comparisons import cached, save
from homun.domain.capabilities import SYNTHESIZE
from homun.domain.errors import (ConflictError, DomainError, NotFoundError,
                                 PermissionDeniedError, ValidationError)
from homun.models.intake import approved_skills_index
from homun.policy import require_project_capability
from homun.policy.intake import latest_intake
from homun.policy.work import require_work_access

PROPOSAL_TYPE = 'synthesis.propose'
ACTIVE = {'pending_approval', 'queued', 'running'}


def public(proposal):
    return {key: value for key, value in proposal.items() if not key.startswith('_')}


def lookup(store, proposal_id, work_id):
    record = store.commands.get(proposal_id)
    if not record or record.type != PROPOSAL_TYPE or record.result['work_id'] != work_id:
        raise NotFoundError('Synthesis proposal not found')
    return record.result


def authority(store, actor, proposal, *, approval=False, needed='write'):
    work = require_work_access(store, actor, proposal['work_id'], needed)
    for binding in proposal['materials']:
        material = store.materials.get(binding['id'])
        if not material:
            raise NotFoundError('Synthesis material not found')
        require_project_capability(store, actor, material.project_id, 'read')
    if approval:
        # Same delegation boundary as read/compare: a delegated agent owner
        # never approves the execution of a concrete action.
        if actor.kind != 'person':
            raise PermissionDeniedError('Only a person may approve the execution of a concrete action')
        if actor.id not in {work.owner_id, work.reviewer_id}:
            raise PermissionDeniedError('Only the current work owner or reviewer may approve')
    return work


def digest(proposal):
    bound = {key: proposal[key] for key in ('id', 'work_id', 'expected_version', 'tool_version',
                                            'materials', 'skills', 'assignee_id', 'limits')}
    bound['action'] = 'synthesize_and_submit_draft'
    return hashlib.sha256(json.dumps(bound, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _skill_bindings(store, skill_ids):
    """Approved procedures the person selected; the body travels at compose time."""
    bindings = []
    for skill_id in dict.fromkeys(skill_ids or []):
        skill = store.skills.get(skill_id)
        if skill is None:
            raise NotFoundError('Skill not found')
        if skill.status != 'approved':
            raise ValidationError('Only approved procedures can guide a synthesis')
        bindings.append({'id': skill.id, 'name': skill.name, 'revision': skill.revision})
    return bindings


def synthesis_assignee(store, work):
    """Who writes: the synthesize phase's assignee, else the work owner."""
    from homun.application.phase_execution import phase_plan_step
    step = phase_plan_step(store, work, 'synthesize')
    if step is not None and step.assignee_id in store.agents:
        return store.agents[step.assignee_id], step
    return store.agents.get(work.owner_id), None


def _source(ctx, store, actor, material_id):
    from homun.materials.source import verify_material
    return verify_material(ctx, store, actor, material_id,
                           max_bytes=SYNTHESIZE.limits['max_bytes_per_material'])


def propose(ctx, actor, work_id, body):
    payload = {**body, 'work_id': work_id}
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work = require_work_access(store, actor, work_id)
            from homun.application.phase_execution import (
                propose_pin_version, require_confirmed_intake_for_tool,
            )
            require_confirmed_intake_for_tool(store, work_id, capability='synthesize')
            material_ids = list(dict.fromkeys(body.get('material_ids') or []))
            if len(material_ids) > SYNTHESIZE.limits['max_materials']:
                raise ValidationError('Too many materials for one synthesis')
            bindings = []
            for material_id in material_ids:
                binding, _ = _source(ctx, store, actor, material_id)
                if store.materials[binding['id']].extract_status not in {'extracted', 'none'}:
                    raise ValidationError('Material has no readable text extract')
                bindings.append(binding)
            skill_ids = list(dict.fromkeys(body.get('skill_ids') or []))
            if len(skill_ids) > SYNTHESIZE.limits['max_skills']:
                raise ValidationError('Too many procedures for one synthesis')
            skills = _skill_bindings(store, skill_ids)
            agent, step = synthesis_assignee(store, work)
            if agent is None or agent.status != 'active':
                raise ValidationError('Synthesis requires an active assigned collaborator')
            record, fingerprint = cached(store, actor, body['command_id'], PROPOSAL_TYPE, payload)
            if record:
                authority(store, actor, record.result)
                return deepcopy(public(record.result))
            for existing in store.commands.values():
                prior = existing.result
                if existing.type != PROPOSAL_TYPE or prior['work_id'] != work_id or prior['status'] not in ACTIVE:
                    continue
                if work.version == prior['expected_version']:
                    raise ConflictError('This work already has an active synthesis')
                prior.update(status='blocked', error_code='synthesis_proposal_obsolete')
            service = ctx.service.for_store(store)
            pinned = propose_pin_version(
                service, store, actor, work, 'synthesize', body['command_id'], body['expected_version'],
                {'title': 'Scrivi la sintesi concordata', 'assignee_id': agent.id,
                 'output_expected': 'Bozza in Markdown da revisionare'},
            )
            proposal = {
                'id': body['command_id'], 'status': 'pending_approval', 'work_id': work_id,
                'expected_version': pinned, 'tool_version': SYNTHESIZE.tool_version,
                'materials': bindings, 'skills': skills, 'assignee_id': agent.id,
                'step_title': step.title if step is not None else work.title,
                'language': (body.get('language') or None),
                'limits': {'max_materials': SYNTHESIZE.limits['max_materials'],
                           'max_skills': SYNTHESIZE.limits['max_skills'],
                           'max_skill_characters': SYNTHESIZE.limits['max_skill_characters'],
                           'max_context_characters': SYNTHESIZE.limits['max_context_characters'],
                           'max_output_characters': SYNTHESIZE.limits['max_output_characters'],
                           'max_attempts': SYNTHESIZE.limits['max_attempts']},
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
            record, fingerprint = cached(store, actor, body['command_id'], 'synthesis.approve', payload)
            if body['digest'] != proposal['digest'] or body['expected_version'] != proposal['expected_version']:
                raise ConflictError('Approval does not match the proposed action and revision')
            for binding in proposal['skills']:
                skill = store.skills.get(binding['id'])
                if skill is None or skill.status != 'approved' or skill.revision != binding['revision']:
                    raise ConflictError('Skill changed; create a new proposal')
            if record:
                return deepcopy(public(proposal))
            if proposal['status'] != 'pending_approval':
                raise ConflictError('Synthesis already approved or closed')
            if work.version != proposal['expected_version']:
                raise ConflictError('Work changed; create a new proposal')
            service = ctx.service.for_store(store)
            from homun.application.phase_execution import approve_starts_phase
            approve_starts_phase(service, store, actor, work, 'synthesize', body['command_id'])
            proposal.update(status='queued', _actor=actor.model_dump(mode='json'),
                            _run_version=work.version, _workflow_id=f"synth:{actor.workspace_id}:{proposal_id}")
            save(store, actor, body['command_id'], 'synthesis.approve', fingerprint, {'proposal_id': proposal_id})
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
