"""Compare-and-project finish journals; callers serialize with human controls."""
import time
from homun.application.automation_store import get_automation_store


def _project(run, evaluation):
    from homun.application.goal_store import get_goal_store
    import json
    work_id = run['work_id']
    for kind in ('goal', 'loop'):
        before, after = evaluation.get(kind + '_before'), evaluation.get(kind + '_after')
        if after is None:
            continue
        database = get_goal_store() if kind == 'goal' else get_automation_store()
        table = 'goals' if kind == 'goal' else 'automation_state'
        predicate = 'session_id=?' if kind == 'goal' else 'session_id=? AND kind=?'
        parameters = (work_id,) if kind == 'goal' else (work_id, 'loop')
        with database._lock, database._conn:
            database._conn.execute('BEGIN IMMEDIATE')
            row = database._conn.execute(f'SELECT payload FROM {table} WHERE {predicate}', parameters).fetchone()
            data = json.loads(row[0]) if row else None
            if data == after:
                continue
            if data != before:
                return False  # New human/tool state wins over old evaluation.
            database._conn.execute(f'UPDATE {table} SET payload=?,updated_at=? WHERE {predicate}',
                                   (json.dumps(after), time.time(), *parameters))
    return True


def invalidate_evaluation(run):
    """Undo only a crash-projected verdict still matching this unconsumed journal."""
    prior = run.pop('_automation_finish', None)
    if not prior or prior['key'] != f'{run["_epoch"]}:{run["turns"]}':
        return
    reverse = {}
    for kind in ('goal', 'loop'):
        if prior.get(kind + '_after') is not None:
            reverse[kind + '_before'] = prior[kind + '_after']
            reverse[kind + '_after'] = prior[kind + '_before']
    _project(run, reverse)

