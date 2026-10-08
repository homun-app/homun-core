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


from homun.execution.identity import digest

class JobSpec(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)
    workspace_id: str = Field(min_length=1, max_length=256)
    run_id: str = Field(min_length=1, max_length=256)
    call_id: str = Field(min_length=1, max_length=256)
    image: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    command: str = Field(min_length=1, max_length=16000)

    cwd: str = '.'

    @field_validator('cwd')
    @classmethod
    def valid_cwd(cls, value: str) -> str:
        from homun.execution.workspace import relative_cwd
        return relative_cwd(value)

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
        return digest({"spec": self.model_dump(exclude={"cwd"} if self.cwd == "." else set()), "policy": "docker-offline-v1"})

    @property
    def name(self) -> str:
        return "homun-job-" + self.identity[:32]


class LocalJobSpec(BaseModel):
    """A command on this computer. Identity matches a container job; the contract does not."""

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)
    workspace_id: str = Field(min_length=1, max_length=256)
    run_id: str = Field(min_length=1, max_length=256)
    call_id: str = Field(min_length=1, max_length=256)
    command: str = Field(min_length=1, max_length=16000)

    deadline_at: str | None = None

    @field_validator("deadline_at")
    @classmethod
    def valid_deadline(cls, value: str | None) -> str | None:
        if value is not None:
            from datetime import datetime
            parsed = datetime.fromisoformat(value)
            if parsed.tzinfo is None or parsed.utcoffset() is None:
                raise ValueError("Local deadlines require a timezone")
        return value

    cwd: str = '.'

    @field_validator('cwd')
    @classmethod
    def valid_cwd(cls, value: str) -> str:
        from homun.execution.workspace import relative_cwd
        return relative_cwd(value)

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
        return digest({"spec": self.model_dump(exclude_none=True, exclude={"cwd"} if self.cwd == "." else set()), "policy": "local-private-v1"})


class SshJobSpec(BaseModel):
    """One approved command on an explicit SSH host. The private key path is not part of the contract."""

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)
    workspace_id: str = Field(min_length=1, max_length=256)
    run_id: str = Field(min_length=1, max_length=256)
    call_id: str = Field(min_length=1, max_length=256)
    command: str = Field(min_length=1, max_length=16000)
    host: str = Field(min_length=1, max_length=253)
    user: str = Field(min_length=1, max_length=32)
    port: int = Field(ge=1, le=65535)
    host_key: str = Field(min_length=1, max_length=2000)
    key_fingerprint: str = Field(pattern=r"^SHA256:[A-Za-z0-9+/]+$")
    key_path: str = Field(min_length=1, max_length=4096)

    @field_validator("command", "workspace_id", "run_id", "call_id", "host", "user", "host_key", "key_path")
    @classmethod
    def no_null(cls, value: str) -> str:
        if "\x00" in value or not value.strip() or "\n" in value or "\r" in value:
            raise ValueError("Job fields must be nonempty and contain no NUL or newline")
        return value

    @property
    def identity(self) -> str:
        return digest([self.workspace_id, self.run_id, self.call_id])

    @property
    def owner(self) -> str:
        return digest([self.workspace_id, self.run_id])

    @property
    def contract(self) -> str:
        visible = self.model_dump(exclude={"key_path"})
        return digest({"spec": visible, "policy": "ssh-v1"})
