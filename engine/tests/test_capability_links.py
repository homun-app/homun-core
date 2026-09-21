"""Capability links on agent profiles: validated, queryable, drive recommendations."""
import json
from types import SimpleNamespace

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


def test_capabilities_validated_against_registry(setup):
    ctx, actor = setup
    result = ctx.service.apply(actor, 'a', 'agent.create', {
        'name': 'Chiara', 'role': 'Analista', 'instructions': 'Analizza.',
        'capabilities': ['compare_csv', 'read_material']})
    ctx.persist()
    agent = ctx.repository.load().agents[result['agent_id']]
    assert agent.capabilities == ['compare_csv', 'read_material']
    with pytest.raises(ValidationError):
        ctx.service.apply(actor, 'b', 'agent.create', {
            'name': 'Fake', 'role': 'R', 'instructions': 'I.', 'capabilities': ['browse_web']})


def test_capabilities_update_selectively(setup):
    ctx, actor = setup
    created = ctx.service.apply(actor, 'a', 'agent.create', {
        'name': 'Chiara', 'role': 'Analista', 'instructions': 'I.', 'capabilities': ['compare_csv']})
    ctx.persist()
    ctx.service.apply(actor, 'u', 'agent.update', {
        'agent_id': created['agent_id'], 'expected_version': 1,
        'capabilities': ['compare_csv', 'read_material']})
    ctx.persist()
    agent = ctx.repository.load().agents[created['agent_id']]
    assert agent.capabilities == ['compare_csv', 'read_material']


def test_intake_recommends_agent_with_matching_capability_link(setup):
    """When two agents exist and only one has the capability link, the engine
    corrects the model's recommendation to the linked one."""
    from homun.application.intake import propose as intake_propose
    ctx, actor = setup
    linked = ctx.service.apply(actor, 'linked', 'agent.create', {
        'name': 'Chiara', 'role': 'Analista di listini CSV',
        'instructions': 'Confronta listini.', 'capabilities': ['compare_csv']})
    other = ctx.service.apply(actor, 'other', 'agent.create', {
        'name': 'Bruno', 'role': 'Ricercatore generico',
        'instructions': 'Fa ricerca.'})  # no capability link
    ctx.persist()
    conv = ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'Nuova richiesta'})
    wid = ctx.service.apply(actor, 'w', 'work.create', {
        'conversation_id': conv['conversation_id'],
        'title': 'Nuova richiesta', 'objective': 'Obiettivo da concordare'})['work_id']
    ctx.persist()
    # The model recommends Bruno (no capability link) even though Chiara has one.
    brief = {
        'title': 'Confronto listini', 'objective': 'Variazioni di prezzo.',
        'output': 'Report e CSV', 'constraints': [], 'missing_information': [],
        'suggested_agent_id': other['agent_id'], 'new_agent': None,
        'rationale': 'ok', 'capability': 'compare_csv', 'changed_fields': []}
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps(brief))
    p = intake_propose(ctx, actor, wid, {'command_id': 'i', 'text': 'Confronta i listini', 'expected_version': 1})
    # Engine-side correction: the agent WITH the capability link wins.
    assert p['suggested_agent']['id'] == linked['agent_id']
    assert p['suggested_agent']['name'] == 'Chiara'


def test_intake_new_agent_carries_capabilities(setup):
    from homun.application.intake import confirm as intake_confirm
    from homun.application.intake import propose as intake_propose
    ctx, actor = setup
    conv = ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'Nuova richiesta'})
    wid = ctx.service.apply(actor, 'w', 'work.create', {
        'conversation_id': conv['conversation_id'],
        'title': 'Nuova richiesta', 'objective': 'Obiettivo da concordare'})['work_id']
    ctx.persist()
    brief = {
        'title': 'Confronto listini', 'objective': 'Variazioni.', 'output': 'Report',
        'constraints': [], 'missing_information': [], 'suggested_agent_id': None,
        'new_agent': {'name': 'Elena', 'role': 'Letttrice', 'instructions': 'Legge.',
                      'responsibility': 'Leggere i documenti.', 'specializations': ['Lettura'],
                      'method': '', 'tone': 'Diretto', 'capabilities': ['read_material']},
        'rationale': 'ok', 'capability': 'read_material', 'changed_fields': []}
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps(brief))
    p = intake_propose(ctx, actor, wid, {'command_id': 'i', 'text': 'Leggi i documenti', 'expected_version': 1})
    intake_confirm(ctx, actor, wid, p['id'], {
        'command_id': 'ok', 'digest': p['digest'], 'expected_version': 1, 'create_agent': True})
    agents = [a for a in ctx.repository.load().agents.values() if a.name == 'Elena']
    assert len(agents) == 1
    assert agents[0].capabilities == ['read_material']


def test_roster_sent_to_model_includes_capabilities(setup):
    from homun.application.intake import propose as intake_propose
    ctx, actor = setup
    ctx.service.apply(actor, 'a', 'agent.create', {
        'name': 'Chiara', 'role': 'Analista', 'instructions': 'I.', 'capabilities': ['compare_csv']})
    ctx.persist()
    conv = ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'N'})
    wid = ctx.service.apply(actor, 'w', 'work.create', {
        'conversation_id': conv['conversation_id'], 'title': 'N', 'objective': 'O'})['work_id']
    ctx.persist()
    seen = []
    def model(messages):
        seen.append(json.loads(messages[-1].content))
        return SimpleNamespace(text=json.dumps({
            'title': 'T', 'objective': 'O', 'output': 'Out', 'constraints': [],
            'missing_information': [], 'suggested_agent_id': None, 'new_agent': None,
            'rationale': 'r', 'capability': 'general', 'changed_fields': []}))
    ctx.models.complete = model
    intake_propose(ctx, actor, wid, {'command_id': 'i', 'text': 'Test', 'expected_version': 1})
    assert seen[0]['agents'][0]['capabilities'] == ['compare_csv']
