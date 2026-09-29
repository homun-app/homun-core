"""Own the wa-rs-bridge sidecar lifecycle for the WhatsApp channel.

When the ``whatsapp`` channel is enabled and no bridge is already listening,
the engine spawns the sidecar binary with a callback URL pointing at its own
authenticated channel ingress, and keeps the session database inside the
engine data directory. An externally started bridge is left alone: probing
wins over spawning, so developers can run ``cargo run -p wa-rs-bridge`` with
custom settings and the engine simply uses it.

Binary resolution order: HOMUN_WHATSAPP_BRIDGE_BIN env, the channel's
``bridge_binary`` field, the interpreter's bin directory (venv or bundle), PATH.

macOS note: an unsigned arm64 binary spawned from a GUI-owned process is
killed silently at exec; installs and packaging must give wa-rs-bridge at
least an ad-hoc signature (``codesign -s - wa-rs-bridge``).
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

_spawned: Optional[subprocess.Popen] = None
_last_check = 0.0
_CHECK_INTERVAL = 10.0


def _channels_config_path() -> Path:
    from homun.context import get_context

    return get_context().data_dir / "channels.json"


def _load_whatsapp_config() -> Dict[str, Any]:
    try:
        import json

        raw = _channels_config_path().read_text(encoding="utf-8")
        data = json.loads(raw) if raw.strip() else {}
        cfg = data.get("whatsapp") or {}
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


def _bridge_port(fields: Dict[str, str]) -> int:
    url = str(
        fields.get("bridge_url")
        or os.environ.get("HOMUN_WHATSAPP_BRIDGE_URL")
        or "http://127.0.0.1:8902"
    )
    try:
        return urlparse(url).port or 8902
    except ValueError:
        return 8902


def _resolve_bridge_binary(fields: Dict[str, str]) -> Optional[str]:
    candidates = [
        os.environ.get("HOMUN_WHATSAPP_BRIDGE_BIN"),
        str(fields.get("bridge_binary") or ""),
        str(Path(sys.executable).parent / "wa-rs-bridge"),
        shutil.which("wa-rs-bridge") or "",
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _bridge_alive(port: int) -> bool:
    try:
        with httpx.Client(timeout=0.8) as client:
            resp = client.get(f"http://127.0.0.1:{port}/health")
        return resp.status_code == 200
    except httpx.HTTPError:
        return False


def ensure_whatsapp_bridge(force: bool = False, allow_unconfigured: bool = False) -> Optional[str]:
    """Make sure a wa-rs-bridge is listening when the channel is enabled.

    ``allow_unconfigured`` lets the onboarding flow spawn the sidecar before
    any channel configuration exists — pairing necessarily precedes enabling.
    Returns a short status string for diagnostics; never raises: a missing or
    broken sidecar must surface through the channel status endpoints, not take
    the engine down.
    """
    global _spawned, _last_check

    now = time.time()
    if not force and now - _last_check < _CHECK_INTERVAL:
        return "throttled"
    _last_check = now

    cfg = _load_whatsapp_config()
    if not cfg.get("enabled"):
        if not allow_unconfigured:
            # Disabling the channel must not leave our own sidecar running.
            if _spawned is not None and _spawned.poll() is None:
                stop_whatsapp_bridge()
            return "disabled"

    fields = cfg.get("fields") or {}
    port = _bridge_port(fields)
    if _bridge_alive(port):
        return "already-listening"

    if _spawned is not None and _spawned.poll() is None:
        # Recently spawned by us but not answering yet (QR pairing handshake).
        return "starting"

    binary = _resolve_bridge_binary(fields)
    if not binary:
        logger.warning(
            "WhatsApp channel enabled but no wa-rs-bridge binary found "
            "(HOMUN_WHATSAPP_BRIDGE_BIN, bridge_binary field, venv bin, PATH)"
        )
        return "binary-missing"

    from homun.application.engine_listening import engine_base_url

    base_url = engine_base_url()
    callback_url = f"{base_url}/v1/gateway/channels/whatsapp/inbound" if base_url else ""
    if not callback_url:
        return "engine-port-unknown"

    data_dir = _channels_config_path().parent
    db_path = data_dir / "channels" / "whatsapp-bridge.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    log_path = data_dir / "channels" / "whatsapp-bridge.log"

    env = {
        **os.environ,
        "WA_BRIDGE_PORT": str(port),
        "WA_BRIDGE_DB": str(db_path),
        "WA_BRIDGE_CALLBACK_URL": callback_url,
        "WA_BRIDGE_CALLBACK_TOKEN": os.environ.get("HOMUN_SESSION_TOKEN", ""),
    }
    log_file = open(log_path, "ab")
    try:
        _spawned = subprocess.Popen(
            [binary],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )
        logger.info("spawned wa-rs-bridge (pid %s) on port %s", _spawned.pid, port)
        return "spawned"
    except OSError as exc:
        logger.error("failed to spawn wa-rs-bridge %s: %s", binary, exc)
        return "spawn-failed"
    finally:
        log_file.close()


def stop_whatsapp_bridge() -> None:
    """Terminate a bridge this process spawned; external bridges stay."""
    global _spawned
    if _spawned is None:
        return
    proc, _spawned = _spawned, None
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
    logger.info("stopped wa-rs-bridge (pid %s)", proc.pid)
