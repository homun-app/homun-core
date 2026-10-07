"""Shared validation for fresh run proposal inputs."""
from typing import Literal
from pydantic import Field
from homun.application.surface_toolset_policy import RunToolPolicy
from homun.application.session_workspace_contracts import WorkspaceTransferReference


class RunRequest(RunToolPolicy):
    workspace_transfer: WorkspaceTransferReference | None = None
    command_id: str = Field(min_length=1, max_length=160)
    expected_version: int = Field(ge=1)
    terminal_image: str | None = Field(default=None,pattern=r'^sha256:[0-9a-f]{64}$')
    terminal_backend: Literal['docker', 'local', 'ssh', 'modal', 'managed_modal', 'singularity', 'daytona', 'vercel'] | None = None
    ssh_host: str | None = Field(default=None, max_length=253)
    ssh_user: str | None = Field(default=None, max_length=32)
    ssh_port: int | None = Field(default=None, ge=1, le=65535)
    ssh_host_key: str | None = Field(default=None, max_length=2000)
    ssh_key_path: str | None = Field(default=None, max_length=4096)
    web_pages: bool = False
    browser: bool = False
    # None = caller did not choose: the engine default applies (native → on).
    memory: bool | None = None
    skills: bool | None = None
    delegation: bool = False
    computer_use: bool = False
    clarify: bool = False
    goals: bool = False
    cron: bool = False
    session_management: bool = False
    gateway: bool = False
    code_execution: bool = False
    plugins: bool = False
    moa: bool | dict | None = None
    server_ids: list[str] = Field(default_factory=list, max_length=4)
    material_ids: list[str] = Field(default_factory=list, max_length=12)
    team_id: str | None = Field(default=None, max_length=160)
    person_id: str | None = Field(default=None, min_length=1, max_length=160)
    cwd: str | None = Field(default=None, max_length=4096)
    workspace_root: str | None = Field(default=None, max_length=4096)
    model_id: str | None = Field(default=None, min_length=1, max_length=256)
    provider_id: str | None = Field(default=None, min_length=1, max_length=160)
    connection_id: str | None = Field(default=None, max_length=160)
    fallback_connection_id: str | None = Field(default=None, max_length=160)

