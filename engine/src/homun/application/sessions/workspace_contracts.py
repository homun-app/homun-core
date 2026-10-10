"""Versioned public references and receipts for approved workspace continuation."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class WorkspaceTransferReference(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    command_id: str = Field(min_length=1, max_length=140)
    digest: str = Field(pattern=r'^[a-f0-9]{64}$')


class ExecutionContext(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    version: Literal[1] = 1
    backend: Literal['local-private-v1', 'docker-offline-v1']
    cwd: str = '.'


class WorkspaceTransferReceipt(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    version: Literal[1] = 1
    manifest_digest: str = Field(pattern=r'^[a-f0-9]{64}$')
    target_run_id: str
    file_count: int = Field(ge=0)
