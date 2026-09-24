"""Modal cloud terminal backend (H10).

Derived conceptually from Hermes tools/environments/modal.py at
c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT). Homun never invents sandbox IDs.
Live Modal Sandbox.create is gated by HOMUN_MODAL_ALLOW_LIVE=1 so unpaid /
unapproved cloud spend cannot happen by accident.
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


def modal_sdk_available() -> bool:
    try:
        import modal  # noqa: F401
        return True
    except Exception:
        return False


def modal_live_allowed() -> bool:
    return str(os.environ.get("HOMUN_MODAL_ALLOW_LIVE") or "").strip() in {"1", "true", "yes"}


def modal_credentials_present() -> bool:
    return bool(
        os.environ.get("MODAL_TOKEN_ID")
        or os.environ.get("MODAL_TOKEN_SECRET")
        or os.environ.get("HOMUN_MODAL_TOKEN")
    )


class ModalJobSpec(BaseModel):
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
        return digest({"spec": self.model_dump(), "policy": "cloud-modal-v1"})


class ModalJobs:
    """Modal Sandbox execution with durable intent files and explicit live opt-in."""

    def __init__(self, root: Path) -> None:
        self.root = confine_directory(Path(root).absolute())
        if not modal_sdk_available():
            raise ExecutionUnavailable(
                "Modal SDK is not installed (pip install modal). Refusing cloud sandboxes."
            )
        if not modal_credentials_present():
            raise ExecutionUnavailable(
                "Modal credentials missing (MODAL_TOKEN_ID/SECRET or HOMUN_MODAL_TOKEN)"
            )
        if not modal_live_allowed():
            raise ExecutionUnavailable(
                "Modal live execution is gated. Set HOMUN_MODAL_ALLOW_LIVE=1 to permit "
                "Sandbox.create (may incur cloud charges)."
            )

    def workspace(self, job: ModalJobSpec) -> Path:
        job = ModalJobSpec.model_validate(job.model_dump())
        return confine_directory(self.root / "workspaces" / job.owner)

    def start(self, job: ModalJobSpec, *, stdin: bool = False, pty: bool = False) -> dict:
        if stdin or pty:
            raise ExecutionUnavailable("Modal execution has no stdin or terminal in this bridge")
        job = ModalJobSpec.model_validate(job.model_dump())
        if self._path("modal-state", job).is_file() or not self._intent(job):
            if not self._path("modal-state", job).is_file():
                raise ExecutionUncertain(
                    "Recorded Modal command has no sandbox; automatic redispatch is forbidden"
                )
            return self.inspect(job)

        import modal

        if job.image.startswith("sha256:"):
            raise ExecutionUnavailable(
                "Modal bridge expects a registry image reference (e.g. python:3.12-slim), not a docker digest pin"
            )
        app = modal.App.lookup("homun-terminal", create_if_missing=True)
        image = modal.Image.from_registry(job.image)
        sandbox = None
        try:
            sandbox = modal.Sandbox.create(image=image, app=app, timeout=600)
            process = sandbox.exec("/bin/sh", "-c", job.command)
            stdout = process.stdout.read() if process.stdout else ""
            stderr = process.stderr.read() if process.stderr else ""
            exit_code = process.wait()
            sandbox.terminate()
            sandbox = None
        except Exception as exc:
            if sandbox is not None:
                try:
                    sandbox.terminate()
                except Exception:
                    pass
            raise ExecutionUncertain(
                f"Modal sandbox execution failed without durable success; not retrying automatically: {exc}"
            ) from None

        log = self._path("modal-logs", job)
        confine_directory(log.parent)
        log.write_text((stdout or "") + (stderr or ""), encoding="utf-8")
        self._write_json(
            self._path("modal-state", job),
            {
                "contract": job.contract,
                "exit_code": int(exit_code) if exit_code is not None else None,
                "finished_at": time.time(),
                "image": job.image,
            },
        )
        return self.inspect(job)

    def inspect(self, job: ModalJobSpec) -> dict:
        job = ModalJobSpec.model_validate(job.model_dump())
        state = self._read_state(job)
        if state is None:
            raise ExecutionUnavailable("Modal job state not found")
        if state.get("contract") != job.contract:
            raise ConflictError("Modal identity is already bound to another contract")
        return {
            "running": False,
            "exit_code": state.get("exit_code"),
            "status": "exited",
        }

    def logs(self, job: ModalJobSpec, *, max_bytes: int = 65536) -> dict:
        path = self._path("modal-logs", job)
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

    def stop(self, job: ModalJobSpec) -> dict:
        return self.inspect(job)

    def remove(self, job: ModalJobSpec) -> None:
        for kind in ("modal-state", "modal-logs", "modal-intents"):
            try:
                self._path(kind, job).unlink(missing_ok=True)
            except OSError:
                pass

    def stdin_open(self, job: ModalJobSpec) -> bool:
        return False

    def write_stdin(self, job: ModalJobSpec, payload: bytes) -> None:
        raise ExecutionUnavailable("Modal execution has no stdin")

    def _intent(self, job: ModalJobSpec) -> bool:
        directory = confine_directory(self.root / "modal-intents")
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
                    "Modal execution intent is incomplete; command will not be repeated"
                ) from None
            return False
        with os.fdopen(fd, "w") as stream:
            json.dump({"contract": job.contract}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        return True

    def _path(self, kind: str, job: ModalJobSpec) -> Path:
        return self.root / kind / (job.identity + (".log" if kind.endswith("logs") else ".json"))

    def _read_state(self, job: ModalJobSpec) -> Optional[dict]:
        path = self._path("modal-state", job)
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError):
            raise ExecutionUncertain("Modal state is corrupt; command will not be repeated") from None

    def _write_json(self, path: Path, payload: Dict[str, Any]) -> None:
        confine_directory(path.parent)
        fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(payload, stream)
            stream.flush()
            os.fsync(stream.fileno())
