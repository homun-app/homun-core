"""Immutable identities and contracts for owned container jobs."""
from __future__ import annotations

import hashlib
import json

from pydantic import BaseModel, ConfigDict, Field, field_validator

from homun.domain.errors import DomainError


class ExecutionUncertain(DomainError):
    code = "execution_uncertain"


class ExecutionUnavailable(DomainError):
    code = "execution_unavailable"


class ExecutionTimeout(DomainError):
    code = "execution_transport_timeout"


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class JobSpec(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)
    workspace_id: str = Field(min_length=1, max_length=256)
    run_id: str = Field(min_length=1, max_length=256)
    call_id: str = Field(min_length=1, max_length=256)
    image: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    command: str = Field(min_length=1, max_length=16000)

    @field_validator("command", "workspace_id", "run_id", "call_id")
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
        return digest({"spec": self.model_dump(), "policy": "docker-offline-v1"})

    @property
    def name(self) -> str:
        return "homun-job-" + self.identity[:32]
