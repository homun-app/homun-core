import json
import pytest
from homun.application.session_manager import SessionManager
from homun.application.session_storage import SessionStorage

@pytest.fixture
def pair(tmp_path):
    storage = SessionStorage(tmp_path / 'sessions.sqlite')
    a = SessionManager('workspace-a', storage)
    b = SessionManager('workspace-b', storage)
    session = a.create_session(title='Private A')
    a.add_message(session.id, 'user', 'private content')
    yield a, b, session
    storage.close()

def test_get_and_messages_do_not_cross_workspaces(pair):
    a, b, session = pair
    assert b.get_session(session.id) is None
    with pytest.raises(ValueError): b.get_messages(session.id)

@pytest.mark.parametrize('operation', ['resume', 'update', 'delete', 'rewind', 'fork', 'export', 'usage', 'record_usage', 'parent'])
def test_foreign_session_operations_are_rejected(pair, operation):
    a, b, session = pair
    sid = session.id
    calls = {
        'resume': lambda: b.resume_session(sid),
        'update': lambda: b.update_session(sid, title='Changed'),
        'delete': lambda: b.delete_session(sid, hard=True),
        'rewind': lambda: b.rewind_session(sid, 0),
        'fork': lambda: b.fork_session(sid),
        'export': lambda: b.export_session(sid),
        'usage': lambda: b.get_usage(sid),
        'record_usage': lambda: b.record_usage(sid, 50, 40, 2.0),
        'parent': lambda: b.create_session(parent_id=sid),
    }
    with pytest.raises(ValueError): calls[operation]()
    assert a.get_session(sid).title == 'Private A'
    assert a.get_messages(sid)[0].active == 1
    assert not b.list_sessions()

def test_import_cannot_overwrite_foreign_session(pair):
    a, b, session = pair
    imported = b.import_session(a.export_session(session.id))
    assert imported.id != session.id
    assert imported.workspace_id == b.workspace_id
    assert a.get_session(session.id).title == 'Private A'
    assert len(a.get_messages(session.id)) == 1


def test_import_always_allocates_new_storage_identity(pair):
    a, b, session = pair
    data = json.dumps({'type':'session_meta','session':{'id':'caller-chosen-id'}})
    first = a.import_session(data)
    second = b.import_session(data)
    assert first.id != second.id
    assert first.id != 'caller-chosen-id'
    assert second.metadata['original_id'] == 'caller-chosen-id'
