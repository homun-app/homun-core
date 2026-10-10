"""Atomic cron occurrence ownership. All IO happens outside these transactions."""
from contextlib import contextmanager
from hashlib import sha256
import json
import time
from uuid import uuid4

from homun.application.cron_contracts import CronOccurrence, CronJob

LEASE_SECONDS = 660  # Longer than the bounded script timeout (600 seconds).
UNRESOLVED = {'claimed', 'executing', 'awaiting_approval', 'running', 'unknown'}
TERMINAL = {'success', 'failed', 'cancelled'}


@contextmanager
def transaction(store):
    with store._lock, store._conn:
        store._conn.execute('BEGIN IMMEDIATE')
        yield store._conn


def read_job(conn, workspace_id, job_id):
    row = conn.execute('SELECT payload FROM cron_jobs WHERE workspace_id=? AND job_id=?',
                       (workspace_id, job_id)).fetchone()
    return CronJob.from_dict(json.loads(row[0])) if row else None


def occurrences(conn, workspace_id, job_id):
    rows = conn.execute('SELECT payload FROM cron_occurrences WHERE workspace_id=? AND job_id=? ORDER BY run_at',
                        (workspace_id, job_id)).fetchall()
    return [CronOccurrence.from_dict(json.loads(r[0])) for r in rows]


def write_occurrence(conn, workspace_id, occ):
    conn.execute('''INSERT INTO cron_occurrences(workspace_id,job_id,occurrence_id,payload,run_at)
        VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,occurrence_id) DO UPDATE SET payload=excluded.payload''',
        (workspace_id, occ.job_id, occ.occurrence_id, json.dumps(occ.to_dict()), occ.run_at))


def identity(job_id, trigger):
    return 'occ-' + sha256(f'{job_id}:{trigger}'.encode()).hexdigest()[:32]


def activate_event(store, workspace_id, job_id, *, activation_id, now):
    if not isinstance(activation_id, str) or not activation_id.strip():
        raise ValueError('Event activation requires a nonempty idempotency key')
    with transaction(store) as conn:
        job = read_job(conn, workspace_id, job_id)
        if not job or job.schedule_kind != 'event':
            raise ValueError('Event activation requires an event job')
        occ_id = identity(job_id, 'event:' + activation_id)
        prior = next((o for o in occurrences(conn, workspace_id, job_id) if o.occurrence_id == occ_id), None)
        if prior:
            return prior
        occ = CronOccurrence(occ_id, job_id, now, 0, 'activated', activation_id=activation_id)
        write_occurrence(conn, workspace_id, occ)
        return occ


def is_due(store, workspace_id, job_id, *, now):
    """Read-only eligibility; never leases or changes an expired occurrence."""
    with store._lock:
        job = read_job(store._conn, workspace_id, job_id)
        if not job or job.status != 'active' or job.quota_hold:
            return False
        history = occurrences(store._conn, workspace_id, job_id)
        active = next((o for o in history if o.status in UNRESOLVED), None)
        if active:
            return (active.status == 'claimed' or active.status == 'executing' and active.recovery_safe) and active.lease_until <= now
        return any(o.status == 'activated' for o in history) if job.schedule_kind == 'event' else now >= job.next_run_at


def claim(store, workspace_id, job_id, *, now, manual=False):
    with transaction(store) as conn:
        job = read_job(conn, workspace_id, job_id)
        if not job or job.status != 'active' or job.quota_hold:
            return None
        history = occurrences(conn, workspace_id, job_id)
        occ = next((o for o in history if o.status in UNRESOLVED), None)
        if occ:
            if occ.status not in {'claimed', 'executing'} or occ.lease_until > now:
                return None
            if occ.status == 'executing' and not occ.recovery_safe:
                occ.status, occ.error = 'unknown', 'cron_execution_outcome_unknown'
                write_occurrence(conn, workspace_id, occ)
                return None
        elif job.schedule_kind == 'event' and not manual:
            occ = next((o for o in history if o.status == 'activated'), None)
            if not occ:
                return None
        else:
            if not manual and now < job.next_run_at:
                return None
            trigger = 'manual:' + uuid4().hex if manual else f'timer:{job.next_run_at}'
            occ_id = identity(job_id, trigger)
            if any(o.occurrence_id == occ_id for o in history):
                return None
            occ = CronOccurrence(occ_id, job_id, now, 0, 'claimed')
        occ.status = 'claimed'
        occ.claim_token, occ.lease_until = uuid4().hex, now + LEASE_SECONDS
        write_occurrence(conn, workspace_id, occ)
        return occ


def begin_execution(store, workspace_id, claim, *, recovery_safe):
    with transaction(store) as conn:
        job = read_job(conn, workspace_id, claim.job_id)
        current = next((o for o in occurrences(conn, workspace_id, claim.job_id)
                        if o.occurrence_id == claim.occurrence_id), None)
        if not job or job.status != 'active' or job.quota_hold or not current or current.status != 'claimed' or current.claim_token != claim.claim_token:
            return False
        current.status, current.recovery_safe = 'executing', recovery_safe
        write_occurrence(conn, workspace_id, current)
        return True


def settle(store, workspace_id, claim, result, *, now):
    """Fence completion and commit history, counters, schedule and delivery together."""
    from homun.application.cron_schedule import compute_next_run
    if result.status not in TERMINAL | {'awaiting_approval', 'running', 'unknown'}:
        raise ValueError('Invalid cron execution outcome')
    with transaction(store) as conn:
        current = next((o for o in occurrences(conn, workspace_id, claim.job_id)
                        if o.occurrence_id == claim.occurrence_id), None)
        if not current or current.claim_token != claim.claim_token or current.status not in {'executing', 'awaiting_approval', 'running'}:
            raise ValueError('Cron occurrence claim is no longer current')
        current.status, current.error = result.status, result.error
        current.exit_code, current.output_preview = result.exit_code, result.output[:2000]
        current.agent_run_id = result.agent_run_id or current.agent_run_id
        current.work_id = result.work_id or current.work_id
        if result.status in TERMINAL:
            current.completed_at = now
            current.duration_s = max(0, now - current.run_at)
            job = read_job(conn, workspace_id, claim.job_id)
            if job:
                if result.status != 'cancelled':
                    job.run_count += 1
                job.last_run_at = current.run_at
                if result.status == 'success':
                    job.last_output, job.consecutive_errors = result.output, 0
                elif result.status == 'failed':
                    job.error_count += 1
                    job.consecutive_errors += 1
                if job.repeat is not None and job.run_count >= job.repeat or job.schedule_kind == 'once':
                    job.status, job.next_run_at = 'completed', 0
                elif job.status == 'active':
                    job.next_run_at = compute_next_run(job, now=now)
                conn.execute('UPDATE cron_jobs SET payload=?,updated_at=? WHERE workspace_id=? AND job_id=?',
                             (json.dumps(job.to_dict()), now, workspace_id, job.id))
                if result.status == 'success' and job.deliver != 'local' and result.output:
                    delivery = dict(job_id=job.id, occurrence_id=current.occurrence_id, target=job.deliver,
                                    output=result.output, enqueued_at=now, status='pending', error_code='delivery_target_unconfigured')
                    conn.execute('INSERT INTO cron_deliveries(workspace_id,payload,enqueued_at) VALUES(?,?,?)',
                                 (workspace_id, json.dumps(delivery), now))
        write_occurrence(conn, workspace_id, current)
        return current
