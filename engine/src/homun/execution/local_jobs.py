"""Owned local commands: one process, a private directory, and no inherited environment.

This is not a container. Absolute paths and the network remain reachable.
Stdin and a terminal are not provided. See homun/notices/hermes-agent.txt.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path

from homun.domain.errors import ConflictError, PermissionDeniedError

from .contracts import ExecutionUnavailable, ExecutionUncertain, LocalJobSpec
from .layout import confine_directory


def _lstart(pid: int) -> str | None:
    try:
        reply = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True)
    except OSError:
        return None
    if reply.returncode:
        return None
    text = reply.stdout.strip()
    return text or None


def _environment(workspace: Path) -> dict[str, str]:
    temporary = confine_directory(workspace / ".tmp")
    return {"PATH": "/usr/bin:/bin", "HOME": str(workspace), "TMPDIR": str(temporary),
            "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}


class LocalJobs:
    def __init__(self, root: Path):
        self.root = confine_directory(Path(root).absolute())

    def workspace(self, job: LocalJobSpec) -> Path:
        job = LocalJobSpec.model_validate(job.model_dump())
        return confine_directory(self.root / "workspaces" / job.owner)

    def start(self, job: LocalJobSpec, *, stdin: bool = False, pty: bool = False) -> dict:
        if stdin or pty:
            raise ExecutionUnavailable("Local execution has no stdin or terminal")
        job = LocalJobSpec.model_validate(job.model_dump())
        workspace = self.workspace(job)
        fresh = self._intent(job)
        if self._path("local-state", job).is_file() or not fresh:
            if not self._path("local-state", job).is_file():
                raise ExecutionUncertain("Recorded command has no process; automatic redispatch is forbidden")
            return self.inspect(job)
        log = self._path("local-logs", job)
        confine_directory(log.parent)
        log_fd = os.open(log, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        try:
            process = subprocess.Popen(["/bin/sh", "-c", job.command], cwd=workspace, env=_environment(workspace),
                                       stdin=subprocess.DEVNULL, stdout=log_fd, stderr=subprocess.STDOUT,
                                       start_new_session=True)
        except OSError:
            raise ExecutionUncertain("Local process did not start; command will not be repeated") from None
        finally:
            os.close(log_fd)
        try:
            self._write_json(self._path("local-state", job), {"contract": job.contract, "pid": process.pid, "lstart": _lstart(process.pid)})
        except OSError:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise ExecutionUncertain("Local process state could not be recorded; command will not be repeated") from None
        return self.inspect(job)

    def inspect(self, job: LocalJobSpec) -> dict:
        job = LocalJobSpec.model_validate(job.model_dump())
        state = self._read_state(job)
        if state is None:
            raise ExecutionUncertain("Local process is missing; command will not be repeated")
        if "exit_code" in state:
            return self._exited(state["exit_code"])
        pid = state["pid"]
        try:
            waited, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            if self._alive(pid) and _lstart(pid) == state.get("lstart"):
                return {"status": "running", "running": True, "exit_code": None, "oom_killed": None}
            return {"status": "outcome_unknown", "running": None, "exit_code": None, "oom_killed": None}
        if waited == 0:
            return {"status": "running", "running": True, "exit_code": None, "oom_killed": None}
        code = os.waitstatus_to_exitcode(status)
        state["exit_code"] = code
        self._write_json(self._path("local-state", job), state)
        return self._exited(code)

    def logs(self, job: LocalJobSpec, *, max_bytes: int = 65536) -> dict:
        job = LocalJobSpec.model_validate(job.model_dump())
        if self._read_state(job) is None:
            raise ExecutionUncertain("Local process is missing; command will not be repeated")
        path = self._path("local-logs", job)
        if path.is_symlink():
            raise PermissionDeniedError("Execution log must not be a symlink")
        raw = path.read_bytes() if path.is_file() else b""
        clipped = len(raw) > max_bytes
        if clipped:
            raw = raw[-max_bytes:]
        text = raw.decode("utf-8", errors="replace")
        lines = text.splitlines()
        if len(lines) > 1000:
            text = "\n".join(lines[-1000:])
            clipped = True
        return {"text": text, "truncated": clipped, "tail_only": True, "line_limit": 1000}

    def stop(self, job: LocalJobSpec) -> dict:
        job = LocalJobSpec.model_validate(job.model_dump())
        state = self._read_state(job)
        if state is None:
            raise ExecutionUncertain("Local process is missing; command will not be repeated")
        pid = state["pid"]
        if "exit_code" in state or (state.get("lstart") and _lstart(pid) != state.get("lstart")):
            return self.inspect(job)
        try:
            if os.getpgid(pid) != pid:
                raise ExecutionUncertain("Process is not the owned session leader")
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            return self.inspect(job)
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

    def remove(self, job: LocalJobSpec) -> None:
        self.stop(job)

    def stdin_open(self, job: LocalJobSpec) -> bool:
        return False

    def write_stdin(self, job: LocalJobSpec, payload: bytes) -> None:
        raise ExecutionUnavailable("Local execution has no stdin or terminal")

    def _exited(self, code: int) -> dict:
        if code < 0:
            return {"status": "dead", "running": False, "exit_code": None, "oom_killed": False}
        return {"status": "exited", "running": False, "exit_code": code, "oom_killed": False}

    def _intent(self, job: LocalJobSpec) -> bool:
        directory = confine_directory(self.root / "intents")
        path = directory / (job.identity + ".json")
        if path.is_symlink():
            raise PermissionDeniedError("Execution intent must not be a symlink")
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            try:
                raw = path.read_bytes()
                if len(raw) > 4096:
                    raise ValueError("Oversize intent")
                contract = json.loads(raw)["contract"]
            except (OSError, ValueError, KeyError, TypeError):
                raise ExecutionUncertain("Execution intent is incomplete; command will not be repeated") from None
            if contract != job.contract:
                raise ConflictError("Execution identity is already bound to another contract")
            return False
        with os.fdopen(descriptor, "w") as stream:
            json.dump({"contract": job.contract}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        return True

    def _path(self, kind: str, job: LocalJobSpec) -> Path:
        suffix = ".json" if kind == "local-state" else ".log"
        return self.root / kind / (job.identity + suffix)

    def _read_state(self, job: LocalJobSpec) -> dict | None:
        path = self._path("local-state", job)
        if path.is_symlink():
            raise PermissionDeniedError("Execution state must not be a symlink")
        if not path.is_file():
            return None
        try:
            raw = path.read_bytes()
            if len(raw) > 4096:
                raise ValueError("Oversize state")
            state = json.loads(raw)
            if state.get("contract") != job.contract:
                raise ConflictError("Execution identity is already bound to another contract")
            if type(state.get("pid")) is not int:
                raise ValueError("Invalid state")
        except (OSError, ValueError, TypeError):
            raise ExecutionUncertain("Local process state is incomplete; command will not be repeated") from None
        return state

    def _write_json(self, path: Path, payload: dict) -> None:
        if path.is_symlink():
            raise PermissionDeniedError("Execution state must not be a symlink")
        confine_directory(path.parent)
        temporary = path.with_suffix(".tmp")
        with temporary.open("w") as stream:
            json.dump(payload, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)

    @staticmethod
    def _alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True
