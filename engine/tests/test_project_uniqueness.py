"""I progetti attivi hanno nome univoco; l'auto-create da lavoro riusa l'omonimo."""
from __future__ import annotations

import pytest

from homun.context import create_context
from homun.domain.errors import ValidationError
from homun.domain.models import Actor


@pytest.fixture
def ctx(tmp_path):
    ctx = create_context(db_path=tmp_path / 'proj.db', data_dir=tmp_path, for_tests=True)
    yield ctx
    ctx.close()


def _apply(ctx, actor, command_id, kind, payload):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result = ctx.service.for_store(store).apply(actor, command_id, kind, payload)
        ctx.service.store = store
    return result


def test_create_rejects_duplicate_active_name(ctx):
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    _apply(ctx, actor, 'p1', 'project.create', {'name': 'Catalogo'})
    with pytest.raises(ValidationError):
        _apply(ctx, actor, 'p2', 'project.create', {'name': '  catalogo '})
    # case-insensitive e trim: stesso nome rifiutato


def test_rename_rejects_name_of_another_project(ctx):
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    a = _apply(ctx, actor, 'p1', 'project.create', {'name': 'Alpha'})
    b = _apply(ctx, actor, 'p2', 'project.create', {'name': 'Beta'})
    with pytest.raises(ValidationError):
        _apply(ctx, actor, 'p3', 'project.update', {
            'project_id': b['project_id'], 'expected_version': 1, 'name': 'alpha'})


def test_archived_name_can_be_reused(ctx):
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    a = _apply(ctx, actor, 'p1', 'project.create', {'name': 'Gamma'})
    _apply(ctx, actor, 'p2', 'project.archive', {
        'project_id': a['project_id'], 'expected_version': 1})
    c = _apply(ctx, actor, 'p3', 'project.create', {'name': 'Gamma'})
    assert c['project_id'] != a['project_id']


def test_auto_create_from_conversation_reuses_same_name(ctx):
    """Il titolo del lavoro genera nomi ripetuti: si aggrega al progetto omonimo."""
    from homun.domain.commands.projects import _project_create_from_conversation
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    first = _apply(ctx, actor, 'c1', 'conversation.create', {'title': 'Spedizioni'})
    second = _apply(ctx, actor, 'c2', 'conversation.create', {'title': 'Spedizioni 2'})
    made = _apply(ctx, actor, 'pc1', 'project.create_from_conversation', {
        'conversation_id': first['conversation_id'],
        'expected_version': 1, 'name': 'Spedizioni'})
    reused = _apply(ctx, actor, 'pc2', 'project.create_from_conversation', {
        'conversation_id': second['conversation_id'],
        'expected_version': 1, 'name': 'Spedizioni'})
    assert reused['project_id'] == made['project_id']
    assert reused.get('reused') is True
