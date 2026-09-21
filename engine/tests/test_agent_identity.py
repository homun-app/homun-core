"""Professional identity on agent profiles: structured, versioned, validated."""
import pytest

from homun.context import create_context
from homun.domain.errors import ValidationError
from homun.domain.models import Actor


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_fabio', workspace_id=ctx.workspace_id, display_name='Fabio')
    yield ctx, actor
    ctx.close()


def test_create_carries_full_identity(setup):
    ctx, actor = setup
    result = ctx.service.apply(actor, 'a', 'agent.create', {
        'name': 'Chiara',
        'role': 'Analista di listini',
        'instructions': 'Confronta i listini assegnati.',
        'responsibility': 'Produrre confronti accurati e verificabili.',
        'specializations': ['Confronto CSV', 'Analisi prezzi'],
        'method': 'Prima verifica le fonti, poi confronta, sempre con riferimenti.',
        'tone': 'Chiaro e sintetico',
        'autonomy_mode': 'supervised',
    })
    ctx.persist()
    agent = ctx.repository.load().agents[result['agent_id']]
    assert agent.responsibility == 'Produrre confronti accurati e verificabili.'
    assert agent.specializations == ['Confronto CSV', 'Analisi prezzi']
    assert agent.method.startswith('Prima verifica')
    assert agent.tone == 'Chiaro e sintetico'
    assert agent.autonomy_mode == 'supervised'


def test_defaults_are_safe_and_empty(setup):
    ctx, actor = setup
    result = ctx.service.apply(actor, 'a', 'agent.create', {
        'name': 'Bruno', 'role': 'Analista', 'instructions': 'Analizza dati.'})
    ctx.persist()
    agent = ctx.repository.load().agents[result['agent_id']]
    assert agent.responsibility == ''
    assert agent.specializations == []
    assert agent.method == ''
    assert agent.tone == ''
    assert agent.autonomy_mode == 'supervised'


def test_update_changes_identity_selectively(setup):
    ctx, actor = setup
    created = ctx.service.apply(actor, 'a', 'agent.create', {
        'name': 'Elena', 'role': 'Letttrice', 'instructions': 'Legge.',
        'responsibility': 'Leggere i documenti assegnati.',
        'specializations': ['Lettura documenti'], 'tone': 'Diretto'})
    updated = ctx.service.apply(actor, 'u', 'agent.update', {
        'agent_id': created['agent_id'], 'expected_version': 1,
        'specializations': ['Lettura documenti', 'Verifica provenienza'],
        'autonomy_mode': 'autonomous'})
    ctx.persist()
    agent = ctx.repository.load().agents[created['agent_id']]
    assert agent.responsibility == 'Leggere i documenti assegnati.'  # untouched
    assert agent.specializations == ['Lettura documenti', 'Verifica provenienza']
    assert agent.autonomy_mode == 'autonomous'
    assert updated['revision'] == 2


def test_invalid_autonomy_and_specializations_rejected(setup):
    ctx, actor = setup
    with pytest.raises(ValidationError):
        ctx.service.apply(actor, 'a', 'agent.create', {
            'name': 'Test', 'role': 'R', 'instructions': 'I.',
            'autonomy_mode': 'unlimited'})
    with pytest.raises(ValidationError):
        ctx.service.apply(actor, 'a2', 'agent.create', {
            'name': 'Test2', 'role': 'R', 'instructions': 'I.',
            'specializations': 'not-a-list'})


def test_intake_created_agent_carries_identity(setup):
    """The intake confirm passes the brief's identity fields into agent.create."""
    import json
    from types import SimpleNamespace
    from homun.application.intake import confirm as intake_confirm
    from homun.application.intake import propose as intake_propose
    ctx, actor = setup
    conv = ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'Nuova richiesta'})
    wid = ctx.service.apply(actor, 'w', 'work.create', {
        'conversation_id': conv['conversation_id'],
        'title': 'Nuova richiesta', 'objective': 'Obiettivo da concordare'})['work_id']
    ctx.persist()
    brief = {
        'title': 'Confronto listini', 'objective': 'Variazioni di prezzo.',
        'output': 'Report e CSV', 'constraints': [], 'missing_information': [],
        'suggested_agent_id': None,
        'new_agent': {
            'name': 'Chiara', 'role': 'Analista di listini',
            'instructions': 'Confronta i listini assegnati.',
            'responsibility': 'Confronti accurati e verificabili.',
            'specializations': ['Confronto CSV', 'Analisi prezzi'],
            'method': 'Verifica fonti poi confronta.',
            'tone': 'Chiaro e sintetico',
        },
        'rationale': 'ok', 'capability': 'compare_csv', 'changed_fields': []}
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps(brief))
    p = intake_propose(ctx, actor, wid, {'command_id': 'i', 'text': 'Confronta i listini', 'expected_version': 1})
    intake_confirm(ctx, actor, wid, p['id'], {
        'command_id': 'ok', 'digest': p['digest'], 'expected_version': 1, 'create_agent': True})
    agents = [a for a in ctx.repository.load().agents.values() if a.name == 'Chiara']
    assert len(agents) == 1
    assert agents[0].responsibility == 'Confronti accurati e verificabili.'
    assert agents[0].specializations == ['Confronto CSV', 'Analisi prezzi']
    assert agents[0].tone == 'Chiaro e sintetico'
