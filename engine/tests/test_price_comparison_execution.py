"""Approval, authority, integrity and replay invariants for real local execution."""
import pytest
from homun.application.material_ingest import ingest_file
from homun.application.price_comparisons import approve, list_proposals, propose
from homun.application.price_comparison_execution import execute
from homun.context import create_context
from homun.domain.errors import ConflictError, PermissionDeniedError
from homun.domain.models import Actor


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_fabio', workspace_id=ctx.workspace_id, display_name='Fabio')
    service = ctx.service
    project = service.apply(actor, 'project', 'project.create', {'name': 'Synthetic'})['project_id']
    conv = service.apply(actor, 'conversation', 'conversation.create', {'title': 'Prices', 'project_id': project})['conversation_id']
    work = service.apply(actor, 'work', 'work.create', {'conversation_id': conv, 'title': 'Prices', 'objective': 'Compare'})['work_id']
    ctx.persist()
    materials = [ingest_file(ctx, actor, command_id=f'ingest-{i}', project_id=project,
                            filename=f'prices-{i}.csv', data=f'sku,name,price,currency\nA,Alpha,{10+i},EUR\n'.encode())['material_id'] for i in range(2)]
    body = dict(command_id='proposal', left_material_id=materials[0], right_material_id=materials[1], expected_version=1, max_rows=10000)
    yield ctx, actor, work, body
    ctx.close()


def confirmation(p):
    return dict(command_id='approve', digest=p['digest'], expected_version=p['expected_version'])


def test_supervised_intake_keeps_human_reviewer_through_execution(setup):
    import json
    from types import SimpleNamespace
    from homun.application.intake import propose as intake_propose, confirm as intake_confirm
    ctx, actor, work, body = setup
    ctx.models.complete = lambda *_args, **_kwargs: SimpleNamespace(text=json.dumps({
        'title': 'Confronto prezzi', 'objective': 'Verificare variazioni', 'output': 'Report e CSV',
        'constraints': [], 'missing_information': [], 'suggested_agent_id': None,
        'new_agent': {'name': 'Analista', 'role': 'Analisi CSV', 'instructions': 'Confronta i listini autorizzati'},
        'rationale': 'Analisi dei listini', 'capability': 'compare_csv',
    }))
    p = intake_propose(ctx, actor, work, {'command_id': 'intake', 'text': 'Confronta i listini', 'expected_version': 1})
    intake_confirm(ctx, actor, work, p['id'], {'command_id': 'staff', 'digest': p['digest'], 'expected_version': 1, 'create_agent': True})
    staffed = ctx.repository.load().works[work]
    assert staffed.owner_id != actor.id
    assert staffed.reviewer_id == actor.id
    p = propose(ctx, actor, work, {**body, 'expected_version': staffed.version})
    approve(ctx, actor, work, p['id'], confirmation(p))
    execute(ctx, p['id'])
    assert ctx.repository.load().works[work].status == 'review'
    assert len(ctx.repository.load().artifacts) == 1


def test_no_execution_without_approval_and_duplicate_approval_one_artifact(setup):
    ctx, actor, work, body = setup
    p = propose(ctx, actor, work, body)
    assert p['expected_version'] == 2
    execute(ctx, p['id'])
    assert not ctx.repository.load().artifacts
    approve(ctx, actor, work, p['id'], confirmation(p))
    approve(ctx, actor, work, p['id'], confirmation(p))
    execute(ctx, p['id'])
    execute(ctx, p['id'])
    store = ctx.repository.load()
    assert len(store.artifacts) == 1
    assert len(store.messages) == 1
    assert next(iter(store.messages.values())).author_id == 'homun_engine'
    assert store.works[work].status == 'review'
    assert list_proposals(ctx, actor, work)['items'][0]['status'] == 'completed'


def test_wrong_digest_and_command_fingerprint(setup):
    ctx, actor, work, body = setup
    p = propose(ctx, actor, work, body)
    with pytest.raises(ConflictError):
        approve(ctx, actor, work, p['id'], {**confirmation(p), 'digest': 'wrong'})
    with pytest.raises(ConflictError):
        propose(ctx, actor, work, {**body, 'max_rows': 3})
    with pytest.raises(ConflictError):
        propose(ctx, actor, work, {**body, 'command_id': 'other', 'expected_version': 2})
    assert not ctx.repository.load().artifacts


def test_changed_source_rejected_and_revoked_authority_blocks_publication(setup):
    ctx, actor, work, body = setup
    p = propose(ctx, actor, work, body)
    material = ctx.repository.load().materials[p['left']['id']]
    path = ctx.data_dir / material.storage_relpath
    original = path.read_bytes()
    path.write_bytes(b'tampered')
    with pytest.raises(ConflictError):
        approve(ctx, actor, work, p['id'], confirmation(p))
    path.write_bytes(original)
    approve(ctx, actor, work, p['id'], confirmation(p))
    with ctx.repository.transaction() as store:
        for grant in store.grants.values():
            grant.status = 'revoked'
    execute(ctx, p['id'])
    assert ctx.repository.load().commands[p['id']].result['status'] == 'blocked'
    assert not ctx.repository.load().artifacts
    with pytest.raises(PermissionDeniedError):
        list_proposals(ctx, actor, work)
    with pytest.raises(PermissionDeniedError):
        approve(ctx, actor, work, p['id'], confirmation(p))


def test_revalidation_after_compute_and_bounded_attempts(setup, monkeypatch):
    ctx, actor, work, body = setup
    p = propose(ctx, actor, work, body)
    approve(ctx, actor, work, p['id'], confirmation(p))
    import homun.application.price_comparison_execution as execution
    original = execution.compare_csv
    def revoke(*args, **kwargs):
        report = original(*args, **kwargs)
        with ctx.repository.transaction() as store:
            for grant in store.grants.values():
                grant.status = 'revoked'
        return report
    monkeypatch.setattr(execution, 'compare_csv', revoke)
    execute(ctx, p['id'])
    assert not ctx.repository.load().artifacts
    assert ctx.repository.load().commands[p['id']].result['error_code'] == 'permission_denied'


def test_attempt_budget_survives_reopen(setup, monkeypatch):
    ctx, actor, work, body = setup
    p = propose(ctx, actor, work, body)
    approve(ctx, actor, work, p['id'], confirmation(p))
    import homun.application.price_comparison_execution as execution
    calls = []
    def unavailable(*args, **kwargs):
        calls.append(1)
        raise RuntimeError('transient tool failure')
    monkeypatch.setattr(execution, 'compare_csv', unavailable)
    for _ in range(3):
        with pytest.raises(RuntimeError):
            execute(ctx, p['id'])
    reopened = create_context(db_path=ctx.data_dir / 'ws.db', data_dir=ctx.data_dir, for_tests=True)
    try:
        execute(reopened, p['id'])
        assert len(calls) == 3
        assert list_proposals(reopened, actor, work)['items'][0]['status'] == 'failed'
        assert not reopened.repository.load().artifacts
    finally:
        reopened.close()


def test_dbos_recovers_approved_intent_after_context_restart(setup):
    import asyncio
    from homun.application.lifecycle import runtime_lifespan
    ctx, actor, work, body = setup
    p = propose(ctx, actor, work, body)
    approve(ctx, actor, work, p['id'], confirmation(p))
    reopened = create_context(db_path=ctx.data_dir / 'ws.db', data_dir=ctx.data_dir, for_tests=True)
    async def run():
        async with runtime_lifespan(reopened):
            for _ in range(100):
                current = list_proposals(reopened, actor, work)['items'][0]
                if current['status'] in {'completed', 'failed', 'blocked'}:
                    assert current['status'] == 'completed', current
                    break
                await asyncio.sleep(.05)
            else:
                pytest.fail('DBOS did not complete the approved comparison')
        # Runtime relaunch and pump replay must not duplicate publication.
        async with runtime_lifespan(reopened):
            await asyncio.sleep(.1)
        store = reopened.repository.load()
        assert len(store.artifacts) == 1
        assert len(store.messages) == 1
        assert store.works[work].status == 'review'
    try:
        asyncio.run(run())
    finally:
        reopened.close()


def test_obsolete_pending_proposal_can_be_replaced(setup):
    ctx, actor, work, body = setup
    p = propose(ctx, actor, work, body)
    with ctx.repository.transaction() as store:
        store.works[work].version += 1
    with pytest.raises(ConflictError):
        approve(ctx, actor, work, p['id'], confirmation(p))
    replacement = propose(ctx, actor, work, {**body, 'command_id': 'replacement', 'expected_version': 3})
    assert replacement['status'] == 'pending_approval'
    assert ctx.repository.load().commands[p['id']].result['status'] == 'blocked'


def test_failed_comparison_projects_failure_and_accepts_corrected_proposal(setup, monkeypatch):
    from homun.domain.errors import ValidationError
    ctx, actor, work, body = setup
    p = propose(ctx, actor, work, body)
    approve(ctx, actor, work, p['id'], confirmation(p))
    def invalid(*args, **kwargs):
        raise ValidationError('Invalid CSV')
    monkeypatch.setattr('homun.application.price_comparison_execution.compare_csv', invalid)
    execute(ctx, p['id'])
    store = ctx.repository.load()
    assert store.works[work].status == 'failed'
    assert store.plans[store.plan_key(work, 1)].steps[0].status == 'failed'
    retry = propose(ctx, actor, work, {**body, 'command_id': 'corrected', 'expected_version': store.works[work].version})
    assert retry['status'] == 'pending_approval'
    assert ctx.repository.load().works[work].status == 'draft'
