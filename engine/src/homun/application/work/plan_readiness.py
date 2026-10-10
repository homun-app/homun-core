"""Material-driven readiness for planned works (Fonte=motore, slice F1).

When every material a phase waits for has landed, the work itself proposes the
executable step: an honest chat message, exactly once per step title. The
panel's live action remains the authoritative trigger — this announcement is a
courtesy told in the person's language, never an implicit start.
"""
from homun.domain.states import StepStatus, WorkStatus
from homun.policy.capabilities import _eligible_comparison_material

ANNOUNCE_PREFIX = 'Ho tutto quello che serve per'


def _current_plan(store, work):
    return store.plans.get(store.plan_key(work.id, work.current_plan_revision))


def _project_of(store, work):
    if work.project_id:
        return work.project_id
    conversation = store.conversations.get(work.primary_conversation_id)
    return conversation.project_id if conversation else None


def first_ready_step(store, actor, work):
    """Next executable step whose materials are all in the work's project, or None."""
    if work.status != WorkStatus.READY:
        return None
    plan = _current_plan(store, work)
    if plan is None:
        return None
    step = next((s for s in plan.steps if s.status == StepStatus.PENDING), None)
    if step is None or step.capability not in ('compare_csv', 'read_material'):
        return None
    project_id = _project_of(store, work)
    if project_id is None:
        return None
    if step.capability == 'compare_csv':
        eligible = sum(1 for material in store.materials.values()
                       if material.project_id == project_id
                       and _eligible_comparison_material(store, actor, material))
        return step if eligible >= 2 else None
    present = any(material.project_id == project_id for material in store.materials.values())
    return step if present else None


def _already_announced(store, conversation_id, step):
    for message in store.messages.values():
        if (message.conversation_id == conversation_id
                and message.text.startswith(ANNOUNCE_PREFIX)
                and f'«{step.title}»' in message.text):
            return True
    return False


def announce_ready_steps(ctx, actor, *, project_id, command_id):
    """After materials land in a project, planned works whose next executable step
    became ready say so in their conversation — once per step title."""
    announced = []
    store = ctx.repository.load()
    for work in list(store.works.values()):
        if _project_of(store, work) != project_id:
            continue
        step = first_ready_step(store, actor, work)
        if step is None or _already_announced(store, work.primary_conversation_id, step):
            continue
        with ctx.repository.transaction() as fresh:
            service = ctx.service.for_store(fresh)
            service.append_engine_message(
                actor=actor, command_id=f'{command_id}:announce:{work.id}',
                conversation_id=work.primary_conversation_id, author_id='homun_engine',
                text=(f'{ANNOUNCE_PREFIX} «{step.title}»: i materiali attesi sono nel progetto. '
                      'Vuoi che avvii questo passaggio? L\'azione è nel riepilogo del lavoro.'),
                event_payload={'work_id': work.id, 'step_id': step.id},
            )
        ctx.service.store = store
        announced.append((work.id, step.id))
    return announced
