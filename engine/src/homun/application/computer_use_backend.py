"""cua-driver backend seam: MCP over stdio, typed unavailability, no silent stubs.

The driver (trycua/cua) speaks MCP on stdin/stdout. Homun never links it:
each call resolves the binary, opens a short-lived stdio session and sends
one ``tools/call``. When the binary is missing the caller gets a typed
BackendUnavailableError carrying the install hint — never a fake success.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional

from homun.domain.errors import BackendUnavailableError

DEFAULT_TIMEOUT = 30.0
MCP_PROTOCOL = "2024-11-05"
INSTALL_HINT = (
    "cua-driver non trovato: installalo con 'brew install cua-driver' o "
    "'cargo install --git https://github.com/trycua/cua', oppure punta "
    "HOMUN_CUA_DRIVER_BIN al binario."
)


def resolve_binary() -> Optional[str]:
    candidates = [
        os.environ.get("HOMUN_CUA_DRIVER_BIN"),
        str(Path(__file__).resolve().parents[2] / ".venv" / "bin" / "cua-driver"),
        shutil.which("cua-driver"),
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def available() -> bool:
    return resolve_binary() is not None


def call_tool(tool: str, arguments: Dict[str, Any],
              *, timeout: float = DEFAULT_TIMEOUT) -> Dict[str, Any]:
    """One MCP round-trip to cua-driver. Raises BackendUnavailableError when absent."""
    binary = resolve_binary()
    if binary is None:
        raise BackendUnavailableError(INSTALL_HINT)
    env = {
        **os.environ,
        "CUA_DRIVER_RS_TELEMETRY_ENABLED": "0",
    }
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": MCP_PROTOCOL, "capabilities": {},
                   "clientInfo": {"name": "homun-engine", "version": "1"}},
    }) + "\n" + json.dumps({
        "jsonrpc": "2.0", "method": "notifications/initialized",
    }) + "\n" + json.dumps({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }) + "\n"
    try:
        completed = subprocess.run(
            [binary], input=payload, capture_output=True, text=True,
            timeout=timeout, env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise BackendUnavailableError(
            f"cua-driver timeout dopo {timeout}s (il driver risponde? prova 'cua-driver doctor')") from exc
    responses = [json.loads(line) for line in completed.stdout.splitlines()
                 if line.strip().startswith("{")]
    result = next((r.get("result") for r in responses
                   if r.get("id") == 2 and "result" in r), None)
    if result is None:
        error = next((r.get("error", {}).get("message") for r in responses
                      if r.get("id") == 2 and "error" in r), None)
        raise BackendUnavailableError(
            f"cua-driver non ha risposto alla chiamata: {error or completed.stderr[:200]}")
    return result
