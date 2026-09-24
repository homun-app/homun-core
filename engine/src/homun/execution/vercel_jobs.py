"""Vercel sandbox terminal backend (H10).

Homun-owned bridge gated by HOMUN_VERCEL_ALLOW_LIVE=1. Without the official
SDK or live opt-in, Homun reports typed unavailability — never invents
deployment IDs or exit codes.
"""
from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator

from homun.execution.contracts import ExecutionUnavailable, digest
from homun.execution.layout import confine_directory


def vercel_sdk_available() -> bool:
    try:
        import vercel  # noqa: F401
        return True
    except Exception:
        return False


def vercel_live_allowed() -> bool:
    return str(os.environ.get("HOMUN_VERCEL_ALLOW_LIVE") or "").strip() in {"1", "true", "yes"}


def vercel_credentials_present() -> bool:
    return bool(os.environ.get("VERCEL_TOKEN") or os.environ.get("HOMUN_VERCEL_TOKEN"))


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
    """Placeholder live bridge: refuses until a Homun-owned Vercel sandbox client lands."""

    def __init__(self, root: Path) -> None:
        self.root = confine_directory(Path(root).absolute())
        if not vercel_credentials_present():
            raise ExecutionUnavailable(
                "Vercel credentials missing (VERCEL_TOKEN or HOMUN_VERCEL_TOKEN)"
            )
        if not vercel_live_allowed():
            raise ExecutionUnavailable(
                "Vercel live execution is gated. Set HOMUN_VERCEL_ALLOW_LIVE=1 to permit "
                "sandbox creation (may incur cloud charges)."
            )
        # Even with opt-in, the concrete Sandbox client API is not yet wired.
        raise ExecutionUnavailable(
            "Vercel credentials and live opt-in are present, but the Homun-owned "
            "Vercel sandbox client is not yet implemented; refusing invented runs"
        )

    def start(self, job: VercelJobSpec, **kwargs):
        raise ExecutionUnavailable("Vercel sandbox client not implemented")

    def inspect(self, job: VercelJobSpec):
        raise ExecutionUnavailable("Vercel sandbox client not implemented")

    def logs(self, job: VercelJobSpec, **kwargs):
        raise ExecutionUnavailable("Vercel sandbox client not implemented")

    def stop(self, job: VercelJobSpec):
        raise ExecutionUnavailable("Vercel sandbox client not implemented")

    def remove(self, job: VercelJobSpec) -> None:
        return None

    def write_stdin(self, job: VercelJobSpec, payload: bytes) -> None:
        raise ExecutionUnavailable("Vercel execution has no stdin")
