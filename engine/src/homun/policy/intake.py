"""Staffing admission for intake-backed work; legacy work remains unchanged."""
from homun.domain.errors import ConflictError


def latest_intake(store, work_id):
    records = [record for record in store.commands.values()
               if record.type == 'intake.propose' and record.result['work_id'] == work_id]
    return max(records,key=lambda record:record.created_at).result if records else None


def has_confirmed_intake(store, work_id):
    """True once any brief for the work has been confirmed (agreed preparation).

    List projections use this to keep status labels stable even when the
    per-work intake state is not loaded client-side.
    """
    return any(record.type == 'intake.propose' and record.result['work_id'] == work_id
               and record.result['status'] == 'confirmed'
               for record in store.commands.values())


def require_confirmed_intake(store, work_id, capability=None):
    proposal = latest_intake(store, work_id)
    if proposal and (proposal['status'] != 'confirmed'
                     or (capability is not None and proposal['capability'] != capability)):
        raise ConflictError('Confirm the intake before assigning or executing this work')


def require_intake_command_admission(store, command_type, payload):
    operational = command_type in {'plan.propose', 'plan.accept', 'plan.revise', 'work.start'}
    if command_type == 'work.apply_patch':
        operational = any(isinstance(change, dict) and change.get('field') in {'owner_id', 'step_assignee'}
                          for change in payload.get('changes', []) or [])
    if operational:
        require_confirmed_intake(store, str(payload.get('work_id', '')))
