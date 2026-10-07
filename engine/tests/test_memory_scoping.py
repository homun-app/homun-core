"""Scoped memory: project isolation, agent craft, promotion, and packs."""
from __future__ import annotations

import pytest

from homun.context import create_context
from homun.domain.errors import ValidationError
from homun.domain.models import Actor


@pytest.fixture
def ctx(tmp_path):
    ctx = create_context(db_path=tmp_path / 'engine.db', data_dir=tmp_path, for_tests=True)
    yield ctx
    ctx.close()


def _apply(ctx, actor, command_id, kind, payload):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result = ctx.service.for_store(store).apply(actor, command_id, kind, payload)
        ctx.service.store = store
    return result


def _world(ctx):
    """Two projects, one agent, one owner: the isolation fixture."""
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    agent = _apply(ctx, actor, 'ag', 'agent.create',
                   {'name': 'Atlas', 'autonomy_mode': 'supervised'})['agent_id']
    project_a = _apply(ctx, actor, 'pa', 'project.create', {'name': 'Alpha'})['project_id']
    project_b = _apply(ctx, actor, 'pb', 'project.create', {'name': 'Beta'})['project_id']
    conv_a = _apply(ctx, actor, 'ca', 'conversation.create',
                    {'title': 'A', 'project_id': project_a})['conversation_id']
    conv_b = _apply(ctx, actor, 'cb', 'conversation.create',
                    {'title': 'B', 'project_id': project_b})['conversation_id']
    work_a = _apply(ctx, actor, 'wa', 'work.create', {
        'conversation_id': conv_a, 'title': 'A', 'objective': 'Do A.'})['work_id']
    work_b = _apply(ctx, actor, 'wb', 'work.create', {
        'conversation_id': conv_b, 'title': 'B', 'objective': 'Do B.'})['work_id']
    return actor, agent, project_a, project_b, work_a, work_b


def _recall(ctx, *, project_id, work_id=None, agent_id=None, query='listin'):
    return ctx.memory.recall(
        query, project_id=project_id, work_id=work_id, agent_id=agent_id,
        include_global=False, limit=20)


def test_run_recall_is_project_and_craft_scoped(ctx):
    actor, agent, project_a, project_b, work_a, work_b = _world(ctx)
    ctx.memory.add_approved(text='Il listino Alpha usa colonne fissate', actor_id=actor.id,
                            project_id=project_a, scope='project')
    ctx.memory.add_approved(text='Il listino Beta e privato di Beta', actor_id=actor.id,
                            project_id=project_b, scope='project')
    ctx.memory.add_approved(text='Nei listini ordina sempre per codice', actor_id=actor.id,
                            scope='agent', subject_id=agent)
    ctx.memory.add_approved(text='Listini: nota globale workspace', actor_id=actor.id)
    ctx.memory.add_approved(text='Il listino preferito di Fabio e compatto', actor_id=actor.id,
                            scope='person', subject_id=actor.id)

    # Run on project A: sees A's note + craft, not B, not global, not person.
    seen_a = _recall(ctx, project_id=project_a, work_id=work_a, agent_id=agent)
    texts_a = {n.text for n in seen_a}
    assert 'Il listino Alpha usa colonne fissate' in texts_a
    assert 'Nei listini ordina sempre per codice' in texts_a
    assert 'Il listino Beta e privato di Beta' not in texts_a
    assert 'Listini: nota globale workspace' not in texts_a
    assert 'Il listino preferito di Fabio e compatto' not in texts_a

    # Run on project B with a different agent: craft of that agent only.
    seen_b = _recall(ctx, project_id=project_b, work_id=work_b, agent_id='agent_other')
    texts_b = {n.text for n in seen_b}
    assert 'Il listino Beta e privato di Beta' in texts_b
    assert 'Nei listini ordina sempre per codice' not in texts_b


def test_memory_remember_from_run_never_lands_global(ctx):
    from homun.application.memory_tools import execute
    actor, agent, project_a, project_b, work_a, work_b = _world(ctx)
    # A work without a project (conversation-less project context).
    conv = _apply(ctx, actor, 'cx', 'conversation.create', {'title': 'free'})['conversation_id']
    free_work = _apply(ctx, actor, 'wx', 'work.create', {
        'conversation_id': conv, 'title': 'free', 'objective': 'No project.'})['work_id']
    run = {'memory': {'policy': 'scoped-workspace-v1'}, 'work_id': free_work,
           'assignee_id': agent}
    outcome = execute(ctx, actor, run, 'memory_remember',
                      {'text': 'Le consegne senza progetto restano nel work'})
    assert outcome['status'] == 'stored'
    note = next(n for n in ctx.memory.list(include_deleted=False)
                if n.text == 'Le consegne senza progetto restano nel work')
    assert note.scope == 'project'
    assert note.project_id is None
    assert note.work_id == free_work
    # And it is not visible from another project's run.
    seen = _recall(ctx, project_id=project_a, work_id=work_a, agent_id=agent,
                   query='consegne senza progetto')
    assert seen == []


def test_promote_to_agent_craft(ctx):
    from homun.application.memory_promote import promote_to_agent
    actor, agent, project_a, project_b, work_a, work_b = _world(ctx)
    source = ctx.memory.add_approved(
        text='Nei listini allinea sempre le colonne prima di totals', actor_id=actor.id,
        project_id=project_a, scope='project')
    result = promote_to_agent(ctx, actor, source.id, agent)
    assert result['status'] == 'promoted'
    craft = ctx.memory.list(scope='agent', subject_id=agent)[0]
    assert craft.source_memory_id == source.id
    assert craft.scope == 'agent'
    # The project original stays untouched.
    original = [n for n in ctx.memory.list(project_id=project_a) if n.id == source.id]
    assert original and original[0].scope == 'project'
    # Second promotion of the same text is a duplicate, not a second note.
    again = promote_to_agent(ctx, actor, source.id, agent)
    assert again['status'] == 'duplicate'
    # Craft follows the agent into the other project.
    seen = _recall(ctx, project_id=project_b, work_id=work_b, agent_id=agent, query='colonne')
    assert any('allinea sempre le colonne' in n.text for n in seen)


def test_promote_refuses_entity_references_and_bad_targets(ctx):
    from homun.application.memory_promote import promote_to_agent
    from homun.domain.errors import NotFoundError, ValidationError
    actor, agent, project_a, project_b, work_a, work_b = _world(ctx)
    leaky = ctx.memory.add_approved(
        text=f'Il cliente di proj {project_a} vuole i totali in grassetto', actor_id=actor.id,
        project_id=project_a, scope='project')
    with pytest.raises(ValidationError):
        promote_to_agent(ctx, actor, leaky.id, agent)
    with pytest.raises(NotFoundError):
        promote_to_agent(ctx, actor, 'mem_missing', agent)
    agent_actor = Actor(id=agent, workspace_id=ctx.workspace_id, display_name='Atlas', kind='agent')
    clean = ctx.memory.add_approved(text='Regola pulita', actor_id=actor.id,
                                    project_id=project_a, scope='project')
    with pytest.raises(ValidationError):
        promote_to_agent(ctx, agent_actor, clean.id, agent)


def test_agent_pack_export_import_roundtrip(ctx, tmp_path):
    from homun.application.memory_packs import export_pack, import_pack
    actor, agent, project_a, project_b, work_a, work_b = _world(ctx)
    ctx.memory.add_approved(text='Metodo: verifica i totali con la somma per colonna',
                            actor_id=actor.id, scope='agent', subject_id=agent)
    project_note = ctx.memory.add_approved(text='Dato riservato del progetto Alpha',
                                           actor_id=actor.id, project_id=project_a, scope='project')
    skill = _apply(ctx, actor, 'sk', 'skill.create', {
        'name': 'listini-allestitura', 'description': 'Metodo listini',
        'body': '# Listini\n1. Allinea colonne', 'author_type': 'agent', 'author_id': agent})
    _apply(ctx, actor, 'sk-ap', 'skill.approve',
           {'skill_id': skill['skill_id'], 'expected_version': 1})

    pack = export_pack(ctx, agent)
    assert pack['agent']['name'] == 'Atlas'
    assert any('verifica i totali' in m['text'] for m in pack['memories'])
    assert all(project_note.text != m['text'] for m in pack['memories'])
    assert [s['name'] for s in pack['skills']] == ['listini-allestitura']

    # A different Homun installation: a fresh context receives the dossier.
    other = create_context(db_path=tmp_path / 'other.db', data_dir=tmp_path / 'other',
                           for_tests=True)
    try:
        imported = import_pack(other, actor, pack)
        assert imported['memories'] == 1 and imported['skills'] == 1
        new_agent = imported['agent_id']
        craft = other.memory.list(scope='agent', subject_id=new_agent)
        assert any('verifica i totali' in n.text for n in craft)
        store = other.repository.load()
        imported_skill = next(s for s in store.skills.values() if s.author_id == new_agent)
        assert imported_skill.status == 'staged'
        with pytest.raises(ValidationError):
            import_pack(other, actor, pack)  # same name twice is refused
    finally:
        other.close()
