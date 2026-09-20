"""A replay key identifies one request, not arbitrary future mutations."""
import pytest

from homun.domain.errors import ConflictError, ValidationError
from homun.domain.models import Actor, CommandRecord
from homun.domain.service import DomainService
from homun.domain.store import WorkspaceStore
from homun.storage.sqlite import SqliteWorkspaceRepository


def actor(identity='person_fabio'):
    return Actor(id=identity, workspace_id='ws_test', display_name=identity)


def test_equivalent_json_order_replays_without_events():
    service = DomainService(WorkspaceStore('ws_test'))
    result = service.apply(actor(), 'cmd_1', 'conversation.create', {'title': 'A', 'extra': {'a': 1, 'b': 2}})
    count = len(service.store.events)
    assert service.apply(actor(), 'cmd_1', 'conversation.create', {'extra': {'b': 2, 'a': 1}, 'title': 'A'}) == result
    assert len(service.store.events) == count


@pytest.mark.parametrize('other_actor,payload', [(actor(), {'title': 'B'}), (actor('person_other'), {'title': 'A'})])
def test_same_key_with_changed_request_rejected(other_actor, payload):
    service = DomainService(WorkspaceStore('ws_test'))
    service.apply(actor(), 'cmd_1', 'conversation.create', {'title': 'A'})
    with pytest.raises(ConflictError):
        service.apply(other_actor, 'cmd_1', 'conversation.create', payload)
    assert len(service.store.conversations) == 1


def test_legacy_unverifiable_record_does_not_replay():
    service = DomainService(WorkspaceStore('ws_test'))
    service.store.commands['legacy'] = CommandRecord(command_id='legacy', type='conversation.create', actor_id=actor().id, workspace_id='ws_test', result={'private': True})
    with pytest.raises(ConflictError):
        service.apply(actor(), 'legacy', 'conversation.create', {'title': 'A'})


def test_fingerprint_survives_restart(tmp_path):
    path = tmp_path / 'workspace.db'
    repo = SqliteWorkspaceRepository(path, 'ws_test')
    service = DomainService(repo.load())
    result = service.apply(actor(), 'cmd_1', 'conversation.create', {'title': 'A'})
    repo.save(service.store)
    repo.close()
    repo = SqliteWorkspaceRepository(path, 'ws_test')
    try:
        service = DomainService(repo.load())
        assert service.apply(actor(), 'cmd_1', 'conversation.create', {'title': 'A'}) == result
        with pytest.raises(ConflictError):
            service.apply(actor(), 'cmd_1', 'conversation.create', {'title': 'B'})
    finally:
        repo.close()


def test_non_json_number_rejected_before_mutation():
    service = DomainService(WorkspaceStore('ws_test'))
    with pytest.raises(ValidationError):
        service.apply(actor(), 'cmd_nan', 'conversation.create', {'title': 'A', 'n': float('nan')})
    assert not service.store.conversations
