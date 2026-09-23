"""Review an intermediate delivery without rewriting history or skipping work."""
from test_agent_runs import setup, scripted


def test_revision_preserves_history_and_precedes_next_phase(setup):
    from homun.application.agent_runs import propose, approve
    from homun.application.agent_run_execution import advance
    ctx, actor, work, material = setup
    plan = ctx.service.apply(actor, 'plan', 'plan.propose', {
        'work_id': work, 'expected_version': 1, 'steps': [
            {'id': 'investigate', 'title': 'Indaga', 'capability': 'agent_run', 'assignee_id': actor.id},
            {'id': 'later', 'title': 'Sintetizza', 'capability': 'synthesize', 'assignee_id': actor.id,
             'depends_on': ['investigate']}]})
    ctx.service.apply(actor, 'accept', 'plan.accept', {'work_id': work, 'expected_version': plan['version']})
    ctx.persist()
    seen = []
    scripted(ctx, [{'kind': 'finish', 'message': 'Prima bozza'}, {'kind': 'finish', 'message': 'Corretta'}], seen)
    def execute(command):
        proposal = propose(ctx, actor, work, {'command_id': command,
            'expected_version': ctx.repository.load().works[work].version, 'material_ids': [material]})
        approve(ctx, actor, work, proposal['id'], {'command_id': command + ':go',
            'expected_version': proposal['expected_version'], 'digest': proposal['digest']})
        assert advance(ctx, proposal['id']) == 'completed'
    execute('first')
    store = ctx.repository.load()
    original_revision = store.works[work].current_plan_revision
    artifact = next(iter(store.artifacts.values()))
    ctx.service = ctx.service.for_store(store)
    ctx.service.apply(actor, 'review', 'work.review', {'work_id': work,
        'expected_version': store.works[work].version, 'artifact_version_id': artifact.id,
        'decision': 'request_changes', 'comment': 'Correggi prima della sintesi'})
    ctx.persist()
    execute('revision')
    store = ctx.repository.load()
    old = store.plans[store.plan_key(work, original_revision)].steps
    current = store.plans[store.plan_key(work, store.works[work].current_plan_revision)].steps
    assert [(s.id, s.status) for s in old] == [('investigate', 'succeeded'), ('later', 'pending')]
    assert len(current) == 3
    assert current[0].id == 'investigate' and current[0].status == 'succeeded'
    assert current[1].capability == 'agent_run' and current[1].status == 'succeeded'
    assert current[2].id == 'later' and current[2].status == 'pending'
    assert len(store.artifacts) == 2
