"""Governance: archiviazione reversibile di lavori e conversazioni via command bus."""
import pytest

from homun.context import create_context
from homun.domain.errors import ConflictError, PermissionDeniedError
from homun.domain.models import Actor


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ctx.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='owner', workspace_id=ctx.workspace_id, display_name='Owner')
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        project = svc.apply(actor, 'proj', 'project.create', {'name': 'P'})['project_id']
        conv = svc.apply(actor, 'conv', 'conversation.create',
                         {'title': 'Chat', 'project_id': project})['conversation_id']
        work = svc.apply(actor, 'work', 'work.create',
                         {'conversation_id': conv, 'title': 'Lavoro',
                          'objective': 'Fare'})['work_id']
    yield ctx, actor, conv, work
    ctx.close()


def test_work_archive_and_restore_roundtrip(setup):
    ctx, actor, conv, work = setup
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        archived = svc.apply(actor, 'a1', 'work.archive',
                             {'work_id': work, 'expected_version': 1})
        assert archived['archived'] is True
        assert store.works[work].archived is True
        assert store.works[work].version == 2
        restored = svc.apply(actor, 'a2', 'work.archive',
                             {'work_id': work, 'expected_version': 2, 'restore': True})
        assert restored['archived'] is False
        assert store.works[work].archived is False


def test_work_archive_requires_write_access(setup):
    ctx, actor, conv, work = setup
    stranger = Actor(id='stranger', workspace_id=ctx.workspace_id, display_name='Stranger')
    with ctx.repository.transaction() as store:
        with pytest.raises(PermissionDeniedError):
            ctx.service.for_store(store).apply(stranger, 's1', 'work.archive',
                                               {'work_id': work, 'expected_version': 1})


def test_work_archive_version_conflict(setup):
    ctx, actor, conv, work = setup
    with ctx.repository.transaction() as store:
        with pytest.raises(ConflictError):
            ctx.service.for_store(store).apply(actor, 'v1', 'work.archive',
                                               {'work_id': work, 'expected_version': 99})


def test_conversation_archive_and_restore_roundtrip(setup):
    ctx, actor, conv, work = setup
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        archived = svc.apply(actor, 'c1', 'conversation.archive',
                             {'conversation_id': conv, 'expected_version': 1})
        assert archived['archived'] is True
        assert store.conversations[conv].archived is True
        restored = svc.apply(actor, 'c2', 'conversation.archive',
                             {'conversation_id': conv, 'expected_version': 2, 'restore': True})
        assert restored['archived'] is False


def test_conversation_archive_requires_write_access(setup):
    ctx, actor, conv, work = setup
    stranger = Actor(id='stranger', workspace_id=ctx.workspace_id, display_name='Stranger')
    with ctx.repository.transaction() as store:
        with pytest.raises(PermissionDeniedError):
            ctx.service.for_store(store).apply(stranger, 's2', 'conversation.archive',
                                               {'conversation_id': conv, 'expected_version': 1})
