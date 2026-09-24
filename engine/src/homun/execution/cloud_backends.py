"""Optional cloud/container terminal backends for H10 (Modal, Daytona, Singularity, Vercel).

Derived conceptually from Hermes tools/environments/{modal,daytona,singularity,vercel_sandbox,managed_modal}.py
at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT). Homun-owned adapters refuse execution with a typed
ExecutionUnavailable until credentials and SDKs are configured — never invent sandbox IDs or exit codes.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from homun.execution.contracts import ExecutionUnavailable

CLOUD_BACKENDS = (
    "modal",
    "managed_modal",
    "singularity",
    "daytona",
    "vercel",
)

_ENV_KEYS = {
    "modal": ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "HOMUN_MODAL_TOKEN"),
    "managed_modal": ("HOMUN_MANAGED_MODAL_URL", "NOUS_MODAL_URL"),
    "singularity": ("HOMUN_SINGULARITY_BIN",),
    "daytona": ("DAYTONA_API_KEY", "HOMUN_DAYTONA_API_KEY"),
    "vercel": ("VERCEL_TOKEN", "HOMUN_VERCEL_TOKEN"),
}


@dataclass(frozen=True)
class CloudBackendStatus:
    name: str
    configured: bool
    ready: bool
    error: Optional[str] = None
    code: str = "backend_unavailable"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "configured": self.configured,
            "ready": self.ready,
            "error": self.error,
            "code": self.code if not self.ready else None,
            "kind": "terminal_backend",
        }


def _env_present(keys: tuple[str, ...]) -> bool:
    return any(bool(os.environ.get(k)) for k in keys)


def probe_cloud_backend(name: str) -> CloudBackendStatus:
    key = name.strip().lower()
    if key not in CLOUD_BACKENDS:
        return CloudBackendStatus(
            name=key,
            configured=False,
            ready=False,
            error=f"Unknown cloud terminal backend: {name}",
        )
    keys = _ENV_KEYS[key]
    if key == "singularity":
        from homun.execution.singularity_jobs import find_singularity_executable, singularity_version

        bin_path = find_singularity_executable()
        if not bin_path:
            return CloudBackendStatus(
                name=key,
                configured=False,
                ready=False,
                error=(
                    "Singularity backend requires apptainer/singularity on PATH "
                    "or HOMUN_SINGULARITY_BIN"
                ),
            )
        try:
            singularity_version(bin_path)
        except Exception as exc:
            return CloudBackendStatus(
                name=key,
                configured=True,
                ready=False,
                error=str(exc),
            )
        return CloudBackendStatus(
            name=key,
            configured=True,
            ready=True,
            error=None,
            code="ok",
        )
    if key == "modal":
        from homun.execution.modal_jobs import (
            modal_credentials_present,
            modal_live_allowed,
            modal_sdk_available,
        )

        if not modal_sdk_available():
            return CloudBackendStatus(
                name=key,
                configured=False,
                ready=False,
                error="Modal SDK is not installed (pip install modal)",
            )
        if not modal_credentials_present():
            return CloudBackendStatus(
                name=key,
                configured=False,
                ready=False,
                error="Modal credentials missing (MODAL_TOKEN_ID/SECRET or HOMUN_MODAL_TOKEN)",
            )
        if not modal_live_allowed():
            return CloudBackendStatus(
                name=key,
                configured=True,
                ready=False,
                error=(
                    "Modal credentials present; set HOMUN_MODAL_ALLOW_LIVE=1 to permit "
                    "Sandbox.create (may incur cloud charges)"
                ),
            )
        return CloudBackendStatus(
            name=key,
            configured=True,
            ready=True,
            error=None,
            code="ok",
        )
    if key == "daytona":
        from homun.execution.daytona_jobs import (
            daytona_credentials_present,
            daytona_live_allowed,
            daytona_sdk_available,
        )

        if not daytona_sdk_available():
            return CloudBackendStatus(
                name=key,
                configured=False,
                ready=False,
                error="Daytona SDK is not installed",
            )
        if not daytona_credentials_present():
            return CloudBackendStatus(
                name=key,
                configured=False,
                ready=False,
                error="Daytona credentials missing (DAYTONA_API_KEY or HOMUN_DAYTONA_API_KEY)",
            )
        if not daytona_live_allowed():
            return CloudBackendStatus(
                name=key,
                configured=True,
                ready=False,
                error=(
                    "Daytona credentials present; set HOMUN_DAYTONA_ALLOW_LIVE=1 to permit "
                    "workspace creation (may incur cloud charges)"
                ),
            )
        return CloudBackendStatus(
            name=key,
            configured=True,
            ready=True,
            error=None,
            code="ok",
        )
    if key == "vercel":
        from homun.execution.vercel_jobs import (
            vercel_credentials_present,
            vercel_live_allowed,
            vercel_sdk_available,
        )

        if not vercel_credentials_present():
            return CloudBackendStatus(
                name=key,
                configured=False,
                ready=False,
                error="Vercel credentials missing (VERCEL_TOKEN or HOMUN_VERCEL_TOKEN)",
            )
        if not vercel_live_allowed():
            return CloudBackendStatus(
                name=key,
                configured=True,
                ready=False,
                error=(
                    "Vercel credentials present; set HOMUN_VERCEL_ALLOW_LIVE=1 after the "
                    "Homun sandbox client is implemented (may incur cloud charges)"
                ),
            )
        if not vercel_sdk_available():
            return CloudBackendStatus(
                name=key,
                configured=True,
                ready=False,
                error="Vercel live opt-in set but no Homun-compatible Vercel sandbox SDK is installed",
            )
        return CloudBackendStatus(
            name=key,
            configured=True,
            ready=False,
            error=(
                "Vercel credentials and live opt-in are present, but the Homun-owned "
                "sandbox client is not yet implemented; refusing invented runs"
            ),
        )
    if not _env_present(keys):
        return CloudBackendStatus(
            name=key,
            configured=False,
            ready=False,
            error=f"{key} backend is not configured (set one of {', '.join(keys)})",
        )
    return CloudBackendStatus(
        name=key,
        configured=True,
        ready=False,
        error=(
            f"{key} credentials are present but the Homun-owned execution bridge "
            "is not yet wired; refusing to invent sandbox runs"
        ),
    )


def list_cloud_backend_status() -> List[Dict[str, Any]]:
    return [probe_cloud_backend(name).to_dict() for name in CLOUD_BACKENDS]


class UnavailableCloudJobs:
    """Stand-in backend that always raises ExecutionUnavailable with an honest probe message."""

    def __init__(self, name: str) -> None:
        self.name = name.strip().lower()
        self.status = probe_cloud_backend(self.name)

    def _raise(self) -> None:
        raise ExecutionUnavailable(self.status.error or f"{self.name} backend unavailable")

    def start(self, spec, **kwargs):
        self._raise()

    def inspect(self, spec):
        self._raise()

    def logs(self, spec):
        self._raise()

    def stop(self, spec):
        self._raise()

    def write_stdin(self, spec, payload):
        self._raise()
