"""Managed Modal remote terminal backend (H10).

Homun posts a one-shot exec request to HOMUN_MANAGED_MODAL_URL when
HOMUN_MANAGED_MODAL_ALLOW_LIVE=1. The remote contract expects JSON
{image, command} and returns {exit_code, stdout, stderr}. Never invents runs.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

from homun.domain.errors import ConflictError
from homun.execution.contracts import ExecutionUnavailable, ExecutionUncertain, digest
from homun.execution.layout import confine_directory


def managed_modal_url() -> str:
    return str(os.environ.get("HOMUN_MANAGED_MODAL_URL") or os.environ.get("NOUS_MODAL_URL") or "").strip()


def managed_modal_live_allowed() -> bool:
    return str(os.environ.get("HOMUN_MANAGED_MODAL_ALLOW_LIVE") or "").strip() in {"1", "true", "yes"}


def managed_modal_token() -> str:
    return str(
        os.environ.get("HOMUN_MANAGED_MODAL_TOKEN")
        or os.environ.get("NOUS_MODAL_TOKEN")
        or ""
    ).strip()


class ManagedModalJobSpec(BaseModel):
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
        return digest({"spec": self.model_dump(), "policy": "cloud-managed_modal-v1"})


class ManagedModalJobs:
    """HTTP exec bridge against a configured managed Modal endpoint."""

    def __init__(self, root: Path, *, client: Optional[httpx.Client] = None) -> None:
        self.root = confine_directory(Path(root).absolute())
        self._url = managed_modal_url()
        self._token = managed_modal_token()
        self._client = client
        if not self._url:
            raise ExecutionUnavailable(
                "managed_modal requires HOMUN_MANAGED_MODAL_URL (or NOUS_MODAL_URL)"
            )
        if not managed_modal_live_allowed():
            raise ExecutionUnavailable(
                "managed_modal live execution is gated. Set HOMUN_MANAGED_MODAL_ALLOW_LIVE=1 "
                "to permit remote sandboxes (may incur cloud charges)."
            )

    def workspace(self, job: ManagedModalJobSpec) -> Path:
        job = ManagedModalJobSpec.model_validate(job.model_dump())
        return confine_directory(self.root / "workspaces" / job.owner)

    def start(self, job: ManagedModalJobSpec, *, stdin: bool = False, pty: bool = False) -> dict:
        if stdin or pty:
            raise ExecutionUnavailable("managed_modal execution has no stdin or terminal in this bridge")
        job = ManagedModalJobSpec.model_validate(job.model_dump())
        if self._state_path(job).is_file() or not self._intent(job):
            if not self._state_path(job).is_file():
                raise ExecutionUncertain(
                    "Recorded managed_modal command has no result; automatic redispatch is forbidden"
                )
            return self.inspect(job)

        headers = {"Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        body = {"image": job.image, "command": job.command, "call_id": job.call_id}
        owns = self._client is None
        client = self._client or httpx.Client(timeout=180.0)
        try:
            resp = client.post(self._url, headers=headers, json=body)
            if resp.status_code >= 400:
                raise ExecutionUncertain(
                    f"managed_modal HTTP {resp.status_code}: {(resp.text or '')[:400]}"
                )
            data = resp.json() if resp.content else {}
            if not isinstance(data, dict):
                raise ExecutionUncertain("managed_modal returned a non-object payload")
            exit_code = data.get("exit_code")
            if exit_code is None:
                exit_code = data.get("exitCode")
            stdout = str(data.get("stdout") or "")
            stderr = str(data.get("stderr") or "")
            try:
                code = int(exit_code) if exit_code is not None else None
            except Exception:
                code = None
        except ExecutionUncertain:
            raise
        except Exception as exc:
            raise ExecutionUncertain(
                f"managed_modal execution failed without durable success; not retrying automatically: {exc}"
            ) from None
        finally:
            if owns:
                client.close()

        log = self.workspace(job) / "managed-modal-logs" / job.identity
        confine_directory(log.parent)
        log.write_text(stdout + stderr, encoding="utf-8")
        self._write_json(
            self._state_path(job),
            {
                "contract": job.contract,
                "exit_code": code,
                "finished_at": time.time(),
                "image": job.image,
            },
        )
        return self.inspect(job)

    def inspect(self, job: ManagedModalJobSpec) -> dict:
        job = ManagedModalJobSpec.model_validate(job.model_dump())
        state = self._read_state(job)
        if state is None:
            raise ExecutionUnavailable("managed_modal job state not found")
        if state.get("contract") != job.contract:
            raise ConflictError("managed_modal identity is already bound to another contract")
        return {"running": False, "exit_code": state.get("exit_code"), "status": "exited"}

    def logs(self, job: ManagedModalJobSpec, *, max_bytes: int = 65536) -> dict:
        path = self.workspace(job) / "managed-modal-logs" / job.identity
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

    def stop(self, job: ManagedModalJobSpec) -> dict:
        return self.inspect(job)

    def remove(self, job: ManagedModalJobSpec) -> None:
        for path in (
            self._state_path(job),
            self.workspace(job) / "managed-modal-logs" / job.identity,
            self.workspace(job) / "managed-modal-intents" / f"{job.identity}.json",
        ):
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass

    def write_stdin(self, job: ManagedModalJobSpec, payload: bytes) -> None:
        raise ExecutionUnavailable("managed_modal execution has no stdin")

    def _state_path(self, job: ManagedModalJobSpec) -> Path:
        return self.workspace(job) / "managed-modal-state" / f"{job.identity}.json"

    def _intent(self, job: ManagedModalJobSpec) -> bool:
        path = self.workspace(job) / "managed-modal-intents" / f"{job.identity}.json"
        if path.is_file():
            return False
        confine_directory(path.parent)
        path.write_text(json.dumps({"contract": job.contract, "at": time.time()}), encoding="utf-8")
        return True

    def _write_json(self, path: Path, payload: Dict[str, Any]) -> None:
        confine_directory(path.parent)
        path.write_text(json.dumps(payload), encoding="utf-8")

    def _read_state(self, job: ManagedModalJobSpec) -> Optional[Dict[str, Any]]:
        path = self._state_path(job)
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
