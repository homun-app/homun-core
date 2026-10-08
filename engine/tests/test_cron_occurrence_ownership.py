"""Durable occurrence claims across independent connections and restart."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from homun.application.cron_manager import CronManager
from homun.application.cron_store import CronStore


def manager(path):
    return CronManager(workspace_id='w', store=CronStore(path))


def due_job(mgr, **kwargs):
    job = mgr.create_job(schedule='every 1h', prompt='tick', now=10, **kwargs)
    job.next_run_at = 20
    mgr._persist_job(job)
    return job


def test_two_connections_only_one_claim_and_restart_preserves_it(tmp_path):
    path = tmp_path / 'cron.db'
    first, second = manager(path), manager(path)
    job = due_job(first)
    barrier = Barrier(2)
    def claim(mgr):
        barrier.wait()
        return mgr.claim_job_for_fire(job.id, now=20)
    with ThreadPoolExecutor(2) as pool:
        claims = list(pool.map(claim, [first, second]))
    assert sum(c is not None for c in claims) == 1
    assert manager(path).claim_job_for_fire(job.id, now=21) is None


def test_event_needs_explicit_idempotent_activation(tmp_path):
    mgr = manager(tmp_path / 'cron.db')
    job = mgr.create_job(schedule='on event:deploy', prompt='tick', now=10)
    assert mgr.claim_job_for_fire(job.id, now=20) is None
    mgr.activate_event(job.id, activation_id='deployment-1', now=20)
    claim = mgr.claim_job_for_fire(job.id, now=20)
    assert claim is not None
    mgr.run_job(job.id, claim=claim, now=20, custom_runner=lambda _: (0, 'ok', None))
    mgr.activate_event(job.id, activation_id='deployment-1', now=21)
    assert mgr.claim_job_for_fire(job.id, now=21) is None


def test_claim_expiry_before_io_is_recoverable_but_after_io_unknown(tmp_path):
    path = tmp_path / 'cron.db'
    mgr = manager(path)
    job = due_job(mgr)
    claim = mgr.claim_job_for_fire(job.id, now=20)
    renewed = manager(path).claim_job_for_fire(job.id, now=claim.lease_until + 1)
    assert renewed.occurrence_id == claim.occurrence_id
    assert renewed.claim_token != claim.claim_token
    from homun.application.cron_occurrences import begin_execution
    assert not begin_execution(mgr._store, 'w', claim, recovery_safe=False)
    assert begin_execution(mgr._store, 'w', renewed, recovery_safe=False)
    assert manager(path).claim_job_for_fire(job.id, now=renewed.lease_until + 1) is None
    history = manager(path).get_history(job.id)
    assert history[-1].status == 'unknown'
    assert manager(path).get_job(job.id).run_count == 0


def test_awaiting_approval_does_not_consume_repeat_or_deliver(tmp_path):
    from homun.application.cron_contracts import CronExecutionResult
    path = tmp_path / 'cron.db'
    mgr = manager(path)
    job = due_job(mgr, repeat=1, deliver='chat')
    occ = mgr.run_job(job.id, now=20, custom_runner=lambda _: CronExecutionResult(
        status='awaiting_approval', agent_run_id='run-1', work_id='work-1'))
    assert occ.status == 'awaiting_approval'
    assert occ.completed_at == 0
    assert manager(path).get_job(job.id).run_count == 0
    assert manager(path).get_job(job.id).status == 'active'
    assert manager(path).claim_job_for_fire(job.id, now=99999) is None
    assert mgr.get_deliveries() == []


def test_real_staging_replay_and_terminal_reconciliation(tmp_path):
    from homun.context import create_context
    from homun.application.cron_agent_runner import make_cron_runner
    from homun.application.cron_reconciliation import reconcile_cron_runs
    from homun.application.agent_runs import approve
    from homun.application.agent_run_execution import advance
    from types import SimpleNamespace
    import json
    ctx = create_context(db_path=tmp_path / 'engine.db', data_dir=tmp_path, for_tests=True)
    try:
        mgr = CronManager(workspace_id=ctx.workspace_id, store=CronStore(tmp_path / 'cron.db'))
        from homun.domain.models import Actor
        owner = Actor(id='person_cron', workspace_id=ctx.workspace_id, display_name='Owner')
        job = due_job(mgr, repeat=1, owner_actor=owner.model_dump(mode='json'))
        runner = make_cron_runner(ctx)
        claim = mgr.claim_job_for_fire(job.id, now=20)
        occ = mgr.run_job(job.id, now=20, claim=claim, custom_runner=runner)
        assert occ.status == 'awaiting_approval'
        before = ctx.repository.load()
        again = runner(dict(job_id=job.id, occurrence_id=occ.occurrence_id, prompt='tick', owner_actor=job.owner_actor))
        after = ctx.repository.load()
        assert again.agent_run_id == occ.agent_run_id
        assert len(before.works) == len(after.works) == 1
        assert mgr.get_job(job.id).run_count == 0
        run = after.commands[occ.agent_run_id].result
        from homun.domain.models import Actor
        actor = Actor(id='person_cron', workspace_id=ctx.workspace_id, display_name='Homun Cron')
        approve(ctx, actor, occ.work_id, occ.agent_run_id, dict(command_id='approve',
            expected_version=run['expected_version'], digest=run['digest']))
        ctx.models.complete = lambda *a, **kw: SimpleNamespace(text=json.dumps({'kind':'finish','message':'Done'}))
        assert advance(ctx, occ.agent_run_id) == 'completed'
        reconcile_cron_runs(ctx, store=mgr._store, now=30)
        reconcile_cron_runs(ctx, store=mgr._store, now=31)
        final = mgr.get_history(job.id)[0]
        assert final.status == 'success'
        assert mgr.get_job(job.id).run_count == 1
        assert mgr.get_job(job.id).status == 'completed'
        assert 'Done' in final.output_preview
    finally:
        ctx.close()


def test_due_listing_does_not_reserve(tmp_path):
    from homun.application.cron_dispatcher import list_due_job_ids
    from homun.application.cron_store import set_cron_store
    mgr = manager(tmp_path / 'cron.db')
    job = due_job(mgr)
    set_cron_store(mgr._store)
    try:
        assert list_due_job_ids('w', now=20) == [job.id]
        assert list_due_job_ids('w', now=20) == [job.id]
        assert mgr.get_history(job.id) == []
        assert mgr.claim_job_for_fire(job.id, now=20) is not None
    finally:
        set_cron_store(None)


def test_staging_crash_before_receipt_recovers_same_proposal(tmp_path, monkeypatch):
    import pytest
    from homun.context import create_context
    from homun.application import cron_occurrences
    from homun.application.cron_agent_runner import make_cron_runner
    ctx = create_context(db_path=tmp_path / 'engine.db', data_dir=tmp_path, for_tests=True)
    try:
        path = tmp_path / 'cron.db'
        mgr = CronManager(workspace_id=ctx.workspace_id, store=CronStore(path))
        from homun.domain.models import Actor
        owner = Actor(id='person_a', workspace_id=ctx.workspace_id, display_name='Owner')
        job = due_job(mgr, owner_actor=owner.model_dump(mode='json'))
        claim = mgr.claim_job_for_fire(job.id, now=20)
        settle = cron_occurrences.settle
        def crash(*a, **kw):
            raise SystemExit('crash after staged command committed')
        monkeypatch.setattr(cron_occurrences, 'settle', crash)
        with pytest.raises(SystemExit):
            mgr.run_job(job.id, now=20, claim=claim, custom_runner=make_cron_runner(ctx))
        monkeypatch.setattr(cron_occurrences, 'settle', settle)
        reopened = CronManager(workspace_id=ctx.workspace_id, store=CronStore(path))
        retry = reopened.claim_job_for_fire(job.id, now=claim.lease_until + 1)
        result = reopened.run_job(job.id, now=claim.lease_until + 1, claim=retry,
                                  custom_runner=make_cron_runner(ctx))
        assert result.status == 'awaiting_approval'
        assert len(ctx.repository.load().works) == 1
        assert len(reopened.get_history(job.id)) == 1
        assert reopened.get_job(job.id).run_count == 0
    finally:
        ctx.close()


def test_stale_completion_cannot_settle_or_enqueue_twice(tmp_path):
    import pytest
    from homun.application.cron_contracts import CronExecutionResult
    from homun.application.cron_occurrences import begin_execution, settle
    mgr = manager(tmp_path / 'cron.db')
    job = due_job(mgr, deliver='chat')
    claim = mgr.claim_job_for_fire(job.id, now=20)
    assert begin_execution(mgr._store, 'w', claim, recovery_safe=False)
    settle(mgr._store, 'w', claim, CronExecutionResult('success', output='done'), now=21)
    with pytest.raises(ValueError):
        settle(mgr._store, 'w', claim, CronExecutionResult('success', output='done'), now=22)
    assert mgr.get_job(job.id).run_count == 1
    assert len(mgr.get_deliveries()) == 1
    assert mgr.get_deliveries()[0]['status'] == 'pending'


def test_pin_or_capability_failure_is_explicit_before_staging(tmp_path):
    from homun.context import create_context
    from homun.application.cron_agent_runner import make_cron_runner
    ctx = create_context(db_path=tmp_path / 'engine.db', data_dir=tmp_path, for_tests=True)
    try:
        from homun.domain.models import Actor
        runner = make_cron_runner(ctx, Actor(id='person_a', workspace_id=ctx.workspace_id, display_name='Owner'))
        assert runner(dict(occurrence_id='x', prompt='tick', model_pin='missing')).error == 'cron_model_binding_unavailable'
        assert runner(dict(occurrence_id='y', prompt='tick', workdir='/tmp')).error == 'cron_capability_unavailable'
        assert not ctx.repository.load().works
    finally:
        ctx.close()


def test_staging_recovery_cannot_be_settled_without_its_backend(tmp_path):
    import pytest
    from homun.application.cron_occurrences import begin_execution
    mgr = manager(tmp_path / 'cron.db')
    job = due_job(mgr)
    original = mgr.claim_job_for_fire(job.id, now=20)
    assert begin_execution(mgr._store, 'w', original, recovery_safe=True)
    claimed = mgr.claim_job_for_fire(job.id, now=original.lease_until + 1)
    with pytest.raises(ValueError, match='recovery requires'):
        mgr.run_job(job.id, claim=claimed, now=original.lease_until + 1)
    assert mgr.get_job(job.id).run_count == 0


def test_timer_requires_bound_actor_and_checks_workspace(tmp_path):
    from homun.context import create_context
    from homun.application.cron_agent_runner import make_cron_runner
    from homun.domain.models import Actor
    ctx = create_context(db_path=tmp_path / 'engine.db', data_dir=tmp_path, for_tests=True)
    try:
        runner = make_cron_runner(ctx)
        base = dict(occurrence_id='actor-check', prompt='tick')
        assert runner(base).error == 'cron_actor_required'
        wrong = Actor(id='person_a', workspace_id='other', display_name='A').model_dump(mode='json')
        assert runner({**base, 'owner_actor': wrong}).error == 'cron_actor_workspace_mismatch'
        assert not ctx.repository.load().works
    finally:
        ctx.close()


def test_timer_revalidates_source_work_access_before_creating_work(tmp_path):
    from homun.context import create_context
    from homun.application.cron_agent_runner import make_cron_runner
    from homun.domain.models import Actor
    ctx = create_context(db_path=tmp_path / 'engine.db', data_dir=tmp_path, for_tests=True)
    try:
        actor = Actor(id='person_a', workspace_id=ctx.workspace_id, display_name='Owner')
        outcome = make_cron_runner(ctx)(dict(occurrence_id='missing-source', prompt='tick',
            owner_actor=actor.model_dump(mode='json'), source_work_id='deleted-work'))
        assert outcome.status == 'failed'
        assert outcome.error == 'not_found'
        assert not ctx.repository.load().works
    finally:
        ctx.close()


def test_job_edit_cannot_overwrite_concurrent_settlement(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from homun.application.cron_occurrences import begin_execution, settle
    from homun.application.cron_contracts import CronExecutionResult
    path=tmp_path/'race.db'
    first, second=manager(path), manager(path)
    job=due_job(first,repeat=1)
    claimed=first.claim_job_for_fire(job.id,now=20)
    assert begin_execution(first._store,'w',claimed,recovery_safe=False)
    read, release=Event(),Event()
    original=second.get_job
    def paused_read(job_id):
        result=original(job_id)
        read.set()
        assert release.wait(3)
        return result
    monkeypatch.setattr(second,'get_job',paused_read)
    with ThreadPoolExecutor() as pool:
        update=pool.submit(second.update_job,job.id,name='renamed')
        assert read.wait(3)
        completion=pool.submit(settle,first._store,'w',claimed,CronExecutionResult('success',output='done'),now=21)
        release.set()
        update.result(); completion.result()
    final=first.get_job(job.id)
    assert final.name=='renamed' and final.run_count==1 and final.status=='completed'


def test_timer_script_rechecks_source_authority(tmp_path):
    from homun.context import create_context
    from homun.domain.models import Actor
    from homun.application.cron_dispatcher import fire_due_jobs
    from homun.application.cron_store import set_cron_store
    ctx=create_context(db_path=tmp_path/'engine.db',data_dir=tmp_path,for_tests=True)
    store=CronStore(tmp_path/'cron-auth.db')
    set_cron_store(store)
    try:
        mgr=CronManager(workspace_id=ctx.workspace_id,store=store)
        owner=Actor(id='person_owner',workspace_id=ctx.workspace_id,display_name='Owner')
        job=mgr.create_job(schedule='every 1h',script='printf MUST_NOT_RUN',no_agent=True,
            owner_actor=owner.model_dump(),source_work_id='deleted-work',now=1)
        result=fire_due_jobs(ctx.workspace_id,ctx=ctx,now=4000)
        assert result[0]['occurrence']['status']=='failed'
        assert 'MUST_NOT_RUN' not in result[0]['occurrence']['output_preview']
    finally:
        set_cron_store(None);ctx.close()
