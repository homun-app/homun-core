"""Immutable source bindings and current authority for deterministic comparisons."""
import hashlib
import json
from homun.domain.capabilities import COMPARE_CSV
from homun.domain.errors import ConflictError, NotFoundError, PermissionDeniedError
from homun.materials.source import verify_material
from homun.policy import require_project_capability
from homun.policy.work import require_work_access

TOOL_VERSION = COMPARE_CSV.tool_version
PROPOSAL_TYPE = 'price_comparison.propose'
ACTIVE = {'pending_approval', 'queued', 'running'}


def public(proposal):
    return {key: value for key, value in proposal.items() if not key.startswith('_')}


def lookup(store, proposal_id, work_id):
    record = store.commands.get(proposal_id)
    if not record or record.type != PROPOSAL_TYPE or record.result['work_id'] != work_id:
        raise NotFoundError('Comparison proposal not found')
    return record.result


def authority(store, actor, proposal, *, approval=False, needed='write'):
    work = require_work_access(store, actor, proposal['work_id'], needed)
    for side in ('left', 'right'):
        material = store.materials.get(proposal[side]['id'])
        if not material:
            raise NotFoundError('Comparison material not found')
        require_project_capability(store, actor, material.project_id, 'read')
    if approval:
        # Autonomy is granted for activity and context, never for effects:
        # executing a concrete action stays a human decision, even when the
        # delegated agent owns the work.
        if actor.kind != 'person':
            raise PermissionDeniedError('Only a person may approve the execution of a concrete action')
        if actor.id not in {work.owner_id, work.reviewer_id}:
            raise PermissionDeniedError('Only the current work owner or reviewer may approve')
    return work


def source(ctx, store, actor, material_id):
    return verify_material(ctx, store, actor, material_id,
                           max_bytes=COMPARE_CSV.limits['max_bytes_per_material'])


def validate_sources(ctx, store, actor, proposal):
    data = []
    for side in ('left', 'right'):
        current, blob = source(ctx, store, actor, proposal[side]['id'])
        if current != proposal[side]:
            raise ConflictError('Comparison source changed; create a new proposal')
        data.append(blob)
    if proposal['tool_version'] != TOOL_VERSION:
        raise ConflictError('Comparison tool changed; create a new proposal')
    return data


def digest(proposal):
    bound = {key: proposal[key] for key in ('id', 'work_id', 'expected_version', 'tool_version', 'left', 'right', 'limits')}
    bound['action'] = 'compare_csv_and_submit_report'
    return hashlib.sha256(json.dumps(bound, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
