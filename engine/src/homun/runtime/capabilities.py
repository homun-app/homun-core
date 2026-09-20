"""Shared capability flags and uptime for the Homun engine."""

from __future__ import annotations

import time
from typing import TypedDict

from homun import __version__
from homun.runtime import dbos_app

STARTED_AT = time.monotonic()


class CapabilityFlags(TypedDict):
    domain: bool
    agents: bool
    materials: bool
    memory: bool
    automations: bool
    peers: bool
    backup: bool
    models: bool
    runtime: bool


class EngineCapabilities(TypedDict):
    api_version: str
    version: str
    features: CapabilityFlags


def get_uptime_seconds() -> float:
    return round(time.monotonic() - STARTED_AT, 3)


def get_capabilities() -> EngineCapabilities:
    """Explicit feature flags — never claim unfinished capabilities as ready."""
    return {
        "api_version": "v1",
        "version": __version__,
        "features": {
            "domain": True,
            "agents": True,
            "materials": True,
            "memory": True,
            "automations": False,
            "peers": False,
            "backup": True,
            "models": True,
            "runtime": dbos_app.is_launched(),
        },
    }
