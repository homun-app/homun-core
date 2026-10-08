"""Builtin catalog seeding, knowledge-capability defaults, per-agent allowlists."""
from __future__ import annotations

import pytest

from homun.context import create_context
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


def test_seeding_is_idempotent_and_respects_user_changes(ctx):
    from homun.application.skill_seeding import seed_builtin_skills
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    first = seed_builtin_skills(ctx)
    assert len(first['created']) >= 50
    store = ctx.repository.load()
    seeded = [s for s in store.skills.values() if s.author_id == 'homun:builtin']
    assert all(s.status == 'approved' and s.author_type == 'person' for s in seeded)
    assert any(s.name == 'xlsx' for s in seeded)
    assert all(s.description is not None and len(s.description) <= 120 for s in seeded)

    second = seed_builtin_skills(ctx)
    assert second['created'] == [] and len(second['skipped']) == first['total_catalog']

    # A human edit (archive) must survive reseeding.
    target = next(s for s in store.skills.values() if s.name == 'xlsx')
    _apply(ctx, actor, 'arch-xlsx', 'skill.archive',
           {'skill_id': target.id, 'expected_version': target.revision})
    third = seed_builtin_skills(ctx)
    assert third['created'] == []
    archived = next(s for s in ctx.repository.load().skills.values() if s.name == 'xlsx')
    assert archived.status == 'archived'


def test_knowledge_capabilities_default_on_native_and_off_otherwise(ctx, monkeypatch):
    from homun.application import agent_runs, agent_native
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    project = _apply(ctx, actor, 'p1', 'project.create', {'name': 'D'})['project_id']
    conversation = _apply(ctx, actor, 'c1', 'conversation.create',
                          {'title': 'D', 'project_id': project})['conversation_id']
    work = _apply(ctx, actor, 'w1', 'work.create', {
        'conversation_id': conversation, 'title': 'D', 'objective': 'Fai.'})['work_id']
    version = ctx.service.store.works[work].version

    # Without native support: capabilities stay off (fake/plain connections).
    plain = agent_runs.propose(ctx, actor, work, {
        'command_id': 'r-plain', 'expected_version': version, 'material_ids': []})
    assert 'memory' not in plain and 'skills' not in plain
    version = ctx.service.store.works[work].version
    # while a pending plain proposal exists, supersede it by versioning the work
    _apply(ctx, actor, 'w1-note', 'work.create', {
        'conversation_id': conversation, 'title': 'D2', 'objective': 'Fai 2.'})['work_id']

    # With native support: memory and skills come on without asking.
    work2_id = _apply(ctx, actor, 'w2', 'work.create', {
        'conversation_id': conversation, 'title': 'N', 'objective': 'Native.'})['work_id']
    work2 = ctx.service.store.works[work2_id]
    monkeypatch.setattr(agent_native, 'enabled', lambda run: True)
    native = agent_runs.propose(ctx, actor, work2.id, {
        'command_id': 'r-native', 'expected_version': work2.version, 'material_ids': []})
    assert native['memory'] == {'policy': 'scoped-workspace-v1', 'version': 1}
    assert native['skills'] == {'policy': 'workspace-catalog-v1', 'version': 1}
    tools = {t['name'] for t in native['tools']}
    assert 'memory_recall' in tools and 'skill_search' in tools

    # Explicit opt-out still wins.
    work3_id = _apply(ctx, actor, 'w3', 'work.create', {
        'conversation_id': conversation, 'title': 'M', 'objective': 'Muto.'})['work_id']
    work3 = ctx.service.store.works[work3_id]
    muted = agent_runs.propose(ctx, actor, work3.id, {
        'command_id': 'r-muted', 'expected_version': work3.version, 'material_ids': [],
        'memory': False, 'skills': False})
    assert 'memory' not in muted and 'skills' not in muted


def test_project_agent_tool_overrides_become_run_allowlist(ctx, monkeypatch):
    from homun.application import agent_runs, agent_native
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    agent = _apply(ctx, actor, 'ag', 'agent.create', {'name': 'Vega'})['agent_id']
    project = _apply(ctx, actor, 'p1', 'project.create', {
        'name': 'O', 'agent_tool_overrides': {agent: ['list_workspace_files', 'skill_search']}})['project_id']
    conversation = _apply(ctx, actor, 'c1', 'conversation.create',
                          {'title': 'O', 'project_id': project})['conversation_id']
    work = _apply(ctx, actor, 'w1', 'work.create', {
        'conversation_id': conversation, 'title': 'O', 'objective': 'Fai.'})['work_id']
    version = ctx.service.store.works[work].version
    _apply(ctx, actor, 'pl', 'plan.propose', {'work_id': work, 'expected_version': version, 'steps': [
        {'title': 'E', 'assignee_id': agent, 'capability': 'agent_run'}]})
    version = ctx.service.store.works[work].version
    _apply(ctx, actor, 'pl2', 'plan.accept', {'work_id': work, 'expected_version': version})
    version = ctx.service.store.works[work].version
    monkeypatch.setattr(agent_native, 'enabled', lambda run: True)
    run = agent_runs.propose(ctx, actor, work, {
        'command_id': 'r-allow', 'expected_version': version, 'material_ids': []})
    assert run['assignee_id'] == agent
    assert run.get('allowed_tools') == ['list_workspace_files', 'skill_search']
