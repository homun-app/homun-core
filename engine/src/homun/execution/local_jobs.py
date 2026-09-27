"""Owned local commands: one process, a private directory, and no inherited environment.

This is not a container. Absolute paths and the network remain reachable.
Stdin and a terminal are not provided.
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
from .workspace import owned_root, working_directory


from .local_job_supervisor import process_lstart as _lstart


def _environment(workspace: Path) -> dict[str, str]:
    temporary = confine_directory(workspace / ".tmp")
    return {"PATH": "/usr/bin:/bin", "HOME": str(workspace), "TMPDIR": str(temporary),
            "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}


class LocalJobs:
    def __init__(self, root: Path):
        self.root = confine_directory(Path(root).absolute())

    def workspace(self, job: LocalJobSpec) -> Path:
        job = LocalJobSpec.model_validate(job.model_dump())
        return owned_root(self.root, job.workspace_id, job.run_id)

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
        cwd = working_directory(workspace, job.cwd)
        log = self._path("local-logs", job)
        confine_directory(log.parent)
        state_path = self._path("local-state", job)
        confine_directory(state_path.parent)
        from .local_job_supervisor import command
        payload = {"command":job.command, "contract":job.contract,
                   "workspace":str(cwd), "environment":_environment(workspace),
                   "state_path":str(state_path), "log_path":str(log), "deadline_at":job.deadline_at}
        try:
            supervisor = subprocess.Popen(command(payload), cwd=workspace,
                env=_environment(workspace), stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            raise ExecutionUncertain("Local supervisor did not start; command will not be repeated") from None
        # Only wait for ownership admission; the supervisor owns the child and
        # its durable exit receipt independently from this engine process.
        until = time.monotonic() + 5
        while time.monotonic() < until:
            if state_path.is_file():
                return self.inspect(job)
            if supervisor.poll() is not None:
                break
            time.sleep(0.01)
        raise ExecutionUncertain("Local ownership admission is unknown; automatic redispatch is forbidden")

    def inspect(self, job: LocalJobSpec) -> dict:
        job = LocalJobSpec.model_validate(job.model_dump())
        state = self._read_state(job)
        if state is None:
            raise ExecutionUncertain("Local process is missing; command will not be repeated")
        if "exit_code" in state:
            return self._exited(state["exit_code"], timed_out=state.get("timed_out"))
        pid = state["pid"]
        if state.get("supervised"):
            # Another process owns waitpid. A vanished PID without its receipt
            # remains unknown (e.g. supervisor crash), never assumed successful.
            owner = state.get('supervisor_pid')
            owner_alive = owner is None or (state.get('supervisor_lstart') and
                self._alive(owner) and _lstart(owner) == state['supervisor_lstart'])
            if owner_alive and state.get("lstart") and self._alive(pid) and _lstart(pid) == state["lstart"]:
                return {"status":"running", "running":True, "exit_code":None, "oom_killed":None}
            latest = self._read_state(job)
            if latest is not None and "exit_code" in latest:
                return self._exited(latest["exit_code"], timed_out=latest.get("timed_out"))
            return {"status":"outcome_unknown", "running":None, "exit_code":None, "oom_killed":None}
        try:
            waited, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            if state.get("lstart") and self._alive(pid) and _lstart(pid) == state["lstart"]:
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
        if state.get('control_version') == 1:
            if 'exit_code' in state:
                return self.inspect(job)
            # The supervisor is the sole waiter and signaller. An engine-side
            # signal could race waitpid and hit a reused PID/process group.
            self._write_json(self._path('local-state', job).with_suffix('.stop'),
                             {'contract':job.contract})
            for _ in range(45):
                current = self.inspect(job)
                if current['running'] is False:
                    return current
                time.sleep(.1)
            raise ExecutionUncertain('Local supervisor did not confirm cancellation')
        if not self._signal_owned(job, signal.SIGTERM):
            return self.inspect(job)
        for _ in range(20):
            current = self.inspect(job)
            if current["running"] is False:
                return current
            time.sleep(0.1)
        # A supervisor may have reaped the child during the grace interval.
        # Reload the receipt and revalidate identity before any escalation.
        if not self._signal_owned(job, signal.SIGKILL):
            return self.inspect(job)
        for _ in range(20):
            current = self.inspect(job)
            if current["running"] is False:
                return current
            time.sleep(0.1)
        return current

    def _signal_owned(self, job: LocalJobSpec, sig: int) -> bool:
        state = self._read_state(job)
        if state is None or "exit_code" in state:
            return False
        if not state.get("lstart"):
            raise ExecutionUncertain("Local process identity is unavailable; refusing to signal")
        pid = state["pid"]
        if _lstart(pid) != state["lstart"]:
            return False
        try:
            if os.getpgid(pid) != pid:
                raise ExecutionUncertain("Process is not the owned session leader")
            os.killpg(pid, sig)
        except ProcessLookupError:
            return False
        return True

    def remove(self, job: LocalJobSpec) -> None:
        self.stop(job)

    def stdin_open(self, job: LocalJobSpec) -> bool:
        return False

    def write_stdin(self, job: LocalJobSpec, payload: bytes) -> None:
        raise ExecutionUnavailable("Local execution has no stdin or terminal")

    def _exited(self, code: int | None, *, timed_out: bool | None = None) -> dict:
        if code is None or code < 0:
            return {"status": "dead", "running": False, "exit_code": None, "oom_killed": False, **({"timed_out": timed_out} if timed_out is not None else {})}
        return {"status": "exited", "running": False, "exit_code": code, "oom_killed": False, **({"timed_out": timed_out} if timed_out is not None else {})}

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
        from .local_job_supervisor import write_receipt
        write_receipt(path, payload)

    @staticmethod
    def _alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True
