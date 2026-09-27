"""Durable wake intent and state mutation share one SQLite commit."""
from hashlib import sha256
import json

from homun.application.automation_store import get_automation_store
from homun.application.heartbeat_manager import HeartbeatState
from homun.application.loop_manager import LoopManager, LoopState


class TransientLoopManager(LoopManager):
    def _save(self):
        return self._state


def prepare(work_id, *, now, allow_loop=True):
    store = get_automation_store()
    with store._lock, store._conn:
        store._conn.execute('BEGIN IMMEDIATE')
        pending = store._conn.execute('SELECT payload FROM automation_wakes WHERE session_id=? AND acknowledged=0 ORDER BY rowid LIMIT 1', (work_id,)).fetchone()
        if pending:
            candidate = json.loads(pending[0])
            row = store._conn.execute('SELECT payload FROM automation_state WHERE kind=? AND session_id=?',
                                      (candidate['source'], work_id)).fetchone()
            current = json.loads(row[0]) if row else {}
            if current.get('status') == 'active' and current.get('created_at') == candidate.get('generation'):
                return candidate
            store._conn.execute('UPDATE automation_wakes SET acknowledged=1 WHERE wake_id=?', (candidate['wake_id'],))

        for kind in ('heartbeat', 'loop'):
            if kind == 'loop' and not allow_loop:
                continue
            row = store._conn.execute('SELECT payload FROM automation_state WHERE kind=? AND session_id=?', (kind, work_id)).fetchone()
            if not row:
                continue
            before = json.loads(row[0])
            if kind == 'heartbeat':
                state = HeartbeatState.from_dict(before)
                if not state.is_due(now):
                    continue
                state.last_fired_at, state.fire_count = now, state.fire_count + 1
                prompt, after = state.render_prompt(), state.to_dict()
            else:
                # Bypass __init__'s DB read: all state belongs to this transaction.
                manager = object.__new__(TransientLoopManager)
                manager.session_id = work_id
                manager._state = LoopState.from_dict(before)
                prompt = manager.fire_tick(now=now)
                if not prompt:
                    continue
                after = manager.state.to_dict()
            wake_id = 'wake-' + sha256(json.dumps([work_id, kind, before], sort_keys=True).encode()).hexdigest()
            wake = dict(wake_id=wake_id, source=kind, text=prompt, session_id=work_id, generation=after.get('created_at'))
            store._conn.execute('UPDATE automation_state SET payload=?,updated_at=? WHERE kind=? AND session_id=?',
                                (json.dumps(after), now, kind, work_id))
            store._conn.execute('INSERT INTO automation_wakes(wake_id,session_id,payload) VALUES(?,?,?)',
                                (wake_id, work_id, json.dumps(wake)))
            return wake
    return None


def acknowledge(wake_id):
    store = get_automation_store()
    with store._lock, store._conn:
        store._conn.execute('UPDATE automation_wakes SET acknowledged=1 WHERE wake_id=?', (wake_id,))


def migrate_legacy(run):
    """Move only this run's legacy state, without replacing work-scoped state."""
    work_id = run['work_id']
    legacy_id = run.get('_automation_session_id') or run.get('session_id') or run['id']
    if legacy_id == work_id:
        return
    store = get_automation_store()
    with store._lock, store._conn:
        store._conn.execute('BEGIN IMMEDIATE')
        for kind in ('heartbeat', 'loop'):
            exists = store._conn.execute('SELECT 1 FROM automation_state WHERE kind=? AND session_id=?', (kind, work_id)).fetchone()
            row = store._conn.execute('SELECT payload,updated_at FROM automation_state WHERE kind=? AND session_id=?', (kind, legacy_id)).fetchone()
            if exists or not row:
                continue
            state = json.loads(row[0])
            if state.get('status') not in {'active', 'paused'}:
                continue
            store._conn.execute('INSERT INTO automation_state(kind,session_id,payload,updated_at) VALUES(?,?,?,?)', (kind, work_id, row[0], row[1]))
            state['status'] = 'migrated'
            store._conn.execute('UPDATE automation_state SET payload=? WHERE kind=? AND session_id=?', (json.dumps(state), kind, legacy_id))
