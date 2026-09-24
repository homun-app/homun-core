"""Daytona cloud terminal backend (H10).

Homun-owned bridge: requires the Daytona SDK and API key, and
HOMUN_DAYTONA_ALLOW_LIVE=1 before creating paid workspaces.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from homun.domain.errors import ConflictError, PermissionDeniedError
from homun.execution.contracts import ExecutionUnavailable, ExecutionUncertain, digest
from homun.execution.layout import confine_directory


def daytona_sdk_available() -> bool:
    try:
        import daytona  # noqa: F401
        return True
    except Exception:
        try:
            from daytona import Daytona  # noqa: F401
            return True
        except Exception:
            return False


def daytona_live_allowed() -> bool:
    return str(os.environ.get("HOMUN_DAYTONA_ALLOW_LIVE") or "").strip() in {"1", "true", "yes"}


def daytona_credentials_present() -> bool:
    return bool(os.environ.get("DAYTONA_API_KEY") or os.environ.get("HOMUN_DAYTONA_API_KEY"))


class DaytonaJobSpec(BaseModel):
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
        return digest({"spec": self.model_dump(), "policy": "cloud-daytona-v1"})


class DaytonaJobs:
    def __init__(self, root: Path) -> None:
        self.root = confine_directory(Path(root).absolute())
        if not daytona_sdk_available():
            raise ExecutionUnavailable(
                "Daytona SDK is not installed. Refusing cloud workspaces."
            )
        if not daytona_credentials_present():
            raise ExecutionUnavailable(
                "Daytona credentials missing (DAYTONA_API_KEY or HOMUN_DAYTONA_API_KEY)"
            )
        if not daytona_live_allowed():
            raise ExecutionUnavailable(
                "Daytona live execution is gated. Set HOMUN_DAYTONA_ALLOW_LIVE=1 to permit "
                "workspace creation (may incur cloud charges)."
            )

    def workspace(self, job: DaytonaJobSpec) -> Path:
        job = DaytonaJobSpec.model_validate(job.model_dump())
        return confine_directory(self.root / "workspaces" / job.owner)

    def start(self, job: DaytonaJobSpec, *, stdin: bool = False, pty: bool = False) -> dict:
        if stdin or pty:
            raise ExecutionUnavailable("Daytona execution has no stdin or terminal in this bridge")
        job = DaytonaJobSpec.model_validate(job.model_dump())
        if self._path("daytona-state", job).is_file() or not self._intent(job):
            if not self._path("daytona-state", job).is_file():
                raise ExecutionUncertain(
                    "Recorded Daytona command has no workspace; automatic redispatch is forbidden"
                )
            return self.inspect(job)

        try:
            from daytona import Daytona, CreateSandboxFromImageParams
        except Exception:
            from daytona_sdk import Daytona, CreateSandboxFromImageParams  # type: ignore

        client = Daytona()
        sandbox = None
        try:
            params = CreateSandboxFromImageParams(image=job.image)
            sandbox = client.create(params)
            result = sandbox.process.exec(job.command)
            exit_code = getattr(result, "exit_code", None)
            stdout = getattr(result, "result", None) or getattr(result, "stdout", "") or ""
            sandbox.delete()
            sandbox = None
        except Exception as exc:
            if sandbox is not None:
                try:
                    sandbox.delete()
                except Exception:
                    pass
            raise ExecutionUncertain(
                f"Daytona execution failed without durable success; not retrying automatically: {exc}"
            ) from None

        log = self._path("daytona-logs", job)
        confine_directory(log.parent)
        log.write_text(str(stdout), encoding="utf-8")
        self._write_json(
            self._path("daytona-state", job),
            {
                "contract": job.contract,
                "exit_code": int(exit_code) if exit_code is not None else 0,
                "finished_at": time.time(),
                "image": job.image,
            },
        )
        return self.inspect(job)

    def inspect(self, job: DaytonaJobSpec) -> dict:
        job = DaytonaJobSpec.model_validate(job.model_dump())
        state = self._read_state(job)
        if state is None:
            raise ExecutionUnavailable("Daytona job state not found")
        if state.get("contract") != job.contract:
            raise ConflictError("Daytona identity is already bound to another contract")
        return {"running": False, "exit_code": state.get("exit_code"), "status": "exited"}

    def logs(self, job: DaytonaJobSpec, *, max_bytes: int = 65536) -> dict:
        path = self._path("daytona-logs", job)
        if not path.is_file():
            return {"text": "", "truncated": False, "tail_only": False, "line_limit": 0}
        data = path.read_bytes()
        truncated = len(data) > max_bytes
        if truncated:
            data = data[-max_bytes:]
        return {"text": data.decode("utf-8", errors="replace"), "truncated": truncated, "tail_only": truncated, "line_limit": 0}

    def stop(self, job: DaytonaJobSpec) -> dict:
        return self.inspect(job)

    def remove(self, job: DaytonaJobSpec) -> None:
        for kind in ("daytona-state", "daytona-logs", "daytona-intents"):
            try:
                self._path(kind, job).unlink(missing_ok=True)
            except OSError:
                pass

    def stdin_open(self, job: DaytonaJobSpec) -> bool:
        return False

    def write_stdin(self, job: DaytonaJobSpec, payload: bytes) -> None:
        raise ExecutionUnavailable("Daytona execution has no stdin")

    def _intent(self, job: DaytonaJobSpec) -> bool:
        directory = confine_directory(self.root / "daytona-intents")
        path = directory / (job.identity + ".json")
        if path.is_symlink():
            raise PermissionDeniedError("Execution intent must not be a symlink")
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            try:
                existing = json.loads(path.read_bytes()[:4097])
                if existing["contract"] != job.contract:
                    raise ConflictError("Execution identity is already bound to another contract")
            except (OSError, ValueError, KeyError, TypeError):
                raise ExecutionUncertain(
                    "Daytona execution intent is incomplete; command will not be repeated"
                ) from None
            return False
        with os.fdopen(fd, "w") as stream:
            json.dump({"contract": job.contract}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        return True

    def _path(self, kind: str, job: DaytonaJobSpec) -> Path:
        return self.root / kind / (job.identity + (".log" if kind.endswith("logs") else ".json"))

    def _read_state(self, job: DaytonaJobSpec) -> Optional[dict]:
        path = self._path("daytona-state", job)
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError):
            raise ExecutionUncertain("Daytona state is corrupt; command will not be repeated") from None

    def _write_json(self, path: Path, payload: Dict[str, Any]) -> None:
        confine_directory(path.parent)
        fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(payload, stream)
            stream.flush()
            os.fsync(stream.fileno())
