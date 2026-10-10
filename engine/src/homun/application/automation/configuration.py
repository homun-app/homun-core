"""Human-owned, idempotent configuration of approved work automations."""
from hashlib import sha256
import json
import time
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from homun.application.agent_control import _owner
from homun.application.agent_runs import authority, lookup
from homun.application.automation_store import get_automation_store
from homun.application.automation_wakes import TransientLoopManager
from homun.application.heartbeat_manager import HeartbeatState
from homun.application.loop_manager import LoopState
from homun.domain.errors import ConflictError, ValidationError


class AutomationCommand(BaseModel):
    model_config = ConfigDict(extra='forbid')
    command_id: str = Field(min_length=1, max_length=160)
    action: Literal['set', 'pause', 'resume', 'clear']
    prompt: str = Field(default='', max_length=16000)
    interval_seconds: int | None = Field(default=None, ge=60, le=31536000)
    times: int = Field(default=0, ge=0, le=100)
    until: str = Field(default='', max_length=4000)
    max_ticks: int = Field(default=100, ge=1, le=100)


def _change(kind, before, command):
    if command.action == 'set' and not command.prompt.strip():
        raise ValidationError('An automation requires a prompt')
    if kind == 'loop':
        manager = object.__new__(TransientLoopManager)
        manager.session_id, manager.min_interval = '', 60
        manager._state = LoopState.from_dict(before) if before else None
        if command.action == 'set':
            manager.set(command.prompt, interval_seconds=command.interval_seconds,
                        times=command.times, until=command.until, max_ticks=command.max_ticks)
        elif command.action == 'clear':
            if manager.state:
                manager.state.status = 'cleared'
        else:
            if not manager.state or manager.state.status not in {'active','paused'}:
                raise ConflictError('No active automation to update')
            getattr(manager, command.action)()
        return manager.state.to_dict() if manager.state else {'status':'cleared'}
    state = HeartbeatState.from_dict(before) if before else None
    if command.action == 'set':
        if command.interval_seconds is None:
            raise ValidationError('Heartbeat interval is required')
        state = HeartbeatState(prompt=command.prompt.strip(), interval_seconds=command.interval_seconds, created_at=time.time())
    elif command.action == 'clear':
        if state:
            state.status = 'cleared'
    else:
        if not state or state.status not in {'active','paused'}:
            raise ConflictError('No active automation to update')
        state.status = 'paused' if command.action == 'pause' else 'active'
        if command.action == 'resume':
            state.last_fired_at = time.time()
    return state.to_dict() if state else {'status':'cleared'}


def configure(ctx, actor, work_id, run_id, kind, command):
    if kind not in {'loop','heartbeat'}:
        raise ValidationError('Unknown automation kind')
    payload = dict(command.model_dump(), work_id=work_id, run_id=run_id, kind=kind, actor=actor.model_dump(mode='json'))
    fingerprint = sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    database = get_automation_store()
    key = f'{actor.workspace_id}:{actor.id}:{command.command_id}'
    # Same engine -> automation lock order as wake admission and finish. No IO.
    with ctx.repository.locked(), ctx.repository.transaction() as store:
        run = lookup(store, run_id, work_id)
        _owner(store, actor, run)
        if run.get('_delegation_parent'):
            raise ValidationError('Configure automations on the parent run')
        authority(ctx, store, actor, run, approve=True)
        with database._lock, database._conn:
            database._conn.execute('BEGIN IMMEDIATE')
            row = database._conn.execute('SELECT payload FROM automation_state WHERE kind=? AND session_id=?', ('command', key)).fetchone()
            if row:
                receipt = json.loads(row[0])
                if receipt['fingerprint'] != fingerprint:
                    raise ConflictError('Command ID already used with different arguments')
                result = receipt['result']
            else:
                result = None
            if result is None:
                if run['status'] not in {'queued','running','paused','waiting_automation','waiting_input','waiting_external'}:
                    raise ConflictError('Automation requires an approved active run')
                if run.get('goals',{}).get('policy') != 'persistent-goals-v1':
                    raise ValidationError('Automation capability was not approved for this run')
                row = database._conn.execute('SELECT payload FROM automation_state WHERE kind=? AND session_id=?', (kind, work_id)).fetchone()
                state = _change(kind, json.loads(row[0]) if row else None, command)
                result = {'work_id':work_id, 'run_id':run_id, 'kind':kind, 'state':state}
                for record_kind, identity, data in ((kind, work_id, state), ('command', key, {'fingerprint':fingerprint,'result':result})):
                    database._conn.execute('INSERT INTO automation_state(kind,session_id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(kind,session_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at', (record_kind, identity, json.dumps(data), time.time()))
                # Invalidates undispatched ticks from the previous configuration.
                for pending in database._conn.execute('SELECT wake_id,payload FROM automation_wakes WHERE session_id=? AND acknowledged=0', (work_id,)).fetchall():
                    if json.loads(pending['payload'])['source'] == kind:
                        database._conn.execute('UPDATE automation_wakes SET acknowledged=1 WHERE wake_id=?', (pending['wake_id'],))
        if key not in run.setdefault('_automation_configuration_ids', []):
            from homun.application.automation_projection import invalidate_evaluation
            invalidate_evaluation(run)
            run['_automation_configuration_ids'].append(key)
            run['_automation_revision'] = run.get('_automation_revision', 0) + 1
        return result
