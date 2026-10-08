"""Vercel sandbox terminal backend (H10).

Homun-owned REST bridge against api.vercel.com/v2/sandboxes, gated by
HOMUN_VERCEL_ALLOW_LIVE=1. Without credentials, project id, or live opt-in,
Homun reports typed unavailability — never invents deployment IDs or exit codes.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

from homun.domain.errors import ConflictError
from homun.execution.contracts import ExecutionUnavailable, ExecutionUncertain, digest
from homun.execution.layout import confine_directory

VERCEL_API = "https://api.vercel.com"


def vercel_sdk_available() -> bool:
    """REST bridge is Homun-owned; no third-party SDK is required."""
    return True


def vercel_live_allowed() -> bool:
    return str(os.environ.get("HOMUN_VERCEL_ALLOW_LIVE") or "").strip() in {"1", "true", "yes"}


def vercel_credentials_present() -> bool:
    return bool(os.environ.get("VERCEL_TOKEN") or os.environ.get("HOMUN_VERCEL_TOKEN"))


def vercel_project_id() -> str:
    return str(os.environ.get("VERCEL_PROJECT_ID") or os.environ.get("HOMUN_VERCEL_PROJECT_ID") or "").strip()


def vercel_team_id() -> str:
    return str(os.environ.get("VERCEL_TEAM_ID") or os.environ.get("HOMUN_VERCEL_TEAM_ID") or "").strip()


def _runtime_from_image(image: str) -> str:
    """Map Homun image refs to Vercel sandbox runtime identifiers."""
    lower = image.lower()
    if image in {"node22", "python3.13", "python3.12"}:
        return image
    if "python" in lower or "py3" in lower:
        return "python3.13"
    if "node" in lower or "javascript" in lower:
        return "node22"
    return "node22"


class VercelJobSpec(BaseModel):
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
        return digest({"spec": self.model_dump(), "policy": "cloud-vercel-v1"})


class VercelJobs:
    """Vercel Sandbox REST execution with durable intent files and live opt-in."""

    def __init__(self, root: Path, *, client: Optional[httpx.Client] = None) -> None:
        self.root = confine_directory(Path(root).absolute())
        self._token = str(os.environ.get("VERCEL_TOKEN") or os.environ.get("HOMUN_VERCEL_TOKEN") or "").strip()
        self._project = vercel_project_id()
        self._team = vercel_team_id()
        self._client = client
        if not self._token:
            raise ExecutionUnavailable(
                "Vercel credentials missing (VERCEL_TOKEN or HOMUN_VERCEL_TOKEN)"
            )
        if not self._project:
            raise ExecutionUnavailable(
                "Vercel project id missing (VERCEL_PROJECT_ID or HOMUN_VERCEL_PROJECT_ID)"
            )
        if not vercel_live_allowed():
            raise ExecutionUnavailable(
                "Vercel live execution is gated. Set HOMUN_VERCEL_ALLOW_LIVE=1 to permit "
                "sandbox creation (may incur cloud charges)."
            )

    def workspace(self, job: VercelJobSpec) -> Path:
        job = VercelJobSpec.model_validate(job.model_dump())
        return confine_directory(self.root / "workspaces" / job.owner)

    def start(self, job: VercelJobSpec, *, stdin: bool = False, pty: bool = False) -> dict:
        if stdin or pty:
            raise ExecutionUnavailable("Vercel execution has no stdin or terminal in this bridge")
        job = VercelJobSpec.model_validate(job.model_dump())
        if self._path("vercel-state", job).is_file() or not self._intent(job):
            if not self._path("vercel-state", job).is_file():
                raise ExecutionUncertain(
                    "Recorded Vercel command has no sandbox; automatic redispatch is forbidden"
                )
            return self.inspect(job)

        runtime = _runtime_from_image(job.image)
        name = f"homun-{job.call_id[:24]}".replace(".", "-")
        create_body: Dict[str, Any] = {
            "name": name,
            "projectId": self._project,
            "runtime": runtime,
            "timeout": 300_000,
            "persistent": False,
        }
        session_id = ""
        try:
            created = self._request("POST", "/v2/sandboxes", json_body=create_body)
            session = created.get("session") if isinstance(created, dict) else None
            if not isinstance(session, dict):
                session = created if isinstance(created, dict) else {}
            session_id = str(session.get("id") or created.get("id") or "").strip()
            if not session_id:
                raise ExecutionUncertain("Vercel sandbox create returned no session id")
            cmd_id = uuid.uuid4().hex[:16]
            cmd_body = {
                "command": "/bin/sh",
                "args": ["-c", job.command],
                "wait": True,
                "logs": True,
                "timeout": 180_000,
            }
            result = self._request(
                "POST",
                f"/v2/sandboxes/sessions/{session_id}/cmd",
                params={"cmdId": cmd_id},
                json_body=cmd_body,
            )
            stdout, stderr, exit_code = self._parse_cmd_result(result)
            try:
                self._request("DELETE", f"/v2/sandboxes/sessions/{session_id}")
            except Exception:
                pass
        except ExecutionUncertain:
            raise
        except Exception as exc:
            raise ExecutionUncertain(
                f"Vercel sandbox execution failed without durable success; not retrying automatically: {exc}"
            ) from None

        log = self._path("vercel-logs", job)
        confine_directory(log.parent)
        log.write_text((stdout or "") + (stderr or ""), encoding="utf-8")
        self._write_json(
            self._path("vercel-state", job),
            {
                "contract": job.contract,
                "exit_code": exit_code,
                "finished_at": time.time(),
                "image": job.image,
                "runtime": runtime,
                "session_id": session_id,
            },
        )
        return self.inspect(job)

    def inspect(self, job: VercelJobSpec) -> dict:
        job = VercelJobSpec.model_validate(job.model_dump())
        state = self._read_state(job)
        if state is None:
            raise ExecutionUnavailable("Vercel job state not found")
        if state.get("contract") != job.contract:
            raise ConflictError("Vercel identity is already bound to another contract")
        return {
            "running": False,
            "exit_code": state.get("exit_code"),
            "status": "exited",
        }

    def logs(self, job: VercelJobSpec, *, max_bytes: int = 65536) -> dict:
        path = self._path("vercel-logs", job)
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

    def stop(self, job: VercelJobSpec) -> dict:
        return self.inspect(job)

    def remove(self, job: VercelJobSpec) -> None:
        for kind in ("vercel-state", "vercel-logs", "vercel-intents"):
            try:
                self._path(kind, job).unlink(missing_ok=True)
            except Exception:
                pass

    def write_stdin(self, job: VercelJobSpec, payload: bytes) -> None:
        raise ExecutionUnavailable("Vercel execution has no stdin")

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, str]] = None,
    ) -> Any:
        query = dict(params or {})
        if self._team:
            query.setdefault("teamId", self._team)
        url = f"{VERCEL_API}{path}"
        owns = self._client is None
        client = self._client or httpx.Client(timeout=120.0)
        try:
            resp = client.request(method, url, headers=self._headers(), json=json_body, params=query or None)
            if resp.status_code >= 400:
                raise ExecutionUncertain(
                    f"Vercel API HTTP {resp.status_code}: {(resp.text or '')[:400]}"
                )
            if not resp.content:
                return {}
            text = resp.text
            if "\n" in text.strip() and not text.strip().startswith(("{", "[")):
                last: Any = {}
                for line in text.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        last = json.loads(line)
                    except Exception:
                        continue
                return last
            return resp.json()
        finally:
            if owns:
                client.close()

    @staticmethod
    def _parse_cmd_result(result: Any) -> tuple[str, str, Optional[int]]:
        if not isinstance(result, dict):
            return "", "", None
        stdout = str(result.get("stdout") or result.get("output") or "")
        stderr = str(result.get("stderr") or "")
        exit_code = result.get("exitCode")
        if exit_code is None:
            exit_code = result.get("exit_code")
        if exit_code is None and isinstance(result.get("command"), dict):
            exit_code = result["command"].get("exitCode")
            stdout = stdout or str(result["command"].get("stdout") or "")
            stderr = stderr or str(result["command"].get("stderr") or "")
        try:
            code = int(exit_code) if exit_code is not None else None
        except Exception:
            code = None
        return stdout, stderr, code

    def _path(self, kind: str, job: VercelJobSpec) -> Path:
        if kind in {"vercel-state", "vercel-intents"}:
            return self.workspace(job) / kind / f"{job.identity}.json"
        return self.workspace(job) / kind / job.identity

    def _intent(self, job: VercelJobSpec) -> bool:
        path = self.workspace(job) / "vercel-intents" / f"{job.identity}.json"
        if path.is_file():
            return False
        confine_directory(path.parent)
        path.write_text(json.dumps({"contract": job.contract, "at": time.time()}), encoding="utf-8")
        return True

    def _write_json(self, path: Path, payload: Dict[str, Any]) -> None:
        confine_directory(path.parent)
        path.write_text(json.dumps(payload), encoding="utf-8")

    def _read_state(self, job: VercelJobSpec) -> Optional[Dict[str, Any]]:
        path = self.workspace(job) / "vercel-state" / f"{job.identity}.json"
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
