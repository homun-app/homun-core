"""The engine's own listening address, captured at serve() bind time.

Channel sidecars spawned by the engine (e.g. wa-rs-bridge) must call back into
this process; the desktop owns the socket and picks a free port, so the bound
port is recorded here right after bind and read wherever the callback URL is
built. Before serve() binds, callers get None and must not invent an address.
"""
from __future__ import annotations

import threading
from typing import Optional

_lock = threading.Lock()
_listening_port: Optional[int] = None


def set_listening_port(port: int) -> None:
    global _listening_port
    with _lock:
        _listening_port = int(port)


def listening_port() -> Optional[int]:
    with _lock:
        return _listening_port


def engine_base_url() -> Optional[str]:
    port = listening_port()
    return f"http://127.0.0.1:{port}" if port else None
