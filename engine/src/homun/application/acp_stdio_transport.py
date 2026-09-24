"""Stdio JSON-RPC transport for Copilot ACP (H39).

Derived from Hermes agent/copilot_acp_client.py session wire at
c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT). Homun-owned: spawns the CLI,
speaks initialize → session/new → session/prompt, and never invents text when
the process fails or times out.
"""
from __future__ import annotations

import json
import logging
import os
import queue
import shutil
import subprocess
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_INITIALIZE_PARAMS: Dict[str, Any] = {
    "protocolVersion": 1,
    "clientInfo": {"name": "homun-engine", "version": "0.1.0"},
    "capabilities": {},
}


class AcpTransportError(RuntimeError):
    """ACP process or protocol failure."""


class StdioAcpTransport:
    """One-shot ACP session over stdin/stdout JSON-RPC lines."""

    def __init__(
        self,
        command: str,
        args: Optional[List[str]] = None,
        *,
        cwd: Optional[str] = None,
        timeout_seconds: float = 60.0,
    ) -> None:
        self.command = command
        self.args = list(args or ["--acp", "--stdio"])
        self.cwd = str(Path(cwd or os.getcwd()).resolve())
        self.timeout_seconds = float(timeout_seconds)

    def run(self, prompt: str) -> str:
        if not shutil.which(self.command) and not os.path.isfile(self.command):
            raise AcpTransportError(f"ACP command not found: {self.command}")
        try:
            proc = subprocess.Popen(
                [self.command] + self.args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                cwd=self.cwd,
                env={**os.environ, "TERM": "dumb"},
            )
        except OSError as exc:
            raise AcpTransportError(f"Could not start ACP process: {exc}") from exc
        if proc.stdin is None or proc.stdout is None:
            proc.kill()
            raise AcpTransportError("ACP process missing stdio pipes")

        inbox: queue.Queue[dict[str, Any]] = queue.Queue()
        stderr_tail: deque[str] = deque(maxlen=40)
        text_parts: List[str] = []

        def _pump_out() -> None:
            for line in proc.stdout or ():
                try:
                    inbox.put(json.loads(line))
                except Exception:
                    inbox.put({"raw": line.rstrip("\n")})

        def _pump_err() -> None:
            for line in proc.stderr or ():
                stderr_tail.append(line.rstrip("\n"))

        threading.Thread(target=_pump_out, daemon=True).start()
        threading.Thread(target=_pump_err, daemon=True).start()
        request_ids = iter(range(1, 1 << 30))
        deadline = time.monotonic() + self.timeout_seconds

        def _request(method: str, params: Dict[str, Any]) -> Any:
            req_id = next(request_ids)
            assert proc.stdin is not None
            proc.stdin.write(
                json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}) + "\n"
            )
            proc.stdin.flush()
            while time.monotonic() < deadline and proc.poll() is None:
                try:
                    msg = inbox.get(timeout=0.1)
                except queue.Empty:
                    continue
                method_name = msg.get("method")
                if isinstance(method_name, str) and method_name == "session/update":
                    update = (msg.get("params") or {}).get("update") or {}
                    content = update.get("content") or {}
                    chunk = str(content.get("text") or "") if isinstance(content, dict) else ""
                    if chunk and str(update.get("sessionUpdate") or "") == "agent_message_chunk":
                        text_parts.append(chunk)
                    continue
                if msg.get("id") != req_id:
                    continue
                if "error" in msg:
                    err = msg.get("error") or {}
                    raise AcpTransportError(
                        f"ACP {method} failed: {err.get('message') or err}"
                    )
                return msg.get("result")
            err = "\n".join(stderr_tail).strip()
            if proc.poll() is not None:
                raise AcpTransportError(
                    f"ACP process exited during {method}: {err or proc.returncode}"
                )
            raise AcpTransportError(f"Timed out waiting for ACP {method}")

        try:
            _request("initialize", _INITIALIZE_PARAMS)
            session = _request("session/new", {"cwd": self.cwd, "mcpServers": []}) or {}
            session_id = str(session.get("sessionId") or "").strip()
            if not session_id:
                raise AcpTransportError("ACP session/new did not return sessionId")
            _request(
                "session/prompt",
                {"sessionId": session_id, "prompt": [{"type": "text", "text": prompt}]},
            )
            return "".join(text_parts)
        finally:
            try:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        proc.kill()
            except Exception as exc:
                logger.debug("ACP process cleanup: %s", exc)
