"""cua-driver backend seam: one persistent MCP stdio connection, typed errors.

The driver's session semantics (start_session, element tokens, session-owned
screenshots) only survive on a single connection, so the engine keeps ONE
long-lived cua-driver process with the MCP handshake done once; every call
writes a request and reads its id-matched response under a lock. When the
binary is missing the caller gets a typed BackendUnavailableError with the
install hint — never a fake success.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, Optional

from homun.domain.errors import BackendUnavailableError

MCP_PROTOCOL = "2024-11-05"
INSTALL_HINT = (
    "cua-driver non trovato: installalo con 'brew install cua-driver' o "
    "'cargo install --git https://github.com/trycua/cua', oppure punta "
    "HOMUN_CUA_DRIVER_BIN al binario."
)

_lock = threading.Lock()
_conn: Optional[Dict[str, Any]] = None


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


def _driver_env() -> Dict[str, str]:
    return {**os.environ, "CUA_DRIVER_RS_TELEMETRY_ENABLED": "0"}


def _read_response(proc: subprocess.Popen, want_id: int, timeout: float) -> Dict[str, Any]:
    import selectors
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    deadline = _now() + timeout
    try:
        buffer = ""
        while True:
            remaining = deadline - _now()
            if remaining <= 0:
                raise BackendUnavailableError(f"cua-driver: nessuna risposta id={want_id} in {timeout}s")
            for key, _ in selector.select(min(remaining, 1.0)):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    raise BackendUnavailableError("cua-driver: connessione chiusa dal driver")
                buffer += chunk.decode("utf-8", "replace")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    message = json.loads(line)
                    if message.get("id") == want_id:
                        if "error" in message:
                            raise BackendUnavailableError(
                                f"cua-driver MCP: {message['error'].get('message', message['error'])}")
                        return message.get("result") or {}
    finally:
        selector.close()


def _now() -> float:
    import time
    return time.monotonic()


def _connection(timeout: float = 30.0) -> Dict[str, Any]:
    global _conn
    if _conn is not None and _conn["proc"].poll() is None:
        return _conn
    binary = resolve_binary()
    if binary is None:
        raise BackendUnavailableError(INSTALL_HINT)
    if _conn is not None:
        try:
            _conn["proc"].kill()
        except OSError:
            pass
    proc = subprocess.Popen(
        [binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=False, bufsize=0, env=_driver_env())
    handshake = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": MCP_PROTOCOL, "capabilities": {},
                   "clientInfo": {"name": "homun-engine", "version": "1"}},
    }).encode() + b"\n" + json.dumps({
        "jsonrpc": "2.0", "method": "notifications/initialized",
    }).encode() + b"\n"
    proc.stdin.write(handshake)
    proc.stdin.flush()
    _read_response(proc, 1, timeout)
    _conn = {"proc": proc, "next_id": 2}
    return _conn


def call_tool(tool: str, arguments: Dict[str, Any],
              *, timeout: float = 60.0) -> Dict[str, Any]:
    """One tools/call on the shared connection (session-safe, id-matched)."""
    with _lock:
        conn = _connection(timeout)
        request_id = conn["next_id"]
        conn["next_id"] += 1
        proc: subprocess.Popen = conn["proc"]
        proc.stdin.write(json.dumps({
            "jsonrpc": "2.0", "id": request_id, "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }).encode() + b"\n")
        proc.stdin.flush()
        try:
            return _read_response(proc, request_id, timeout)
        except BackendUnavailableError:
            # Dead connection: drop it so the next call re-handshakes.
            global _conn
            try:
                proc.kill()
            except OSError:
                pass
            _conn = None
            raise


def reset_for_tests() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            try:
                _conn["proc"].kill()
            except OSError:
                pass
        _conn = None
