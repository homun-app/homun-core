"""Primitive canonical session records, scoped reads and stable transcript revisions."""
import hashlib
import json
from copy import deepcopy
from homun.application.agent_run_policy import history_is_readable
from homun.domain.errors import NotFoundError, PermissionDeniedError, ValidationError
from homun.policy.work import require_work_access

SNAPSHOT = 'session.snapshot'


def revision(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def rows(record):
    value = record.result
    if record.type == 'agent_run.propose':
        return [{'id': f"{value['id']}:{index}", 'run_id': value['id'], 'index': index, 'message': deepcopy(message)}
                for index, message in enumerate(value.get('_messages', []))]
    return deepcopy(value['messages'])


def authorize_record(store, actor, work_id, session_id):
    require_work_access(store, actor, work_id, 'read')
    record = store.commands.get(session_id)
    if not record or record.type not in {'agent_run.propose', SNAPSHOT} or record.result.get('work_id') != work_id:
        raise NotFoundError('Canonical session not found in this work')
    if not history_is_readable(store, actor, record.result):
        raise PermissionDeniedError('Session source material is no longer readable')
    return record


def read(store, actor, work_id, session_id):
    record = authorize_record(store, actor, work_id, session_id)
    if record.type == 'agent_run.propose' and '_messages' not in record.result:
        if record.result.get('_tombstone'):
            return record
        raise ValidationError('This run has no native transcript')
    return record
