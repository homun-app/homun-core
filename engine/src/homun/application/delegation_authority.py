"""Pure parent/child authority checks; no runtime or tool-registry dependencies."""
from homun.domain.errors import PermissionDeniedError, ValidationError
from homun.policy.work import require_work_access


class DelegationError(ValidationError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def validate_parent_work(store, actor, parent):
    work = require_work_access(store, actor, parent['work_id'], 'write')
    if actor.kind != 'person' or actor.id not in {work.owner_id, work.reviewer_id}:
        raise PermissionDeniedError('Only the approved owner or reviewer can delegate')
    if work.status != 'running' or work.version != parent.get('_run_version'):
        raise PermissionDeniedError('Approved parent work changed')
    return work


def admitted_parent(ctx, store, actor, snapshot):
    record = store.commands.get(snapshot.get('id'))
    if not record or record.type != 'agent_run.propose':
        raise DelegationError('delegation_parent_not_admitted', 'Delegation requires an approved canonical parent run')
    parent = record.result
    if parent.get('_delegation_parent'):
        raise DelegationError('delegation_recursive_unavailable', 'Nested delegation is not authorized')
    if parent.get('delegation', {}).get('policy') != 'isolated-subagent-v1':
        raise DelegationError('delegation_not_authorized', 'Parent approval does not include delegation')
    validate_parent_work(store, actor, parent)
    if (parent.get('status') != 'running' or not parent.get('_lease_token')
            or parent['_lease_token'] != snapshot.get('_lease_token')
            or parent['work_id'] != snapshot.get('work_id')):
        raise DelegationError('delegation_parent_superseded', 'Parent execution lease is no longer current')
    return parent


def parent_for(store, child):
    binding = child.get('_delegation_parent') or {}
    record = store.commands.get(binding.get('run_id'))
    parent = record.result if record and record.type == 'agent_run.propose' else None
    return binding, parent


def validate_child(store, run):
    if not run.get('_delegation_parent'):
        return
    binding, parent = parent_for(store, run)
    if not parent or parent['work_id'] != run['work_id'] or parent['_epoch'] != binding['epoch']:
        raise PermissionDeniedError('Delegation parent authority changed')
    if parent['status'] not in {'running', 'queued', 'waiting_automation'}:
        raise PermissionDeniedError('Delegation parent is not executing')
    handle = parent.get('_delegations', {}).get(binding['delegation_id'])
    if not handle or handle['child_run_id'] != run['id']:
        raise PermissionDeniedError('Delegation is not admitted by this parent')
    approved = {item['name']:item for item in parent['tools']}
    if any(approved.get(item['name']) != item for item in run['tools']):
        raise PermissionDeniedError('Child tool scope exceeds the approved parent')
