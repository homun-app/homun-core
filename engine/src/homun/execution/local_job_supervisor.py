"""Standalone local child owner; writes exit receipts even after engine restart.

Keep this helper stdlib-only: source runs use isolated Python, frozen runs use
an explicit entrypoint command. It never retries or infers an exit code.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import signal
import time
import stat


def command(payload: dict) -> list[str]:
    encoded = json.dumps(payload)
    if getattr(sys, 'frozen', False):
        return [sys.executable, '_local-job-supervisor', encoded]
    return [sys.executable, '-I', str(Path(__file__).resolve()), encoded]


def write_receipt(path: Path, payload: dict):
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise RuntimeError('Supervisor receipt path must not contain symlinks')
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(payload, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def process_lstart(pid: int) -> str | None:
    try:
        reply = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='],
                               capture_output=True, text=True)
        return reply.stdout.strip() or None
    except OSError:
        return None


def signal_child(process, lstart: str | None, sig: int) -> bool:
    # Only this supervisor reaps its child, so an unreaped PID cannot be reused
    # between the identity check and signal. Never poll/reap after this check.
    if process.returncode is not None or not lstart or process_lstart(process.pid) != lstart:
        return False
    try:
        if os.getpgid(process.pid) != process.pid:
            return False
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        return False
    return True


class IdentityUnavailable(RuntimeError):
    """An ownership failure must never be retried by exception cleanup."""


def stop_requested(path: Path, contract: str) -> bool:
    try:
        descriptor = os.open(path.with_suffix('.stop'), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return False
    with os.fdopen(descriptor, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            return False
        try:
            return json.loads(stream.read(4096)).get('contract') == contract
        except (ValueError, AttributeError):
            return False


def wait_owned(process, state: dict, path: Path, deadline: datetime | None) -> int:
    due = None if deadline is None else time.monotonic() + max(
        0, (deadline - datetime.now(timezone.utc)).total_seconds())
    cancelling = None
    while True:
        now = time.monotonic()
        boundary = min(value for value in (now + .1, due, cancelling) if value is not None)
        try:
            return process.wait(timeout=max(0, boundary - now))
        except subprocess.TimeoutExpired:
            now = time.monotonic()
            expired = due is not None and now >= due
            escalated = cancelling is not None and now >= cancelling
            if expired or escalated:
                if not signal_child(process, state['lstart'], signal.SIGKILL):
                    raise IdentityUnavailable('Local process identity unavailable; refusing to signal')
                code = process.wait()
                # A normal exit racing the timeout is still a normal exit.
                state['timed_out'] = expired and cancelling is None and code == -signal.SIGKILL
                return code
            if cancelling is None and stop_requested(path, state['contract']):
                if not signal_child(process, state['lstart'], signal.SIGTERM):
                    raise IdentityUnavailable('Local process identity unavailable; refusing to signal')
                cancelling = now + 2


def supervise(encoded: str) -> int:
    payload = json.loads(encoded)
    deadline = datetime.fromisoformat(payload['deadline_at']) if payload.get('deadline_at') else None
    if deadline is not None and (deadline.tzinfo is None or deadline.utcoffset() is None):
        raise ValueError('Local deadlines require a timezone')
    path = Path(payload['state_path'])
    # The engine validated these directories and recorded dispatch intent before
    # starting us. Never replace an existing owner's state or launch twice.
    if path.exists() or path.is_symlink():
        return 1
    if deadline is not None and deadline <= datetime.now(timezone.utc):
        write_receipt(path, {'contract':payload['contract'], 'pid':0, 'supervised':True,
                             'not_started':True, 'timed_out':True, 'exit_code':None})
        return 0
    log = os.open(payload['log_path'], os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        process = subprocess.Popen(['/bin/sh', '-c', payload['command']], cwd=payload['workspace'],
            env=payload['environment'], stdin=subprocess.DEVNULL, stdout=log,
            stderr=subprocess.STDOUT, start_new_session=True)
    finally:
        os.close(log)
    state = {'contract':payload['contract'], 'pid':process.pid, 'supervised':True, 'control_version':1}
    try:
        state['lstart'] = process_lstart(process.pid)
        state['supervisor_pid'] = os.getpid()
        state['supervisor_lstart'] = process_lstart(os.getpid())
        write_receipt(path, state)
        state['timed_out'] = False
        state['exit_code'] = wait_owned(process, state, path, deadline)
        write_receipt(path, state)
    except BaseException as exc:
        # An unwritable ownership/receipt journal must not leave an unowned job.
        if not isinstance(exc, IdentityUnavailable) and signal_child(process, state.get('lstart'), signal.SIGKILL):
            process.wait()
        raise
    return 0


if __name__ == '__main__':
    raise SystemExit(supervise(sys.argv[1]))
