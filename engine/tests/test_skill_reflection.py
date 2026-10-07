"""Post-run skill reflection, the in-run skill_patch tool, and usage tracking."""
from __future__ import annotations

from types import SimpleNamespace

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


def _completed_run(ctx, actor, *, skills=True, messages=None, agent_id=None):
    import uuid as _uuid
    unique = _uuid.uuid4().hex[:8]
    agent_id = agent_id or _apply(ctx, actor, f'ag-{unique}', 'agent.create',
                                  {'name': f'Atlas-{unique}'})['agent_id']
    project = _apply(ctx, actor, f'p-{unique}', 'project.create', {'name': 'P'})['project_id']
    conversation = _apply(ctx, actor, f'c-{unique}', 'conversation.create',
                          {'title': 'P', 'project_id': project})['conversation_id']
    work = _apply(ctx, actor, f'w-{unique}', 'work.create', {
        'conversation_id': conversation, 'title': 'L',
        'objective': 'Prepara il listino.'})['work_id']
    from homun.application.agent_runs import propose
    proposal = propose(ctx, actor, work,
                       {'command_id': f'run-{unique}', 'expected_version': 1, 'material_ids': []})
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = store.commands[proposal['id']].result
            if skills:
                run['skills'] = {'policy': 'workspace-catalog-v1', 'version': 1}
            run['assignee_id'] = agent_id
            run.update(status='completed',
                       _actor=actor.model_dump(mode='json'),
                       _messages=messages or [
                           {'role': 'user', 'content': 'Prepara il listino Alpha'},
                           {'role': 'assistant', 'content': 'Fatto, colonne allineate.'},
                       ])
        ctx.service.store = store
    return proposal['id'], work, agent_id


def _fake_model(payload: dict):
    import json
    text = json.dumps(payload)

    def complete(messages, **kwargs):
        return SimpleNamespace(text=text, model_id='fake', provider_id='fake', usage=None)

    return complete


def test_reflection_patches_and_proposes_staged(ctx):
    from homun.application.skill_reflection import maybe_reflect
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    run_id, work, agent_id = _completed_run(ctx, actor)
    skill = _apply(ctx, actor, 'sk', 'skill.create', {
        'name': 'listini', 'description': 'Metodo listini', 'body': '# Listini\n1. Allinea',
        'author_type': 'agent', 'author_id': agent_id})
    _apply(ctx, actor, 'sk-ap', 'skill.approve',
           {'skill_id': skill['skill_id'], 'expected_version': 1})

    ctx.models.complete = _fake_model({
        'proposals': [
            {'action': 'patch', 'skill_id': skill['skill_id'], 'expected_version': 2,
             'body': '# Listini\n1. Allinea\n2. Verifica i totali'},
            {'action': 'propose', 'name': 'consegne-listini', 'description': 'Consegne',
             'body': '# Consegne\n1. Tre capitoli', 'tags': ['listini']},
        ],
        'summary': 'due lezioni',
    })
    assert maybe_reflect(ctx, run_id) is True
    store = ctx.repository.load()
    patched = store.skills[skill['skill_id']]
    assert patched.status == 'staged'          # back to quarantine
    assert patched.revision == 3               # approve bumped to 2, patch to 3
    assert 'Verifica i totali' in patched.body
    proposed = next(s for s in store.skills.values() if s.name == 'consegne-listini')
    assert proposed.status == 'staged'
    assert proposed.author_id == agent_id

    # Idempotent: the marker prevents a second reflection.
    ctx.models.complete = _fake_model({'proposals': [], 'summary': ''})
    assert maybe_reflect(ctx, run_id) is False
    assert f'{run_id}:reflect' in ctx.repository.load().commands


def test_reflection_requires_skills_capability_and_transcript(ctx):
    from homun.application.skill_reflection import maybe_reflect
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    plain_id, _, _ = _completed_run(ctx, actor, skills=False)
    assert maybe_reflect(ctx, plain_id) is False
    empty_id, _, _ = _completed_run(ctx, actor, messages=[{'role': 'user', 'content': ''}])
    assert maybe_reflect(ctx, empty_id) is False
    assert f'{empty_id}:reflect' not in ctx.repository.load().commands


def test_reflection_survives_bad_payload(ctx):
    from homun.application.skill_reflection import maybe_reflect
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    run_id, work, agent_id = _completed_run(ctx, actor)

    def broken(messages, **kwargs):
        return SimpleNamespace(text='non json', model_id='f', provider_id='f', usage=None)

    ctx.models.complete = broken
    assert maybe_reflect(ctx, run_id) is False
    # The marker is still written: a broken model does not retry forever.
    assert f'{run_id}:reflect' in ctx.repository.load().commands


def test_skill_patch_tool_guards_and_usage_tracking(ctx):
    from homun.application.skill_tools import execute
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    run = {'skills': {'policy': 'workspace-catalog-v1'}, 'work_id': None, 'assignee_id': None}
    agent_skill = _apply(ctx, actor, 'sk1', 'skill.create', {
        'name': 'listini', 'body': 'A', 'author_type': 'agent', 'author_id': 'agent_x'})
    _apply(ctx, actor, 'sk1-ap', 'skill.approve',
           {'skill_id': agent_skill['skill_id'], 'expected_version': 1})
    person_skill = _apply(ctx, actor, 'sk2', 'skill.create', {
        'name': 'personale', 'body': 'B', 'author_type': 'person', 'status': 'approved'})

    # Viewing an approved skill tracks usage.
    view = execute(ctx, actor, run, 'skill_view', {'skill_id': agent_skill['skill_id']})
    assert view['usage_count'] >= 1
    store = ctx.repository.load()
    assert store.skills[agent_skill['skill_id']].usage_count >= 1
    assert store.skills[agent_skill['skill_id']].last_used_at is not None

    # The agent may patch agent-authored skills only.
    denied = execute(ctx, actor, run, 'skill_patch',
                     {'skill_id': person_skill['skill_id'], 'body': 'new'})
    assert denied['error_code'] == 'skill_not_agent_managed'
    outcome = execute(ctx, actor, run, 'skill_patch',
                      {'skill_id': agent_skill['skill_id'], 'body': '# Listini\n1. Allinea\n2. Totali'})
    assert outcome['status'] == 'staged'
    assert outcome['revision'] == 3
    store = ctx.repository.load()
    assert store.skills[agent_skill['skill_id']].status == 'staged'
    assert 'Totali' in store.skills[agent_skill['skill_id']].body

    with pytest.raises(ValidationError):
        execute(ctx, actor, {'skills': {}}, 'skill_view', {'skill_id': agent_skill['skill_id']})
