"""Approved commands on one explicit SSH host.

The client ignores the person's SSH configuration and agent. The private key
path is checked against the approved fingerprint and is not part of the job
contract. This is not a container and it does not sync files.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import signal
import subprocess
import time
from pathlib import Path

from homun.domain.errors import ConflictError, PermissionDeniedError, ValidationError

from .contracts import ExecutionUnavailable, ExecutionUncertain, SshJobSpec
from .layout import confine_directory

_FINGERPRINT = re.compile(r"SHA256:[A-Za-z0-9+/]+")


def key_fingerprint(path: str) -> str:
    """Return the SHA256 fingerprint of a private key that is not group-readable."""
    key = Path(path)
    if not key.is_absolute() or key.is_symlink() or not key.is_file():
        raise ValidationError("SSH private key must be an absolute regular file")
    if key.stat().st_mode & 0o077:
        raise ValidationError("SSH private key must not be group or world accessible")
    reply = subprocess.run(["/usr/bin/ssh-keygen", "-lf", str(key), "-E", "sha256"],
                           capture_output=True, text=True)
    found = _FINGERPRINT.search(reply.stdout)
    if reply.returncode or found is None:
        raise ValidationError("SSH private key could not be read")
    return found.group(0)


class SshJobs:
    def __init__(self, root: Path):
        self.root = confine_directory(Path(root).absolute())

    def start(self, job: SshJobSpec, *, stdin: bool = False, pty: bool = False) -> dict:
        if stdin or pty:
            raise ExecutionUnavailable("SSH execution has no stdin or terminal")
        job = SshJobSpec.model_validate(job.model_dump())
        try:
            if key_fingerprint(job.key_path) != job.key_fingerprint:
                raise ExecutionUnavailable("SSH key does not match the approved fingerprint")
        except ValidationError as exc:
            raise ExecutionUnavailable(str(exc)) from None
        fresh = self._intent(job)
        if self._state_path(job).is_file() or not fresh:
            if not self._state_path(job).is_file():
                raise ExecutionUncertain("Recorded command has no process; automatic redispatch is forbidden")
            return self.inspect(job)
        known = self._install_host_key(job)
        log = self.root / "ssh-logs" / (job.identity + ".log")
        confine_directory(log.parent)
        log_fd = os.open(log, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        try:
            process = subprocess.Popen(self._argv(job, known, self._remote(job)), cwd=self.root,
                                       env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
                                       stdin=subprocess.DEVNULL, stdout=log_fd, stderr=subprocess.STDOUT,
                                       start_new_session=True)
        except OSError:
            raise ExecutionUncertain("SSH process did not start; command will not be repeated") from None
        finally:
            os.close(log_fd)
        remote_pid, remote_lstart = self._await_markers(log)
        self._write_json(self._state_path(job), {"contract": job.contract, "pid": process.pid,
                                                 "remote_pid": remote_pid, "remote_lstart": remote_lstart})
        return self.inspect(job)

    def inspect(self, job: SshJobSpec) -> dict:
        job = SshJobSpec.model_validate(job.model_dump())
        state = self._read_state(job)
        if state is None:
            raise ExecutionUncertain("SSH process is missing; command will not be repeated")
        if "exit_code" in state:
            return self._exited(state["exit_code"])
        try:
            waited, status = os.waitpid(state["pid"], os.WNOHANG)
        except ChildProcessError:
            return {"status": "outcome_unknown", "running": None, "exit_code": None, "oom_killed": None}
        if waited == 0:
            return {"status": "running", "running": True, "exit_code": None, "oom_killed": None}
        code = os.waitstatus_to_exitcode(status)
        state["exit_code"] = code
        self._write_json(self._state_path(job), state)
        return self._exited(code)

    def logs(self, job: SshJobSpec, *, max_bytes: int = 65536) -> dict:
        job = SshJobSpec.model_validate(job.model_dump())
        if self._read_state(job) is None:
            raise ExecutionUncertain("SSH process is missing; command will not be repeated")
        path = self.root / "ssh-logs" / (job.identity + ".log")
        if path.is_symlink():
            raise PermissionDeniedError("Execution log must not be a symlink")
        raw = path.read_bytes() if path.is_file() else b""
        clipped = len(raw) > max_bytes
        text = (raw[-max_bytes:] if clipped else raw).decode("utf-8", errors="replace")
        lines = [line for line in text.splitlines() if not line.startswith(("PID:", "LSTART:"))]
        if len(lines) > 1000:
            lines = lines[-1000:]
            clipped = True
        return {"text": "\n".join(lines), "truncated": clipped, "tail_only": True, "line_limit": 1000}

    def stop(self, job: SshJobSpec) -> dict:
        job = SshJobSpec.model_validate(job.model_dump())
        state = self._read_state(job)
        if state is None:
            raise ExecutionUncertain("SSH process is missing; command will not be repeated")
        self._stop_remote(job, state)
        pid = state["pid"]
        if "exit_code" not in state:
            try:
                if os.getpgid(pid) == pid:
                    os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            for _ in range(20):
                current = self.inspect(job)
                if current["running"] is not True:
                    return current
                time.sleep(0.1)
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return self.inspect(job)

    def remove(self, job: SshJobSpec) -> None:
        self.stop(job)

    def stdin_open(self, job: SshJobSpec) -> bool:
        return False

    def write_stdin(self, job: SshJobSpec, payload: bytes) -> None:
        raise ExecutionUnavailable("SSH execution has no stdin or terminal")

    def _argv(self, job: SshJobSpec, known: Path, remote: str) -> list[str]:
        return ["/usr/bin/ssh", "-F", "/dev/null",
                "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
                "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known}",
                "-o", "GlobalKnownHostsFile=/dev/null", "-o", "PasswordAuthentication=no",
                "-o", "PreferredAuthentications=publickey", "-o", "ClearAllForwardings=yes",
                "-o", "ConnectTimeout=10", "-i", job.key_path, "-p", str(job.port),
                f"{job.user}@{job.host}", remote]

    def _remote(self, job: SshJobSpec) -> str:
        workdir = f"$HOME/homun-{job.owner[:32]}"
        return (f"mkdir -p {workdir} && cd {workdir} && printf 'PID:%s\\n' \"$$\" && "
                "printf 'LSTART:%s\\n' \"$(ps -p $$ -o lstart=)\" && "
                f"exec sh -c {shlex.quote(job.command)}")

    def _stop_remote(self, job: SshJobSpec, state: dict) -> None:
        pid, started = state.get("remote_pid"), state.get("remote_lstart")
        if type(pid) is not int or not started:
            return
        remote = (f"current=$(ps -p {pid} -o lstart=); current=$(printf '%s' \"$current\" | tr -d '[:space:]'); "
                  f"[ \"$current\" = {shlex.quote(''.join(started.split()))} ] && kill -TERM {pid}")
        try:
            subprocess.run(self._argv(job, self._install_host_key(job), remote),
                           cwd=self.root, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            return

    def _install_host_key(self, job: SshJobSpec) -> Path:
        path = confine_directory(self.root / "ssh-known") / (job.identity + ".known")
        if path.is_symlink():
            raise PermissionDeniedError("SSH known hosts must not be a symlink")
        line = f"[{job.host}]:{job.port} {job.host_key}\n"
        if path.is_file() and path.read_text() != line:
            raise ConflictError("SSH host key changed")
        if not path.is_file():
            path.write_text(line)
            os.chmod(path, 0o600)
        return path

    def _await_markers(self, log: Path) -> tuple[int | None, str | None]:
        for _ in range(20):
            pid, started = _markers(log.read_text(errors="replace") if log.is_file() else "")
            if pid is not None:
                return pid, started
            time.sleep(0.05)
        return None, None

    def _intent(self, job: SshJobSpec) -> bool:
        directory = confine_directory(self.root / "intents")
        path = directory / (job.identity + ".json")
        if path.is_symlink():
            raise PermissionDeniedError("Execution intent must not be a symlink")
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            try:
                raw = path.read_bytes()
                contract = json.loads(raw)["contract"] if len(raw) <= 8192 else None
            except (OSError, ValueError, TypeError):
                raise ExecutionUncertain("Execution intent is incomplete; command will not be repeated") from None
            if contract != job.contract:
                raise ConflictError("Execution identity is already bound to another contract")
            return False
        with os.fdopen(descriptor, "w") as stream:
            json.dump({"contract": job.contract}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        return True

    def _state_path(self, job: SshJobSpec) -> Path:
        return self.root / "ssh-state" / (job.identity + ".json")

    def _read_state(self, job: SshJobSpec) -> dict | None:
        path = self._state_path(job)
        if path.is_symlink():
            raise PermissionDeniedError("Execution state must not be a symlink")
        if not path.is_file():
            return None
        try:
            state = json.loads(path.read_bytes())
            if state.get("contract") != job.contract or type(state.get("pid")) is not int:
                raise ValueError("Invalid state")
        except (OSError, ValueError, TypeError):
            raise ExecutionUncertain("SSH process state is incomplete; command will not be repeated") from None
        return state

    def _write_json(self, path: Path, payload: dict) -> None:
        confine_directory(path.parent)
        temporary = path.with_suffix(".tmp")
        with temporary.open("w") as stream:
            json.dump(payload, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)

    @staticmethod
    def _exited(code: int) -> dict:
        if code < 0:
            return {"status": "dead", "running": False, "exit_code": None, "oom_killed": False}
        return {"status": "exited", "running": False, "exit_code": code, "oom_killed": False}


def _markers(text: str) -> tuple[int | None, str | None]:
    pid = started = None
    for line in text.splitlines()[:4]:
        if line.startswith("PID:") and pid is None:
            try:
                pid = int(line[4:])
            except ValueError:
                pid = None
        elif line.startswith("LSTART:") and started is None:
            started = "".join(line[len("LSTART:"):].split())
    return pid, started
