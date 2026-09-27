"""Bounded owned Python process. This is process ownership, not an OS sandbox."""
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from homun.execution.local_jobs import _environment


def _read_output(stream, limit):
    size = stream.tell()
    stream.seek(0)
    if size <= limit:
        return stream.read().decode('utf-8', errors='replace'), False
    head_size = int(limit * .4)
    head = stream.read(head_size)
    stream.seek(-(limit - head_size), 2)
    tail = stream.read(limit - head_size)
    return (head.decode('utf-8', errors='replace') +
            f'\n\n[... Homun: omitted {size-limit} bytes of output ...]\n\n' +
            tail.decode('utf-8', errors='replace')), True


def run_command(argv, *, cwd, timeout, stdout_limit, stderr_limit, cancelled=None):
    with tempfile.TemporaryDirectory(prefix='homun-python-') as home, tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(argv, cwd=cwd or home,
                                env=_environment(Path(home).resolve()), stdin=subprocess.DEVNULL,
                                stdout=out, stderr=err, start_new_session=os.name == 'posix')
        deadline = time.monotonic() + timeout
        error = None
        try:
            while proc.poll() is None:
                if os.fstat(out.fileno()).st_size + os.fstat(err.fileno()).st_size > 10 * 1024 * 1024:
                    error = 'Execution output limit exceeded'
                    break
                if cancelled and cancelled():
                    error = 'Execution cancelled'
                    break
                if time.monotonic() >= deadline:
                    error = f'Execution timed out after {timeout} seconds'
                    break
                time.sleep(.02)
        finally:
            # Descendants must not survive a completed, failed or cancelled call.
            try:
                if os.name == 'posix':
                    os.killpg(proc.pid, signal.SIGKILL)
                elif proc.poll() is None:
                    proc.kill()
            except ProcessLookupError:
                pass
            proc.wait(timeout=2)
        stdout, truncated = _read_output(out, stdout_limit)
        stderr, _ = _read_output(err, stderr_limit)
        return (-1 if error else proc.returncode), stdout, stderr, truncated, error


def run_script(script, **kwargs):
    return run_command([sys.executable, '-I', script], **kwargs)
