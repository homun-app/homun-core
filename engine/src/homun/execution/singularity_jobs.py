"""Singularity/Apptainer terminal backend (H10).

c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT). Homun-owned spawn-per-call
execution: each start() runs `apptainer|singularity exec --containall --no-home`
without inventing instance IDs when the CLI is missing.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from homun.domain.errors import ConflictError, PermissionDeniedError
from homun.execution.contracts import ExecutionUnavailable, ExecutionUncertain, digest
from homun.execution.layout import confine_directory


def find_singularity_executable() -> Optional[str]:
    env = (
        os.environ.get("HOMUN_SINGULARITY_BIN")
        or os.environ.get("SINGULARITY_BIN")
        or ""
    ).strip()
    if env and os.path.isfile(env) and os.access(env, os.X_OK):
        return env
    for name in ("apptainer", "singularity"):
        found = shutil.which(name)
        if found:
            return found
    return None


def singularity_version(executable: str, *, timeout: float = 10.0) -> str:
    try:
        reply = subprocess.run(
            [executable, "version"],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ExecutionUnavailable(f"Singularity CLI not usable: {exc}") from exc
    if reply.returncode != 0:
        err = (reply.stderr or reply.stdout or "").strip()[:200]
        raise ExecutionUnavailable(f"Singularity version failed: {err or reply.returncode}")
    return (reply.stdout or reply.stderr or "").strip()


class SingularityJobSpec(BaseModel):
    """Command inside an Apptainer/Singularity image (SIF path or docker:// URI)."""

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)
    workspace_id: str = Field(min_length=1, max_length=256)
    run_id: str = Field(min_length=1, max_length=256)
    call_id: str = Field(min_length=1, max_length=256)
    image: str = Field(min_length=1, max_length=4000)
    command: str = Field(min_length=1, max_length=16000)

    @field_validator("command", "workspace_id", "run_id", "call_id", "image")
    @classmethod
    def no_null(cls, value: str) -> str:
        if "\x00" in value or not value.strip():
            raise ValueError("Job fields must be nonempty and contain no NUL")
        return value

    @property
    def identity(self) -> str:
        return digest([self.workspace_id, self.run_id, self.call_id])

    @property
    def owner(self) -> str:
        return digest([self.workspace_id, self.run_id])

    @property
    def contract(self) -> str:
        return digest({"spec": self.model_dump(), "policy": "cloud-singularity-v1"})


def _lstart(pid: int) -> str | None:
    try:
        reply = subprocess.run(
            ["/bin/ps", "-p", str(pid), "-o", "lstart="],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if reply.returncode:
        return None
    text = reply.stdout.strip()
    return text or None


class SingularityJobs:
    """Spawn-per-call Singularity execution with durable intent files."""

    def __init__(self, root: Path, *, executable: Optional[str] = None):
        self.root = confine_directory(Path(root).absolute())
        self.executable = executable or find_singularity_executable()
        if not self.executable:
            raise ExecutionUnavailable(
                "Singularity/Apptainer CLI not found; set HOMUN_SINGULARITY_BIN or install apptainer"
            )
        singularity_version(self.executable)

    def workspace(self, job: SingularityJobSpec) -> Path:
        job = SingularityJobSpec.model_validate(job.model_dump())
        return confine_directory(self.root / "workspaces" / job.owner)

    def start(self, job: SingularityJobSpec, *, stdin: bool = False, pty: bool = False) -> dict:
        if stdin or pty:
            raise ExecutionUnavailable("Singularity execution has no stdin or terminal")
        job = SingularityJobSpec.model_validate(job.model_dump())
        workspace = self.workspace(job)
        if self._path("singularity-state", job).is_file() or not self._intent(job):
            if not self._path("singularity-state", job).is_file():
                raise ExecutionUncertain(
                    "Recorded Singularity command has no process; automatic redispatch is forbidden"
                )
            return self.inspect(job)
        log = self._path("singularity-logs", job)
        confine_directory(log.parent)
        bind = f"{workspace}:/work:rw"
        argv = [
            self.executable,
            "exec",
            "--containall",
            "--no-home",
            "--writable-tmpfs",
            "--bind",
            bind,
            "--pwd",
            "/work",
            job.image,
            "/bin/sh",
            "-c",
            job.command,
        ]
        log_fd = os.open(log, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        try:
            process = subprocess.Popen(
                argv,
                cwd=workspace,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
                stdin=subprocess.DEVNULL,
                stdout=log_fd,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as exc:
            raise ExecutionUncertain(
                f"Singularity process did not start; command will not be repeated ({exc})"
            ) from None
        finally:
            os.close(log_fd)
        try:
            self._write_json(
                self._path("singularity-state", job),
                {
                    "contract": job.contract,
                    "pid": process.pid,
                    "lstart": _lstart(process.pid),
                    "image": job.image,
                    "executable": self.executable,
                },
            )
        except OSError:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise ExecutionUncertain(
                "Singularity process state could not be recorded; command will not be repeated"
            ) from None
        return self.inspect(job)

    def inspect(self, job: SingularityJobSpec) -> dict:
        job = SingularityJobSpec.model_validate(job.model_dump())
        state = self._read_state(job)
        if state is None:
            raise ExecutionUnavailable("Singularity job state not found")
        if state.get("contract") != job.contract:
            raise ConflictError("Singularity identity is already bound to another contract")
        pid = int(state["pid"])
        running = False
        exit_code = None
        try:
            os.kill(pid, 0)
            current = _lstart(pid)
            if current and current == state.get("lstart"):
                running = True
            else:
                exit_code = self._wait_exit(pid)
        except ProcessLookupError:
            exit_code = self._wait_exit(pid)
        except OSError:
            raise ExecutionUncertain("Singularity process identity could not be verified") from None
        return {
            "running": running,
            "exit_code": exit_code,
            "status": "running" if running else "exited",
        }

    def logs(self, job: SingularityJobSpec, *, max_bytes: int = 65536) -> dict:
        job = SingularityJobSpec.model_validate(job.model_dump())
        path = self._path("singularity-logs", job)
        if not path.is_file():
            return {"text": "", "truncated": False, "tail_only": False, "line_limit": 0}
        data = path.read_bytes()
        truncated = len(data) > max_bytes
        if truncated:
            data = data[-max_bytes:]
        return {
            "text": data.decode("utf-8", errors="replace"),
            "truncated": truncated,
            "tail_only": truncated,
            "line_limit": 0,
        }

    def stop(self, job: SingularityJobSpec) -> dict:
        job = SingularityJobSpec.model_validate(job.model_dump())
        state = self._read_state(job)
        if state is None:
            return self.inspect(job) if False else {"running": False, "exit_code": None, "status": "exited"}
        pid = int(state["pid"])
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except OSError as exc:
            raise ExecutionUnavailable(f"Could not signal Singularity process: {exc}") from exc
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                os.kill(pid, 0)
                time.sleep(0.05)
            except ProcessLookupError:
                break
        else:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return self.inspect(job)

    def remove(self, job: SingularityJobSpec) -> None:
        job = SingularityJobSpec.model_validate(job.model_dump())
        try:
            self.stop(job)
        except Exception:
            pass
        for kind in ("singularity-state", "singularity-logs", "singularity-intents"):
            path = self._path(kind, job)
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    def stdin_open(self, job: SingularityJobSpec) -> bool:
        return False

    def write_stdin(self, job: SingularityJobSpec, payload: bytes) -> None:
        raise ExecutionUnavailable("Singularity execution has no stdin")

    def _intent(self, job: SingularityJobSpec) -> bool:
        directory = confine_directory(self.root / "singularity-intents")
        path = directory / (job.identity + ".json")
        if path.is_symlink():
            raise PermissionDeniedError("Execution intent must not be a symlink")
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            try:
                with path.open("rb") as stream:
                    raw = stream.read(4097)
                if len(raw) > 4096:
                    raise ValueError("Oversize intent")
                existing = json.loads(raw)
                contract = existing["contract"]
            except (OSError, ValueError, KeyError, TypeError):
                raise ExecutionUncertain(
                    "Singularity execution intent is incomplete; command will not be repeated"
                ) from None
            if contract != job.contract:
                raise ConflictError("Execution identity is already bound to another contract")
            return False
        with os.fdopen(fd, "w") as stream:
            json.dump({"contract": job.contract}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        return True

    def _path(self, kind: str, job: SingularityJobSpec) -> Path:
        return self.root / kind / (job.identity + (".log" if kind.endswith("logs") else ".json"))

    def _read_state(self, job: SingularityJobSpec) -> dict | None:
        path = self._path("singularity-state", job)
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError):
            raise ExecutionUncertain("Singularity state is corrupt; command will not be repeated") from None

    def _write_json(self, path: Path, payload: dict) -> None:
        confine_directory(path.parent)
        fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(payload, stream)
            stream.flush()
            os.fsync(stream.fileno())

    def _wait_exit(self, pid: int) -> int | None:
        try:
            _, status = os.waitpid(pid, os.WNOHANG)
            if status == 0:
                return None
            if os.WIFEXITED(status):
                return os.WEXITSTATUS(status)
            if os.WIFSIGNALED(status):
                return 128 + os.WTERMSIG(status)
        except ChildProcessError:
            return None
        return None
