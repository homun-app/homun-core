"""Per-work budget: reservation, exhaustion, cancellation, recovery."""
import json
from datetime import timedelta
from types import SimpleNamespace

import pytest

from homun.application import budgets
from homun.application.intake import classify_message, propose
from homun.context import create_context
from homun.domain.errors import BudgetExhaustedError, ConflictError, PermissionDeniedError
from homun.domain.models import Actor, BudgetCounters, utc_now


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path / 'ws.sqlite3', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_fabio', workspace_id='ws_local', display_name='Fabio')
    conv = ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'Nuova richiesta'})
    wid = ctx.service.apply(actor, 'w', 'work.create', {'conversation_id': conv['conversation_id'], 'title': 'Nuova richiesta', 'objective': 'Obiettivo da concordare'})['work_id']
    ctx.persist()
    brief = {'title': 'Confronto listini', 'objective': 'Variazioni di prezzo.', 'output': 'Report e CSV',
             'constraints': [], 'missing_information': [], 'suggested_agent_id': None, 'new_agent': None,
             'rationale': 'ok', 'capability': 'general'}
    yield ctx, actor, wid, brief
    ctx.close()


def budget(ctx, wid):
    return ctx.repository.load().work_budgets[wid]


def test_reserve_reconcile_and_persistence(setup):
    ctx, actor, wid, _ = setup
    rid = budgets.reserve(ctx, actor, wid, BudgetCounters(attempts=1), purpose='test')
    assert budget(ctx, wid).reserved.attempts == 1
    budgets.reconcile(ctx, actor, wid, rid,
                      usage=BudgetCounters(attempts=1, input_tokens=120, output_tokens=45))
    store = ctx.repository.load()
    assert store.work_budgets[wid].spent.input_tokens == 120
    assert store.work_budgets[wid].spent.attempts == 1
    assert store.work_budgets[wid].reserved.attempts == 0
    assert not store.work_budgets[wid].pending


def test_exhaustion_is_typed_and_atomic(setup):
    ctx, actor, wid, _ = setup
    ctx.service.apply(actor, 'cap', 'work.set_budget', {'work_id': wid, 'caps': {'model_attempts': 2}})
    ctx.persist()
    r1 = budgets.reserve(ctx, actor, wid, BudgetCounters(attempts=1))
    r2 = budgets.reserve(ctx, actor, wid, BudgetCounters(attempts=1))
    with pytest.raises(BudgetExhaustedError):
        budgets.reserve(ctx, actor, wid, BudgetCounters(attempts=1))
    budgets.reconcile(ctx, actor, wid, r1, usage=BudgetCounters(attempts=1))
    budgets.release(ctx, actor, wid, r2)
    # Released estimates return to the envelope: one more call fits.
    r3 = budgets.reserve(ctx, actor, wid, BudgetCounters(attempts=1))
    budgets.reconcile_unknown(ctx, actor, wid, r3)
    assert budget(ctx, wid).unknown.attempts == 1
    with pytest.raises(BudgetExhaustedError):
        budgets.reserve(ctx, actor, wid, BudgetCounters(attempts=1))


def test_unknown_usage_never_becomes_zero(setup):
    ctx, actor, wid, _ = setup
    rid = budgets.reserve(ctx, actor, wid, BudgetCounters(attempts=1))
    budgets.reconcile(ctx, actor, wid, rid, usage=None)  # success without reported usage
    assert budget(ctx, wid).unknown.attempts == 1
    assert budget(ctx, wid).spent.attempts == 0


def test_stale_reservations_recovered_as_unknown(setup):
    ctx, actor, wid, _ = setup
    rid = budgets.reserve(ctx, actor, wid, BudgetCounters(attempts=1), purpose='crashed')
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            reservation = next(r for r in store.work_budgets[wid].pending if r.id == rid)
            reservation.created_at = utc_now() - timedelta(minutes=30)
        ctx.service.store = store
    assert budgets.recover_pending(ctx) == 1
    assert budget(ctx, wid).unknown.attempts == 1
    assert budget(ctx, wid).reserved.attempts == 0
    assert budgets.recover_pending(ctx) == 0


def test_denied_actor_cannot_reserve(setup):
    ctx, actor, wid, _ = setup
    project = ctx.service.apply(actor, 'proj', 'project.create', {'name': 'Private'})['project_id']
    ctx.service.store.works[wid].project_id = project
    ctx.persist()
    stranger = Actor(id='stranger', workspace_id='ws_local', display_name='Stranger')
    with pytest.raises(PermissionDeniedError):
        budgets.reserve(ctx, stranger, wid, BudgetCounters(attempts=1))


def test_intake_propose_fails_durably_when_exhausted_then_set_budget_recovers(setup):
    ctx, actor, wid, brief = setup
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps(brief))
    ctx.service.apply(actor, 'cap', 'work.set_budget', {'work_id': wid, 'caps': {'model_attempts': 1}})
    ctx.persist()
    p = propose(ctx, actor, wid, {'command_id': 'i1', 'text': 'Confronta listini', 'expected_version': 1})
    assert p['status'] == 'pending_confirmation'
    assert budget(ctx, wid).spent.attempts + budget(ctx, wid).unknown.attempts == 1
    p2 = propose(ctx, actor, wid, {'command_id': 'i2', 'text': 'Ancora un confronto', 'expected_version': 1})
    assert p2['status'] == 'failed' and p2['error_code'] == 'budget_exhausted'
    assert ctx.repository.load().works[wid].owner_id == actor.id
    # Raising the cap explicitly restores the flow.
    ctx.service.apply(actor, 'cap2', 'work.set_budget', {'work_id': wid, 'caps': {'model_attempts': 3}})
    ctx.persist()
    p3 = propose(ctx, actor, wid, {'command_id': 'i3', 'text': 'Riproviamo il confronto', 'expected_version': 1})
    assert p3['status'] == 'pending_confirmation'


def test_classify_reserves_and_reports_exhaustion(setup):
    ctx, actor, wid, _ = setup
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps({'kind': 'question'}))
    assert classify_message(ctx, actor, wid, 'Una domanda?') == ('question', None)
    # Fake providers report no usage: the attempt is charged, as unknown.
    assert budget(ctx, wid).spent.attempts + budget(ctx, wid).unknown.attempts == 1
    ctx.service.apply(actor, 'cap', 'work.set_budget', {'work_id': wid, 'caps': {'model_attempts': 1}})
    ctx.persist()
    with pytest.raises(BudgetExhaustedError):
        classify_message(ctx, actor, wid, 'Un\'altra domanda?')


def test_set_budget_version_conflict(setup):
    ctx, actor, wid, _ = setup
    ctx.service.apply(actor, 'cap', 'work.set_budget', {'work_id': wid, 'caps': {'model_attempts': 5}})
    ctx.persist()
    with pytest.raises(ConflictError):
        ctx.service.apply(actor, 'cap2', 'work.set_budget',
                          {'work_id': wid, 'expected_version': 1, 'caps': {'model_attempts': 9}})


@pytest.fixture
def http_setup(tmp_path):
    from fastapi.testclient import TestClient
    from homun.context import reset_context_for_tests
    from homun.app import create_app
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    client = TestClient(create_app())
    headers = {'X-Homun-Actor-Id': 'person_fabio'}
    conv = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                       json={'command_id': 'c', 'type': 'conversation.create', 'payload': {'title': 'Test'}}).json()['result']['conversation_id']
    work = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                       json={'command_id': 'w', 'type': 'work.create',
                             'payload': {'conversation_id': conv, 'title': 'Test', 'objective': 'Obiettivo'}}).json()['result']['work_id']
    plain = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                        json={'command_id': 'c2', 'type': 'conversation.create', 'payload': {'title': 'No work'}}).json()['result']['conversation_id']
    yield ctx, client, headers, conv, work, plain
    client.close()
    reset_context_for_tests(None)


def test_message_interpretation_reserves_work_budget_only_for_works(http_setup):
    ctx, client, headers, conv, wid, plain = http_setup
    # Short text stays a reply in the fake provider: one interpret attempt.
    r1 = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                     json={'command_id': 'm1', 'type': 'conversation.post_message',
                           'payload': {'conversation_id': conv, 'text': 'Ciao!'}})
    assert r1.status_code == 200, r1.text
    budget = ctx.repository.load().work_budgets.get(wid)
    assert budget is not None
    assert budget.spent.attempts + budget.unknown.attempts == 1
    # A longer ask becomes a command proposal: interpret + plan extraction.
    r15 = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                      json={'command_id': 'm15', 'type': 'conversation.post_message',
                            'payload': {'conversation_id': conv, 'text': 'Prepariamo il piano del lavoro'}})
    assert r15.status_code == 200, r15.text
    budget = ctx.repository.load().work_budgets.get(wid)
    assert budget.spent.attempts + budget.unknown.attempts == 3
    r2 = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                     json={'command_id': 'm2', 'type': 'conversation.post_message',
                           'payload': {'conversation_id': plain, 'text': 'Ciao!'}})
    assert r2.status_code == 200, r2.text
    # Conversations without a work stay unbudgeted.
    assert plain not in ctx.repository.load().work_budgets


def test_message_interpretation_exhaustion_is_typed_and_not_auto_retried(http_setup):
    ctx, client, headers, conv, wid, plain = http_setup
    client.post('/v1/workspaces/ws_local/commands', headers=headers,
                json={'command_id': 'cap', 'type': 'work.set_budget',
                      'payload': {'work_id': wid, 'caps': {'model_attempts': 1}}})
    r1 = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                     json={'command_id': 'm1', 'type': 'conversation.post_message',
                           'payload': {'conversation_id': conv, 'text': 'Ciao!'}})
    assert r1.status_code == 200, r1.text
    r2 = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                     json={'command_id': 'm2', 'type': 'conversation.post_message',
                           'payload': {'conversation_id': conv, 'text': 'Di nuovo!'}})
    assert r2.status_code == 429
    assert r2.json()['detail']['code'] == 'budget_exhausted'
    record = ctx.repository.load().commands['m2']
    assert record.followup_status == 'failed'
    assert record.followup_next_attempt_at is None  # never auto-retried
    # The user message stays committed; the only unanswered one is m2.
    users = [m for m in ctx.repository.load().messages.values()
             if m.conversation_id == conv and m.author_id == 'person_fabio']
    assert len(users) == 2
    # Raising the cap explicitly restores the conversation.
    client.post('/v1/workspaces/ws_local/commands', headers=headers,
                json={'command_id': 'cap2', 'type': 'work.set_budget',
                      'payload': {'work_id': wid, 'caps': {'model_attempts': 5}}})
    r3 = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                     json={'command_id': 'm2', 'type': 'conversation.post_message',
                           'payload': {'conversation_id': conv, 'text': 'Di nuovo!'}})
    assert r3.status_code == 200
    assert r3.json()['result'].get('assistant_text')


def test_delegated_agent_chats_under_its_allocation(http_setup):
    ctx, client, headers, conv, wid, plain = http_setup
    agent = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                        json={'command_id': 'ag', 'type': 'agent.create',
                              'payload': {'name': 'Bruno', 'role': 'Analisi', 'instructions': 'Analizza'}}).json()['result']['agent_id']
    project = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                          json={'command_id': 'pj', 'type': 'project.create',
                                'payload': {'name': 'P'}}).json()['result']['project_id']
    with ctx.repository.transaction() as store:
        store.works[wid].project_id = project
        store.conversations[conv].project_id = project
    client.post('/v1/workspaces/ws_local/commands', headers=headers,
                json={'command_id': 'gr', 'type': 'grant.issue',
                      'payload': {'project_id': project, 'subject_id': agent, 'capability': 'write'}})
    client.post('/v1/workspaces/ws_local/commands', headers=headers,
                json={'command_id': 'cap', 'type': 'work.set_budget',
                      'payload': {'work_id': wid, 'caps': {'model_attempts': 20},
                                  'allocations': [{'actor_id': agent, 'model_attempts': 1}]}})
    agent_headers = {'X-Homun-Actor-Id': agent, 'X-Homun-Actor-Name': 'Bruno'}
    # The delegated agent can run its supervised turn on the work conversation...
    r1 = client.post('/v1/workspaces/ws_local/commands', headers=agent_headers,
                     json={'command_id': 'am1', 'type': 'conversation.post_message',
                           'payload': {'conversation_id': conv, 'text': 'Stato?'}})
    assert r1.status_code == 200, r1.text
    budget = ctx.repository.load().work_budgets[wid]
    assert budget.allocations[agent].spent.attempts + budget.allocations[agent].unknown.attempts == 1
    # ...until its own allocation is exhausted: typed, while the human can still talk.
    r2 = client.post('/v1/workspaces/ws_local/commands', headers=agent_headers,
                     json={'command_id': 'am2', 'type': 'conversation.post_message',
                           'payload': {'conversation_id': conv, 'text': 'Ancora?'}})
    assert r2.status_code == 429
    assert r2.json()['detail']['code'] == 'budget_exhausted'
    r3 = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                     json={'command_id': 'hm1', 'type': 'conversation.post_message',
                           'payload': {'conversation_id': conv, 'text': 'Ciao!'}})
    assert r3.status_code == 200
    stored = ctx.repository.load().work_budgets[wid]
    assert stored.allocations[agent].spent.attempts + stored.allocations[agent].unknown.attempts == 1


def test_plan_draft_extraction_is_budgeted(http_setup, monkeypatch):
    import homun.application.interpretation as interpretation_mod
    ctx, client, headers, conv, wid, plain = http_setup
    from homun.planning.draft import PlanDraft, PlanStepDraft
    from homun.planning.extract import validate_plan_draft
    draft = validate_plan_draft(
        PlanDraft(objective='Obiettivo di prova', expected_result='Risultato',
                  steps=[PlanStepDraft(title='Passo', assignee_id='', output_expected='Out')]),
        allowed_assignee_ids=set())
    monkeypatch.setattr(interpretation_mod, 'extract_plan_draft', lambda *a, **k: draft)
    from types import SimpleNamespace as NS
    roster = []
    conversation_context = None
    body = NS(command_id='b')
    out = interpretation_mod._budgeted_plan_draft(ctx, ctx.service._context if False else _actor(ctx), _work(ctx, wid), body, 'pianifica il lavoro', roster, conversation_context)
    assert out.objective == draft.objective
    budget = ctx.repository.load().work_budgets[wid]
    assert budget.spent.attempts + budget.unknown.attempts == 1


def _actor(ctx):
    from homun.domain.models import Actor
    return Actor(id='person_fabio', workspace_id=ctx.workspace_id, display_name='Fabio')


def _work(ctx, wid):
    return ctx.repository.load().works[wid]


def test_delegate_allocation_is_its_own_cap(setup):
    ctx, actor, wid, _ = setup
    agent = ctx.service.apply(actor, 'ag', 'agent.create',
                              {'name': 'Bruno', 'role': 'Analisi', 'instructions': 'Analizza'})['agent_id']
    ctx.service.apply(actor, 'cap', 'work.set_budget',
                      {'work_id': wid, 'caps': {'model_attempts': 20},
                       'allocations': [{'actor_id': agent, 'model_attempts': 1}]})
    ctx.persist()
    delegate = Actor(id=agent, workspace_id=ctx.workspace_id, display_name='Bruno', kind='agent')
    rid = budgets.reserve(ctx, delegate, wid, BudgetCounters(attempts=1))
    budgets.reconcile(ctx, delegate, wid, rid)
    stored = ctx.repository.load().work_budgets[wid]
    assert stored.allocations[agent].spent.attempts + stored.allocations[agent].unknown.attempts == 1
    # The delegate is exhausted while the work envelope still has room...
    with pytest.raises(BudgetExhaustedError):
        budgets.reserve(ctx, delegate, wid, BudgetCounters(attempts=1))
    # ...and other actors are unaffected.
    rid2 = budgets.reserve(ctx, actor, wid, BudgetCounters(attempts=1))
    budgets.reconcile(ctx, actor, wid, rid2)
    stored = ctx.repository.load().work_budgets[wid]
    assert stored.allocations[agent].spent.attempts + stored.allocations[agent].unknown.attempts == 1
    # Raising the allocation explicitly restores the delegate.
    ctx.service.apply(actor, 'cap2', 'work.set_budget',
                      {'work_id': wid, 'caps': {'model_attempts': 20},
                       'allocations': [{'actor_id': agent, 'model_attempts': 5}]})
    ctx.persist()
    rid3 = budgets.reserve(ctx, delegate, wid, BudgetCounters(attempts=1))
    budgets.reconcile(ctx, delegate, wid, rid3)
    stored = ctx.repository.load().work_budgets[wid]
    assert stored.allocations[agent].spent.attempts + stored.allocations[agent].unknown.attempts == 2


def test_agent_owner_cannot_approve_concrete_actions_person_gate(setup):
    import hashlib
    from homun.application.material_ingest import ingest_file
    from homun.application.material_reads import approve as read_approve
    from homun.application.material_reads import propose as read_propose
    from homun.application.price_comparisons import approve as compare_approve
    from homun.application.price_comparisons import propose as compare_propose
    ctx, actor, wid, brief = setup
    brief['capability'] = 'compare_csv'
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps(brief))
    from homun.application.intake import confirm as intake_confirm
    from homun.application.intake import propose as intake_propose
    p = intake_propose(ctx, actor, wid, {'command_id': 'i1', 'text': 'Confronta i listini', 'expected_version': 1})
    # Delegate to a fresh agent: it becomes the owner, Fabio stays reviewer.
    brief['new_agent'] = {'name': 'Analista', 'role': 'Analisi', 'instructions': 'Confronta'}
    brief['suggested_agent_id'] = None
    p2 = intake_propose(ctx, actor, wid, {'command_id': 'i2', 'text': 'Con confronto', 'expected_version': 1})
    intake_confirm(ctx, actor, wid, p2['id'], {'command_id': 'ok', 'digest': p2['digest'],
                                               'expected_version': p2['expected_version'], 'create_agent': True})
    store = ctx.repository.load()
    agent_owner = Actor(id=store.works[wid].owner_id, workspace_id=ctx.workspace_id,
                        display_name='Delegato', kind='agent')
    assert store.works[wid].reviewer_id == actor.id

    # CSV: the delegated agent owner cannot approve execution; the human reviewer can.
    project = store.works[wid].project_id or ctx.service.apply(
        actor, 'pj', 'project.create', {'name': 'P'})['project_id']
    ctx.service.store.works[wid].project_id = project
    # Delegation is explicit: a write grant plus the delegated ownership.
    ctx.service.apply(actor, 'gr', 'grant.issue',
                      {'project_id': project, 'subject_id': agent_owner.id, 'capability': 'write'})
    ctx.persist()
    materials = [ingest_file(ctx, actor, command_id=f'mi{i}', project_id=project,
                             filename=f'l{i}.csv', data=f'sku,name,price\nA,A,{i}\n'.encode())['material_id']
                 for i in range(2)]
    version = ctx.repository.load().works[wid].version
    cp = compare_propose(ctx, agent_owner, wid, {'command_id': 'cmp', 'left_material_id': materials[0],
                                                 'right_material_id': materials[1],
                                                 'expected_version': version, 'max_rows': 100})
    from homun.domain.errors import PermissionDeniedError
    with pytest.raises(PermissionDeniedError):
        compare_approve(ctx, agent_owner, wid, cp['id'], {'command_id': 'no', 'digest': cp['digest'],
                                                          'expected_version': cp['expected_version']})
    # Material read: same person gate.
    from homun.domain.models import CommandRecord
    from homun.domain.command_identity import request_fingerprint
    with ctx.repository.transaction() as st:
        st.commands['rd'] = CommandRecord(
            command_id='rd', type='material_read.propose', actor_id=actor.id,
            workspace_id=actor.workspace_id,
            request_fingerprint=request_fingerprint(actor, 'material_read.propose', {'work_id': wid}),
            result={'id': 'rd', 'status': 'pending_approval', 'work_id': wid, 'expected_version': 99,
                    'tool_version': 'material-read-v1', 'material': {'id': materials[0], 'title': 'l0',
                    'sha256': 'x', 'version': 1}, 'limits': {}, 'digest': 'd'})
    with pytest.raises(PermissionDeniedError):
        read_approve(ctx, agent_owner, wid, 'rd', {'command_id': 'no2', 'digest': 'd', 'expected_version': 99})
    assert not ctx.repository.load().artifacts
