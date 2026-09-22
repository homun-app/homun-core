"""Phase-aware admission for executable-tool proposals (compare CSV / read material).

A work whose accepted plan already contains a step with the tool's capability
must not grow a second single-step plan: the phase ladder IS the plan. Tool
preparation pins the current work version; approving the tool is the phase's
explicit go (work.start of that step) when the work is not already running.
"""
from homun.domain.errors import ConflictError
from homun.domain.states import WorkStatus
from homun.policy.intake import latest_intake


def phase_plan_step(store, work, capability):
    """The plan step carrying this capability, when the work has an accepted plan."""
    if not work.current_plan_revision:
        return None
    plan = store.plans.get(store.plan_key(work.id, work.current_plan_revision))
    if plan is None:
        return None
    return next((s for s in plan.steps if s.capability == capability), None)


def require_confirmed_intake_for_tool(store, work_id, capability):
    """Confirmed intake with the tool capability, or with a declared phase of it.

    A multi-phase agreement may carry capability 'general' while one of its
    phases runs the tool: admitting the tool on that phase is honest, forcing
    the whole work into the tool's capability is not.
    """
    from homun.policy.intake import require_confirmed_intake
    try:
        require_confirmed_intake(store, work_id, capability=capability)
        return
    except ConflictError:
        work = store.works.get(work_id)
        if work is not None and phase_plan_step(store, work, capability) is not None:
            proposal = latest_intake(store, work_id)
            if proposal and proposal.get('status') == 'confirmed':
                return
        raise


def propose_pin_version(service, store, actor, work, capability, command_id,
                        expected_version, single_step, *, retry_accept=None):
    """Version to pin the tool proposal to; creates a plan only for plan-less works."""
    if phase_plan_step(store, work, capability) is not None:
        return work.version  # the phase ladder is the plan; nothing to add
    if retry_accept is not None:
        retry_accept()
        expected_version = work.version
    plan = service.apply(actor, f"{command_id}:plan", 'plan.propose', {
        'work_id': work.id, 'expected_version': expected_version, 'steps': [single_step]})
    return plan['version']


def approve_starts_phase(service, store, actor, work, capability, command_id):
    """Plan acceptance + start for plan-less works; for phased ones the approval
    itself is the supervised go (start the phase if the work is still ready)."""
    if phase_plan_step(store, work, capability) is not None:
        if work.status == WorkStatus.READY:
            service.apply(actor, f"{command_id}:start", 'work.start', {
                'work_id': work.id, 'expected_version': work.version, 'durable': False})
        return
    service.apply(actor, f"{command_id}:accept", 'plan.accept', {
        'work_id': work.id, 'expected_version': work.version})
    service.apply(actor, f"{command_id}:start", 'work.start', {
        'work_id': work.id, 'expected_version': work.version, 'durable': False})
