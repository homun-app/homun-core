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
    from intake_setup import front_door_intake
    p = front_door_intake(ctx, actor, wid, brief, command_id='i', confirm=False)
    # Engine-side correction: the agent WITH the capability link wins.
    assert p['suggested_agent']['id'] == linked['agent_id']
    assert p['suggested_agent']['name'] == 'Chiara'


def test_intake_new_agent_carries_capabilities(setup):
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
    from intake_setup import front_door_intake
    front_door_intake(ctx, actor, wid, brief, command_id='i', text='Leggi i documenti', create_agent=True)
    agents = [a for a in ctx.repository.load().agents.values() if a.name == 'Elena']
    assert len(agents) == 1
    assert agents[0].capabilities == ['read_material']


def test_agent_catalog_for_the_turn_includes_capabilities(setup):
    """Il catalogo che il turno di ingresso valida (e il modello vede nel
    preamble) porta i link di capacità reali degli agenti attivi."""
    from homun.application.work.intake_policy import active_agents
    ctx, actor = setup
    ctx.service.apply(actor, 'a', 'agent.create', {
        'name': 'Chiara', 'role': 'Analista', 'instructions': 'I.', 'capabilities': ['compare_csv']})
    ctx.persist()
    agents = active_agents(ctx.repository.load())
    chiara = next(a for a in agents if a['name'] == 'Chiara')
    assert chiara['capabilities'] == ['compare_csv']
